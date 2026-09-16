// ═════════════════════════════════════════════════════════════════════
// Server-side pricing: calculateQuote + Stripe Tax.
// Extracted verbatim from functions/index.js. No logic changes.
// ═════════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
const { resolveProductTier, inferQtyFromTierKey } = require('./tierLadders');
const { loadPlanTiers, tierForItem, tierById, perMealPrice: tierPerMealPrice } = require('./planTiers');
const volumeRamp = require('./volumeRamp');
const { computeSwapAmount } = require('./swapMath');
// The ONE definition of "may this customer spend coins" — read the rule (and
// why a booth purchase counts) in that file before changing Guard ① below.
const { coinsRedeemable } = require('../loyalty/coinsUnlocked');
const { evaluateCouponDiscount, missingFreeItemIds, packMismatchOnly, couponMinSubtotal,
        COUPON_POST_FOOD_FLOOR, couponBreachesFoodFloor } = require('./couponDiscount');

// ── ONE-TIME (NON-SUBSCRIBER) MARKUP ──────────────────────────────────
// Subscribers pay the volume-ramp price; one-time buyers pay a markup on
// top. The percentage and scope are set in HQ2 · Pricing · Meals
// (subscriptionConfig.oneTimeMarkupPct / oneTimeMarkupScope). These
// helpers are MIRRORED BYTE-FOR-BYTE on the client in scripts/cart-pricing.js
// (_otMarkup*). The displayed price (client) and the charged price (here)
// must agree or createPaymentIntent's price-match guard rejects the order.
// A missing config field resolves to the SAME default on both runtimes
// (ON at 10%, scope 'mealsExtras'), so the markup is live the moment this
// deploys, before HQ2 is ever opened.
function _otMarkupPct(cfg) {
  const v = cfg && cfg.oneTimeMarkupPct;
  return (v != null && isFinite(v)) ? Number(v) : 10;
}
function _otMarkupFactor(cfg) { return 1 + _otMarkupPct(cfg) / 100; }
function _otMarkupScope(cfg) {
  const s = cfg && cfg.oneTimeMarkupScope;
  return s === 'meals' ? 'meals' : 'mealsExtras';
}
function _otRound2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
// Entrée (meal) vs "extra" (baked/product). Single-try promos and
// subscriber (weekly/monthly) lines never get the markup. Bundles never
// reach calculateQuote.
//   IMPORTANT: the cart items _v2ToQuoteItems hands us do NOT tag meals with
//   type:'meal' — the meal branch omits `type`, and calculateQuote itself
//   identifies an entrée as "not baked/product" (see `isBaked`). Testing
//   `type === 'meal'` here therefore never matched a real meal, so with the
//   scope set to "meals only" (oneTimeMarkupScope:'meals') the entrée markup
//   silently did nothing — the customer paid the subscriber rate on one-time
//   orders. Detect the entrée the same way the pricing loop does instead.
function _otMarkupApplies(item, billingType, scope) {
  if (billingType !== 'onetime') return false;
  if (item.isSingleTry) return false;
  if (item.type === 'bundle') return false;
  const isExtra = (item.type === 'baked' || item.type === 'product');
  if (!isExtra) return true;                      // entrées: every scope
  return scope === 'mealsExtras';                 // extras: only this scope
}
const { liveStripe } = require('../lib/stripeClient');
const { loadLoyaltyConfig } = require('../lib/loyaltyConfig');

const db = admin.firestore();
// Module-level `const stripe = Stripe(process.env.STRIPE_SK)` removed
// May 2026 — see CLAUDE.md "Per-function `secrets:` override vs
// module-level `Stripe()` const collision". The live client is now
// lazily constructed by liveStripe() and passed through the
// stripeOverride parameter chain to buildTaxCalculation.

// ── REWARD CATALOG CACHE ──
// settings/rewardCatalog is read on every quote; cache for 60s so the
// hot path doesn't pay a Firestore read per request. HQ saves bump
// version, but we don't watch — staleness is bounded by the TTL.
let _rewardCatalogCache = { at: 0, data: null };
async function loadRewardCatalog() {
  if (Date.now() - _rewardCatalogCache.at < 60000 && _rewardCatalogCache.data) {
    return _rewardCatalogCache.data;
  }
  const snap = await db.collection('settings').doc('rewardCatalog').get();
  const data = snap.exists ? snap.data() : { rewards: {}, version: 0 };
  _rewardCatalogCache = { at: Date.now(), data };
  return data;
}

// ── RECIPE PRICING META ──
// Loads premiumMeal + menuPrice for every recipeId in the cart. Used to
// authoritatively pick the per-meal anchor when computing tier pricing —
// salmon ($14.50, premiumMeal=true) needs to anchor on $14.50, not the
// $11.50 basePrice. Reading from /recipes here (not trusting the cart's
// own fields) prevents a forged client payload from quoting a premium
// meal at the base rate. Empty input returns {} immediately.
async function _loadRecipePricingMeta(ids) {
  if (!Array.isArray(ids) || !ids.length) return {};
  const docs = await Promise.all(ids.map(id =>
    db.collection('recipes').doc(id).get().catch(() => null)
  ));
  const map = Object.create(null);
  docs.forEach(d => {
    if (!d || !d.exists) return;
    const data = d.data() || {};
    map[d.id] = {
      premiumMeal: !!data.premiumMeal,
      menuPrice:   Number(data.menuPrice) || 0,
      // Authoritative reward tags — written onto the recipe by HQ's
      // "rebuild all". Cart items don't carry these, so the redemption
      // matcher reads them from here (never from the cart payload, so a
      // forged cart can't claim a tag the recipe doesn't actually have).
      rewardTags: Array.isArray(data.rewardTags) ? data.rewardTags : null,
      rewardTag:  (typeof data.rewardTag === 'string' && data.rewardTag) ? data.rewardTag : null,
      // Authoritative per-tag pack-size allowlist (HQ → Recipe Eligibility).
      // Shape: { '<rewardTag>': ['<tierKey>', ...] }. Absent/empty = every
      // pack size of this recipe qualifies for that reward.
      rewardTagPackTiers: (data.rewardTagPackTiers && typeof data.rewardTagPackTiers === 'object') ? data.rewardTagPackTiers : null,
    };
  });
  return map;
}

function _tierRankFromOrderCount(n) {
  return n >= 25 ? 2 : n >= 10 ? 1 : 0;
}
function _tierRankFromName(name) {
  return name === 'connoisseur' ? 2 : name === 'foodie' ? 1 : 0;
}
// v2 legacy: tier rank from lifetime spend (cents). $500 → foodie,
// $2000 → connoisseur. RETAINED only for the redemption-preview
// signature; v3 catalog has no tier-gated rewards (see _applyRedemption),
// so the rank computed here is never compared against a requiredRank.
// Safe to delete once every legacy caller is verified gone.
function _tierRankFromSpendCents(cents) {
  const c = Number(cents) || 0;
  return c >= 200000 ? 2 : c >= 50000 ? 1 : 0;
}

// Match a cart line against a reward's `effect.tag` (v2 tag-driven free
// items). The menu item (recipe/product doc) carries `rewardTag` (string)
// or `rewardTags` (array). _sourceItem is the raw doc, so a forged cart
// can't claim a tag the menu item doesn't actually have.
function _itemMatchesTag(item, lineItem, tag) {
  if (!tag || !item) return false;
  const t = String(tag).toLowerCase();
  const single = item.rewardTag != null ? [item.rewardTag] : [];
  const many = Array.isArray(item.rewardTags) ? item.rewardTags : [];
  const tagged = single.concat(many).some(x => String(x || '').toLowerCase() === t);
  if (!tagged) return false;
  // Pack-size restriction (optional). When the authoritative recipe limits
  // this tag to specific pack tiers (HQ → Recipe Eligibility → "which pack
  // sizes count"), the cart line's chosen pack must be on the allowlist.
  // Absent/empty list = every pack size qualifies (back-compat default).
  const ptMap = item.rewardTagPackTiers;
  if (ptMap && typeof ptMap === 'object') {
    const allow = ptMap[t] || ptMap[String(tag)];
    if (Array.isArray(allow) && allow.length) {
      const wantKey = String(item.tierKey || '').trim();
      const wantQty = String(parseInt(item.packQty) || '').trim();
      const ok = allow.some(p => {
        const s = String(p == null ? '' : p).trim();
        return s !== '' && (s === wantKey || s === wantQty);
      });
      if (!ok) return false;
    }
  }
  return true;
}

// Match a cart line against a reward's `effect.category`. Items carry
// shape variation across the codebase — meal items have `plan`, baked
// items have `type === 'baked'`. The category match accepts any of the
// common shape fields so HQ can extend the catalog without a code
// deploy as long as the cart item exposes the category somewhere.
function _itemMatchesCategory(item, lineItem, category) {
  const cat = String(category || '').toLowerCase();
  if (!cat) return false;
  // Synthetic categories — match by the cart item's structural type.
  if (cat === 'sauce') {
    const tag = String(item.menuCategory || item.category || item.mealType || '').toLowerCase();
    return tag === 'sauce' || tag === 'sauces' || /sauce|topping|condiment/.test(tag);
  }
  if (cat === 'bakery') {
    const tag = String(item.menuCategory || item.category || item.type || '').toLowerCase();
    return tag === 'bakery' || tag === 'baked' || tag === 'product';
  }
  if (cat === 'meals') {
    return !(item.type === 'baked' || item.type === 'product');
  }
  // Pass-through string match (e.g. 'smoothie', 'merch').
  const tag = String(item.menuCategory || item.category || item.mealType || '').toLowerCase();
  return tag === cat;
}

// Resolve the dollar amount for a `meal_credit` effect. The credit
// is denominated in dollars (not coins) and represents the value of
// one 5-meal week. Source today is the standard 5-meal tier's
// weeklyPrice from planTiers; falls back to subscriptionConfig.
function _resolveMealCreditAmount(planTiers, cfg) {
  if (Array.isArray(planTiers) && planTiers.length) {
    const five = planTiers.find(t => Number(t.mealsPerWeek) === 5);
    if (five && Number.isFinite(+five.weeklyPrice)) return +five.weeklyPrice;
  }
  const explicit = Number(cfg && cfg.fiveMealWeeklyPrice);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return 0;
}

