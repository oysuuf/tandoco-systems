/* ════════════════════════════════════════════════════════════════════
   CRM — Saved segments.

   A segment is a named filter recipe stored under /segments/{id}.
   The same evaluator powers:
     - HQ "show me this audience" preview counts
     - SMS / email broadcast audience pickers
     - Workflow trigger.type='segment_entered'

   Schema:
     {
       name:        string,
       description: string,
       filter: {
         tier?:        'newbie'|'foodie'|'connoisseur',
         rfmTag?:      'loyal'|'win_back'|'at_risk'|'high_value'|'new',
         lastOrderDaysMin?: number,
         lastOrderDaysMax?: number,
         orderCountMin?:    number,
         orderCountMax?:    number,
         lifetimeSpendMin?: number,
         lifetimeSpendMax?: number,
         hasTag?:           string,
         notHasTag?:        string,
         smsOptIn?:         boolean,
         subscriberOnly?:   boolean,
         topCategoryIs?:    string,
         predictedLtvMin?:  number,
         aovMin?:           number,
         aovMax?:           number,
         cadenceDaysMax?:   number,
         stageIs?:          string,
         hasNoOrders?:      boolean,
         joinedDaysMax?:    number,
         source?:           string,
         marketIs?:         string,   // canonical pickup-market id
       },
       updatedAt: Timestamp,
       updatedBy: uid,
     }

   The evaluator runs in-memory on a capped scan. For the customer
   counts we have today (<10k) this is fine. If we ever blow past
   25k we switch to materialized memberships under /segments/{id}/members.
   ════════════════════════════════════════════════════════════════════ */

'use strict';

const { isSubscriber } = require('../lib/subscriber');

const SCAN_CAP = 5000;

function _daysSince(ts, now) {
  if (!ts) return Infinity;
  const ms = ts.toMillis ? ts.toMillis() : (ts.seconds ? ts.seconds * 1000 : 0);
  if (!ms) return Infinity;
  return (now.getTime() - ms) / 86400000;
}

/**
 * Match one customer doc against a filter. Pure — no Firestore reads.
 * @returns {boolean}
 */
function customerMatches(customer, filter, now) {
  if (!customer || !filter) return false;
  now = now || new Date();

  const derived = customer.derived || {};
  const lastOrderAt = (derived.lastOrder && derived.lastOrder.placedAt)
    || customer.lastPaidOrderAt || null;
  const days = _daysSince(lastOrderAt, now);
  const orderCount = Number(customer.orderCount || derived.orderCount || 0);
  const spend = Number(customer.orderTotal || derived.lifetimeSpend || 0);
  const tier = String(customer.tier || derived.tier || '').toLowerCase();
  const rfm = String(customer.rfmTag || derived.rfmTag || '').toLowerCase();
  const tags = Array.isArray(customer.tags) ? customer.tags.map(String) : [];
  const topCat = (derived.topCategories && derived.topCategories[0]) || '';
  // Server-materialized stats (functions/src/crm/customerStats.js) — the
  // aov / predictedLtv / cadenceDays / stage keys read straight off the
  // customer doc that trigger writes. Fall back to derived where present.
  const aov          = Number(customer.aov || derived.aov || 0);
  const predictedLtv = Number(customer.predictedLtv || derived.predictedLtv || 0);
  const cadenceDays  = (customer.cadenceDays != null) ? Number(customer.cadenceDays)
    : (derived.cadenceDays != null ? Number(derived.cadenceDays) : null);
  const stage        = String(customer.stage || derived.stage || '').toLowerCase();
  const source       = String(customer.source || derived.source || '').toLowerCase();
  const joinedDays   = _daysSince(customer.firstSeenAt || customer.createdAt || null, now);
  // Markets this customer has shown up at (online pickup + booth), as
  // canonical ids. Materialized by functions/src/crm/customerStats.js —
  // this evaluator only ever sees the customer doc, never their orders,
  // so the rollup has to already be on the doc.
  const marketIds    = Array.isArray(customer.marketIds) ? customer.marketIds.map(String) : [];

  if (filter.tier && tier !== String(filter.tier).toLowerCase()) return false;
  if (filter.rfmTag && rfm !== String(filter.rfmTag).toLowerCase()) return false;
  if (Number.isFinite(filter.lastOrderDaysMin) && !(days >= filter.lastOrderDaysMin)) return false;
  if (Number.isFinite(filter.lastOrderDaysMax) && !(days <= filter.lastOrderDaysMax)) return false;
  if (Number.isFinite(filter.orderCountMin) && !(orderCount >= filter.orderCountMin)) return false;
  if (Number.isFinite(filter.orderCountMax) && !(orderCount <= filter.orderCountMax)) return false;
  if (Number.isFinite(filter.lifetimeSpendMin) && !(spend >= filter.lifetimeSpendMin)) return false;
  if (Number.isFinite(filter.lifetimeSpendMax) && !(spend <= filter.lifetimeSpendMax)) return false;
  if (filter.hasTag && !tags.includes(filter.hasTag)) return false;
  if (filter.notHasTag && tags.includes(filter.notHasTag)) return false;
  if (filter.smsOptIn === true && customer.smsOptIn !== true) return false;
  // subscriberOnly reads the ONE helper (functions/src/lib/subscriber.js).
  // It used to test the nested `subscription.active`, which nothing writes —
  // so this filter excluded every customer, including real subscribers.
  if (filter.subscriberOnly === true && !isSubscriber(customer)) return false;
  if (filter.topCategoryIs && String(topCat).toLowerCase() !== String(filter.topCategoryIs).toLowerCase()) return false;
  if (Number.isFinite(filter.predictedLtvMin) && !(predictedLtv >= filter.predictedLtvMin)) return false;
  if (Number.isFinite(filter.aovMin) && !(aov >= filter.aovMin)) return false;
  if (Number.isFinite(filter.aovMax) && !(aov <= filter.aovMax)) return false;
  // cadenceDaysMax: only orders-with-cadence customers can match (a
  // single-order customer has no cadence — null — and is excluded).
  if (Number.isFinite(filter.cadenceDaysMax) && !(cadenceDays != null && cadenceDays <= filter.cadenceDaysMax)) return false;
  if (filter.stageIs && stage !== String(filter.stageIs).toLowerCase()) return false;
  if (filter.hasNoOrders === true && orderCount > 0) return false;
  if (Number.isFinite(filter.joinedDaysMax) && !(joinedDays <= filter.joinedDaysMax)) return false;
  if (filter.source && source !== String(filter.source).toLowerCase()) return false;
  if (filter.marketIs && !marketIds.includes(String(filter.marketIs))) return false;

  return true;
}

/**
 * Materialize a segment's members. Returns customer ids (capped).
 */
async function evaluateSegment(db, filter, opts) {
  opts = opts || {};
  const limit = Math.min(SCAN_CAP, Math.max(1, opts.limit || 1000));

  // Single scan; in-memory filter. We deliberately don't compose
  // Firestore where() clauses dynamically — composite indexes would
  // explode and the customer collection is small.
  const snap = await db.collection('customers').limit(limit).get();
  const matched = [];
  const now = new Date();
  for (const doc of snap.docs) {
    if (customerMatches(doc.data(), filter || {}, now)) {
      matched.push({ id: doc.id, data: doc.data() });
    }
  }
  return matched;
}

module.exports = {
  customerMatches,
  evaluateSegment,
  SCAN_CAP,
};
