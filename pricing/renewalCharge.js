'use strict';

/* ════════════════════════════════════════════════════════════════════
   RENEWAL CHARGE — ONE FORMULA, TWO READERS (Aug 2026)

   WHAT THIS IS
   Answers a single question: "if this subscription renewed right now,
   what would actually leave the customer's account?" Food, minus any
   retention discount, plus the re-priced delivery fee, plus sales tax,
   minus whatever their gift balance covers.

   WHY IT EXISTS
   Two places need that answer and they used to compute it separately:

     • chargeOneSubscription (functions/index.js) — the Thursday charge.
       Did all of the above.
     • renewalPreflightAndNotify (functions/index.js) — the Wednesday
       heads-up email + text. Did none of it: it quoted the raw
       pre-tax `sub.total` straight off the subscription doc.

   So the only advance warning a subscriber ever gets before money moves
   understated the charge. Live example (Aug 11 2026): sub
   8QH4DA7uk8C26g83Ip9K carries total 107.78 and the email said
   "$107.78" for a card that was about to be charged ~$117.51 — the
   subtotal, with the sales tax quietly dropped. Wrong in the direction
   that generates complaints, on the first real renewal the business
   ever ran.

   The fix is not to teach the email how to add tax — that would be a
   second copy of the formula, free to drift from the first the moment
   either changes. The fix is that BOTH callers ask this module, so the
   number in the email is the number the charge will compute, by
   construction.

   ── THE TAX ZIP (fixed here, Aug 2026) ──────────────────────────────
   Minnesota sales tax on a delivered order is DESTINATION-based, and
   the whole rest of the system agrees on that: the checkout paths pass
   the cart's delivery ZIP (functions/index.js `customerZip`), and
   `_createAuthoritativeTaxForOrder` files the real tax.transaction
   against `orderData.delivery.address.zip`.

   The renewal path did not. It passed KITCHEN_ZIP unconditionally, so
   a delivery sub was CHARGED at the origin rate and FILED at the
   destination rate. On the live sub above: City A is 9.03%,
   City B is 8.53% — we would have collected $9.73 of tax and
   remitted $9.19, over-charging the customer 54c and holding tax money
   that was never owed. This module resolves the destination ZIP for
   delivery subs (pickup keeps the kitchen ZIP, matching checkout).

   ── WHAT THIS IS NOT ────────────────────────────────────────────────
   The tax number here is an ESTIMATE off the cached per-ZIP rate, and
   deliberately so — the locked rule (CLAUDE.md) is that the real,
   billable Stripe Tax call only ever happens AFTER payment, in the
   webhook. So this costs nothing to call, and can be called on a
   Wednesday for a charge that has not happened yet. Anything shown to
   a customer from this module must be worded as an estimate.

   Because it is state-dependent (the customer can edit their box, spend
   their gift balance, or accept a retention offer between Wednesday and
   Thursday), the preview is a good-faith projection, not a promise.
   ════════════════════════════════════════════════════════════════════ */

// Cap on the cancel-flow "stay for 10% off" retention offer. The field
// sits on a client-writable customer doc, so a self-written larger
// value is clamped rather than trusted.
const RETENTION_MAX_PCT = 10;

/* Which customer-doc balance field a renewal may spend. Renewals bill
   through live Stripe, so only the LIVE balance is ever spendable —
   an HQ2-issued test card must never pay for a real week of food.
   Mirrors _giftBalanceField('live') in functions/index.js. */
const GIFT_BALANCE_FIELD_LIVE = 'giftCardBalanceCents';

/* Stripe's floor for a card charge. A gift balance may cover an order
   in full, but must never leave the card owing an amount Stripe would
   refuse — that order could then never be paid at all. Same three
   outcomes as _giftApplyCents in functions/index.js. */
const STRIPE_MIN_CHARGE_CENTS = 50;

