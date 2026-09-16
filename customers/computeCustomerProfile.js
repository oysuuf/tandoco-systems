// ═════════════════════════════════════════════════════════════════════
// computeCustomerProfile — the single derivation pass.
//
// This is the ONE function that writes customers/{uid}.profile. Every
// surface in the product reads from that field; nothing else writes to
// it. The function is pure-ish: same inputs → same output, idempotent,
// safe to replay.
//
// Triggers (wired up in index.js):
//   • Firestore onWrite('customers/{uid}')        — prefs or goal changed
//   • Firestore onCreate('orders/{orderId}')      — new order completed
//   • Firestore onWrite('customers/{uid}/bodyMetrics/{w}') — wearable sync
//   • Firestore onWrite('customers/{uid}/events/{e}')      — new signal
//   • Scheduled nightly 03:00                     — catch-up + decay
//
// All triggers funnel into recompute(uid). The function itself is
// safe to call from anywhere (admin scripts, tests, manual debug).
// ═════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const {
  SCHEMA_VERSION,
  buildEmptyProfile,
  validateProfile,
  applyLegacyPreferences,
  applyOnboardingPreferences,
} = require('./profileSchema');
const { classifyState } = require('./stateClassifier');
const { recentEvents, EVENT_WEIGHTS } = require('./events');

// How far back to look when computing taste signals.
// 90 days is long enough to be stable, short enough to reflect changes.
const TASTE_WINDOW_DAYS = 90;
const ADHERENCE_WINDOW_WEEKS = 12;
const TOP_MEALS_K = 12;       // keep top-K most-loved meal IDs
const AVOID_MEALS_K = 6;      // and top-K avoided
const TIME_DECAY_HALF_LIFE_D = 45; // exponential decay: signal half-life in days