// ── BUNDLE DEALS (mise → Store Layout → deals) ──────────────────────
// settings/storeDeals { deals: [{id, enabled, name, offCents,
// maxPerOrder, items: [{recipeId, qty}]}] }. A deal applies when the
// cart holds EVERY criteria item at >= its qty (matched on the cart
// line's recipeId/id, LINE quantities — a bakery pack line counts as
// its line qty, not the units inside). Discount = offCents × the number
// of complete bundles (capped by maxPerOrder, default 1).
//
// Pure + shared: calculateQuote (the authoritative charge) and
// getTaxQuoteV2Live (the cart/checkout preview) both call THIS so the
// preview never disagrees with the charge. Deals are merchandising —
// they apply before coupons/rewards and on every renewal while enabled.
function evaluateStoreDeals(items, dealsDocData) {
  const out = {discounts: [], totalOffCents: 0};
  const deals = dealsDocData && Array.isArray(dealsDocData.deals) ? dealsDocData.deals : [];
  if (!deals.length || !Array.isArray(items) || !items.length) return out;
  // Cart quantity per recipe id (line qty summed across lines).
  const qtyById = Object.create(null);
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const rid = it.recipeId || it.id;
    if (!rid) continue;
    qtyById[rid] = (qtyById[rid] || 0) + (parseInt(it.qty, 10) || 0);
  }
  for (const deal of deals) {
    if (!deal || deal.enabled !== true) continue;
    const offCents = Math.round(Number(deal.offCents) || 0);
    const criteria = Array.isArray(deal.items) ? deal.items.filter(c => c && (c.recipeId || c.id)) : [];
    if (offCents <= 0 || !criteria.length) continue;
    // Complete bundles = the binding criterion across all required items.
    let multiples = Infinity;
    for (const c of criteria) {
      const need = Math.max(1, parseInt(c.qty, 10) || 1);
      const have = qtyById[c.recipeId || c.id] || 0;
      multiples = Math.min(multiples, Math.floor(have / need));
    }
    if (!Number.isFinite(multiples) || multiples <= 0) continue;
    const cap = Math.max(1, parseInt(deal.maxPerOrder, 10) || 1);
    multiples = Math.min(multiples, cap);
    const amountCents = offCents * multiples;
    const name = String(deal.name || deal.id || 'bundle deal');
    out.discounts.push({
      id: String(deal.id || name),
      name,
      amountCents,
      multiples,
      label: `${name} — $${(amountCents / 100).toFixed(2)} off`,
    });
    out.totalOffCents += amountCents;
  }
  return out;
}

// Resolve a redemption against the catalog and apply it to the running
// subtotal. Returns { subtotal, breakdown } — breakdown is null if the
// redemption was rejected (missing reward, tier-locked, insufficient
// balance, no eligible cart line, etc.). Pure function; webhook resolves
// cost identically off the same catalog so the ledger never trusts the
// metadata for cost.
function _applyRedemption({
  rewardId, catalog, lineItems, subtotal, coinBalance, tierRank,
  firstOrderCompleted, hasSubscriptionLine, freeItemSku, planTiers, cfg,
  // Proof of a paid MARKET-BOOTH purchase (customers/{uid}.coinsUnlocked,
  // set by marketEarn). Read alongside firstOrderCompleted by Guard ① below.
  // Defaults false so a caller that doesn't pass it behaves exactly as before.
  coinsUnlocked = false,
  // Multi-redemption support: a map of {lineIndex -> unitsAlreadyZeroed}
  // accumulated across earlier redemptions in the SAME order, so a second
  // "meal's on us" can't re-zero a unit a first one already covered. The
  // returned breakdown.consumed reports which units THIS redemption took
  // so the caller can fold them back into the map before the next pass.
  consumedUnits = {},
  // The $10 min-order floor is a property of the WHOLE cart, evaluated once
  // before ANY reward is applied. Callers stacking multiple redemptions must
  // pass the pre-redemption subtotal here, otherwise a first free-item reward
  // that shrinks the running `subtotal` below the floor would wrongly block a
  // later reward in the same order. Defaults to the running `subtotal` for
  // legacy single-redemption callers (no behavior change for them).
  minOrderSubtotal = null,
}) {
  // Failures carry a structured `reason` (+ optional `detail`) so the cart
  // can surface it ("add $X more to use this reward") instead of silently
  // dropping the redemption.
  const fail = (reason, detail) => ({ subtotal, breakdown: null, reason: reason || 'rejected', detail: detail || null });

  if (!rewardId || !catalog || !catalog.rewards) return fail('no_reward');
  const reward = catalog.rewards[rewardId];
  if (!reward || reward.enabled === false) return fail('unknown_reward');
  // Guard ① — coins are display-only until the customer has actually PAID us,
  // on the website (firstOrderCompleted) OR at a market booth (coinsUnlocked).
  // Either proves it; see src/loyalty/coinsUnlocked.js for the full rule and
  // why a booth purchase must NOT flip firstOrderCompleted instead.
  if (!coinsRedeemable({ firstOrderCompleted, coinsUnlocked })) return fail('coins_locked');
  const cost = Number(reward.cost) || 0;
  if (coinBalance < cost) return fail('insufficient_balance', { need: cost, have: coinBalance });
  // v3: NO tier gates — every reward is reachable by coins alone. Tiers only
  // speed earning (the multiplier), they never lock a reward. `tierRank` is
  // still accepted in the signature for compatibility but no longer gates.
  if (subtotal <= 0) return fail('empty_cart');

  const effect = reward.effect || {};

  // Per-reward cart minimum (PRE-reward, whole-cart basis). Only fires when a
  // reward explicitly sets effect.minSubtotal — e.g. a future cash-off like
  // "$10 off a $25 cart". The UNIVERSAL floor that stops a cart being comped
  // to nothing is now enforced AFTER the reward applies, against the running
  // food subtotal (see POST_REWARD_FOOD_FLOOR below) — that's what lets the
  // customer always pay at least $5 of food even when rewards are stacked.
  const minSub = Number(effect.minSubtotal) || 0;
  // Gate against the whole-cart basis (pre-redemption), not the running
  // subtotal — see minOrderSubtotal note above. Falls back to `subtotal`
  // when a caller doesn't supply a basis.
  const minBasis = (minOrderSubtotal == null) ? subtotal : minOrderSubtotal;
  if (minSub > 0 && minBasis < minSub) {
    return fail('min_order', { minSubtotal: minSub, short: Math.round((minSub - minBasis) * 100) / 100 });
  }

  let amount = 0;
  let freeItemRef = null;
  let consumedPicks = [];   // [{idx, take}] of line units this redemption zeroed (free_item only)
  if (effect.kind === 'cash_off') {
    // Min-order check hoisted above; just compute the discount.
    amount = Math.min(Number(effect.amount) || 0, subtotal);
  } else if (effect.kind === 'free_item') {
    // Tag-driven (v2): match the menu item's rewardTag and cover up to N
    // UNITS at unit price. effect.maxUnits sets N (default 1 — every
    // existing reward keeps its current one-unit behavior). When N > 1,
    // walk the eligible pool cheapest-first and zero N units across
    // however many lines that takes. A qty:N line counts as N units.
    // cap from effect.maxLineValue still applies as the TOTAL discount
    // ceiling (rare — only legacy rows set it).
    const tag = effect.tag ? String(effect.tag).toLowerCase() : '';
    const cap = Number(effect.maxLineValue) || Infinity;
    const wantedUnits = Math.max(1, parseInt(effect.maxUnits, 10) || 1);
    const _unitOf = (li) => {
      const q = Number(li && li.qty);
      const unit = Number(li && li.unitPrice);
      if (Number.isFinite(unit) && unit > 0) return unit;
      if (Number.isFinite(q) && q > 0 && Number.isFinite(li && li.lineTotal)) return li.lineTotal / q;
      return Number(li && li.lineTotal) || 0;
    };
    let candidates = lineItems
      .map((li, idx) => ({ li, idx, item: li._sourceItem || {}, unit: _unitOf(li) }))
      .filter(c => tag ? _itemMatchesTag(c.item, c.li, tag) : _itemMatchesCategory(c.item, c.li, effect.category));
    if (!candidates.length) return fail('no_eligible_item', { tag: tag || effect.category || null });
    // Cheapest UNIT wins — walked in order until we've taken N units.
    // A $3.15 bread × 2 ($6.30 line) beats a $5 scone × 1 ($5 line).
    candidates.sort((a, b) => a.unit - b.unit);
    // freeItemSku pinning: if the customer (or webhook) requested a
    // specific SKU, that line goes FIRST in the pick order. Remaining
    // units (if maxUnits > 1) fill from the cheapest-first list.
    if (freeItemSku) {
      const pinIdx = candidates.findIndex(c =>
        (c.li.id === freeItemSku) || ((c.item.recipeId || c.item.id) === freeItemSku)
      );
      if (pinIdx > 0) candidates.unshift(candidates.splice(pinIdx, 1)[0]);
    }
    const picks = [];
    let unitsRemaining = wantedUnits;
    for (const c of candidates) {
      if (unitsRemaining <= 0) break;
      const lineQty = Math.max(1, parseInt(c.li.qty, 10) || 1);
      // Subtract units already zeroed by an earlier redemption on this
      // same order so we never double-cover one physical unit.
      const alreadyTaken = Number(consumedUnits[c.idx]) || 0;
      const available = lineQty - alreadyTaken;
      if (available <= 0) continue;
      const take = Math.min(available, unitsRemaining);
      picks.push({ c, take });
      unitsRemaining -= take;
    }
    // Every eligible line was already fully consumed by prior redemptions —
    // there's nothing left for this one to cover.
    if (!picks.length) return fail('no_eligible_item', { tag: tag || effect.category || null, exhausted: true });
    const totalAmount = picks.reduce((s, p) => s + p.c.unit * p.take, 0);
    amount = Math.min(totalAmount, cap, subtotal);
    // back-compat: freeItemSku stays the first/pinned pick. freeItemSkus
    // is the new field carrying every SKU that got zeroed (per-unit).
    freeItemRef = picks[0] ? picks[0].c.li.id : null;
    // Report which line units this redemption took so the multi-redemption
    // loop can exclude them from the next pass.
    consumedPicks = picks.map(p => ({ idx: p.c.idx, take: p.take }));
  } else if (effect.kind === 'meal_credit') {
    // No-stack guard (v2): the free week can't ride on top of a
    // subscription-renewal week already in the cart.
    if (effect.noStackWithSub && hasSubscriptionLine) return fail('sub_conflict');
    const credit = _resolveMealCreditAmount(planTiers, cfg);
    if (credit <= 0) return fail('no_credit');
    // Apply only against meal-plan line totals; bakery still pays full.
    const mealsSubtotal = lineItems
      .filter(li => !(li._sourceItem && (li._sourceItem.type === 'baked' || li._sourceItem.type === 'product')))
      .reduce((s, li) => s + li.lineTotal, 0);
    if (mealsSubtotal <= 0) return fail('no_meals');
    amount = Math.min(credit, mealsSubtotal, subtotal);
  } else {
    return fail('unknown_effect');
  }

  if (amount <= 0) return fail('zero_amount');
  const rounded = Math.round(amount * 100) / 100;
  // Universal post-reward food floor: a redemption may not drop the running
  // food subtotal below $5. Checked on the RUNNING `subtotal` (which the
  // multi-redemption caller decrements per pass) so EACH stacked reward is
  // tested against what's left — the first reward(s) still apply, but once
  // only $5 of food remains, further rewards are turned away instead of
  // comping the order to $0. Delivery is excluded (subtotal is food-only).
  // On fail we return breakdown:null, so the caller never folds this pick's
  // consumed units in — the rejected reward leaves the cart untouched.
  // The floor dollar amount is operator-tunable in mise (HQ → Commerce →
  // TandoCoin Rewards), stored as catalog.postRewardFoodFloor. Missing/invalid
  // → $5 default; an explicit 0 disables the floor entirely.
  const _cfgFloor = Number(catalog && catalog.postRewardFoodFloor);
  const POST_REWARD_FOOD_FLOOR = (Number.isFinite(_cfgFloor) && _cfgFloor >= 0) ? _cfgFloor : 5;
  const foodAfter = Math.round((subtotal - rounded) * 100) / 100;
  if (POST_REWARD_FOOD_FLOOR > 0 && foodAfter < POST_REWARD_FOOD_FLOOR - 0.001) {
    return fail('food_floor', { floor: POST_REWARD_FOOD_FLOOR, remaining: foodAfter });
  }
  return {
    subtotal: subtotal - rounded,
    breakdown: {
      rewardId,
      cost,
      amount: rounded,
      kind: effect.kind,
      label: reward.label || rewardId,
      freeItemSku: freeItemRef,
      consumed: consumedPicks,   // line units zeroed; folded into consumedUnits by the caller
    },
  };
}

