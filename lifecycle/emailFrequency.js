'use strict';

/* ════════════════════════════════════════════════════════════════════
   EMAIL FREQUENCY — how many soft emails one person gets in a week

   THE PROBLEM THIS SOLVES
   Every email sender in this system guards against ITSELF repeating — a
   per-message `*Sent` flag, a claimed reminder slot, a dedup log. Not one
   of them knows another exists. So a weekly subscriber collected the
   union of all of them: renewal heads-up, order confirmation, locked-in,
   ready, review request, the Wednesday menu blast, the wellness report
   and the referral share nudge — about eight emails a week, every week,
   for as long as they stay subscribed (Omar, Aug 2026: "the referral
   nudge goes out too many times, and then the abandon cart, renewal etc
   all stack").

   TEXTS ALREADY HAD THIS AND EMAIL DIDN'T. `smsDailyLog` in
   src/sms/queue.js caps planned texts at one per phone per day, exempts
   receipts, and counts every send so a soft text after a receipt is held.
   Nothing equivalent existed on the email side, which is the whole reason
   the stack grew there and not in the texts.

   WHERE IT RUNS
   ONE call site — onMailCreated (functions/index.js), the trigger every
   customer email already funnels through, right where the preference,
   suppression and comms-hold gates already sit. Deliberately NOT a check
   inside each sender: that is exactly how the existing suppression layers
   drifted apart, and it is the same reasoning commSkip's header sets out.

   FAIL OPEN. A lookup or transaction error SENDS the email. A volume
   control must never become the reason a customer misses their receipt.
   ──────────────────────────────────────────────────────────────────── */

const _commSkip = require('./commSkip');

/* ────────────────────────────────────────────────────────────────────
   WHAT COUNTS AS "SOFT"

   Exactly commSkip's MARKETING_TYPES — anything whose purpose is to
   bring someone back or sell them something. Reused rather than
   re-listed so a new marketing message type is governed the day it is
   added, instead of quietly escaping a second hand-typed list. That
   drift is the bug this file's neighbours keep having.

   Everything else — receipts, payment problems, order ready, locked-in,
   pickup and delivery logistics, the renewal heads-up, cancellations —
   is transactional. It is never held AND never counted. Not counting it
   is the deliberate half: a subscriber's three order emails would
   otherwise consume the whole week's budget and they would receive no
   marketing at all, which is a different decision from the one made
   here.
   ──────────────────────────────────────────────────────────────────── */
function isSoft(type){
  return _commSkip.isMarketingType(type);
}

/* ────────────────────────────────────────────────────────────────────
   THE BUDGET

   Two soft emails per recipient per rolling 7 days (Omar's call, Aug
   2026, over a looser 3 and a texts-style one-per-day — one-per-day
   sounds tighter and is not: it still permits seven a week as long as
   they land on different days).

   Rolling, not calendar: a Sunday-night blast and a Monday-morning one
   are two emails in a day however you slice the week, so the window
   follows the recipient rather than the calendar.
   ──────────────────────────────────────────────────────────────────── */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SOFT_CAP  = 2;

/* ────────────────────────────────────────────────────────────────────
   TWO TIERS, BECAUSE FIRST-COME-FIRST-SERVED PICKS THE WRONG WINNER

   A flat cap is decided by whichever job happens to run first, and the
   jobs do not fire in order of worth. The referral share nudge runs
   every morning at 11:00; the menu blast runs once, on Wednesday. A flat
   cap of two would hand both weekly slots to the nudge before the blast
   ever ran — the least valuable message reliably beating the most, every
   week. That is the complaint, not the fix for it.

   So the lower tier may only ever take the FIRST slot:

     • CORE    — may use the full budget (up to SOFT_CAP).
                 The menu blast, journeys, win-backs, an abandoned cart,
                 the review ask, the welcome, the weekly wellness report.
                 Each is either about something the customer just did or
                 is the one scheduled thing we have to say this week.

     • CHATTER — sends only when the week is otherwise EMPTY (count 0),
                 leaving the second slot for a core message that has not
                 run yet. Reminders with no news in them: the referral
                 share nudge, a loyalty balance nudge, a birthday note.
                 Someone who hears from us about anything else that week
                 does not also need these.

   The effect on the referral nudge is the point: an engaged customer
   already getting the menu drop never sees it, a dormant one still does.
   ──────────────────────────────────────────────────────────────────── */