// ── Helpers ────────────────────────────────────────────────────────
function _daysAgo(ts) {
  if (!ts) return Infinity;
  const t = ts.toMillis ? ts.toMillis() : (ts.seconds ? ts.seconds * 1000 : +new Date(ts));
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}
function _decay(days) {
  // Exponential half-life: weight halves every TIME_DECAY_HALF_LIFE_D days.
  return Math.pow(0.5, days / TIME_DECAY_HALF_LIFE_D);
}
function _topN(map, n) {
  return Array.from(map.entries())
    .map(([id, score]) => ({ id, score: Math.round(score * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

// ── Goal → nutrition target mapping ────────────────────────────────
// These are starting defaults; users can override in the onboarding modal.
function _goalToTargets(goalType) {
  switch (goalType) {
    case 'lose-weight':
      return { proteinFloor: 140, calorieRange: [1600, 2000], fiberFloor: 30 };
    case 'build-muscle':
      return { proteinFloor: 180, calorieRange: [2400, 2900], fiberFloor: 30 };
    case 'maintain':
      return { proteinFloor: 130, calorieRange: [2000, 2400], fiberFloor: 30 };
    default:
      return { proteinFloor: null, calorieRange: null, fiberFloor: null };
  }
}

// ── Main: derive profile from all source data ──────────────────────
/**
 * Recompute the profile for a single customer.
 * Idempotent — calling it twice with no input changes returns the same result.
 *
 * @param {string} uid
 * @returns {Promise<object>} the written profile
 */
async function recompute(uid) {
  if (!uid) throw new Error('recompute: uid required');
  const db = admin.firestore();

  // 1. Load the customer doc.
  const custSnap = await db.collection('customers').doc(uid).get();
  if (!custSnap.exists) {
    // No customer doc yet — nothing to compute. Caller decides what to do.
    return null;
  }
  const cust = custSnap.data() || {};

  const profile = buildEmptyProfile();

  // 2. Mirror explicit preferences in this source priority:
  //    a. The new rich shape (customers/{uid}.tastePreferences /
  //       .dietaryConstraints) — written by future surfaces.
  //    b. The /onboarding survey (customers/{uid}.dietaryPreferences +
  //       .goals) — the customer-facing source today. Highest signal.
  //    c. The legacy 9-tag staff CRM array (customers/{uid}.preferences).
  //
  // Each layer is additive: an allergen captured in (a) won't be erased
  // by (b) or (c); a cuisine added by (b) appears alongside any from (a).
  if (cust.tastePreferences && typeof cust.tastePreferences === 'object') {
    Object.assign(profile.tastePreferences, cust.tastePreferences);
  }
  if (cust.dietaryConstraints && typeof cust.dietaryConstraints === 'object') {
    Object.assign(profile.dietaryConstraints, cust.dietaryConstraints);
  }
  const onboarding = applyOnboardingPreferences(profile, cust);
  applyLegacyPreferences(profile, cust.preferences);

  // 3. Goal + targets.
  //    Priority: onboarding survey > new explicit goalType field >
  //    legacy `goal.type`. Onboarding wins because it's customer-stated
  //    and recent.
  const goalType =
    onboarding.goalType ||
    (cust.goal && cust.goal.type) ||
    cust.goalType ||
    null;
  profile.goalType = goalType;
  // applyOnboardingPreferences may have already filled nutritionTargets
  // from per-meal proteinTarget/calorieTarget. Explicit cust.nutritionTargets
  // (set by mise or a future settings UI) still wins. Otherwise fall back
  // to goal-shape defaults so the engine has something to score against.
  if (cust.nutritionTargets && typeof cust.nutritionTargets === 'object') {
    Object.assign(profile.nutritionTargets, cust.nutritionTargets);
  } else if (profile.nutritionTargets.proteinFloor == null) {
    Object.assign(profile.nutritionTargets, _goalToTargets(goalType));
  }

  // 4. Body metrics → state classifier.
  // Pull 12 weeks — the smart-cart-style classifier compares the
  // most-recent 3 weeks against the prior 9 for stable trend detection.
  // A 1-week snapshot was too noisy (one bad sleep week could flip the
  // state). 12 weeks is also the ADHERENCE_WINDOW so we're not making
  // an extra round trip for two different windowing needs.
  const bmSnap = await db.collection('customers').doc(uid)
    .collection('bodyMetrics')
    .orderBy('weekStart', 'desc')
    .limit(12)
    .get();
  const bodyMetrics = bmSnap.docs.map(d => d.data());
  const { currentState, wearableContext } = classifyState({ bodyMetrics, goalType });
  profile.currentState = currentState;
  profile.wearableContext = wearableContext;
  // Mark wearable providers if we have at least one bodyMetrics row that
  // carries a `source` field (set by the integration writers).
  const providers = new Set();
  for (const m of bodyMetrics) {
    if (m.source) providers.add(m.source);
    if (Array.isArray(m.sources)) m.sources.forEach(s => providers.add(s));
  }
  profile.wearableContext.providers = Array.from(providers);

  // 5. Order history → taste signals.
  // Pull orders within the taste window. Cap to a reasonable number
  // so a heavy customer doesn't blow up the read budget.
  const cutoff = admin.firestore.Timestamp.fromMillis(
    Date.now() - TASTE_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );
  const orderSnap = await db.collection('orders')
    .where('uid', '==', uid)
    .where('createdAt', '>=', cutoff)
    .orderBy('createdAt', 'desc')
    .limit(60)
    .get()
    .catch(() => ({ docs: [] })); // tolerate index-missing during initial deploy
  const orders = orderSnap.docs.map(d => d.data());

  // Tally weighted item counts with time decay.
  const mealScore = new Map();
  const cuisineScore = new Map();
  const proteinScore = new Map();
  let lastOrderAt = null;
  let weeksOrderedSet = new Set();

  for (const o of orders) {
    const ageDays = _daysAgo(o.createdAt);
    const w = _decay(ageDays);
    if (!lastOrderAt || ageDays < _daysAgo(lastOrderAt)) lastOrderAt = o.createdAt;
    // Week bucket for adherence — ISO weekstart.
    if (o.createdAt && o.createdAt.toDate) {
      const d = o.createdAt.toDate();
      const monday = new Date(d);
      monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      weeksOrderedSet.add(monday.toISOString().slice(0, 10));
    }
    const items = Array.isArray(o.items) ? o.items : [];
    for (const it of items) {
      const id = it.recipeId || it.id;
      if (!id) continue;
      const qty = Number(it.quantity || it.qty || 1);
      mealScore.set(id, (mealScore.get(id) || 0) + w * qty);
      if (it.cuisine) cuisineScore.set(it.cuisine, (cuisineScore.get(it.cuisine) || 0) + w * qty);
      if (it.protein)  proteinScore.set(it.protein,  (proteinScore.get(it.protein)  || 0) + w * qty);
    }
  }

  // 6. Recent events → refine signals + capture avoid list + adherence behavior.
  const events = await recentEvents(uid, 200);
  for (const e of events) {
    const w = (e.weight != null) ? e.weight : (EVENT_WEIGHTS[e.type] ?? 0);
    if (!e.recipeId) continue;
    const ageDays = _daysAgo(e.timestamp);
    const decayed = w * _decay(ageDays);
    mealScore.set(e.recipeId, (mealScore.get(e.recipeId) || 0) + decayed);
  }

  // 7. Build the signals block.
  // Top meals: positive scores only.
  const topMeals = [...mealScore.entries()].filter(([, s]) => s > 0);
  // Avoid: negative scores (from remove/skip/negative ratings).
  const avoidMeals = [...mealScore.entries()].filter(([, s]) => s < 0);
  const topMealsTop = _topN(new Map(topMeals), TOP_MEALS_K);
  const avoidMealsTop = _topN(new Map(avoidMeals.map(([id,s])=>[id,-s])), AVOID_MEALS_K)
    .map(({ id, score }) => ({ id, score: -score })); // restore sign

  profile.signals.topMealIds = topMealsTop;
  profile.signals.avoidMealIds = avoidMealsTop;
  profile.signals.topCuisines = _topN(cuisineScore, 5).map(x => ({ name: x.id, score: x.score }));
  profile.signals.topProteins = _topN(proteinScore, 5).map(x => ({ name: x.id, score: x.score }));
  profile.signals.orderCount = cust.orderCount || orders.length;
  profile.signals.lastOrderAt = lastOrderAt || null;
  profile.signals.weeklyAdherence = Math.min(
    1,
    weeksOrderedSet.size / ADHERENCE_WINDOW_WEEKS
  );
  // Exploration appetite: ratio of unique meals to total order-line-items.
  const totalLines = orders.reduce((n, o) => n + (Array.isArray(o.items) ? o.items.length : 0), 0);
  if (totalLines > 0) {
    profile.signals.explorationAppetite = Math.min(1, mealScore.size / Math.max(1, totalLines));
  }

  // 8. Behavioral flags.
  const flags = profile.behavioralFlags;
  flags.isFirstOrder = !cust.firstOrderCompleted && profile.signals.orderCount === 0;
  flags.isFoundingMember = !!cust.foundingMember;
  // GLP-1: explicit flag, legacy staff tag, OR the customer chose
  // "supporting glp-1" in the /onboarding survey (goals array).
  flags.isGLP1 = !!cust.isGLP1
    || (cust.preferences || []).includes('glp1')
    || onboarding.isGLP1;
  flags.isPostPartum = !!cust.isPostPartum;
  flags.isCutSeason = goalType === 'lose-weight';
  flags.isBuildSeason = goalType === 'build-muscle';
  // Churn risk: simple model — high if no order in 21+ days while
  // they were previously ordering weekly.
  const daysSinceLast = _daysAgo(lastOrderAt);
  if (profile.signals.weeklyAdherence > 0.5 && daysSinceLast > 21) {
    flags.churnRisk = Math.min(1, (daysSinceLast - 21) / 42);
  } else {
    flags.churnRisk = 0;
  }

  // 9. Stamp + write.
  profile.lastComputed = admin.firestore.FieldValue.serverTimestamp();
  profile.version = SCHEMA_VERSION;
  validateProfile({ ...profile, lastComputed: new Date() }); // validate a stamped copy

  await db.collection('customers').doc(uid).set({ profile }, { merge: true });
  return profile;
}

// ── Batch recompute (used by the nightly scheduled function) ────────
async function recomputeBatch(uids) {
  const results = [];
  // Sequential to keep memory bounded; if we ever need parallel,
  // p-limit at concurrency 5–10 is safe.
  for (const uid of uids) {
    try {
      const p = await recompute(uid);
      results.push({ uid, ok: true, hasProfile: !!p });
    } catch (e) {
      results.push({ uid, ok: false, error: String(e && e.message || e) });
    }
  }
  return results;
}

module.exports = {
  recompute,
  recomputeBatch,
  TASTE_WINDOW_DAYS,
  TIME_DECAY_HALF_LIFE_D,
};