// ── SERVER-SIDE PRICE CALCULATION ──
// Best-price logic: active sale + plan discount — "best price wins" per item.
// (Founding-member, launch, and first-order discounts were all retired in 2026.)
//
// H5 fix: calculateServerTotal wrapper removed. All callers migrated to
// calculateQuote() directly during the I1/H8 refactor; the wrapper was
// only referenced by a stale comment.

// ── LEGACY→LADDER tier-key compat shim ──────────────────────────────
// During the ladder rollout, carts in localStorage may still carry the
// legacy { packQty: N } shape for products whose recipe doc has been
// migrated to { ladderId, priceOverrides }. Map packQty → tierKey so the
// old cart still checks out correctly. Covers the common pack counts
// used across active ladders. Anything else returns null and the ladder
// resolver will fall back to the first offered tier.
function _tierKeyFromLegacy(recipeData, item) {
  if (item && item.tierKey) return item.tierKey; // already new shape
  const n = parseInt(item && item.packQty);
  if (!n) return null;
  // Try the common numeric-pack tier keys in priority order.
  const candidates = [`${n}-pack`, `${n}-slices`, `${n}-meal`];
  const overrides = (recipeData && recipeData.priceOverrides) || {};
  for (const key of candidates) {
    if (overrides[key] != null) return key;
  }
  // Handful of known legacy qty→key mappings.
  if (n === 1)  return overrides.single    != null ? 'single'    : (overrides.loaf != null ? 'loaf' : null);
  if (n === 6)  return overrides['half-dozen'] != null ? 'half-dozen' : null;
  if (n === 12) return overrides.dozen     != null ? 'dozen'     : null;
  return null;
}

