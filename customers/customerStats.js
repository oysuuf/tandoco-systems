/* ════════════════════════════════════════════════════════════════════
   CRM — customer stats trigger (Phase 1B-1d / arch roadmap #3)
   ────────────────────────────────────────────────────────────────────
   Maintains rollup fields on /customers/{id} that the front-end
   currently recomputes from raw orders on every drawer open:

     ltv              — sum of paid orders (alias: lifetimeSpend)
     orderCount       — count of paid orders
     aov              — avg order value
     lastOrderAt      — most recent paid order timestamp
     firstOrderAt     — first paid order timestamp
     predictedLtv     — heuristic (functions/src/crm/ltv.js scorer)
     churnRisk        — 0..1, recency × cadence
     cadenceDays      — avg days between paid orders
     daysSinceLastOrder — derived snapshot at recompute time
     stage            — lead | new | repeat | loyal | atRisk | lapsed
                        | vip | subscriber (computed)
     statsUpdatedAt   — timestamp of last recompute

   Why centralize:
     The CRM list paint currently runs `enrichCustomer` over every
     customer in memory, joining against /orders by email. That's
     ~2000 order reads + ~500 customer reads on every visit — and the
     numbers go stale the moment a new order lands. Pre-computing
     these on the customer doc means:
       • One small read per customer drawer / list row (no joins)
       • Numbers are always fresh — they update within ~1s of any
         /orders write, automatically
       • Querying "VIPs ($500+)" or "at-risk (60d+)" becomes a real
         Firestore index hit instead of an in-memory filter

   Triggers:
     onDocumentWritten('orders/{orderId}')  → recompute the affected
                                               customer's stats. The
                                               existing customer-
                                               derived.js trigger
                                               handles "lastOrder /
                                               topCategories /
                                               recommendations" — this
                                               module owns the
                                               value/risk fields.

     Plus an HTTP backfill endpoint for the first run + drift
     recovery, similar to aggregatesRecomputeNow.

   Idempotency: same input set → same output. Concurrent invocations
   for the same customer are fine — last write wins, and we only
   fetch a bounded window (last 365d, capped at 100 paid orders).
   ════════════════════════════════════════════════════════════════════ */

'use strict';

const admin = require('firebase-admin');
const {onDocumentWritten, onDocumentCreated} = require('firebase-functions/v2/firestore');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {onRequest} = require('firebase-functions/v2/https');
const {logger} = require('firebase-functions/v2');

const ltv = require('./ltv');
const { isSubscriber } = require('../lib/subscriber');
const {resolveMarketId, marketIdsFromTags} = require('../lib/marketNames');

const PAID_STATUSES = new Set([
  'paid', 'completed', 'ready', 'fulfilled', 'picked_up',
  'confirmed', 'in progress', 'in_progress', 'out_for_delivery',
  'in transit', 'in_transit', 'delivered',
]);

// ─── Market catalogue cache ───────────────────────────────────────
// The nightly sweep recomputes up to 400 customers per run and every
// one of them needs the same settings/fulfillment market list, so read
// it once per function instance rather than 400 times. Short TTL so a
// newly-added market shows up without waiting for a cold start.
const _MKT_TTL_MS = 5 * 60 * 1000;
let _mktCache = null;      // { at: ms, list: [{id,label}] }

async function _loadPickupMarkets(db){
  const now = Date.now();
  if (_mktCache && (now - _mktCache.at) < _MKT_TTL_MS) return _mktCache.list;
  let list = [];
  try {
    const snap = await db.collection('settings').doc('fulfillment').get();
    const s = snap.exists ? (snap.data() || {}) : {};
    list = (Array.isArray(s.pickupMarkets) ? s.pickupMarkets : [])
      .filter(m => m && m.id)
      .map(m => ({ id: String(m.id), label: String(m.label || m.id) }));
  } catch (e){
    // Non-fatal: a failed read just means no market ids this pass. The
    // next recompute self-heals, and stats must never fail over this.
    logger.warn('[customerStats] pickupMarkets read failed', { err: e.message });
    // Serve a stale cache rather than nothing when one read blips.
    if (_mktCache) return _mktCache.list;
  }
  _mktCache = { at: now, list };
  return list;
}

