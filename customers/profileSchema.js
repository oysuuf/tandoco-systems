// ═════════════════════════════════════════════════════════════════════
// CustomerProfile — single unified document per customer.
//
// This is the canonical, derived view of a customer that every UI surface
// (store, homepage, account portal, checkout, weekly email) reads from
// when it needs to personalize. It is NEVER written by client code —
// only by the `computeCustomerProfile` Cloud Function. Source-of-truth
// data lives in:
//   • customers/{uid}.preferences              (explicit prefs)
//   • customers/{uid}.tastePreferences         (explicit prefs, rich)
//   • customers/{uid}.dietaryConstraints       (explicit prefs)
//   • customers/{uid}.goal                     (lose / build / maintain)
//   • customers/{uid}/bodyMetrics/{weekStart}  (wearable rollups)
//   • customers/{uid}/events/{eventId}         (signal log)
//   • orders/* where uid matches               (order history)
//   • reviews/* where uid matches              (ratings)
//
// Path:  customers/{uid}.profile  (subfield on the customer doc)
//
// Versioning: bump SCHEMA_VERSION whenever the shape changes. The compute
// function always writes the current version; readers should tolerate
// older versions (additive changes only).
// ═════════════════════════════════════════════════════════════════════

const SCHEMA_VERSION = 1;

// ── 6-state classifier output (see stateClassifier.js) ─────────────
// Every customer is in exactly one current state, computed from their
// last 7d of wearable + body metrics. Surfaces read this single value
// to know how to tilt recommendations *today*.
const CURRENT_STATES = [
  'baseline',              // nothing notable; default
  'training-hard',         // high training load, push protein up
  'recovery',              // low HRV or poor sleep, anti-inflammatory tilt
  'sleep-debt',            // chronic short sleep, emphasize breakfast + magnesium
  'high-load-week',        // sustained high TL, calorie-dense bias
  'recovery-trending-up',  // HRV recovering, reinforce pattern
  'cut-mode',              // weight-loss goal active; high protein-per-kcal
];

// ── Default profile for new / data-sparse customers ────────────────
// Returned by buildEmptyProfile() and used as the base object that
// derivation logic mutates. Every field always exists so readers
// never need to defensive-check.
function buildEmptyProfile() {
  return {
    lastComputed: null,
    version: SCHEMA_VERSION,

    // Explicit preferences (mirrored from the customer doc for fast read)
    tastePreferences: {
      cuisines: [],          // ['mediterranean','asian','mexican','american','indian',...]
      proteins: [],          // ['chicken','beef','fish','plant','egg','dairy']
      flavorProfile: [],     // ['savory','spicy','sweet','umami','smoky','fresh']
      spiceTolerance: 2,     // 0–5
      sweetnessAppetite: 2,  // 0–5
    },
    dietaryConstraints: {
      allergens: [],         // ['nuts','dairy','gluten','eggs','soy','shellfish']
      avoidances: [],        // ['pork','beef','alcohol','red-meat','seed-oils-pref']
      dietPattern: 'omnivore', // 'omnivore'|'vegetarian'|'vegan'|'pescatarian'|'halal'|'keto'|'paleo'
    },

    // Goals (mirrored from customers/{uid}.goal)
    goalType: null,          // 'lose-weight'|'build-muscle'|'maintain'|'custom'|null
    nutritionTargets: {
      proteinFloor: null,    // grams/day
      calorieRange: null,    // [min, max] kcal/day
      fiberFloor: null,      // grams/day
    },

    // Computed from order + rating history (with time decay)
    signals: {
      topMealIds: [],            // [{id, score}] — most-loved meals
      avoidMealIds: [],          // [{id, score}] — disliked / repeatedly skipped
      topCuisines: [],           // [{name, score}] — inferred from order history
      topProteins: [],           // [{name, score}]
      explorationAppetite: 0.3,  // 0–1: how often they try new items
      weeklyAdherence: 0,        // 0–1: fraction of weeks ordered in last 12
      orderCount: 0,             // lifetime
      lastOrderAt: null,         // timestamp
    },

    // Wearable-derived (only populated when bodyMetrics exists)
    currentState: 'baseline',
    wearableContext: {
      hasWearable: false,
      providers: [],             // ['fitbit','strava'] — wearable providers
      avgSleep7d: null,          // 0–100 score (Fitbit/Oura sleepRecovery)
      hrvTrend: 'unknown',       // 'up'|'down'|'flat'|'unknown'
      trainingLoad7d: 'unknown', // 'high'|'med'|'low'|'unknown'
      weightTrend14d: 'unknown', // 'up'|'down'|'flat'|'unknown'
      lastSyncedAt: null,
      // Signal block — independent boolean signals + facts the
      // explainer uses for specific phrasing ("HRV down 13%",
      // "sleep averaging 64/100"). Always present so consumers
      // can read facts.hrvDeltaPct without null-guards.
      signals: {
        hrvLow: false,
        sleepLow: false,
        heavyTraining: false,
        weightWrong: false,
        facts: {},
      },
    },

    // Behavioral flags (computed from order patterns + customer doc)
    behavioralFlags: {
      isFirstOrder: true,        // hasn't completed a paid order yet
      isFoundingMember: false,
      churnRisk: 0,              // 0–1
      isGLP1: false,             // self-reported or inferred from prefs
      isPostPartum: false,
      isCutSeason: false,        // active cut goal
      isBuildSeason: false,
    },
  };
}