// ═════════════════════════════════════════════════════════════════════
// calculateQuote — the single source of truth for tandoco pricing.
// Takes cart items + customer context and returns a fully itemized
// breakdown. Called by:
//   - createPaymentIntent (to verify the client's total before charging)
//   - exports.getQuote (public HTTP endpoint used by checkout.html)
// ═════════════════════════════════════════════════════════════════════
async function calculateQuote({items, uid, couponCode, autoRenew, redeemedRewardId = null, freeItemSku = null,
  // Multi-redemption (June 2026): an array of {rewardId, freeItemSku}
  // the customer queued in the cart drawer. When present it supersedes
  // the singular redeemedRewardId/freeItemSku (which stay for back-compat
  // with any caller still on the one-reward path). The only gate is coin
  // balance — each redemption deducts its rung cost from a running
  // balance, so a customer can stack as many as they can afford.
  redeemedRewards = null,
  tandoCoinDiscount = 0,
  // ── Delivery-cart port, PR 2 ─────────────────────────────────
  // Optional. When fulfillment === 'delivery', deliveryFeeCents is
  // added on top of the food total (kept in a separate field so
  // tax line-item allocation continues to work against food only;
  // the delivery fee rides as a shipping_cost on Stripe Tax instead).
  fulfillment, deliveryFeeCents = 0,
  // Order-level cadence ('onetime' | 'weekly'), passed by the payment paths
  // (createPaymentIntentV2*). The one-time (non-subscriber) markup is an
  // ORDER property, not a per-item one — meal cart items still carry a
  // default 'weekly' billing left over from the subscription-framed cart,
  // so keying the markup off the per-item field silently skipped it on
  // one-time orders (customers charged the subscriber rate). When cadence
  // is supplied we drive the markup off it (+ the delivery gate below).
  // Legacy callers (public getQuote preview) omit it → per-item behavior.
  cadence = null,
  // Dynamic delivery (June 2026): when > 0, the delivery fee is waived
  // once the food subtotal (post-discount, pre-tax) reaches this. The
  // caller (createPaymentIntentV2*) passes the live value from
  // /settings/deliveryConfig so the authoritative charge matches the
  // cart's "free delivery over $X" display. See deliveryPricing.js.
  freeDeliveryOverCents = 0,
  // Availability backstop (opt-in). Cart PREVIEW leaves this false so a
  // sold-out item in the cart doesn't break the totals view. The PAYMENT
  // paths (createPaymentIntent*, writeOrderV2*) pass true so a customer
  // can't pay for an item that's sold out or off this week's menu — the
  // store grid disables those, but the standalone /menu/<slug> pages (and
  // Google traffic landing on them) had no server backstop. Throws
  // item_unavailable, which the payment endpoints surface as a clear
  // "no longer available this week" message.
  enforceAvailability = false}) {
  // Premium meal anchors are authoritative — load straight from /recipes
  // so a forged client can't drop a $14.50 salmon to the $11.50 base. We
  // do this in parallel with the rest of the pricing config so it adds
  // ~no latency to the quote.
  const recipeIds = [...new Set((items || [])
    .map(it => it && (it.recipeId || it.id))
    .filter(Boolean))];

  // Availability backstop (payment paths only). Batch-load every cart
  // item's recipe/product doc and reject anything unpublished or not on
  // this week's menu BEFORE we price or charge. Isolated from the pricing
  // logic below so it can't perturb it. A missing doc is left to the
  // existing item_unavailable handling in the pricing loop.
  if (enforceAvailability && recipeIds.length) {
    const _availDocs = await Promise.all(recipeIds.map(async (id) => {
      // Bakery lives in /products, meals in /recipes — check whichever exists.
      const [prod, rec] = await Promise.all([
        db.collection('products').doc(id).get().catch(() => null),
        db.collection('recipes').doc(id).get().catch(() => null),
      ]);
      const doc = (prod && prod.exists) ? prod : ((rec && rec.exists) ? rec : null);
      return { id, data: doc ? (doc.data() || {}) : null };
    }));
    for (const { id, data } of _availDocs) {
      if (!data) continue; // unknown id → handled by the pricing loop's item_unavailable
      // `published` and `availableThisWeek` are the same fields the store
      // grid and the writeOrderV2* / addon paths already gate on. Treat a
      // missing availableThisWeek as available (legacy docs predate it);
      // only an explicit false blocks the sale.
      const unpublished = data.published === false;
      const offMenu = data.availableThisWeek === false;
      if (unpublished || offMenu) {
        const itemName = (items.find(it => (it.recipeId || it.id) === id) || {}).name || data.name || id;
        const e = new Error(`Item no longer available this week: ${itemName}`);
        e.code = 'item_unavailable';
        e.itemId = id;
        e.itemName = itemName;
        throw e;
      }
    }
  }

  // 1. Load all pricing-related config in parallel (same sources as store/checkout)
  const [cfgSnap, perksSnap, salesSnap, planTiers, rewardCatalog, recipePricingMeta, loyaltyCfg, dealsSnap] = await Promise.all([
    db.collection('settings').doc('subscriptionConfig').get(),
    db.collection('settings').doc('membershipPerks').get(),
    db.collection('sales').where('active', '==', true).get().catch(() => ({docs: []})),
    loadPlanTiers().catch(() => []),
    loadRewardCatalog().catch(() => ({rewards: {}, version: 0})),
    _loadRecipePricingMeta(recipeIds).catch(() => ({})),
    loadLoyaltyConfig().catch(() => null),
    // Bundle deals — a failed read means no deals, never a failed quote.
    db.collection('settings').doc('storeDeals').get().catch(() => null),
  ]);
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  const perks = perksSnap.exists ? perksSnap.data() : {};
  const basePrice = cfg.basePrice || 11.50;
  const stacking = cfg.discountStacking || 'additive';
  // One-time markup config — resolved once; applied per line below.
  const otMarkupFactor = _otMarkupFactor(cfg);
  const otMarkupScope = _otMarkupScope(cfg);
  // One-time markup is decided at the ORDER level when the caller passes the
  // authoritative cadence. Delivery-gated to mirror the storefront
  // (cart-pricing.js `_cartOneTime`): market pickup is one-time by model but
  // is never marked up. Recurring (weekly) orders and legacy no-cadence
  // callers fall through to the per-item billing check below.
  const _otOrderIsDelivery = !!(fulfillment && fulfillment.type === 'delivery');
  const _otOrderOneTimeDelivery = (cadence === 'onetime') && _otOrderIsDelivery;
  const activeSales = (salesSnap.docs || []).map(d => ({id: d.id, ...d.data()}));

  // 2. Customer context
  let orderCount = 0;
  let isFirstOrder = true;
  let referredBy = null;
  if (uid) {
    try {
      const custDoc = await db.collection('customers').doc(uid).get();
      if (custDoc.exists) {
        const c = custDoc.data();
        orderCount = c.orderCount || 0;
        isFirstOrder = !c.firstOrderCompleted;
        referredBy = c.referredBy || null;
      }
    } catch (e) { /* defaults */ }
  }

  function calcMonthlyPPM(base, planPct, monthlyPct) {
    return stacking === 'additive'
      ? base * (1 - (planPct + monthlyPct))
      : base * (1 - planPct) * (1 - monthlyPct);
  }

  // Find active sale targeting an item (mirrors client getItemSale)
  function getItemSale(item) {
    if (!activeSales.length) return null;
    const targetId = item.recipeId || item.id;
    for (const s of activeSales) {
      const targets = s.targetIds || s.itemIds || [];
      if (targets.includes(targetId)) return s;
      if (s.appliesTo === 'all') return s;
      if (s.appliesTo === 'meals' && !(item.type === 'baked' || item.type === 'product')) return s;
      if (s.appliesTo === 'baked' && (item.type === 'baked' || item.type === 'product')) return s;
    }
    return null;
  }

  // "Best price wins" mirror of client _storeGetBestDiscount
  function bestPriceForItem(item, itemBase, isBaked) {
    const candidates = [itemBase];

    // Active sale on this item
    const sale = getItemSale(item);
    if (sale) {
      const sp = sale.discountType === 'fixed'
        ? Math.max(0, itemBase - (sale.discountValue || 0))
        : itemBase * (1 - (sale.discountValue || 0) / 100);
      candidates.push(sp);
    }
    // First-order discount was retired May 2026 — referred friends now get a free
    // entrée via the loyalty program; organic signups get the +100 welcome coins.

    return Math.min(...candidates);
  }

  // ── Volume ramp: aggregate meal count across the WHOLE cart ─────────
  // The per-meal price slides down with the TOTAL number of meals in the
  // cart (volumeRamp.js), not the discrete tier bucket. Compute that
  // total here, before pricing any line, and ONLY from the server's own
  // validated quantities — never from a client-sent count, since a
  // forged higher count would lower the price. Mirrors the client's
  // totalEntrees sum in cart-pricing.js (standard meal entrees only:
  // baked/product/bundle and single-try are excluded).
  let volumeMealCount = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const t = item.type;
    if (t === 'baked' || t === 'product' || t === 'bundle') continue;
    const single = item.isSingleTry || (item.plan && /single/i.test(String(item.plan)));
    if (single) continue;
    volumeMealCount += parseInt(item.qty, 10) || 0;
  }

  // 3. Calculate per-item server price — accumulating line items for the breakdown
  let subtotal = 0;
  const lineItems = [];
  for (const item of items) {
    // Authoritative premium-meal override. We trust /recipes, not the
    // cart payload, so the client can't quote a $14.50 salmon at base.
    const rid = item.recipeId || item.id;
    const meta = rid ? recipePricingMeta[rid] : null;
    if (meta) {
      item.premiumMeal = meta.premiumMeal;
      item.menuPrice   = meta.menuPrice;
      // Authoritative reward tags + pack-size allowlist for reward
      // matching — sourced from /recipes, never the cart payload. Cart
      // items never carry rewardTags, so without this hydration the
      // free-item matcher never matched and every freebie silently
      // rejected with `no_eligible_item`.
      item.rewardTags = meta.rewardTags;
      item.rewardTag  = meta.rewardTag;
      item.rewardTagPackTiers = meta.rewardTagPackTiers;
    }
    const isBaked = item.type === 'baked' || item.type === 'product';
    const plan = item.plan || null;
    const billingType = item.billingType || 'onetime';
    const subMode = item.subscriptionMode || (billingType === 'monthly' ? 'monthly' : billingType === 'weekly' ? 'recurring' : 'onetime');

    // Determine base price for this item (pre-discount)
    let itemBase;
    let itemTaxCode; // Stripe Tax code from the product/recipe doc, if set
    // How many INDIVIDUAL pieces one sold unit of this line represents.
    // Bakery sells PACKS: `unitPrice` is the price of a half dozen, and
    // `qty` counts half dozens — one line unit is NOT one roll. Resolved
    // from the SERVER-side pack tier only (the matched packOptions entry
    // or the ladder tier key), never from the cart payload: a forged
    // `packQty: 1` on a dozen would make a free-item coupon comp the
    // whole box. Meals and flat-price products stay at 1 — a meal box
    // that happens to hold 4 egg bites is still ONE thing the customer
    // bought, and `itemsPerContainer` is explicitly not a piece count
    // (see the July 2026 pack-counting lesson in CLAUDE-LESSONS.md).
    let packPieces = 1;
    // Which pack tier this line actually is ('half-dozen', '4-pack', …),
    // as resolved server-side. A coupon can restrict itself to chosen
    // pack sizes (coupon.itemPackTiers) and this is what it matches on,
    // so the answer must come from the same place the PRICE came from —
    // not from the cart, which could name a tier it didn't pay for.
    let packTierKey = null;
    if (isBaked) {
      if (item.recipeId || item.id) {
        try {
          const prodDoc = await db.collection('products').doc(item.recipeId || item.id).get();
          if (prodDoc.exists) {
            // Authoritative reward tags for bakery PRODUCTS — mirrors the
            // recipe hydration above (recipePricingMeta). The free-item
            // matcher reads item.rewardTag(s); products were never hydrated
            // here, so a "free bakery pack" reward always rejected
            // `no_eligible_item` (cart showed the discount, Apple Pay charged
            // full price) even after a mise "rebuild all" — which only walks
            // /recipes. Sourced from /products, never the cart payload, so a
            // forged cart can't claim a tag the product doesn't carry.
            const _pd = prodDoc.data() || {};
            if (Array.isArray(_pd.rewardTags)) item.rewardTags = _pd.rewardTags;
            if (typeof _pd.rewardTag === 'string' && _pd.rewardTag) item.rewardTag = _pd.rewardTag;
            if (_pd.rewardTagPackTiers && typeof _pd.rewardTagPackTiers === 'object') item.rewardTagPackTiers = _pd.rewardTagPackTiers;
          }
          if (prodDoc.exists && prodDoc.data().price != null) {
            itemBase = prodDoc.data().price;
            itemTaxCode = prodDoc.data().stripeTaxCode || undefined;
          } else {
            const recDoc = await db.collection('recipes').doc(item.recipeId || item.id).get();
            if (recDoc.exists) {
              const rd = recDoc.data();
              itemTaxCode = rd.stripeTaxCode || undefined;
              // packOptions is the authoritative source of truth for any
              // recipe with pack tiers. hq2 denormalizes both predefined
              // ladders (sweets/loaf/sliced/...) AND ad-hoc 'custom'
              // ladders into packOptions[] on save — each entry carries
              // qty, price, tierKey. Checking packOptions first lets the
              // 'custom' ladder work without registering it in the
              // server-side LADDERS map, and avoids the silent-undercharge
              // path where an unknown ladderId fell through to the
              // bounded unitPrice fallback at a stale/placeholder price.
              if (Array.isArray(rd.packOptions) && rd.packOptions.length > 0) {
                // Match by tierKey first (new), packQty second (legacy),
                // then fall back to the first option — mirrors checkout's
                // historical default of picking the smallest pack.
                const wantedKey = item.tierKey || null;
                const wantedQty = parseInt(item.packQty) || 0;
                let match = null;
                if (wantedKey) {
                  match = rd.packOptions.find(p => p.tierKey === wantedKey);
                }
                if (!match && wantedQty > 0) {
                  match = rd.packOptions.find(p => parseInt(p.qty) === wantedQty);
                }
                if (!match) match = rd.packOptions[0];
                if (match && match.price != null) {
                  itemBase = match.price;
                  // The pack tier that set the price also says how many
                  // pieces it holds — keep the two together so they can
                  // never disagree.
                  const _mq = parseInt(match.qty, 10);
                  if (Number.isFinite(_mq) && _mq > 1) packPieces = _mq;
                  packTierKey = String(match.tierKey || match.qty || '').trim() || null;
                } else {
                  throw new Error(
                    `No packOption match for item ${item.recipeId || item.id} ` +
                    `tierKey=${wantedKey || '(none)'} packQty=${wantedQty} ` +
                    `(available: ${rd.packOptions.map(p=>p.qty).join(',')})`
                  );
                }
              } else if (rd.ladderId) {
                // Legacy fallback for recipes that have a ladderId +
                // priceOverrides but never got their packOptions[]
                // denormalized. Resolves through the LADDERS registry.
                const productDoc = { id: item.recipeId || item.id, ...rd };
                const resolved = resolveProductTier(productDoc, {
                  tierKey: item.tierKey || _tierKeyFromLegacy(rd, item),
                });
                if (!resolved || resolved.price == null) {
                  throw new Error(
                    `No tier match for item ${item.recipeId || item.id} ` +
                    `ladderId=${rd.ladderId} tierKey=${item.tierKey || '(none)'}`
                  );
                }
                itemBase = resolved.price;
                // Ladder path: the tier key carries the piece count
                // (half-dozen → 6, 4-pack → 4). Same map the store uses
                // when it denormalizes a ladder into packOptions, so the
                // two paths agree on how many pieces a tier holds.
                const _lq = inferQtyFromTierKey(resolved.tierKey);
                if (Number.isFinite(_lq) && _lq > 1) packPieces = _lq;
                packTierKey = String(resolved.tierKey || '').trim() || null;
              } else if (rd.price != null) {
                // Legacy: flat `price` field on the recipe doc.
                itemBase = rd.price;
              } else if (rd.menuPrice != null && parseFloat(rd.menuPrice) > 0) {
                // Current HQ admin writes the canonical price under
                // `menuPrice` (string or number). This is what shows up
                // in the recipe editor's "MENU PRICE ($)" field, and
                // is the source of truth when the pack-ladder dropdown
                // reads "none · use single menu price". Without this
                // branch, every bakery item created in the new admin
                // throws "Cannot verify price" because the legacy
                // `price` field stays undefined.
                itemBase = parseFloat(rd.menuPrice);
              } else {
                // Recipe exists but has none of: flat price, menuPrice,
                // packOptions[], or ladderId. This is the half-
                // configured-recipe state (chef created the doc in /hq2
                // but hasn't published pricing yet). The catch-all
                // retry below will rethrow as item_unavailable if no
                // rescue applies.
                const e = new Error(`Product not found: ${item.recipeId || item.id}`);
                e.code = 'item_unavailable';
                e.itemId = item.recipeId || item.id;
                e.itemName = item.name || rd.name || item.recipeId || item.id;
                throw e;
              }
            } else {
              // Recipe doesn't exist in /recipes either — completely stale.
              const e = new Error(`Product not found: ${item.recipeId || item.id}`);
              e.code = 'item_unavailable';
              e.itemId = item.recipeId || item.id;
              e.itemName = item.name || item.recipeId || item.id;
              throw e;
            }
          }
        } catch (e) {
          // Fallback for à-la-carte single meals that live in /recipes
          // but have no top-level `price` field (pricing lives on the
          // parent meal-plan config instead). If the client supplied a
          // unitPrice and it's within a sane bound we trust it —
          // otherwise rethrow. The bound ($0.50 ≤ x ≤ $60) keeps this
          // from becoming a client-driven pricing backdoor.
          const clientUnit = parseFloat(item.unitPrice);
          if (Number.isFinite(clientUnit) && clientUnit >= 0.5 && clientUnit <= 60) {
            itemBase = clientUnit;
          } else {
            // Last-resort: re-load the recipe doc and check if it's a
            // meal-type recipe that defaulted to the system base rate
            // (the HQ "auto · base price" mode where menuPrice is never
            // persisted to Firestore — non-premium meals just inherit
            // basePrice for display). Without this rescue, a brand-new
            // meal recipe lands the customer on "Cannot verify price"
            // even though HQ displays $11.50 and the cart drawer
            // charges $11.50. We never trust a client-supplied price
            // here — fallback uses the server-loaded subCfg.basePrice,
            // which is the same rate the meal-branch falls back to at
            // line ~487. Logs loudly so HQ data hygiene is still
            // visible in stackdriver.
            let basePriceFallback = null;
            try {
              const recDocRetry = await db.collection('recipes').doc(item.recipeId || item.id).get();
              if (recDocRetry.exists) {
                const rd = recDocRetry.data() || {};
                const hasPackConfig = (Array.isArray(rd.packOptions) && rd.packOptions.length > 0) || !!rd.ladderId;
                const cat = String(rd.menuCategory || rd.mealType || rd.category || '').toLowerCase();
                const isBakeryCat = ['bakery','sauce','sauces','smoothie','smoothies','shake','shakes','drink','drinks','beverage','beverages','product','loaf','sweets','sliced'].includes(cat);
                const looksLikeMeal = !hasPackConfig && !isBakeryCat && !rd.premiumMeal;
                if (looksLikeMeal) basePriceFallback = basePrice;
              }
            } catch (_) { /* fall through to throw */ }
            if (basePriceFallback != null) {
              console.warn('Meal recipe routed through baked branch with no explicit price — falling back to basePrice:', item.recipeId || item.id, 'at', basePriceFallback);
              itemBase = basePriceFallback;
            } else {
              console.error('Price lookup failed for item:', item.recipeId || item.id, e.message);
              // Preserve the inner error's code/itemId/itemName when set
              // (the nested throws above already attach them); otherwise
              // synthesize them from the cart item shape so the caller can
              // surface a clear "X is no longer available" message.
              const friendlyName = item.name || item.recipeId || item.id;
              const err = new Error(`Cannot verify price for item: ${friendlyName}`);
              err.code = e && e.code === 'item_unavailable' ? 'item_unavailable' : 'item_unavailable';
              err.itemId = (e && e.itemId) || item.recipeId || item.id;
              err.itemName = (e && e.itemName) || friendlyName;
              throw err;
            }
          }
        }
      } else {
        throw new Error('Baked/product item missing recipeId or id');
      }
    } else {
      // Meal items — resolve through the planTiers registry. Plan id
      // can come as 'committed' / 'monthly-committed' / 'standard' /
      // 'monthly-standard' (post _v2ToQuoteItems translation), or
      // explicitly via item.planTierId.
      const isMonthly = plan && plan.startsWith('monthly-');
      let tier = null;
      // Plan-string whitelist: if the cart claims a planTierId that
      // doesn't exist in the registry, refuse the quote rather than
      // silently mis-pricing. Same for a `plan` string that doesn't
      // resolve to a known tier when no planTierId is set. Single-try
      // and onetime items don't carry planTierId — those still fall
      // through to the basePrice branch.
      const isSingleTry = item.isSingleTry || (plan && /single/i.test(String(plan)));
      if (item.planTierId) {
        tier = tierById(item.planTierId, planTiers);
        if (!tier) {
          throw new Error('Unknown planTierId: ' + item.planTierId);
        }
      } else if (plan && !isSingleTry) {
        tier = tierForItem({ plan, mealsPerWeek: item.mealsPerWeek }, planTiers);
        if (!tier) {
          throw new Error('Unknown plan string: ' + plan);
        }
      }
      // Premium meals override basePrice as the per-meal anchor passed
      // to the tier discount (salmon at $14.50 × −25% standard = $10.88).
      // Server reads premiumMeal + menuPrice from authoritative recipe
      // data (stamped onto the cart item upstream in _v2ToQuoteItems via
      // the recipe-pricing-meta batch lookup), so a forged client value
      // can't drop a $14.50 meal to the $11.50 base.
      const itemAnchor = (item.premiumMeal && Number(item.menuPrice) > 0)
        ? Number(item.menuPrice)
        : basePrice;
      if (tier) {
        // Meal monthly bonus disabled in code (HQ override — no recurring discounts).
        const monthPct = 0;
        // Volume ramp: the weekly per-meal price is a function of the
        // WHOLE cart's meal count, not the tier bucket. Standard meals
        // read the curve directly; premium meals (their own menuPrice
        // anchor) get the same % off the entry price the curve implies
        // at this cart size. The tier is still resolved above for
        // identity + the monthly bonus, just not for the base rate.
        const weeklyPpm = (item.premiumMeal && Number(item.menuPrice) > 0)
          ? volumeRamp.perMealForAnchor(itemAnchor, volumeMealCount, cfg)
          : volumeRamp.perMealForCount(volumeMealCount, cfg);
        itemBase = isMonthly
          ? (stacking === 'additive'
              ? weeklyPpm - itemAnchor * monthPct
              : weeklyPpm * (1 - monthPct))
          : weeklyPpm;
      } else if (isSingleTry) {
        // Single-try meals are intentionally non-tier-priced — the
        // customer is paying a one-off "try one" rate set on the cart
        // entry by /store's single-try flow. Trust the cart price;
        // basePrice fallback only when the entry is malformed.
        const cartPrice = parseFloat(item.price) || parseFloat(item.unitPrice) || parseFloat(item.pricePerMeal);
        itemBase = (cartPrice && cartPrice > 0) ? cartPrice : basePrice;
      } else {
        // Default-tier rate. Below the smallest tier's threshold (e.g.
        // 1–2 meals when starter starts at 3) the customer still pays
        // the smallest tier's perMealPrice — that matches the cart
        // drawer's "starter rate · $X ea" rendering and makes the
        // pricing story coherent across the funnel: meals are always
        // tier-priced, never subject to the recipe-lab basePrice
        // (which has been a footgun whenever it drifts from the
        // tier table). Falls back to basePrice only when no tiers
        // are configured at all (extremely defensive — would only
        // happen if the planTiers collection is empty AND
        // subscriptionConfig has no derivable tiers either).
        const smallestTier = Array.isArray(planTiers) && planTiers.length ? planTiers[0] : null;
        if (smallestTier) {
          // Meal monthly bonus disabled in code (HQ override — no recurring discounts).
          const monthPct = 0;
          // Volume ramp (same as the resolved-tier branch above): rate
          // comes from the whole-cart meal count, not the tier.
          const weeklyPpm = (item.premiumMeal && Number(item.menuPrice) > 0)
            ? volumeRamp.perMealForAnchor(itemAnchor, volumeMealCount, cfg)
            : volumeRamp.perMealForCount(volumeMealCount, cfg);
          itemBase = isMonthly
            ? (stacking === 'additive'
                ? weeklyPpm - itemAnchor * monthPct
                : weeklyPpm * (1 - monthPct))
            : weeklyPpm;
        } else {
          const cartPrice = parseFloat(item.price) || parseFloat(item.unitPrice) || parseFloat(item.pricePerMeal);
          itemBase = (cartPrice && cartPrice > 0) ? cartPrice : basePrice;
        }
      }
    }

    // Apply "best price wins" (active sale + plan discount; founding/launch retired)
    let price = bestPriceForItem(item, itemBase, isBaked);

    // Weekly subscription discount for baked items — mirrors client
    // applyHqPricing (bakedRecurringDiscount || globalRecurringDiscount)
    // and the tax endpoint (_v2ComputeTaxForItems). Without this the
    // drawer shows a discounted subtotal but the PI is created at the
    // full Firestore price → price_mismatch on every bakery Apple Pay
    // attempt when a subscription discount is configured.
    if (isBaked && billingType === 'weekly') {
      // Bakery recurring discount disabled in code (HQ override).
      const bakedWkPct = 0;
      if (bakedWkPct > 0) price = price * (1 - bakedWkPct);
    }

    // One-time (non-subscriber) markup — mirror of cart-pricing.js. Scale
    // the per-unit price so qty*price (lineTotal) carries it, matching the
    // client's displayed total and the price-match guard. Subscriber
    // (weekly/monthly) lines, single-try promos, and bundles are skipped.
    // Effective billing for the markup decision. ENTRÉES only: when the
    // caller passed the authoritative order cadence, drive the markup off the
    // ORDER (one-time + delivery) so meals are marked up despite their stale
    // per-item 'weekly' billing — the root cause of the missed markup, since
    // the storefront stamps a meal's billing to 'onetime' only in one-time
    // delivery mode and that signal doesn't always survive to here. EXTRAS
    // (bakery/products) are inherently one-time-billed and the storefront
    // marks them up off their own billing + scope regardless of cadence, so
    // they keep the per-item billing here to stay in lockstep with the client
    // (avoids a price-match mismatch if the scope is ever set to 'mealsExtras').
    // No cadence (legacy callers) → per-item billing for everything.
    const _otIsExtra = (item.type === 'baked' || item.type === 'product');
    const _otBilling = (cadence != null && !_otIsExtra)
      ? (_otOrderOneTimeDelivery ? 'onetime' : 'weekly')
      : billingType;
    if (otMarkupFactor !== 1 && _otMarkupApplies(item, _otBilling, otMarkupScope)) {
      price = _otRound2(price * otMarkupFactor);
    }

    // Quantity (monthly bills mealsPerWeek * 4 weeks)
    const isMonthly = billingType === 'monthly';
    const qty = isMonthly ? (item.mealsPerWeek || item.qty) * 4 : item.qty;

    // Substitution upgrades — flat surcharge added on top of the line
    // total, no plan/sale/coupon discount applied. Read from BOTH shapes:
    //   1. selectedMeals[].swapDelta — legacy plan-shape entries (one
    //      meal-plan slot can have a swap upgrade per meal)
    //   2. top-level swapDelta — current individual-meal entries (each
    //      cart item is one meal with one optional upgrade; plans were
    //      retired and replaced with a flat 3-meal-min cart)
    // The two shapes never co-exist on the same cart entry, so summing
    // is safe — whichever one is set contributes; the other is 0.
    // Swap-delta surcharge — see swapMath.js for the rules. Both call
    // sites that compute swap totals (this and _v2ComputeTaxForItems)
    // share the helper so they stay in sync.
    const swapAmount = computeSwapAmount(item, isMonthly);

    const lineTotal = qty * price + swapAmount;
    subtotal += lineTotal;

    lineItems.push({
      id: item.id || item.recipeId,
      name: item.name || '',
      qty,
      basePrice: Math.round(itemBase * 100) / 100,
      unitPrice: Math.round(price * 100) / 100,
      // Pieces per sold unit — 6 for a half dozen, 1 for a meal. Read by
      // couponDiscount.js so "one free item" comps one roll, not the
      // whole box it came in. packTierKey names the tier so a coupon can
      // apply to chosen pack sizes only.
      packPieces,
      packTierKey,
      swapAmount: Math.round(swapAmount * 100) / 100,
      lineTotal: Math.round(lineTotal * 100) / 100,
      plan,
      billingType,
      taxCode: itemTaxCode, // undefined for meal items; buildTaxCalculation defaults to txcd_40060003
      // Stash the cart-input shape — read by the redemption helper to
      // categorize lines for free_item / meal_credit matching. Stripped
      // before the response is serialized so it never leaks to clients.
      _sourceItem: item,
    });
  }

  // 4. (recurring discount intentionally not applied here — controlled in HQ via tier prices / coupons / sales)

  // 4b. Bundle deals — merchandising discounts (mise → Store Layout).
  // Applied to the running subtotal ahead of coupons/rewards so their
  // min-order floors see the post-deal food total. Capped at the
  // subtotal; the preview endpoint mirrors this via the same evaluator.
  const dealBreakdowns = [];
  {
    const dealsData = (dealsSnap && dealsSnap.exists) ? dealsSnap.data() : null;
    const dealEval = evaluateStoreDeals(items, dealsData);
    for (const d of dealEval.discounts) {
      if (subtotal <= 0) break;
      const amount = Math.min(d.amountCents / 100, subtotal);
      if (amount <= 0) continue;
      dealBreakdowns.push({
        id: d.id,
        name: d.name,
        amount: Math.round(amount * 100) / 100,
        amountCents: Math.round(amount * 100),
        label: d.label,
      });
      subtotal -= amount;
    }
  }

  // 5. Validate coupon (NO increment — that happens in stripeWebhook on PI.succeeded)
  // Validation + pricing live in validateAndPriceCoupon (shared with the
  // getTaxQuoteV2Live cart preview, so the discount the customer watches
  // while editing the cart is priced by the same gates as the charge).
  // Behavior here is unchanged: a null breakdown means no discount, no PI
  // metadata, no usage count. The reject reason IS surfaced on the quote
  // (couponRejected below) so PI-create's response can tell the client
  // WHY — the client's free-item auto-add needs 'missing_item' + the
  // qualifying itemIds to drop the item into the cart instead of just
  // clearing the chip with "that code isn't valid".
  let couponBreakdown = null;
  let couponRejected = null;
  if (couponCode && subtotal > 0) {
    const cpn = await validateAndPriceCoupon({
      couponCode, uid, lineItems, subtotal,
      isDelivery: !!(fulfillment && fulfillment.type === 'delivery'),
    });
    couponBreakdown = cpn.breakdown;
    if (!couponBreakdown && cpn.reason) {
      couponRejected = {
        code: String(couponCode).toUpperCase(),
        reason: cpn.reason,
        ...(Array.isArray(cpn.missingItemIds) && cpn.missingItemIds.length
          ? {itemIds: cpn.missingItemIds, itemTiers: cpn.missingItemTiers || {}} : {}),
        // Cart-minimum miss — the client turns these into "add $4.45 more
        // to use this code" rather than the anonymous "isn't valid".
        ...(cpn.reason === 'min_order'
          ? {minSubtotal: cpn.minSubtotal, short: cpn.short} : {}),
        // Post-coupon food floor miss — "this code needs $X more food
        // left over", so the client can keep the chip and say so.
        ...(cpn.reason === 'food_floor'
          ? {floor: cpn.floor, remaining: cpn.remaining, short: cpn.short} : {}),
      };
    }
    if (couponBreakdown && couponBreakdown.amount > 0) {
      subtotal -= couponBreakdown.amount;
    }
  }

  // 6. Validate TandoCoin redemption — catalog-driven (settings/rewardCatalog).
  //    Three effect kinds dispatched by _applyRedemption:
  //      • cash_off    — flat dollar discount, capped at subtotal
  //      • free_item   — zeroes the picked SKU's line, capped at maxLineValue
  //      • meal_credit — credit equal to one 5-meal week, applied only against
  //                      meal-plan line totals
  //    Webhook resolves cost from the same catalog (never trust the metadata)
  //    so the ledger and the quote always agree.
  // Normalize the redemption request into a list. New callers send
  // `redeemedRewards: [{rewardId, freeItemSku}, ...]`; legacy callers send
  // the singular `redeemedRewardId` (+ optional `freeItemSku`). Either way
  // we walk a list, so single-redemption is just the one-element case.
  const _redemptionList = (Array.isArray(redeemedRewards) && redeemedRewards.length)
    ? redeemedRewards
        .map(r => (r && typeof r === 'object')
          ? { rewardId: r.rewardId || r.id || null, freeItemSku: r.freeItemSku || r.sku || null }
          : { rewardId: r || null, freeItemSku: null })
        .filter(r => r.rewardId)
    : (redeemedRewardId ? [{ rewardId: redeemedRewardId, freeItemSku }] : []);

  // tandoCoinBreakdowns: one entry per applied redemption (in apply order).
  // tandoCoinRejections: one entry per refused redemption, each tagged with
  // its rewardId so the cart can point the customer at the right pick.
  const tandoCoinBreakdowns = [];
  const tandoCoinRejections = [];
  if (_redemptionList.length && uid && subtotal > 0) {
    try {
      const custDoc2 = await db.collection('customers').doc(uid).get();
      const cd = custDoc2.exists ? custDoc2.data() : {};
      // Running balance — each successful redemption deducts its rung cost
      // so the affordability check is cumulative across the whole queue.
      // Read the balance the SAME way every other surface does — account
      // pages, the cart drawer, the HQ reads (index.js), and crucially the
      // reward PREVIEW (getTaxQuoteV2Live) all fall back to the legacy
      // `tandocoinBalance` field when `tandoCoins` is absent. This path read
      // ONLY `tandoCoins`, so an account whose coins live in the legacy field
      // showed the discount everywhere (preview reads both) yet had every
      // redemption rejected here as insufficient_balance — the PaymentIntent
      // (and Apple Pay) then charged full price while the cart showed the
      // discount. Matching the preview's read keeps the charge in step with
      // what the customer was shown.
      let runningBalance = Number(cd.tandoCoins || cd.tandocoinBalance) || 0;
      // v3: tier rank is no longer a gate — _applyRedemption ignores it
      // (every reward reachable with coins alone). Still computed for any
      // future tier-aware UI consistency.
      const tierRank = (typeof cd.tier === 'string' && cd.tier)
        ? _tierRankFromName(cd.tier)
        : (Number.isFinite(+cd.lifetimeSpendCents)
            ? _tierRankFromSpendCents(cd.lifetimeSpendCents)
            : _tierRankFromOrderCount(Number(cd.orderCount) || 0));
      const firstOrderCompleted = !!cd.firstOrderCompleted;
      // Market-booth purchases set coinsUnlocked but never firstOrderCompleted
      // (a booth sale is a marketTicket, not an order). Guard ① accepts either.
      const coinsUnlocked = cd.coinsUnlocked === true;
      // A subscription-renewal line is any cart line billed weekly/monthly.
      const hasSubscriptionLine = lineItems.some(li =>
        (li && (li.billingType === 'weekly' || li.billingType === 'monthly')) ||
        (li && li._sourceItem && (li._sourceItem.billingType === 'weekly' || li._sourceItem.billingType === 'monthly'))
      );
      // Tracks which line UNITS each free_item redemption has zeroed so the
      // next one can't double-cover the same physical unit.
      const consumedUnits = {};
      // The $10 min-order floor is a property of the whole cart — fix it to
      // the subtotal as it stands BEFORE any reward is applied, so stacking a
      // second reward isn't blocked just because the first one already
      // discounted the cart below the floor.
      const redemptionBaseSubtotal = subtotal;
      // Per-rung usage counter. Each catalog rung carries perOrderLimit (all
      // ship as 1) but nothing enforced it — the same rung could be queued
      // twice and stack on one order. Cap each rung at its declared limit
      // here, the one place queued rewards turn into applied discounts, so
      // the cap flows through to the PI metadata + webhook debit unchanged.
      // A rung with no positive perOrderLimit is treated as unlimited (no
      // behavior change for any reward that intentionally omits it).
      const _rewardUseCount = {};
      for (const redemption of _redemptionList) {
        const _rw = rewardCatalog && rewardCatalog.rewards && rewardCatalog.rewards[redemption.rewardId];
        const _limit = Number(_rw && _rw.perOrderLimit) || Infinity;
        const _used = _rewardUseCount[redemption.rewardId] || 0;
        if (_used >= _limit) {
          tandoCoinRejections.push({ rewardId: redemption.rewardId, reason: 'per_order_limit', detail: { limit: _limit } });
          continue;
        }
        const result = _applyRedemption({
          rewardId: redemption.rewardId,
          catalog: rewardCatalog,
          lineItems,
          subtotal,
          coinBalance: runningBalance,
          tierRank,
          firstOrderCompleted,
          coinsUnlocked,
          hasSubscriptionLine,
          freeItemSku: redemption.freeItemSku || null,
          planTiers,
          cfg,
          consumedUnits,
          minOrderSubtotal: redemptionBaseSubtotal,
        });
        if (result.breakdown) {
          subtotal = result.subtotal;
          runningBalance -= (Number(result.breakdown.cost) || 0);
          tandoCoinBreakdowns.push(result.breakdown);
          _rewardUseCount[redemption.rewardId] = _used + 1;
          // Fold this redemption's consumed line units into the shared map
          // so the next redemption skips them.
          for (const u of (result.breakdown.consumed || [])) {
            consumedUnits[u.idx] = (Number(consumedUnits[u.idx]) || 0) + (Number(u.take) || 0);
          }
        } else if (result.reason) {
          tandoCoinRejections.push({ rewardId: redemption.rewardId, reason: result.reason, detail: result.detail || null });
        }
      }
    } catch (e) { console.log('tandoCoin validation error:', e.message); }
  }
  // Back-compat singular views — first applied / first rejected.
  const tandoCoinBreakdown = tandoCoinBreakdowns[0] || null;
  const tandoCoinRejection = tandoCoinRejections[0] || null;

  // ── REFERRAL FREE MEAL (v2) ──────────────────────────────────────
  // A referred friend gets their most expensive entrée free on their
  // first paid order, provided the order has at least
  // cfg.freeMealMinEntreeCount entrées in it. Pre-conditions:
  //   · customer doc has referredBy set (set by auth-modal on signup)
  //   · firstOrderCompleted is false (this is their first paid order)
  //   · entrée count meets the configured minimum
  // The "free meal" is the unitPrice of the most expensive non-baked
  // line item (one entrée's worth of value, NOT the full line total).
  // Stacks AFTER coupon + tandoCoin so the cheapest possible scenario
  // applies first; the free meal is the headline perk for referred
  // friends and doesn't compete with their other discounts.
  let referralFreeMealBreakdown = null;
  if (referredBy && isFirstOrder && subtotal > 0) {
    const minEntrees = Math.max(1, Number(loyaltyCfg && loyaltyCfg.freeMealMinEntreeCount) || 3);
    // An "entrée" is any non-baked line item. _sourceItem.type === 'baked'
    // or 'product' is the bakery/sauce/smoothie carve-out.
    const entreeLines = lineItems.filter(li => {
      const src = li && li._sourceItem;
      const t = src && src.type;
      return t !== 'baked' && t !== 'product';
    });
    const entreeCount = entreeLines.reduce((s, li) => s + (Number(li.qty) || 0), 0);
    if (entreeCount >= minEntrees && entreeLines.length) {
      // Pick the highest unitPrice; tie-break by lineTotal so a
      // higher-quantity line wins (gives the customer more value).
      let best = entreeLines[0];
      for (const li of entreeLines) {
        if (li.unitPrice > best.unitPrice ||
            (li.unitPrice === best.unitPrice && li.lineTotal > best.lineTotal)) {
          best = li;
        }
      }
      const freeMealAmount = Math.min(Number(best.unitPrice) || 0, subtotal);
      if (freeMealAmount > 0) {
        subtotal -= freeMealAmount;
        referralFreeMealBreakdown = {
          amount: Math.round(freeMealAmount * 100) / 100,
          label: 'referral perk · most expensive entrée free',
          itemId: best.id || null,
          itemName: best.name || null,
        };
      }
    }
  }

  const total = Math.max(0, Math.round(subtotal * 100) / 100);

  // ── Delivery-cart port, PR 2 — fulfillment + delivery fee echo ──
  // totalCents stays food-only (subtotal − discounts) so existing
  // callers and _buildTaxLineItems keep their pro-rata semantics.
  // grandTotalCents adds the delivery fee for the customer-facing
  // pre-tax total. buildTaxCalculation reads deliveryFeeCents off
  // the quote and rides it as a Stripe Tax shipping_cost.
  const fulfillmentType =
    (fulfillment && fulfillment.type === 'delivery') ? 'delivery' : 'pickup';
  const totalCents = Math.round(total * 100);
  let safeDeliveryFeeCents = (fulfillmentType === 'delivery' && Number.isInteger(deliveryFeeCents) && deliveryFeeCents >= 0)
    ? deliveryFeeCents
    : 0;
  // Free delivery over $X — waive the fee once the food the customer
  // ACTUALLY PAYS FOR reaches the threshold. We compare against the
  // POST-discount food total (`totalCents` = subtotal − all deals/coupon/
  // coin discounts, pre-tax, no delivery), NOT the pre-discount gross.
  // Rationale: delivery is a hard cash cost, so we don't stack a free
  // ride on top of a big discount — a coupon that drops the paid food
  // below $50 also drops the free-delivery perk. This is authoritative:
  // it's the fee that's charged and snapshotted onto the order. The
  // client can't compute this (it never sees coupon values), so: (a) the
  // customer-facing checkout sheet reflects it — renderTotals() prefers
  // this server fee (serverTax.deliveryFeeCents) over its own pre-coupon
  // estimate; and (b) the PI-claim path (cart-checkout.js) claims the
  // UNWAIVED base fee, so a coupon that removes this waiver can never make
  // the claimed total dip below the server's and trip the price-match guard.
  if (fulfillmentType === 'delivery'
      && Number.isInteger(freeDeliveryOverCents) && freeDeliveryOverCents > 0
      && totalCents >= freeDeliveryOverCents) {
    safeDeliveryFeeCents = 0;
  }
  // Coupon-driven free delivery (coupon doc freeDelivery:true). Applied
  // AFTER the free-over rule — both zero the fee, order doesn't matter,
  // but keeping it here means the quote's deliveryFeeCents (and so tax,
  // grandTotal, PI amount, pendingOrders) all inherit the waiver from
  // this one spot. The client learns about it from the PI response's
  // deliveryFeeCents + the coupon breakdown's freeDelivery flag.
  if (couponBreakdown && couponBreakdown.freeDelivery) {
    safeDeliveryFeeCents = 0;
  }

  // Structured breakdown: ordered list of every discount applied so the
  // client can render discount lines generically without schema knowledge.
  const breakdown = [];
  for (const b of dealBreakdowns) breakdown.push({type: 'deal', ...b});
  if (couponBreakdown) breakdown.push({type: 'coupon', ...couponBreakdown});
  // One discount row per applied redemption so the cart can render each
  // free item as its own line (matches the queued-list design).
  for (const b of tandoCoinBreakdowns) breakdown.push({type: 'tandoCoin', ...b});
  if (referralFreeMealBreakdown) breakdown.push({type: 'referralFreeMeal', ...referralFreeMealBreakdown});

  // Strip the internal `_sourceItem` before returning — it's a server-only
  // hint for the redemption helper, not part of the response contract.
  const responseLineItems = lineItems.map(li => {
    const {_sourceItem, ...rest} = li;
    return rest;
  });

  return {
    lineItems: responseLineItems,
    subtotal: Math.round(lineItems.reduce((s, i) => s + i.lineTotal, 0) * 100) / 100, // pre-discount
    autoRenewDiscount: null,
    dealDiscounts: dealBreakdowns,   // bundle deals (mise Store Layout) — applied before coupon
    couponDiscount: couponBreakdown,
    // {code, reason, itemIds?} when the code didn't price — 'missing_item'
    // carries the qualifying itemIds so the client can auto-add the free
    // item and re-price instead of dropping the chip.
    couponRejected,
    tandoCoinDiscount: tandoCoinBreakdown,          // singular — first applied redemption (back-compat)
    tandoCoinDiscounts: tandoCoinBreakdowns,        // plural — every applied redemption, in apply order
    tandoCoinRejection,   // {reason, detail} when a requested redemption was refused (e.g. min_order, coins_locked, sub_conflict)
    tandoCoinRejections,  // plural — every refused redemption, each tagged with its rewardId
    tandoCoinCostTotal: tandoCoinBreakdowns.reduce((s, b) => s + (Number(b.cost) || 0), 0), // coins to debit on success
    referralFreeMealDiscount: referralFreeMealBreakdown,
    breakdown,
    total,
    totalCents,                                              // food only (subtotal − discounts), pre-tax, no delivery
    // ── Delivery-cart port, PR 2 ────────────────────────────────
    fulfillmentType,
    deliveryFeeCents: safeDeliveryFeeCents,
    grandTotalCents:  totalCents + safeDeliveryFeeCents,     // food + delivery, pre-tax
    rewardCatalogVersion: (rewardCatalog && rewardCatalog.version) || 0,
    orderCount,
    isFirstOrder,
    // Founding-member pricing is retired; kept as a literal `false` so the
    // documented quote shape + the order-metadata consumers in index.js stay
    // intact. (PR #3228 removed the variable but left this reference, which
    // crashed every quote with "isFoundingMember is not defined".)
    isFoundingMember: false
  };
}