function _giftApplyCents(balanceCents, totalCents) {
  const bal   = Math.max(0, Math.floor(Number(balanceCents) || 0));
  const total = Math.max(0, Math.floor(Number(totalCents)   || 0));
  let apply = Math.min(bal, total);
  const remainder = total - apply;
  if (remainder > 0 && remainder < STRIPE_MIN_CHARGE_CENTS) {
    apply = Math.max(0, total - STRIPE_MIN_CHARGE_CENTS);
  }
  return apply;
}

/* Is this a v2 subscription — the /checkout-v2 flow, whose `total` is a
   clean pre-tax subtotal? Pre-v2 subs (the legacy /checkout.html flow)
   have whatever tax was applied at initial signup already baked into
   `total`, so adding tax again would double-charge them. Leave those
   alone: their charge is `total` and so is their heads-up. */
function isV2Sub(sub) {
  return typeof sub.source === 'string' && sub.source.startsWith('checkout-v2');
}

/* The ZIP whose sales-tax rate applies. Delivery = destination (the
   customer's address); pickup = origin (the kitchen). Same rule, same
   shape, as the `customerZip` resolution in the checkout paths. */
function resolveTaxZip(sub, kitchenZip) {
  const zip = String(
    (sub.fulfillmentType === 'delivery' && sub.delivery && sub.delivery.address && sub.delivery.address.zip) || ''
  ).trim();
  return /^\d{5}$/.test(zip) ? zip : kitchenZip;
}

/**
 * Compute what a renewal of `sub` would charge right now.
 *
 * Reads Firestore (delivery-pricing config + the cached tax-rate map)
 * but writes nothing and touches neither Stripe nor the customer's
 * balance — safe to call from a heads-up cron.
 *
 * @param {object}  args.db            Firestore instance.
 * @param {object}  args.sub           subscriptions/{id} data.
 * @param {object} [args.customerData] customers/{uid} data, if already read.
 *                                     Supplies the retention discount and
 *                                     gift balance; omitting it just means
 *                                     neither is applied.
 * @param {object}  args.deliveryPricing  src/pricing/deliveryPricing module.
 * @param {object} [args.taxRateCache] src/pricing/taxRateCache module.
 *                                     Injectable for the same reason
 *                                     deliveryPricing is — it reaches
 *                                     Firestore at module load, so tests
 *                                     hand in a fixed rate table instead.
 *                                     Defaults to the real one.
 * @param {function}[args.log]         optional line logger.
 *
 * @returns {Promise<object>} breakdown:
 *   retentionPct        percent off the food line (0 when none)
 *   retentionOffCents   dollars-off from that discount
 *   foodCents           food subtotal AFTER the retention discount
 *   deliveryFeeCents    fee charged this renewal (0 for pickup / waived)
 *   subtotalCents       foodCents + deliveryFeeCents (the taxable base)
 *   taxCents            estimated sales tax (0 when not applicable)
 *   taxRate             the cached rate used (null when no tax applied)
 *   taxZip              which ZIP that rate came from
 *   taxEstimated        true when a tax line was computed at all
 *   tax                 the raw estimate object, or null — the shape
 *                       chargeOneSubscription stamps onto PI metadata
 *   totalCents          what the renewal costs in total, tax included
 *   giftBalanceCents    the customer's spendable live gift balance
 *   giftAppliedCents    how much of it this renewal would consume
 *   cardChargeCents     what the CARD is actually charged — the number a
 *                       customer sees on their statement
 */
