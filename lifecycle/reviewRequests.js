'use strict';

/* ════════════════════════════════════════════════════════════════════
   REVIEW-REQUEST SELECTION — who gets asked "how was your order?"

   The SELECTION half of the sendReviewRequests cron, split out of the
   send loop and into its own module for one reason: so the Comms ·
   Schedule board's dry run can call the REAL filter instead of a
   mirrored copy of it. That is the shape src/comms/dryRun.js asks every
   new cron to use, and orderLockedIn.js already follows.

   Nothing in here writes, sends, or stamps. Reads only.

   Why the cron had never sent a single email, both bugs fixed together:

   1. It filtered on ['Completed','Ready'] — capitalized. Firestore
      string matching is case-SENSITIVE and every writer stores
      lowercase, so it matched nothing and logged "found 0 recent
      orders" every run.
   2. It keyed its window off `createdAt` — when the order was PLACED —
      and looked back only 4 days. The weekly cycle is order by
      thursday, collect sunday, so at the wednesday run a normal order
      was placed 6-9 days earlier and fell outside the window EVERY
      time. The status list also omitted 'picked_up', which is exactly
      what the staff app writes when someone hands an order over at the
      market.

   The question this cron wants to ask is "who RECEIVED food a few days
   ago", so it keys off `pickupDate`: the zero-padded 'YYYY-MM-DD'
   fulfillment day carried by pickup AND delivery orders alike (a
   string, so >= / <= compare lexicographically). Backed by the existing
   (status, pickupDate) composite index — no new index needed.
   ════════════════════════════════════════════════════════════════════ */

const {FULFILLED_STATUSES} = require('../lib/orderStatus');
const _fulfillmentSchedule = require('../lib/fulfillmentSchedule');

/* Every status meaning "the customer has the food", pickup and delivery.
   Built from the shared canon rather than hand-typed: the last hand-typed
   copy is what dropped 'picked_up'. */
const REVIEW_ELIGIBLE_STATUSES = [
  ...FULFILLED_STATUSES,    // delivered · picked_up · completed
  'fulfilled',              // legacy alias for completed; still on old docs
  /* Handed over but never tapped. Staff at a market routinely don't tap
     "picked up", and a driver can close a route without marking the last
     stop, so real orders sit at 'ready'/'out_for_delivery' forever. Safe
     to include ONLY because of the settle gap below: the fulfillment date
     must be at least REVIEW_SETTLE_DAYS past, by which point the food was
     collected whether or not anyone tapped a button. Shrink that gap and
     you have to drop these two statuses with it. */
  'ready',
  'out_for_delivery',
];

/* Window, in days back from the run date. The floor gives one spare
   weekend of slack so a single failed run doesn't lose a week of
   customers, and hard-stops a first-run-after-a-fix from back-filling
   months of history.

   THE SETTLE GAP IS THE LOAD-BEARING ONE (Omar, Aug 2 2026: "it cannot go
   to anyone who got their food aug 2 and beyond"). A fulfilment date is
   not proof the food changed hands. Staff mark orders in bulk, an order
   can be flipped to 'ready' days BEFORE its pickup date, and a date that
   is merely scheduled may still be in the future — the live data on the
   day this was set had a Monday order sitting at 'ready' for the NEXT
   day, which a 2-day gap would happily have asked about.

   At 2 days a Wednesday run reached Monday, i.e. yesterday and today's
   food. At 4 it stops at the preceding Saturday, so every order it asks
   about was collected at a market that has since packed up and gone home.
   Asking "how was it?" before someone has eaten is worse than not asking:
   it is unanswerable, and it burns the one ask that order will ever get.

   If this moves again, move it UP. Moving it down walks back toward
   asking people about food they are still waiting for. */
const REVIEW_LOOKBACK_DAYS = 14;
const REVIEW_SETTLE_DAYS   = 4;

/* Runaway backstop, not a policy cap. A normal run is a handful of
   people; anything near this means the window logic broke, and we would
   rather stop than mail hundreds at once. Logged loudly when hit — never
   a silent truncation. */
const REVIEW_MAX_PER_RUN = 300;

function reviewWindow(nowMs) {
  const todayStr = _fulfillmentSchedule.ctDateStr(nowMs);
  return {
    floorStr:   _fulfillmentSchedule.addDays(todayStr, -REVIEW_LOOKBACK_DAYS),
    ceilingStr: _fulfillmentSchedule.addDays(todayStr, -REVIEW_SETTLE_DAYS),
  };
}