// ── STRIPE TAX: build tax line_items and call stripe.tax.calculations ──
// Shared by getQuote (live preview) and createPaymentIntent (authoritative charge).
//
// Returns { taxCalculationId, subtotalCents, taxCents, totalCents, reused }.
// subtotalCents is derived from calc.amount_total - calc.tax_amount_exclusive so
// that when phase 2 passes a shipping_cost, shipping + shipping-tax + MN RDF roll
// into the totals without changing callers. For pickup-only today,
// calc.amount_total - tax_amount_exclusive === quote.totalCents exactly.
//
// Hint reuse: if taxCalculationIdHint is provided AND still valid AND matches the
// freshly built line_items, reuse it. Prevents orphan calculations on retry and
// saves a Stripe round-trip on the happy path when the UI already fetched a
// calculation via getQuote.
const TAX_DEFAULT_CODE = 'txcd_40060003'; // Stripe's "Prepared food" — matches the dashboard default
const ZIP_RE = /^\d{5}$/;
// Place-of-sale for MN sales tax. Pickup-only today → jurisdiction is always
// the kitchen's address (<kitchen street>, <city>, MN <zip>). When we add
// shipped/delivered orders later, re-introduce a destination-address capture
// and flow it through buildTaxCalculation's zip param (which stays parameterized
// precisely so that future doesn't require a rewrite).
const KITCHEN_ZIP = '00000';   // placeholder

