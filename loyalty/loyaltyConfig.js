// ═════════════════════════════════════════════════════════════════════
// Loyalty config loader — settings/loyaltyConfig.
//
// Single source of truth for v2 TandoCoins dials (earn paths, tier
// system, referral payouts). The admin editor at
// /hq2#/commerce/loyalty (scripts/hq2.js) writes to the same doc.
//
// If the doc doesn't exist (pre-first-save), falls back to
// LIVE_DEFAULTS — values that mirror today's pre-config baseline so
// deploying the wiring alone changes no behavior. An admin SAVE in
// the editor is the explicit opt-in to tune anything away from
// baseline.
//
// 60s TTL in-memory cache. Cheap on the hot path; staleness bounded
// by the TTL. Webhook latency dominates any cache miss anyway. Same
// pattern as loadRewardCatalog in calculateQuote.js.
// ═════════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
const db = admin.firestore();

// LIVE_DEFAULTS mirrors today's hardcoded values so a missing
// Firestore doc preserves current behavior. KEEP IN SYNC with
// DEFAULT_LOYALTY_CONFIG in scripts/hq2.js — the editor paints from
// that constant on a fresh doc; if the two drift, "click save without
// changing anything" would unexpectedly alter the program.
const LIVE_DEFAULTS = Object.freeze({
  signupBonus:              100,
  // v3 earn model — flat coins per QUALIFYING order. A subscription week is
  // one weekly charge = one order, so this is effectively "per active week"
  // for subscribers, and "per one-time order" for one-offs. Orders below
  // minEarnOrderCents earn nothing (farm guard). perOrderCoinsPerDollar is
  // the retired v2 per-dollar rate — kept ONLY so an old saved config doc /
  // the HQ form field still merges cleanly; the earn path no longer reads it.
  perOrderCoins:             50,
  minEarnOrderCents:        500,
  perOrderCoinsPerDollar:     1,
  firstSubscriptionBonus:   500,
  renewalStreakWeeklyBonus:  50,
  renewalStreakStartWeek:     5,
  birthdayBonus:            150,
  // v3 tiers are reached by ACTIVE SUBSCRIPTION TENURE (weeks), not spend.
  // thresholdWeeks is the live basis; thresholdCents is retained (old values)
  // purely as the legacy fallback for customers who don't have a tenure count
  // yet. Tiers never gate a reward (PR 1) — they only set earnMultiplier.
  tiers: [
    { id: 'newbie',      name: 'Newbie',      thresholdWeeks:  0, thresholdCents:      0, earnMultiplier: 1.0,  tierUpBonus:   0 },
    { id: 'foodie',      name: 'Foodie',      thresholdWeeks:  8, thresholdCents:  50000, earnMultiplier: 1.25, tierUpBonus: 100 },
    { id: 'connoisseur', name: 'Connoisseur', thresholdWeeks: 26, thresholdCents: 200000, earnMultiplier: 1.5,  tierUpBonus: 300 },
  ],
  referrerPayout:           500,
  freeMealMinEntreeCount:     3,
  referrerMustBeCustomer:  true,
});

const CACHE_TTL_MS = 60 * 1000;
let _cache = { at: 0, data: null };

// Read settings/loyaltyConfig with a 60s TTL cache. Returns
// LIVE_DEFAULTS on first call when the doc doesn't exist, or on a
// transient Firestore read failure (we'd rather pay defaults than
// throw inside the webhook).
async function loadLoyaltyConfig() {
  if (Date.now() - _cache.at < CACHE_TTL_MS && _cache.data) {
    return _cache.data;
  }
  let data = LIVE_DEFAULTS;
  try {
    const snap = await db.collection('settings').doc('loyaltyConfig').get();
    if (snap.exists) {
      const saved = snap.data() || {};
      // Merge over LIVE_DEFAULTS so a partial doc (missing a newer
      // field) still has every key populated. Tiers are replaced
      // wholesale when the saved doc carries them.
      data = Object.assign({}, LIVE_DEFAULTS, saved);
      if (Array.isArray(saved.tiers) && saved.tiers.length) {
        data.tiers = saved.tiers;
      }
    }
  } catch (e) {
    // Don't burn the cache slot on a read failure — next call retries.
    console.warn('[loyaltyConfig] read failed, using LIVE_DEFAULTS:', e && e.message);
    return LIVE_DEFAULTS;
  }
  _cache = { at: Date.now(), data };
  return data;
}