/**
 * Every market this customer has actually shown up at, as canonical ids.
 *
 * Two independent sources, deliberately unioned — a customer who
 * pre-orders online for Market A pickup and a customer who walks up to
 * the Market A booth are both "a Market A customer", and any segment
 * asking that question has to see both:
 *
 *   online  — order.pickupMarketId (already a canonical id)
 *   booth   — the `market:<name>` tags captureMarketLead stamps, whose
 *             names come from whatever staff typed at the till
 *
 * The till spells markets differently from the catalogue ("Market B" vs "Market B Farmers Market"), which is why both sides go
 * through resolveMarketId instead of being compared as strings.
 */
function _marketIdsFor(customer, paidOrders, pickupMarkets){
  const out = new Set(marketIdsFromTags(customer && customer.tags, pickupMarkets));
  (paidOrders || []).forEach(o => {
    const raw = (o && o.pickupMarketId)
      || (o && o.pickupLocation && (o.pickupLocation.id || o.pickupLocation.label))
      || '';
    const id = resolveMarketId(raw, pickupMarkets);
    if (id) out.add(id);
  });
  return Array.from(out).sort();
}

// Same status-normalize logic as the orders module + aggregates so
// the "is this paid?" check agrees everywhere.
function normStatus(s){
  const v = String(s || '').toLowerCase().trim();
  if (!v) return 'pending';
  if (v === 'in progress' || v === 'in-progress') return 'in_progress';
  if (v === 'out for delivery' || v === 'in transit' || v === 'shipped' || v === 'in_transit') return 'out_for_delivery';
  if (v === 'fulfilled' || v === 'picked_up') return 'completed';
  return v;
}

// Resolve the customerId from an order — prefers `uid`, falls back to
// looking up by email so guest orders that later sign up still flow
// into the right /customers doc.
async function _customerIdFromOrder(db, order){
  if (order && order.uid) return order.uid;
  const email = String((order && (order.customerEmail || order.email)) || '').toLowerCase().trim();
  if (!email) return null;
  try {
    const snap = await db.collection('customers').where('email', '==', email).limit(1).get();
    if (!snap.empty) return snap.docs[0].id;
  } catch (_) {}
  return null;
}

