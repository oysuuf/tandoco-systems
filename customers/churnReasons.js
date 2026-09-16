'use strict';

/* ════════════════════════════════════════════════════════════════════
   WHY PEOPLE LEAVE — the one list, and the one place it's validated.

   WHY THIS EXISTS
   The cancel sheet has asked "mind sharing why? (optional)" as a free-text
   box for months. Across **21 cancelled subscriptions** it collected
   exactly **one** answer, and that one was somebody testing the box.
   An optional textarea at the end of a
   cancel flow is, in practice, a question nobody answers — you are asking
   someone to write an essay at the exact moment they have decided to
   leave.

   One tap answers it. So the reasons are a fixed list of chips, and the
   free text becomes an optional extra rather than the whole ask.

   ── THE RULE THIS MUST NOT BREAK ────────────────────────────────────
   Cancelling stays as easy as signing up was. The cancel sheet carries a
   standing note about it (FTC click-to-cancel): the retention offer and
   pause sit BESIDE the confirm button as equal-weight options, never as
   gates in front of it. That flow was already reduced from a three-step
   gauntlet once; do not walk it back.

   A reason picker is compatible with that rule for exactly one reason:
   **`prefer_not_to_say` is always on the list.** Choosing a reason is one
   tap, and one of the taps is "rather not". Nobody is ever held, argued
   with, or asked twice. If you are tempted to remove that option to raise
   the answer rate, you have turned a question into a toll booth — don't.

   And the server NEVER fails a cancellation over a reason: an unknown,
   missing or malformed value is recorded as `unknown` and the
   subscription is cancelled exactly the same. The reason is telemetry.
   The cancellation is the customer's decision, already made.

   ── KEEP THE THREE LISTS IDENTICAL ──────────────────────────────────
   These slugs are written to Firestore and read back on reporting
   surfaces, so they are a data contract, not copy:

     • this file                          — server validation (source of truth)
     • account.html   `CANCEL_REASONS`    — the web sheet's chips
     • food-app/App.swift `ChurnReason`   — the iOS sheet's chips
     • scripts/hq2.js `CHURN_REASON_LABELS` — how staff read them back

   Adding or renaming a reason means touching all four in the SAME PR.
   Never repurpose an existing slug: the old rows keep the old meaning and
   the chart silently starts lying about last quarter.
   ════════════════════════════════════════════════════════════════════ */

/* Slug → the label a customer taps. Order is the display order, chosen so
   the most common answers sit first and `prefer_not_to_say` sits last
   without being buried. */
const CHURN_REASONS = [
  { slug: 'too_expensive',   label: 'too expensive' },
  { slug: 'too_much_food',   label: 'too much food' },
  { slug: 'not_enough_variety', label: 'not enough variety' },
  { slug: 'food_quality',    label: 'the food itself' },
  { slug: 'delivery_pickup', label: 'delivery or pickup' },
  { slug: 'moving',          label: 'moving away' },
  { slug: 'taking_a_break',  label: 'just taking a break' },
  { slug: 'prefer_not_to_say', label: 'rather not say' },
];

const CHURN_REASON_SLUGS = CHURN_REASONS.map(r => r.slug);

/* Recorded when the customer cancelled through a surface that never asked
   (the old flow, staff cancelling on someone's behalf, an API caller).
   Deliberately NOT one of the pickable options — "we didn't ask" and
   "they declined to answer" are different facts and reports need to tell
   them apart. */
const CHURN_REASON_UNKNOWN = 'unknown';

/* Free-text detail cap. Long enough for a real sentence or two, short
   enough that nobody pastes a novel into a Firestore doc. */
const CHURN_NOTE_MAX = 400;

/**
 * Coerce whatever a client sent into something safe to store.
 * Never throws — a cancellation must not fail over its own telemetry.
 *
 * @returns {{reason: string, note: string|null, recognized: boolean}}
 */
function normalizeChurnReason(reason, note) {
  const slug = String(reason == null ? '' : reason).trim().toLowerCase();
  const recognized = CHURN_REASON_SLUGS.indexOf(slug) >= 0;
  const clean = String(note == null ? '' : note)
    // Strip control characters so a note can't corrupt a log line or a CSV
    // export of the churn report.
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, CHURN_NOTE_MAX);
  return {
    reason: recognized ? slug : CHURN_REASON_UNKNOWN,
    note:   clean || null,
    recognized,
  };
}

/** Human label for a stored slug, for emails/reports. */
function churnReasonLabel(slug) {
  const found = CHURN_REASONS.find(r => r.slug === slug);
  return found ? found.label : 'not given';
}

module.exports = {
  CHURN_REASONS,
  CHURN_REASON_SLUGS,
  CHURN_REASON_UNKNOWN,
  CHURN_NOTE_MAX,
  normalizeChurnReason,
  churnReasonLabel,
};