class TaxInputError extends Error {
  constructor(msg) { super(msg); this.name = 'TaxInputError'; }
}

function _buildTaxLineItems(quote) {
  // Allocate each lineItem's share of quote.totalCents pro-rata from lineTotal,
  // so the sum of amounts equals quote.totalCents exactly (any rounding
  // remainder lands on the last line).
  const grossCents = Math.round(quote.lineItems.reduce((s, li) => s + li.lineTotal * 100, 0));
  const totalCents = quote.totalCents;
  const rawShares = quote.lineItems.map(li => (li.lineTotal * 100 / grossCents) * totalCents);
  const intShares = rawShares.map(x => Math.floor(x));
  let remainder = totalCents - intShares.reduce((a, b) => a + b, 0);
  // Distribute the rounding remainder starting from the line with the largest fractional part.
  const order = rawShares
    .map((x, i) => ({i, frac: x - Math.floor(x)}))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) {
    intShares[order[k].i] += 1;
  }
  return quote.lineItems.map((li, i) => ({
    amount: intShares[i],
    quantity: 1,
    tax_code: li.taxCode || TAX_DEFAULT_CODE,
    reference: String(li.id || `line_${i}`)
  }));
}

function _taxLineItemsMatch(freshItems, calcLineItems) {
  if (!Array.isArray(calcLineItems) || calcLineItems.length !== freshItems.length) return false;
  const key = (li) => `${li.reference}|${li.amount}|${li.tax_code}`;
  const freshKeys = freshItems.map(key).sort();
  const calcKeys = calcLineItems.map(li => `${li.reference}|${li.amount}|${li.tax_code}`).sort();
  for (let i = 0; i < freshKeys.length; i++) {
    if (freshKeys[i] !== calcKeys[i]) return false;
  }
  return true;
}