async function computeRenewalCharge({ db, sub, customerData, deliveryPricing, taxRateCache, log }) {
  const _log = typeof log === 'function' ? log : () => {};
  const cust = customerData || {};

  // ── Retention discount ──
  // The cancel-flow "stay for 10% off" offer, honored ONCE against this
  // renewal's food subtotal. chargeOneSubscription clears the flag after
  // a successful charge; a preview must never clear it.
  let retentionPct = 0;
  const _rp = Number(cust.retentionDiscount);
  if (Number.isFinite(_rp) && _rp > 0) retentionPct = Math.min(_rp, RETENTION_MAX_PCT);

  const grossFoodCents  = Math.round(Number(sub.total || 0) * 100);
  const retentionOffCents = retentionPct > 0
    ? Math.round(grossFoodCents * retentionPct / 100)
    : 0;
  const foodCents = grossFoodCents - retentionOffCents;

  // ── Delivery fee ──
  // RE-PRICED from the member's address every renewal (their distance
  // band from the zone-check cache), waived over the free-over threshold
  // and for subscribers when configured. If the address now re-prices out
  // of zone (config drift), fall back to the last-known fee so an existing
  // member's renewal never hard-fails. Pickup subs are always 0.
  let deliveryFeeCents = 0;
  if (sub.fulfillmentType === 'delivery' && sub.delivery) {
    try {
      const cfg = await deliveryPricing.loadConfig(db);
      let base = await deliveryPricing.resolveBaseFeeCents({ db, delivery: sub.delivery, cfg });
      if (base === null) {
        base = Number.isInteger(sub.deliveryFeeCents) ? sub.deliveryFeeCents : cfg.fallbackFeeCents;
      }
      deliveryFeeCents = deliveryPricing.effectiveFeeCents(base, foodCents, cfg, { isSubscriber: true });
    } catch (_e) {
      deliveryFeeCents = Number.isInteger(sub.deliveryFeeCents) ? sub.deliveryFeeCents : 0;
    }
  }

  const subtotalCents = foodCents + deliveryFeeCents;

  // ── Sales tax ──
  // Cached per-ZIP rate, never a billable Stripe Tax call (locked rule:
  // the real calc happens after payment, in the webhook). Fold the
  // delivery fee into the taxed base so this matches the one-time path;
  // the webhook backs the food base out as subtotal − deliveryFee and
  // rides the fee as shipping_cost.
  const { estimateTaxWithFallback, KITCHEN_ZIP } =
    taxRateCache || require('../pricing/taxRateCache');
  const taxZip = resolveTaxZip(sub, KITCHEN_ZIP);

  let tax = null;
  if (isV2Sub(sub) && Array.isArray(sub.items) && sub.items.length > 0) {
    try {
      const quote = {
        lineItems:  [{ id: 'renewal', lineTotal: subtotalCents / 100 }],
        totalCents: subtotalCents,
      };
      tax = await estimateTaxWithFallback(quote, taxZip);
    } catch (taxErr) {
      // A tax line we cannot compute is not a reason to fail a renewal —
      // charge the pre-tax amount and let the webhook's authoritative
      // calc be the record. The heads-up reads the same null and simply
      // says nothing about tax rather than guessing.
      _log(`renewal tax estimate failed, falling back to pre-tax: ${taxErr.message}`);
      tax = null;
    }
  }

  const taxCents   = tax ? tax.taxCents : 0;
  const totalCents = tax ? tax.totalCents : subtotalCents;

  // ── Gift balance as tender ──
  // A gift card is a payment method, not a discount: it comes off AFTER
  // tax, so the taxable base and the tax we file stay the full price of
  // the food.
  const giftBalanceCents = Math.max(0, Number(cust[GIFT_BALANCE_FIELD_LIVE]) || 0);
  const giftAppliedCents = (sub.uid && giftBalanceCents > 0)
    ? _giftApplyCents(giftBalanceCents, totalCents)
    : 0;

  return {
    retentionPct,
    retentionOffCents,
    foodCents,
    deliveryFeeCents,
    subtotalCents,
    taxCents,
    taxRate:      tax ? tax.rate : null,
    taxZip,
    taxEstimated: !!tax,
    tax,
    totalCents,
    giftBalanceCents,
    giftAppliedCents,
    cardChargeCents: totalCents - giftAppliedCents,
  };
}

module.exports = {
  computeRenewalCharge,
  isV2Sub,
  resolveTaxZip,
  RETENTION_MAX_PCT,
  GIFT_BALANCE_FIELD_LIVE,
  STRIPE_MIN_CHARGE_CENTS,
};