// ── Validator ──────────────────────────────────────────────────────
// Cheap sanity check before write. Throws on missing required fields.
// Use as the last step of computeCustomerProfile() so we never write
// a malformed profile.
function validateProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('profile must be an object');
  }
  if (profile.version !== SCHEMA_VERSION) {
    throw new Error(`profile.version mismatch: got ${profile.version}, expected ${SCHEMA_VERSION}`);
  }
  if (!CURRENT_STATES.includes(profile.currentState)) {
    throw new Error(`profile.currentState invalid: ${profile.currentState}`);
  }
  for (const key of ['tastePreferences','dietaryConstraints','signals','wearableContext','behavioralFlags','nutritionTargets']) {
    if (!profile[key] || typeof profile[key] !== 'object') {
      throw new Error(`profile.${key} must be an object`);
    }
  }
  return true;
}

// ── Mirrors the legacy preferences string-array into the rich shape ──
// During the transition, customers still have the old
// customers/{uid}.preferences = ['gluten-free','high-protein',...]
// array. This helper maps those legacy tags into the new
// tastePreferences / dietaryConstraints shape so the profile is
// useful from day one without forcing a re-onboarding.
const LEGACY_PREF_MAP = {
  'gluten-free':   { dietaryConstraints: { allergens: ['gluten'] } },
  'nut-allergy':   { dietaryConstraints: { allergens: ['nuts'] } },
  'dairy-free':    { dietaryConstraints: { allergens: ['dairy'] } },
  'vegetarian':    { dietaryConstraints: { dietPattern: 'vegetarian' } },
  'vegan':         { dietaryConstraints: { dietPattern: 'vegan' } },
  'halal':         { dietaryConstraints: { dietPattern: 'halal' } },
  'high-protein':  { /* goal-flavored; handled via goalType */ },
  'low-carb':      { /* goal-flavored; handled via goalType */ },
  'loves-bakery':  { /* signal-flavored; handled via signals */ },
};

function applyLegacyPreferences(profile, legacyArr) {
  if (!Array.isArray(legacyArr)) return profile;
  for (const tag of legacyArr) {
    const m = LEGACY_PREF_MAP[tag];
    if (!m) continue;
    if (m.dietaryConstraints) {
      if (m.dietaryConstraints.allergens) {
        for (const a of m.dietaryConstraints.allergens) {
          if (!profile.dietaryConstraints.allergens.includes(a)) {
            profile.dietaryConstraints.allergens.push(a);
          }
        }
      }
      if (m.dietaryConstraints.dietPattern) {
        profile.dietaryConstraints.dietPattern = m.dietaryConstraints.dietPattern;
      }
    }
  }
  return profile;
}

// ─────────────────────────────────────────────────────────────────────
// Customer-facing onboarding survey at /onboarding.html writes to
// customers/{uid}.dietaryPreferences + customers/{uid}.goals. This
// is the RICHEST source of explicit signal in the system. We fold
// those fields into the profile shape here.
//
// Shape produced by /onboarding (see persistOnboarding in onboarding.html):
//   customers/{uid} {
//     goals: ['lose-weight','build-muscle','hit-macros',
//             'eat-cleaner','save-time','glp1','just-curious'],
//     dietaryPreferences: {
//       diet:                ['high-protein','low-carb','vegetarian',
//                              'pescatarian','gluten-free','dairy-free',
//                              'halal','low-calorie'],
//       avoid:               ['peanut','tree-nut','dairy','eggs','soy',
//                              'gluten','fish','shellfish'],
//       cuisines:            ['mexican','mediterranean','asian','indian',
//                              'italian','american','middle-eastern'],
//       proteinTarget:       N,  // PER-MEAL grams
//       calorieTarget:       N,  // PER-MEAL kcal
//       excludedIngredients: [...]
//     }
//   }
// ─────────────────────────────────────────────────────────────────────

// `dietaryPreferences.diet` mixes two semantically distinct concepts —
// constraint tags (vegetarian, pescatarian, halal, gluten-free, dairy-free)
// and aspirational tags (high-protein, low-carb, low-calorie). The
// constraints map to dietary fields; the aspirations get absorbed into
// the goal logic below.
const ONBOARDING_DIET_MAP = {
  'gluten-free':   { allergens: ['gluten'] },
  'dairy-free':    { allergens: ['dairy'] },
  'vegetarian':    { dietPattern: 'vegetarian' },
  'pescatarian':   { dietPattern: 'pescatarian' },
  'halal':         { dietPattern: 'halal' },
  // 'high-protein','low-carb','low-calorie' are goal-flavored, not constraints
};