// Tier lookup helpers. All take the loaded config as the first arg so
// callers avoid double-loading in a tight transaction. Pure functions.

function tandocoinTierById(cfg, id) {
  const tiers = (cfg && cfg.tiers) || LIVE_DEFAULTS.tiers;
  for (let i = 0; i < tiers.length; i++) {
    if (tiers[i].id === id) return tiers[i];
  }
  return tiers[0];
}

// Tier for a given lifetime spend (cents). Walks the table top-down
// so a future 4th tier slots in by appending to the array.
function tandocoinTierForSpend(cfg, lifetimeSpendCents) {
  const tiers = (cfg && cfg.tiers) || LIVE_DEFAULTS.tiers;
  const spend = Math.max(0, Number(lifetimeSpendCents) || 0);
  let pick = tiers[0];
  for (let i = 0; i < tiers.length; i++) {
    if (spend >= Number(tiers[i].thresholdCents)) pick = tiers[i];
  }
  return pick;
}

// Tier for a given active-tenure week count. Walks the table top-down so a
// future 4th tier slots in by appending to the array. This is the v3 basis.
function tandocoinTierForTenure(cfg, tenureWeeks) {
  const tiers = (cfg && cfg.tiers) || LIVE_DEFAULTS.tiers;
  const weeks = Math.max(0, Number(tenureWeeks) || 0);
  let pick = tiers[0];
  for (let i = 0; i < tiers.length; i++) {
    // Default a missing thresholdWeeks to 0 so a partial/legacy tier row
    // (thresholdCents only) doesn't throw — it just never out-ranks newbie.
    if (weeks >= Number(tiers[i].thresholdWeeks || 0)) pick = tiers[i];
  }
  return pick;
}

// Tier for a customer doc. v3: PREFERS active-subscription tenure
// (tandocoinTenureWeeks). Falls back to the legacy v2 lifetime-spend signal,
// then to legacy orderCount thresholds, so customers without a tenure count
// yet don't appear to "demote" during the transition window.
function tandocoinTierForCustomer(cfg, custData) {
  const tiers = (cfg && cfg.tiers) || LIVE_DEFAULTS.tiers;
  if (!custData) return tiers[0];
  // v3 tenure basis, in priority order:
  //  1. explicit tandocoinTenureWeeks (if a future job writes it), else
  //  2. derived.streakWeeks — consecutive active (non-paused) weeks, already
  //     maintained in customer-derived.js; pauses are skipped and a real gap
  //     resets it, which matches "tenure freezes on pause / drops on lapse".
  if (typeof custData.tandocoinTenureWeeks === 'number' && custData.tandocoinTenureWeeks >= 0) {
    return tandocoinTierForTenure(cfg, custData.tandocoinTenureWeeks);
  }
  const streak = custData.derived && Number(custData.derived.streakWeeks);
  if (Number.isFinite(streak) && streak >= 0) {
    return tandocoinTierForTenure(cfg, streak);
  }
  if (typeof custData.lifetimeSpendCents === 'number' && custData.lifetimeSpendCents >= 0) {
    return tandocoinTierForSpend(cfg, custData.lifetimeSpendCents);
  }
  const oc = Number(custData.orderCount) || 0;
  if (oc >= 25) return tandocoinTierById(cfg, 'connoisseur');
  if (oc >= 10) return tandocoinTierById(cfg, 'foodie');
  return tandocoinTierById(cfg, 'newbie');
}

// Test-only — clears the cache between tests so each call hits Firestore.
function _resetCacheForTests() { _cache = { at: 0, data: null }; }

module.exports = {
  loadLoyaltyConfig,
  tandocoinTierById,
  tandocoinTierForSpend,
  tandocoinTierForTenure,
  tandocoinTierForCustomer,
  LIVE_DEFAULTS,
  _resetCacheForTests,
};