/* Everyone who must NOT be asked, by email and by uid.

   ASK A PERSON ONCE, EVER (Omar, Aug 2 2026: "if someone has gotten a
   review sent already they shouldn't get any other"). The idempotency flag
   lives on the ORDER, which only ever promised that one ORDER is not asked
   about twice. A regular — exactly the customer you least want to annoy —
   would otherwise be asked again every time they bought, forever. There is
   also nothing to gain: a person can leave you one Google review, so the
   second ask can only ever be nagging.

   Keyed on BOTH email and uid so neither a changed address nor a guest
   checkout can open a second door. `.select()` fetches just the two fields
   instead of whole order docs, so this stays cheap as history grows.

   TWO different facts feed this, and they are not the same thing:

     1. WE ASKED THEM — `orders.reviewRequestSent`, written by this sender.
     2. THEY ALREADY REVIEWED — `customers.reviewAskOptOut`, set by a human
        who saw the review land.

   (2) exists because nothing can detect it. The email asks for a GOOGLE
   review; `gbpReviews` is empty (no sync), and the on-site `recipeReviews`
   carry a first name and no email, so there is no key to join on. A person
   has to record it.

   Do NOT be tempted to express "they already reviewed" by stamping
   `reviewRequestSent` on their order instead. That writes a lie into the
   data — the exact shape of the bug that had one customer permanently
   marked as asked when no email ever reached her, because the scrapped SMS
   producer stamped a send that never happened. Keep the two facts apart. */
async function loadDoNotAsk(db) {
  const [askedSnap, optOutSnap] = await Promise.all([
    db.collection('orders')
      .where('reviewRequestSent', '==', true)
      .select('customerEmail', 'uid')
      .get(),
    db.collection('customers')
      .where('reviewAskOptOut', '==', true)
      .select('email')
      .get(),
  ]);

  const emails = new Set(), uids = new Set();
  const add = (email, uid) => {
    const e = String(email || '').trim().toLowerCase();
    if (e) emails.add(e);
    if (uid) uids.add(String(uid));
  };
  for (const d of askedSnap.docs)  { const o = d.data() || {}; add(o.customerEmail, o.uid); }
  // A customer doc's id IS the uid, so the doc id covers anyone whose
  // address on file differs from the one their order carried.
  for (const d of optOutSnap.docs) { const o = d.data() || {}; add(o.email, d.id); }

  return {emails, uids};
}

/* Reads only. `isCatering` is injected rather than imported so this module
   stays free of functions/index.js (which requires dryRun.js, which
   requires this — importing back would close the loop). */
async function selectReviewOrders(db, floorStr, ceilingStr, isCatering) {
  const [snap, doNotAsk] = await Promise.all([
    db.collection('orders')
      .where('status', 'in', REVIEW_ELIGIBLE_STATUSES)
      .where('pickupDate', '>=', floorStr)
      .where('pickupDate', '<=', ceilingStr)
      .get(),
    loadDoNotAsk(db),
  ]);

  const eligible = [];
  const skipped  = {already_asked: 0, do_not_ask: 0, no_email: 0,
                    no_items: 0, catering: 0, same_person: 0};

  for (const doc of snap.docs) {
    const order = doc.data();
    if (!order.customerEmail) { skipped.no_email++; continue; }
    if (!(order.items || []).some(i => i.recipeId || i.id)) { skipped.no_items++; continue; }

    /* Already asked on ANY order ever, or flagged by a human as having
       already reviewed. Nothing brings either back. */
    const email = String(order.customerEmail).trim().toLowerCase();
    if (doNotAsk.emails.has(email) || (order.uid && doNotAsk.uids.has(String(order.uid)))) {
      skipped.do_not_ask++; continue;
    }

    /* Catering is excluded from every automated customer message (locked
       rule — CLAUDE.md "Orders have TWO axes", rule 4). A negotiated
       corporate job gets a human follow-up, never an automated "leave us a
       google review". Read through the caller's axes normalizer so legacy
       single-axis docs (fulfillmentType:'catering') are excluded too. */
    if (isCatering(order)) { skipped.catering++; continue; }

    if (order.reviewRequestSent) { skipped.already_asked++; continue; }
    eligible.push({doc, order});
  }

  /* ONE ASK PER PERSON PER RUN.
     The idempotency flag lives on the ORDER, so a customer with two
     fulfilled orders in the window passes every guard twice and gets two
     identical "how was your order?" emails in the same minute. A dry run
     against live data caught exactly this: over Jul 22 - Aug 3, fourteen
     emails were going to twelve people, two of them served twice.

     So: group by email, keep the most RECENT order (the one they actually
     remember), and let the caller stamp the older siblings as asked
     without mailing them — otherwise they simply come back around next
     Wednesday and re-create the double.

     Same family as the locked "ONE text per market morning" rule: the
     count of messages a person gets is the thing being controlled, not
     the number of records that happen to qualify. */
  const byPerson = new Map();
  for (const e of eligible) {
    const key  = String(e.order.customerEmail).trim().toLowerCase();
    const prev = byPerson.get(key);
    if (!prev) { byPerson.set(key, {lead: e, siblings: []}); continue; }
    // Later fulfillment date wins; ties keep the incumbent.
    if (String(e.order.pickupDate || '') > String(prev.lead.order.pickupDate || '')) {
      prev.siblings.push(prev.lead);
      prev.lead = e;
    } else {
      prev.siblings.push(e);
    }
  }
  const people = [...byPerson.values()];
  skipped.same_person = people.reduce((n, p) => n + p.siblings.length, 0);

  return {scanned: snap.size, eligible, people, skipped};
}

module.exports = {
  selectReviewOrders,
  reviewWindow,
  REVIEW_ELIGIBLE_STATUSES,
  REVIEW_LOOKBACK_DAYS,
  REVIEW_SETTLE_DAYS,
  REVIEW_MAX_PER_RUN,
};