// Allergens captured under `dietaryPreferences.avoid`. Two tree/peanut
// variants both map to the broad 'nuts' allergen tag that the engine
// uses for filtering — we keep the original tag too for surface display.
const ONBOARDING_AVOID_MAP = {
  'peanut':    'nuts',
  'tree-nut':  'nuts',
  'dairy':     'dairy',
  'eggs':      'eggs',
  'soy':       'soy',
  'gluten':    'gluten',
  'fish':      'fish',
  'shellfish': 'shellfish',
};

// Goal array → single goalType. A customer can pick multiple goals;
// we collapse to the strongest signal. GLP-1 users are also weight-loss
// users (sets isGLP1 flag downstream in computeCustomerProfile).
function _pickGoalType(goalsArr) {
  if (!Array.isArray(goalsArr) || !goalsArr.length) return null;
  const set = new Set(goalsArr);
  if (set.has('glp1')) return 'lose-weight';
  if (set.has('lose-weight')) return 'lose-weight';
  if (set.has('build-muscle')) return 'build-muscle';
  if (set.has('hit-macros') || set.has('eat-cleaner') || set.has('save-time')) return 'maintain';
  return null; // 'just-curious' or unknown → no goal tilt
}

/**
 * Fold the /onboarding survey shape into the profile.
 *
 * @param {Object} profile      — mutable, mutated in place
 * @param {Object} cust         — the raw customers/{uid} doc
 * @returns {{goalType: string|null, isGLP1: boolean, hasOnboarding: boolean}}
 */
function applyOnboardingPreferences(profile, cust) {
  const dp = (cust && cust.dietaryPreferences) || {};
  const goals = (cust && cust.goals) || [];
  const hasOnboarding =
    !!(cust && cust.onboarding && (cust.onboarding.completed || cust.onboarding.skipped)) ||
    !!(dp.diet || dp.avoid || dp.cuisines || dp.excludedIngredients);

  // 1. Diet tags → constraints (allergens / pattern).
  if (Array.isArray(dp.diet)) {
    for (const tag of dp.diet) {
      const m = ONBOARDING_DIET_MAP[tag];
      if (!m) continue;
      if (m.allergens) {
        for (const a of m.allergens) {
          if (!profile.dietaryConstraints.allergens.includes(a)) {
            profile.dietaryConstraints.allergens.push(a);
          }
        }
      }
      if (m.dietPattern) profile.dietaryConstraints.dietPattern = m.dietPattern;
    }
  }

  // 2. Allergen "avoid" → allergens (hard rule).
  if (Array.isArray(dp.avoid)) {
    for (const tag of dp.avoid) {
      const a = ONBOARDING_AVOID_MAP[tag] || tag;
      if (!profile.dietaryConstraints.allergens.includes(a)) {
        profile.dietaryConstraints.allergens.push(a);
      }
    }
  }

  // 3. Excluded ingredients → avoidances (also hard rule, but softer than
  // allergens — these are free-text user input, e.g. "cilantro", "mushrooms").
  if (Array.isArray(dp.excludedIngredients)) {
    for (const ex of dp.excludedIngredients) {
      const norm = String(ex).toLowerCase().trim();
      if (norm && !profile.dietaryConstraints.avoidances.includes(norm)) {
        profile.dietaryConstraints.avoidances.push(norm);
      }
    }
  }

  // 4. Cuisines (explicit) — wins over inferred topCuisines for taste fit.
  if (Array.isArray(dp.cuisines) && dp.cuisines.length) {
    for (const c of dp.cuisines) {
      const norm = String(c).toLowerCase().trim();
      if (norm && norm !== 'surprise' && !profile.tastePreferences.cuisines.includes(norm)) {
        profile.tastePreferences.cuisines.push(norm);
      }
    }
  }

  // 5. Per-meal protein/calorie targets → daily nutrition targets.
  //    We assume ~3 tandoco-equivalent meals/day. Customers can override
  //    via customers/{uid}.nutritionTargets if they want exact daily values.
  if (typeof dp.proteinTarget === 'number' && dp.proteinTarget > 0) {
    profile.nutritionTargets.proteinFloor = Math.round(dp.proteinTarget * 3);
  }
  if (typeof dp.calorieTarget === 'number' && dp.calorieTarget > 0) {
    const daily = dp.calorieTarget * 3;
    profile.nutritionTargets.calorieRange = [
      Math.round(daily * 0.9),
      Math.round(daily * 1.1),
    ];
  }

  // 6. Goal → goalType (overrides any inferred goal).
  const goalType = _pickGoalType(goals);
  const isGLP1 = Array.isArray(goals) && goals.indexOf('glp1') !== -1;
  return { goalType, isGLP1, hasOnboarding };
}

module.exports = {
  SCHEMA_VERSION,
  CURRENT_STATES,
  buildEmptyProfile,
  validateProfile,
  applyLegacyPreferences,
  applyOnboardingPreferences,
};