const CHATTER_TYPES = new Set([
  'referral',
  'loyalty_reward',
  'birthday',
]);

// How many of the week's slots this type is allowed to occupy. Chatter
// gets 1, so it needs a completely quiet week; core gets the full budget.
function budgetFor(type){
  return CHATTER_TYPES.has(String(type || '')) ? 1 : SOFT_CAP;
}

// Firestore doc-id-safe key. Keyed on the recipient ADDRESS, not the
// customer id, for the same reason the text cap keys on the phone: it
// matches who actually gets the email, so guests, leads and blast
// recipients with no account are covered too.
function recipientKey(email){
  return String(email || '').trim().toLowerCase().replace(/\//g, '_').slice(0, 400);
}

function _toMillis(v){
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function')   return v.toDate().getTime();
  if (v instanceof Date)                return v.getTime();
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

// Recent sends still inside the window, newest last. Exported for the
// test and for HQ2's "why was this held" answer.
function windowSends(doc, now){
  const cut = (now || Date.now()) - WINDOW_MS;
  const raw = (doc && Array.isArray(doc.sends)) ? doc.sends : [];
  return raw
    .map(s => ({ at: _toMillis(s && s.at), type: (s && s.type) || '' }))
    .filter(s => s.at > cut)
    .sort((a, b) => a.at - b.at);
}

/* ────────────────────────────────────────────────────────────────────
   claimSlot — the one question onMailCreated asks.

   Returns null to send, or { reason, type, count, cap } to hold.

   The read, the prune, the count and the append happen in ONE
   transaction. Without it two senders firing in the same second both
   read a count of 1 and both send, which is precisely the stacking this
   exists to stop — and the two worst offenders (the 11:00 referral job
   and the Wednesday blast) are cron jobs that fan out in bulk, so
   simultaneous sends to one address are the normal case, not the rare
   one.

   A slot is claimed only when the email is actually going to send, so
   this runs LAST among the gates — the same ordering, for the same
   reason, as the text cap: a message that would have been dropped by a
   preference, a suppression or a staff hold must never burn the week's
   budget on its way to being dropped.
   ──────────────────────────────────────────────────────────────────── */
async function claimSlot(db, admin, { template, to }){
  try {
    const type = _commSkip.messageType({ template });
    if (!isSoft(type)) return null;             // transactional — exempt, uncounted

    const key = recipientKey(to);
    if (!key) return null;                      // nothing to key on — send

    const ref = db.collection('emailFrequencyLog').doc(key);
    const now = Date.now();
    const cap = budgetFor(type);

    const held = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur  = snap.exists ? (snap.data() || {}) : {};
      const recent = windowSends(cur, now);

      if (recent.length >= cap){
        return { count: recent.length, cap };
      }

      // Keep only what the window still needs, plus this send. Bounded so
      // the doc can't grow without limit on a heavily-mailed address.
      const kept = recent.slice(-(SOFT_CAP * 4));
      tx.set(ref, {
        email: String(to || '').toLowerCase(),
        sends: kept.concat([{ at: now, type }]).map(s => ({ at: s.at, type: s.type })),
        lastAt: admin.firestore.FieldValue.serverTimestamp(),
        lastType: type,
        // Lets a Firestore TTL policy sweep addresses that went quiet.
        expireAt: new Date(now + 30 * 24 * 3600 * 1000),
      }, { merge: true });
      return null;
    });

    if (held){
      return {
        reason: 'frequency_cap:' + type,
        type,
        count: held.count,
        cap: held.cap,
      };
    }
    return null;
  } catch (e){
    // FAIL OPEN — see the header.
    console.error('[emailFrequency] check failed, sending anyway:', e && e.message);
    return null;
  }
}

module.exports = {
  claimSlot,
  isSoft,
  budgetFor,
  windowSends,
  recipientKey,
  CHATTER_TYPES,
  SOFT_CAP,
  WINDOW_MS,
};