// ─── Close the abandoned-cart snapshot after an order (Jul 2026) ───
// `abandonedCarts/{uid}` is the cart-recovery snapshot read by two crons
// (abandonedCartReminders = email, cartAbandonmentSms = SMS). It is meant
// to flip to completed:true the moment the customer's cart empties, which
// is what happens right after they pay — but the flip lived ONLY in
// cart-drawer.js, and the confirmation page neither loads that script nor
// empties the cart through it. Result: the snapshot stayed completed:false
// holding the just-purchased items, and ~24h later the SMS cron texted
// "your cart's still waiting (5 items)" to a customer who had already paid.
//
// order-confirmed.html now closes it client-side; this is the safety net
// for every path that doesn't go through that page — a customer who closes
// the tab before it finishes, a subscription renewal, a webhook/orphan
// reconcile. Fully best-effort: it must never fail the order.
//
// The doc id is the auth uid (enforced by the firestore rule), which is
// exactly what _customerIdFromOrder returns.
async function _closeAbandonedCart(db, customerId){
  if (!customerId) return;
  try {
    const ref = db.collection('abandonedCarts').doc(customerId);
    const snap = await ref.get();
    // Only ever CLOSE an existing open snapshot. Never create one — an
    // empty completed doc for someone who never had a tracked cart is
    // noise in the recovery funnel reports (hq2 reads this collection).
    if (!snap.exists) return;
    if (snap.data() && snap.data().completed === true) return;
    await ref.update({
      completed: true,
      itemCount: 0,
      items: [],
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      completedByOrderAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    logger.error('[customerStats] close abandoned cart failed', {
      err: err && err.message, customerId,
    });
  }
}

// ─── Canonical CRM segment (Phase 3 — one source of truth) ─────────
// A single string, stamped on customers/{uid}.crmSegment, that BOTH
// HQ2 and the Mise app read so the two surfaces can never disagree on
// which segment a customer is in. Rules are ABSOLUTE (no percentile)
// so a per-write trigger is deterministic — same inputs → same label.
//
// Inputs are read from already-stored customer fields + the freshly
// computed stats (this fn runs inside computeStatsForCustomer, so the
// order-count / days-since numbers are the just-computed ones).
//
// Rules (priority: vip > lapsing > new > active):
//   new     — createdAt within 7 days AND orderCount == 0
//   vip     — lifetimeSpendCents >= CRM_VIP_CENTS
//   lapsing — has ordered (orderCount > 0) AND daysSinceLastOrder > 45
//   active  — everyone else who has ordered (orderCount > 0)
//   new     — fallthrough: no orders and not recent → still 'new'
//
// CRM_VIP_CENTS is the VIP spend threshold in cents. Tunable here — it
// is the ONE place the dollar cutoff lives. Default $250 = 25000.
const CRM_VIP_CENTS = 25000;

// Milliseconds in a day (used for the createdAt-recency check).
const _DAY_MS = 24 * 60 * 60 * 1000;

// Normalize a Firestore/JS timestamp-ish value to millis, or null.
function _tsMillis(v){
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (typeof v === 'number') return v;
  const n = new Date(v).getTime();
  return Number.isFinite(n) ? n : null;
}

/**
 * Compute the canonical crmSegment string for a customer.
 *
 * @param {object} customer  the customers/{uid} doc data (for createdAt,
 *                           lifetimeSpendCents, lastOrderAt as fallbacks)
 * @param {object} stats     the freshly-computed stats object
 *                           (orderCount, daysSinceLastOrder). May be a
 *                           partial customer doc during the onWrite path.
 * @returns {'new'|'vip'|'lapsing'|'active'}
 */
function computeCrmSegment(customer, stats){
  const c = customer || {};
  const s = stats || {};

  // orderCount — prefer the just-computed stat, fall back to the stored
  // aliases (orderCount / statsOrderCount) so the customers-onWrite path
  // (which passes the raw doc as `stats`) still resolves a count.
  const orderCount = Number(
    s.orderCount != null ? s.orderCount
      : (c.orderCount != null ? c.orderCount
        : (c.statsOrderCount != null ? c.statsOrderCount : 0))
  ) || 0;

  // Spend in cents — the authoritative VIP input (written by stripeWebhook).
  const spendCents = Number(c.lifetimeSpendCents) || 0;

  // daysSinceLastOrder — prefer the computed stat; else derive from
  // lastOrderAt (top-level) so the onWrite path works pre-backfill.
  let days = (s.daysSinceLastOrder != null) ? Number(s.daysSinceLastOrder)
    : (c.daysSinceLastOrder != null ? Number(c.daysSinceLastOrder) : null);
  if (days == null){
    const lastMs = _tsMillis(c.lastOrderAt);
    if (lastMs != null) days = Math.floor((Date.now() - lastMs) / _DAY_MS);
  }

  const createdMs = _tsMillis(c.createdAt);
  const recentlyCreated = createdMs != null && (Date.now() - createdMs) <= 7 * _DAY_MS;

  // Priority order: vip > lapsing > new > active.
  if (spendCents >= CRM_VIP_CENTS) return 'vip';
  if (orderCount > 0 && days != null && days > 45) return 'lapsing';
  if (recentlyCreated && orderCount === 0) return 'new';
  if (orderCount > 0) return 'active';
  return 'new'; // no orders and not recent → still 'new' (prospect)
}

// Lifecycle stage — derived from the LTV stats. Mirrors the rules in
// scripts/hq2.js enrichCustomer() so segment buckets (VIPs / Loyal /
// At-risk / Lapsed) stay consistent between client-derived and
// server-derived paths during the migration.
function _computeStage(stats, customer){
  // "Is this customer a subscriber" has exactly one answer — see
  // functions/src/lib/subscriber.js. This used to read the nested
  // `subscription.active`, which nothing has ever written, so 'subscriber'
  // was a stage no customer could reach.
  const subActive = isSubscriber(customer);
  const orderCount = Number(stats.orderCount) || 0;
  const ltvVal     = Number(stats.ltv) || 0;
  const days       = stats.daysSinceLastOrder;
  let stage;
  if (orderCount === 0)                                                  stage = 'lead';
  else if (ltvVal >= 500 && (days == null || days < 60))                 stage = 'vip';
  else if (orderCount >= 5)                                              stage = 'loyal';
  else if (orderCount >= 2 && days != null && days >= 30 && days < 60)   stage = 'atRisk';
  else if (days != null && days >= 60)                                    stage = 'lapsed';
  else if (orderCount === 1)                                              stage = 'new';
  else                                                                    stage = 'active';
  if (subActive && stage !== 'vip' && stage !== 'lapsed')                 stage = 'subscriber';
  if (customer && customer.archived === true)                             stage = 'archived';
  return stage;
}

/**
 * Pull the customer's last 365d of paid orders + run scoreFromOrders
 * + return a stats object ready to merge onto the customer doc.
 *
 * Returns null if the customer doesn't exist (we don't materialize
 * stats for ghost references).
 */
// `opts.queueClaimEmail` — see _stampClaimEmailDue. OFF by default and
// deliberately opt-in: this function is also called in bulk by the CRM
// backfill and the nightly churn sweep, and a stamp written from either
// of those would silently queue the entire pre-existing backlog of
// unclaimed guests on a schedule, with nobody having seen the list.
// Only a real order write may queue the email.
async function computeStatsForCustomer(db, customerId, opts){
  if (!customerId) return null;
  const customerRef = db.collection('customers').doc(customerId);
  const customerSnap = await customerRef.get();
  if (!customerSnap.exists){
    logger.warn('[customerStats] missing customer', { customerId });
    return null;
  }
  const customer = customerSnap.data() || {};

  // CRM shared-contract foundation fields. Stamp defaults ONLY when the
  // field is missing so we never clobber a market-booth origin, an
  // explicit marketing opt-in, or an earlier firstSeenAt. lastActiveAt
  // tracks "last time this customer's stats were touched by an order".
  const _foundation = {};
  if (customer.source == null)           _foundation.source = 'website';
  if (customer.firstSeenAt == null){
    _foundation.firstSeenAt = customer.createdAt
      || admin.firestore.FieldValue.serverTimestamp();
  }
  if (customer.marketingConsent == null) _foundation.marketingConsent = false;
  _foundation.lastActiveAt = admin.firestore.FieldValue.serverTimestamp();

  // Lookup orders by uid first, fall back to email. Some legacy
  // guest orders only have customerEmail set.
  const queries = [];
  queries.push(
    db.collection('orders')
      .where('uid', '==', customerId)
      .orderBy('createdAt', 'desc')
      .limit(200)
      .get()
      .catch(() => null)
  );
  const email = String(customer.email || '').toLowerCase().trim();
  if (email){
    queries.push(
      db.collection('orders')
        .where('customerEmail', '==', email)
        .orderBy('createdAt', 'desc')
        .limit(200)
        .get()
        .catch(() => null)
    );
  }
  const snaps = await Promise.all(queries);
  const pickupMarkets = await _loadPickupMarkets(db);

  // De-duplicate by doc id since uid + email queries can overlap
  const seen = new Set();
  const orders = [];
  snaps.forEach(snap => {
    if (!snap) return;
    snap.docs.forEach(d => {
      if (seen.has(d.id)) return;
      seen.add(d.id);
      orders.push(Object.assign({ id: d.id }, d.data()));
    });
  });

  // Filter to paid + sort newest-first (scoreFromOrders expects this)
  const paid = orders
    .filter(o => PAID_STATUSES.has(normStatus(o.status)))
    .sort((a, b) => {
      const at = (a.createdAt && a.createdAt.toMillis) ? a.createdAt.toMillis() : 0;
      const bt = (b.createdAt && b.createdAt.toMillis) ? b.createdAt.toMillis() : 0;
      return bt - at;
    });

  // Empty state — clear the stats so a customer who refunded their
  // only order goes back to "lead" cleanly.
  if (paid.length === 0){
    const emptyStats = {
      ltv: 0,
      lifetimeSpend: 0,
      orderCount: 0,
      aov: 0,
      lastOrderAt: null,
      firstOrderAt: null,
      predictedLtv: 0,
      churnRisk: 0.5,
      cadenceDays: null,
      daysSinceLastOrder: null,
      stage: _computeStage({ orderCount: 0, ltv: 0, daysSinceLastOrder: null }, customer),
      // No paid orders, but booth tags can still place them at a market —
      // someone who joined the wallet at Market A and never ordered online
      // is still a Market A contact.
      marketIds: _marketIdsFor(customer, [], pickupMarkets),
      statsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      statsSource: 'cf:customerStats',
    };
    emptyStats.crmSegment = computeCrmSegment(customer, emptyStats);
    return Object.assign(emptyStats, _foundation);
  }

  const score = ltv.scoreFromOrders(paid);
  const lastTs = (paid[0].createdAt && paid[0].createdAt.toMillis) ? paid[0].createdAt.toMillis() : 0;
  const firstTs = (paid[paid.length - 1].createdAt && paid[paid.length - 1].createdAt.toMillis)
    ? paid[paid.length - 1].createdAt.toMillis() : 0;

  const stats = {
    ltv: score.lifetimeSpend,
    lifetimeSpend: score.lifetimeSpend,           // alias kept for legacy readers
    orderCount: paid.length,
    aov: score.avgOrderValue,
    lastOrderAt: lastTs ? admin.firestore.Timestamp.fromMillis(lastTs) : null,
    firstOrderAt: firstTs ? admin.firestore.Timestamp.fromMillis(firstTs) : null,
    predictedLtv: score.predictedLtv,
    churnRisk: score.churnRisk,
    cadenceDays: score.cadenceDays,
    daysSinceLastOrder: score.daysSinceLastOrder,
    // Every market this customer has turned up at, online pickup + booth,
    // as canonical ids. Powers the `marketIs` segment filter — see
    // functions/src/crm/segments.js.
    marketIds: _marketIdsFor(customer, paid, pickupMarkets),
    statsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    statsSource: 'cf:customerStats',
  };
  stats.stage = _computeStage(stats, customer);
  stats.crmSegment = computeCrmSegment(customer, stats);
  Object.assign(stats, _foundation);
  if (opts && opts.queueClaimEmail) _stampClaimEmailDue(stats, customer);

  return stats;
}

/* ─── Guest account-claim email: stamp the queue slot ────────────────
   A guest checkout provisions a real Firebase user with claimed:false
   (_v2LookupOrCreateGuestUser), so the customer owns an account they
   have never been told about and cannot open. The one email that tells
   them lives behind a due-at stamp swept by _sweepGuestClaimEmails
   (functions/index.js), the same self-draining single-field queue the
   held-invoice-quote sweep uses: a range query on ONE field needs no
   composite index, and handling a doc deletes the field, so the queue
   drains itself and can never grow into a scan.

   This function answers only WHEN. Everything about WHETHER to send —
   have they signed in since, is this a retail order, is the customer on
   a comms hold — belongs to the sweep, which is where the Auth and
   order reads already happen. Keeping the decision out of here stops a
   stats module from quietly owning messaging policy.

   Stamped once and only once: the sweep stamps claimEmailSentAt or
   claimEmailSkippedAt when it decides, and both are checked here, so a
   later order write on the same customer cannot re-queue an email that
   has already been sent or already been ruled out.
   ──────────────────────────────────────────────────────────────────── */
const CLAIM_EMAIL_DELAY_MS = 3 * 24 * 60 * 60 * 1000;   // 3 days (Omar, aug 2026)

function _stampClaimEmailDue(stats, customer){
  const c = customer || {};
  // Only guest-born accounts that are still unclaimed, and only once.
  if (c.claimed !== false) return;
  if (c.claimEmailSentAt || c.claimEmailSkippedAt || c.claimEmailDueAt) return;
  if (!stats.firstOrderAt || !stats.firstOrderAt.toMillis) return;
  stats.claimEmailDueAt = admin.firestore.Timestamp.fromMillis(
    stats.firstOrderAt.toMillis() + CLAIM_EMAIL_DELAY_MS
  );
}

async function _writeStats(db, customerId, stats){
  if (!customerId || !stats) return;
  await db.collection('customers').doc(customerId).set(stats, { merge: true });
}

// ─── Trigger: order write → recompute that customer's stats ────────

const customerStatsOnOrderWritten = onDocumentWritten('orders/{orderId}', async (event) => {
  try {
    const before = event.data && event.data.before && event.data.before.exists
      ? event.data.before.data() : null;
    const after = event.data && event.data.after && event.data.after.exists
      ? event.data.after.data() : null;
    if (!after && !before) return;

    const db = admin.firestore();

    // We may need to recompute TWO customers if the order's email
    // / uid changed mid-stream (rare but possible — e.g. a guest
    // order linked to an account post-checkout). De-dupe by id.
    const ids = new Set();
    const beforeId = before ? await _customerIdFromOrder(db, before) : null;
    const afterId  = after  ? await _customerIdFromOrder(db, after)  : null;
    if (beforeId) ids.add(beforeId);
    if (afterId)  ids.add(afterId);
    if (!ids.size){
      // Order has no resolvable customer — nothing to update
      return;
    }

    for (const id of ids){
      // A real order write is the ONE path allowed to queue the guest
      // account-claim email (see computeStatsForCustomer opts).
      const stats = await computeStatsForCustomer(db, id, { queueClaimEmail: true });
      if (stats) await _writeStats(db, id, stats);
    }
  } catch (err) {
    logger.error('[customerStats] order trigger failed', {
      err: err && err.message,
      orderId: event.params && event.params.orderId,
    });
  }
});

// ─── Trigger: order CREATE → stamp canonical crmSegment (Phase 3) ──
// The onDocumentWritten trigger above already recomputes the whole
// stats bundle (crmSegment included) on every order write. This
// explicit onDocumentCreated trigger is a thin, spec-mandated belt-and-
// suspenders: when a brand-new order lands, make sure that order's
// customer has a fresh crmSegment (e.g. a first order should flip a
// 'new' prospect to 'active'). It reuses the same idempotent compute,
// so running alongside the onWritten trigger is harmless (last write
// wins, identical output).
const customerSegmentOnOrderCreated = onDocumentCreated('orders/{orderId}', async (event) => {
  try {
    const order = event.data && event.data.exists ? event.data.data() : null;
    if (!order) return;
    const db = admin.firestore();
    const customerId = await _customerIdFromOrder(db, order);
    if (!customerId) return;
    // A brand-new order means whatever was in this customer's cart just
    // converted — close the recovery snapshot so the abandoned-cart crons
    // don't nudge them about the order they just placed. Piggybacked here
    // rather than in its own trigger to avoid burning a us-central1
    // function slot (see CLAUDE-LESSONS: quota exhausted at ~200).
    await _closeAbandonedCart(db, customerId);
    const stats = await computeStatsForCustomer(db, customerId);
    if (stats) await _writeStats(db, customerId, stats);
  } catch (err) {
    logger.error('[customerStats] order-created segment trigger failed', {
      err: err && err.message,
      orderId: event.params && event.params.orderId,
    });
  }
});

// ─── Trigger: customer WRITE → keep crmSegment in sync (Phase 3) ───
// Some inputs to the canonical segment change WITHOUT an order write —
// most importantly `lifetimeSpendCents`, which stripeWebhook increments
// directly on the customer doc (functions/index.js ~9574). This trigger
// recomputes crmSegment from the AFTER doc and writes it back ONLY if it
// actually changed.
//
// ⚠ LOOP GUARD (critical): this trigger writes to the SAME collection it
// listens on, so it MUST bail unless the segment label truly changes.
// We compute the new segment from the after-image, compare it to the
// after-image's existing crmSegment, and update ONLY when they differ.
// Writing an unchanged value (or touching updatedAt) would re-fire this
// trigger forever. The `update({crmSegment})` below is therefore reached
// at most once per real segment transition, and its own resulting write
// produces after.crmSegment === computed → next invocation bails. No loop.
const customerSegmentOnWrite = onDocumentWritten('customers/{uid}', async (event) => {
  try {
    const after = event.data && event.data.after && event.data.after.exists
      ? event.data.after.data() : null;
    // Deleted doc → nothing to stamp.
    if (!after) return;

    // Compute from the after-image. We pass `after` as BOTH customer and
    // stats: computeCrmSegment reads orderCount / daysSinceLastOrder /
    // lifetimeSpendCents / createdAt / lastOrderAt, all of which live on
    // the customer doc itself (materialized by the order triggers).
    const next = computeCrmSegment(after, after);
    const current = after.crmSegment;

    // LOOP GUARD — bail if the segment didn't change. This is the ONLY
    // thing standing between us and an infinite self-trigger loop.
    if (next === current) return;

    const db = admin.firestore();
    await db.collection('customers').doc(event.params.uid).update({
      crmSegment: next,
    });
  } catch (err) {
    logger.error('[customerStats] customer-write segment trigger failed', {
      err: err && err.message,
      uid: event.params && event.params.uid,
    });
  }
});

// ─── HTTP: manual backfill (staff-only) ────────────────────────────

const customerStatsBackfill = onRequest({ cors: false, timeoutSeconds: 540 }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST'){
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  let staff = null;
  try {
    const { verifyStaff } = require('../lib/auth');
    staff = await verifyStaff(req);
  } catch (e) {
    logger.warn('customerStatsBackfill auth check failed', e.message);
  }
  if (!staff){
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  try {
    const db = admin.firestore();
    const limit = Math.min(5000, Math.max(1, Number(req.body && req.body.limit) || 2000));
    const startAfter = (req.body && req.body.startAfter) || null;

    let q = db.collection('customers').orderBy(admin.firestore.FieldPath.documentId()).limit(limit);
    if (startAfter){
      const s = await db.collection('customers').doc(startAfter).get();
      if (s.exists) q = q.startAfter(s);
    }
    const snap = await q.get();

    let updated = 0;
    let lastId = null;
    // Process in chunks of 25 to avoid hitting OOM on huge batches.
    const CHUNK = 25;
    for (let i = 0; i < snap.docs.length; i += CHUNK){
      const slice = snap.docs.slice(i, i + CHUNK);
      await Promise.all(slice.map(async d => {
        const stats = await computeStatsForCustomer(db, d.id);
        if (stats){
          await _writeStats(db, d.id, stats);
          updated++;
        }
        lastId = d.id;
      }));
    }

    return res.status(200).json({
      ok: true,
      scanned: snap.size,
      updated,
      lastId,
      hasMore: snap.size === limit,
    });
  } catch (err) {
    logger.error('[customerStats] backfill failed', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ─── SCHEDULED: nightly churn / recency recompute ──────────────────
// A customer whose stats were last touched by an order write can go
// stale on the recency-derived fields (churnRisk / daysSinceLastOrder /
// stage) simply because TIME passed — no order needs to write for a
// 30-day-quiet customer to cross into "atRisk". This nightly sweep
// re-runs the SAME per-customer compute for the customers whose stats
// haven't been recomputed recently, so the win-back enrollment sweep
// (which runs ~1h later) evaluates fresh recency buckets.
//
// Paginated + capped so a nightly run never fans out unbounded. Reads
// only; the per-customer compute is idempotent (same input → same
// output). This does NOT message anyone — it only refreshes rollup
// fields on the customer doc.
const CHURN_SWEEP_MAX = 400;         // hard cap on recomputes per run
const CHURN_SWEEP_STALE_HOURS = 18;  // skip docs recomputed more recently

const customerStatsChurnSweep = onSchedule({
  schedule: '0 2 * * *',            // 02:00 CT, before the win-back sweep (03:00)
  timeZone: 'America/Chicago',
}, async () => {
  const db = admin.firestore();
  const now = Date.now();
  const staleCutoff = admin.firestore.Timestamp.fromMillis(
    now - CHURN_SWEEP_STALE_HOURS * 3600 * 1000
  );

  let scanned = 0, updated = 0, skipped = 0;
  try {
    // Oldest-recomputed first so we always make progress on the most
    // stale docs. Customers never recomputed (no statsUpdatedAt) sort
    // first under an ascending order on the field.
    const snap = await db.collection('customers')
      .orderBy('statsUpdatedAt', 'asc')
      .limit(CHURN_SWEEP_MAX)
      .get()
      .catch(async (e) => {
        // Missing index / field on legacy docs — fall back to an id scan.
        logger.warn('[customerStats] churn sweep ordered query failed, id-scan fallback', { e: e.message });
        return db.collection('customers')
          .orderBy(admin.firestore.FieldPath.documentId())
          .limit(CHURN_SWEEP_MAX)
          .get();
      });

    for (const doc of snap.docs){
      scanned++;
      const c = doc.data() || {};
      const last = c.statsUpdatedAt;
      // Skip docs already recomputed within the stale window (they were
      // just touched by an order write or a prior sweep page).
      if (last && last.toMillis && last.toMillis() >= staleCutoff.toMillis()){
        skipped++;
        continue;
      }
      const stats = await computeStatsForCustomer(db, doc.id);
      if (stats){
        await _writeStats(db, doc.id, stats);
        updated++;
      }
    }
  } catch (err){
    logger.error('[customerStats] churn sweep failed', { err: err && err.message });
  }
  logger.info('[customerStats] churn sweep', { scanned, updated, skipped });
});

module.exports = {
  computeStatsForCustomer,
  computeCrmSegment,          // pure helper (exported for testability)
  CRM_VIP_CENTS,              // tunable VIP threshold (cents)
  customerStatsOnOrderWritten,
  customerSegmentOnOrderCreated,
  customerSegmentOnWrite,
  customerStatsChurnSweep,
  // NOTE: customerStatsBackfill now stamps crmSegment too (it calls
  // computeStatsForCustomer, which includes crmSegment) — it is the
  // one-shot backfill endpoint the owner runs after deploy. No separate
  // crmSegment backfill is needed.
  customerStatsBackfill,
};