async function buildTaxCalculation(quote, customerZip, taxCalculationIdHint, stripeOverride) {
  if (!customerZip || !ZIP_RE.test(String(customerZip))) {
    throw new TaxInputError('Valid 5-digit billing zip required for tax calculation.');
  }
  // Optional override lets a caller (e.g., createPaymentIntentV2Test) run
  // the calculation against a different Stripe account/key. Test-mode tax
  // calcs MUST use the test key — a calc id created with the live key
  // can't be referenced by a test PaymentIntent. Defaults to the lazy
  // liveStripe() helper for live-mode callers.
  const stripeInstance = stripeOverride || liveStripe();

  // ── Emulator guardrail (see CLAUDE.md "Stripe Tax fees burned …") ──
  // The Firebase Functions emulator sets FUNCTIONS_EMULATOR=true. When
  // running locally we must NEVER hit live Stripe Tax — that path billed
  // us $331 over a single dev sprint in April-May 2026. If the caller
  // didn't pass an explicit stripeOverride (i.e. the test Stripe client),
  // refuse rather than silently bill the live account. Set
  // ALLOW_LIVE_STRIPE_TAX_IN_EMULATOR=1 to opt in for the rare case where
  // you genuinely need a live calc from local (verifying a registration,
  // debugging a tax-code mismatch).
  if (!stripeOverride &&
      String(process.env.FUNCTIONS_EMULATOR || '').toLowerCase() === 'true' &&
      process.env.ALLOW_LIVE_STRIPE_TAX_IN_EMULATOR !== '1') {
    throw new TaxInputError(
      'Refusing to call live Stripe Tax from the Functions emulator. ' +
      'Pass a stripeOverride (test client), or set ALLOW_LIVE_STRIPE_TAX_IN_EMULATOR=1 to opt in.'
    );
  }

  const zip = String(customerZip);
  const freshLineItems = _buildTaxLineItems(quote);

  // ── Delivery-cart port, PR 2 — shipping_cost on the tax calc ──
  // When the quote includes a delivery fee, ride it as Stripe Tax's
  // shipping_cost. Stripe taxes the shipping appropriately for MN
  // (delivery charges are taxable when the goods are taxable) and
  // rolls shipping + shipping-tax into amount_total, so the returned
  // totalCents naturally includes everything.
  // tax_code: txcd_92010001 = "Shipping" (general). The kitchen ZIP
  // → customerZip ZIP variation handles destination-based MN local
  // tax rates correctly.
  const hasDeliveryFee = Number.isInteger(quote.deliveryFeeCents) && quote.deliveryFeeCents > 0;
  const shippingCost = hasDeliveryFee
    ? { amount: quote.deliveryFeeCents, tax_code: 'txcd_92010001' }
    : null;

  // Skip the hint-reuse path when delivery is in play — a cached calc
  // that didn't carry shipping_cost would silently understate tax.
  // The reuse only saves one Stripe round-trip; not worth the audit
  // risk on delivery orders. Pickup orders keep the existing fast path.
  if (!hasDeliveryFee && taxCalculationIdHint && typeof taxCalculationIdHint === 'string') {
    try {
      const cached = await stripeInstance.tax.calculations.retrieve(taxCalculationIdHint, {
        expand: ['line_items']
      });
      const nowSec = Math.floor(Date.now() / 1000);
      const validFor = (cached.expires_at || 0) - nowSec;
      const addr = (cached.customer_details && cached.customer_details.address) || {};
      const calcItems = (cached.line_items && cached.line_items.data) || [];
      if (validFor < 60) {
        console.log(`[tax-calc] cache miss: hint expires in ${validFor}s`);
      } else if (cached.currency !== 'usd') {
        console.log(`[tax-calc] cache miss: currency ${cached.currency}`);
      } else if (addr.state !== 'MN' || addr.postal_code !== zip) {
        console.log(`[tax-calc] cache miss: address changed (${addr.state}/${addr.postal_code} vs MN/${zip})`);
      } else if (!_taxLineItemsMatch(freshLineItems, calcItems)) {
        console.log('[tax-calc] cache miss: line_items mismatch');
      } else {
        console.log(`[tax-calc] reused ${cached.id} (tax=$${(cached.tax_amount_exclusive / 100).toFixed(2)})`);
        return {
          taxCalculationId: cached.id,
          subtotalCents: cached.amount_total - cached.tax_amount_exclusive,
          taxCents: cached.tax_amount_exclusive,
          totalCents: cached.amount_total,
          reused: true
        };
      }
    } catch (e) {
      console.log(`[tax-calc] cache miss: retrieve failed (${e.message})`);
    }
  }

  const calc = await stripeInstance.tax.calculations.create({
    currency: 'usd',
    line_items: freshLineItems,
    ...(shippingCost ? { shipping_cost: shippingCost } : {}),
    customer_details: {
      address: { country: 'US', state: 'MN', postal_code: zip },
      address_source: 'billing'
    },
    expand: ['line_items.data']
  });
  console.log(`[tax-calc] fresh ${calc.id} (tax=$${(calc.tax_amount_exclusive / 100).toFixed(2)}, zip=${zip}${shippingCost ? `, ship=$${(shippingCost.amount/100).toFixed(2)}` : ''})`);
  return {
    taxCalculationId: calc.id,
    subtotalCents: calc.amount_total - calc.tax_amount_exclusive,
    taxCents: calc.tax_amount_exclusive,
    totalCents: calc.amount_total,
    reused: false
  };
}

// ── Shared coupon validator + pricer ─────────────────────────────────
// The ONE place a coupon code is checked and turned into a discount.
// Used by the authoritative charge path (calculateQuote step 5) AND the
// cart-preview path (getTaxQuoteV2Live), so the number the customer
// watches while editing the cart comes from the same gates that price
// the real charge. Returns {breakdown, reason}:
//   breakdown — {code, amount, label, allowRepeatUse?, freeDelivery?}
//               (exact step-5 shape), or null when the code takes
//               nothing off this cart.
//   reason    — why breakdown is null: 'not_found' | 'email_locked' |
//               'already_redeemed' | 'inactive' | 'min_order' |
//               'food_floor' | 'zero_value' | 'error'. 'food_floor'
//               means the discount would leave under $5 of food (the
//               coupon twin of the reward catalog's floor).
//               'min_order' rides with
//               {minSubtotal, short} so the client can say "add $4.45
//               more" instead of "that code isn't valid".
//               The charge path ignores it. The preview cares about two:
//               'email_locked' on an UNAUTHED quote isn't definitive (a
//               guest's email only resolves to a uid at PI-create), and
//               'error' is infra noise — the client keeps the applied
//               chip for both instead of clearing it.
async function validateAndPriceCoupon({couponCode, uid, lineItems, subtotal, isDelivery}) {
  try {
    const cSnap = await db.collection('coupons').where('code', '==', couponCode.toUpperCase()).limit(1).get();
    if (cSnap.empty) return {breakdown: null, reason: 'not_found'};
    const coupon = cSnap.docs[0].data();
    const now = new Date();
    // Personal coupons (e.g. referral FRIEND-XXXX) carry restrictedToEmail
    // so they can only be redeemed by the account they were issued to.
    // Without this gate, a referee could share their code with a friend
    // and the second person could spend it.
    let emailMatches = true;
    if (coupon.restrictedToEmail && uid) {
      try {
        const reqCust = await db.collection('customers').doc(uid).get();
        const reqEmail = reqCust.exists ? String(reqCust.data().email || '').trim().toLowerCase() : '';
        emailMatches = reqEmail && reqEmail === String(coupon.restrictedToEmail).trim().toLowerCase();
      } catch (_) { emailMatches = false; }
    } else if (coupon.restrictedToEmail && !uid) {
      emailMatches = false;
    }
    // Expiry: the HQ coupon editor (hq2.js openCouponModal) stores the
    // end date as a Firestore Timestamp in `endsAt`. Older/personal
    // coupons may instead carry `validUntil`/`validFrom` date strings.
    // Honor whichever is present so an expiry set in HQ actually applies
    // (previously only validUntil/validFrom were checked, so HQ `endsAt`
    // dates were silently ignored and coupons never expired server-side).
    const endsAtMs = coupon.endsAt && typeof coupon.endsAt.toMillis === 'function'
      ? coupon.endsAt.toMillis()
      : (coupon.validUntil ? new Date(coupon.validUntil).getTime() : null);
    // One-per-customer: a coupon may be redeemed at most once per
    // account. Guest checkouts resolve to a STABLE uid keyed off their
    // email (_v2LookupOrCreateGuestUser → getUserByEmail), so this
    // per-uid check also enforces one-per-email for shoppers who never
    // sign in. The marker is written in stripeWebhook on
    // payment_intent.succeeded at coupons/{id}/redemptions/{uid}.
    let alreadyRedeemed = false;
    // Staff test coupons (allowRepeatUse:true, always paired with
    // restrictedToEmail) skip the once-per-account rule so the founders
    // can run repeated ~55¢ live-mode checkout tests post-launch.
    // oncePerCustomer:false — an HQ-configured evergreen code the same
    // customer may reuse (default/absent = true, so existing coupons keep
    // the one-per-account rule). Unlike allowRepeatUse this does NOT hide
    // the order from GA4 — reuse of a public code is real demand.
    if (uid && coupon.allowRepeatUse !== true && coupon.oncePerCustomer !== false) {
      try {
        const rSnap = await cSnap.docs[0].ref.collection('redemptions').doc(uid).get();
        alreadyRedeemed = rSnap.exists;
      } catch (e) {
        // Transient read failure — don't block a possibly-first
        // redemption on infra noise. The webhook still records the
        // redemption, and any maxUses cap remains a backstop.
        console.log('coupon redemption check error:', e.message);
      }
    }
    if (!emailMatches) return {breakdown: null, reason: 'email_locked'};
    if (alreadyRedeemed) return {breakdown: null, reason: 'already_redeemed'};
    const isValid = coupon.isActive && !coupon.archived
      && (!coupon.validFrom || new Date(coupon.validFrom) <= now)
      && (endsAtMs == null || endsAtMs >= now.getTime())
      && (!coupon.maxUses || (coupon.currentUses || 0) < coupon.maxUses);
    if (!isValid) return {breakdown: null, reason: 'inactive'};
    // Minimum-order gate — checked HERE, ahead of pricing, so every
    // coupon shape (food discount, free item, free delivery) is gated by
    // the same number and the client gets a reason it can explain. The
    // minimum is the coupon's own minSubtotal or the hard $5 floor,
    // whichever is higher (couponDiscount.js couponMinSubtotal) — a doc
    // can raise it, never lower it. Rejecting before evaluateCouponDiscount
    // also means a free-item code below the minimum doesn't report
    // 'missing_item' and get its item auto-added into the cart.
    const _minSub = couponMinSubtotal(coupon);
    if (subtotal < _minSub) {
      return {
        breakdown: null,
        reason: 'min_order',
        minSubtotal: _minSub,
        short: Math.round((_minSub - subtotal) * 100) / 100,
      };
    }
    // Pricing the coupon lives in couponDiscount.js (pure, unit-tested).
    // Whole-order percent / amount ('fixed') behave as before; the
    // item-scoped types (free_item / item_percent / item_amount) read
    // coupon.itemIds + coupon.maxUnits and discount only matching cart
    // lines. A null result (zero value, or the qualifying item isn't in
    // the cart) leaves breakdown null — same as an invalid code — so PI
    // metadata is never stamped and no usage is counted.
    const disc = evaluateCouponDiscount(coupon, lineItems, subtotal, couponCode);
    // freeDelivery:true — the coupon also waives the delivery fee
    // (applied at the caller's fee assembly via the breakdown flag).
    // Only meaningful on delivery carts; on pickup the flag is inert
    // so a free-delivery-only code correctly reads "didn't apply".
    const _couponFreeDelivery = coupon.freeDelivery === true && isDelivery;
    // Post-coupon food floor — at least $5 of food must survive the
    // discount, the same rule coin redemptions have. Refuse rather than
    // clamp: a free item quietly downgraded to a part-discount is worse
    // than an honest "not on this cart". Staff repeat-use test coupons
    // are exempt (they exist to make ~55c live test charges).
    if (disc && disc.amount > 0 && couponBreachesFoodFloor(coupon, subtotal, disc.amount)) {
      return {
        breakdown: null,
        reason: 'food_floor',
        floor: COUPON_POST_FOOD_FLOOR,
        remaining: Math.round((subtotal - disc.amount) * 100) / 100,
        short: Math.round((COUPON_POST_FOOD_FLOOR - (subtotal - disc.amount)) * 100) / 100,
      };
    }
    if (disc) {
      return {
        breakdown: {
          code: String(couponCode).toUpperCase(),
          amount: Math.round(disc.amount * 100) / 100,
          label: disc.label + (_couponFreeDelivery ? ' + free delivery' : ''),
          // Surfaced so PI-create can stamp metadata and the webhook can
          // keep staff test orders out of GA4 purchase analytics.
          ...(coupon.allowRepeatUse === true ? { allowRepeatUse: true } : {}),
          ...(_couponFreeDelivery ? { freeDelivery: true } : {}),
        },
        reason: null,
      };
    }
    // Free-item code whose qualifying item isn't in the cart. Instead of
    // the anonymous 'zero_value' (client shows "code isn't valid"), name
    // the reason and WHICH items qualify — the client auto-adds one and
    // the next re-price zeroes it (matcher: couponDiscount.js
    // missingFreeItemIds — same id triple the evaluator walks). Only
    // free_item: auto-adding an item the customer would still PAY for
    // (item_percent/item_amount) would put unasked-for charges in the
    // cart. Checked BEFORE the free-delivery-only fallback so a
    // free_item+freeDelivery code on a delivery cart auto-adds its item
    // too (the re-price then applies item AND fee waiver together)
    // instead of settling for fee-only.
    // A free-item code whose free item isn't in the cart AT A
    // QUALIFYING PACK. The answer is to add one — that IS the coupon
    // ("simply add the free item"), so a cart holding a half dozen when
    // the code gives away a single still gets its free single. The
    // chosen tier rides along so the client adds the pack the operator
    // picked, not the item's default size.
    const missing = missingFreeItemIds(coupon, lineItems);
    if (missing && missing.ids.length) {
      return {
        breakdown: null,
        reason: 'missing_item',
        missingItemIds: missing.ids,
        missingItemTiers: missing.tiers,
      };
    }
    // Right item, wrong pack — for the PAID item-scoped types only
    // (item_percent / item_amount). There's nothing to auto-add: the
    // customer would be charged for it. So name the reason instead, and
    // the client says "applies to a different pack size" rather than
    // the baffling "that code isn't valid" while they hold the exact
    // product the code names.
    if (packMismatchOnly(coupon, lineItems)) {
      return {breakdown: null, reason: 'wrong_pack'};
    }
    // Free-delivery-only codes reach here with disc === null, so they'd
    // slip any gate that lived only inside evaluateCouponDiscount — a
    // fee-only code (e.g. FREEDELIVERY50) would waive delivery on ANY
    // size cart. The minimum-order check above now runs before this
    // point for every coupon shape, so by here the cart has already
    // cleared it.
    if (_couponFreeDelivery) {
      // Free-delivery-ONLY coupon (no food discount — e.g. percent 0).
      // Still counts as applied: amount 0 keeps the food math intact,
      // the freeDelivery flag zeroes the fee, and PI metadata / webhook
      // usage-counting fire as normal off the set breakdown.
      return {
        breakdown: {
          code: String(couponCode).toUpperCase(),
          amount: 0,
          label: `${String(couponCode).toUpperCase()} — free delivery`,
          freeDelivery: true,
          ...(coupon.allowRepeatUse === true ? { allowRepeatUse: true } : {}),
        },
        reason: null,
      };
    }
    return {breakdown: null, reason: 'zero_value'};
  } catch (e) {
    console.log('coupon validation error:', e.message);
    return {breakdown: null, reason: 'error'};
  }
}

module.exports = {
  calculateQuote,
  buildTaxCalculation,
  KITCHEN_ZIP,
  TaxInputError,
  loadRewardCatalog,
  // Exposed so the cart-preview path (getTaxQuoteV2Live) can run the
  // exact same free_item line-matcher used at PI-create / webhook time.
  // Single source of truth for "does this cart line qualify for this
  // reward tag" — preview and authoritative paths stay in lockstep.
  itemMatchesTag:      _itemMatchesTag,
  itemMatchesCategory: _itemMatchesCategory,
  evaluateStoreDeals,
  evaluateCouponDiscount,
  // Exposed for tests. The coin-redemption validator is the authoritative
  // gate on spending TandoCoins (Guard ① = the coins_locked lock), so its
  // behavior is covered directly rather than through a full quote.
  applyRedemption:     _applyRedemption,
  // Shared coupon gate + pricer — getTaxQuoteV2Live previews with the
  // exact rules PI-create charges with (see the function's doc block).
  validateAndPriceCoupon,
};
