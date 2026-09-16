'use strict';

/* ════════════════════════════════════════════════════════════════════
   JOURNEY ENGINE — self-firing automation flows
   ────────────────────────────────────────────────────────────────────
   Turns the HQ2 Journey Builder from a screen that saves flows into an
   engine that runs them. A journey is: a TRIGGER (who enters) + an
   ordered list of STEPS (wait N days · send an email · send an SMS).
   Linear for v1 — no branching yet.

   SAFETY (this sends real messages, so it's guarded hard):
     • A journey only fires when status === 'live'. New journeys default
       to 'draft'. A global kill-switch (settings/featureFlags
       .journeysEnginePaused === true) freezes everything.
     • Each customer enrolls in a given journey AT MOST ONCE — the
       enrollment doc id is `${journeyId}_${uid}`.
     • State advances inside a transaction BEFORE any send, so overlapping
       cron runs can't double-send (at-most-once: a crash drops a message
       rather than duplicating it).
     • Per-run caps on both enrollment and processing.
     • Email steps carry their OWN subject + HTML (built in the block
       designer) and send as template:'custom' — so they run through the
       same suppression + unsubscribe gate as any marketing email, and
       there's no code-template-vs-commTemplates ambiguity.

   Invoked from an existing 15-min cron (no new Cloud Function).

   Collections:
     journeys/{id}                     — the flow definition
     journeyEnrollments/{jid}_{uid}    — one customer's progress
   ════════════════════════════════════════════════════════════════════ */

const ENROLL_CAP_PER_RUN  = 300;   // new enrollments created per cron tick
const PROCESS_CAP_PER_RUN = 300;   // enrollments advanced per cron tick
const CUSTOMER_SCAN_CAP   = 3000;

function _ms(ts){
  if (!ts) return 0;
  if (ts.toMillis) return ts.toMillis();
  if (ts._seconds) return ts._seconds * 1000;
  if (ts.seconds) return ts.seconds * 1000;
  const n = new Date(ts).getTime();
  return isNaN(n) ? 0 : n;
}

function _wrapEmail(subject, body){
  const bodyHTML = String(body || '').replace(/\n/g, '<br>');
  return '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F5F3EE;font-family:\'Helvetica Neue\',Helvetica,Arial,sans-serif;">' +
    '<table role="presentation" width="100%" style="background:#F5F3EE;"><tr><td align="center" style="padding:32px 16px;">' +
    '<table role="presentation" width="100%" style="max-width:540px;background:#fff;border-radius:20px;border:1px solid #E8E4D8;">' +
    '<tr><td style="padding:32px 36px 16px;"><div style="font-size:22px;font-weight:900;color:#1B1A6B;">tandoco</div></td></tr>' +
    '<tr><td style="padding:0 36px 32px;font-size:15px;line-height:1.8;color:#2C2C3A;">' + bodyHTML + '</td></tr>' +
    '<tr><td style="padding:16px 36px 24px;border-top:1px solid #EDE8DC;text-align:center;"><p style="font-size:11px;color:#999;margin:0;">tandoco &middot; Minneapolis, MN &middot; <a href="https://tandoco.com" style="color:#1B1A6B;">tandoco.com</a></p></td></tr>' +
    '</table></td></tr></table></body></html>';
}

// Resolve the set of customers currently eligible for a journey's trigger.
// Returns [{ uid, email, phone, firstName }]. Best-effort + bounded.
async function _eligibleCustomers(db, journey){
  const trig = journey.trigger || {};
  const out = [];
  let snap;
  try {
    snap = await db.collection('customers').limit(CUSTOMER_SCAN_CAP).get();
  } catch (e){
    console.error('[journeys] customer scan failed:', e.message);
    return out;
  }
  const liveSince = _ms(journey.liveSince);
  const now = Date.now();
  snap.forEach(d => {
    const c = d.data() || {};
    const uid = d.id;
    const email = c.email ? String(c.email).toLowerCase() : '';
    const firstName = c.firstName || (c.name ? String(c.name).split(' ')[0] : '') || 'friend';
    const phone = c.phone || null;
    let ok = false;
    if (trig.type === 'signup'){
      // Only customers who signed up AFTER the journey went live.
      const created = _ms(c.createdAt);
      ok = created > 0 && (!liveSince || created >= liveSince);
    } else if (trig.type === 'no_order_days'){
      const days = Number(trig.days) || 30;
      const last = _ms(c.lastOrderAt || c.lastOrderDate || c.lastOrder);
      ok = last > 0 && (now - last) >= days * 86400000;
    } else if (trig.type === 'tag'){
      const tag = String(trig.tag || '').toLowerCase();
      const tags = Array.isArray(c.tags) ? c.tags.map(t => String(t).toLowerCase()) : [];
      ok = !!tag && tags.includes(tag);
    }
    if (ok) out.push({ uid, email, phone, firstName });
  });
  return out;
}

// Compute the next state for an enrollment: walk from stepIndex, collect
// consecutive sends until a wait step or the end. Returns { sends, next }.
function _advance(steps, fromIndex, nowMs){
  const sends = [];
  let i = fromIndex;
  while (i < steps.length){
    const step = steps[i] || {};
    if (step.type === 'wait'){
      const days = Number(step.days) || 1;
      i += 1;                       // consume the wait
      return { sends, nextIndex: i, nextRunAtMs: nowMs + days * 86400000, done: i >= steps.length };
    }
    if (step.type === 'email' || step.type === 'sms'){
      sends.push(step);
    }
    i += 1;
  }
  return { sends, nextIndex: i, nextRunAtMs: nowMs, done: true };
}

async function _enqueueSend(db, admin, step, person, journey){
  if (step.type === 'email'){
    if (!person.email) return;
    await db.collection('mail').add({
      to: person.email,
      template: 'custom',
      subject: step.subject || (journey.name || 'tandoco'),
      html: step.html ? String(step.html) : _wrapEmail(step.subject, step.body),
      data: { first_name: person.firstName },
      journeyId: journey.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } else if (step.type === 'sms'){
    if (!person.phone) return;
    const raw = String(step.body || '').trim();
    if (!raw) return;
    const body = /reply\s+stop/i.test(raw) ? raw : raw + ' Reply STOP to opt out.';
    const { _queueSms } = require('../sms/queue');
    await _queueSms({ to: person.phone, scenario: 'journey.' + journey.id, body, customerId: person.uid });
  }
}

async function runJourneys(db, admin){
  // Global kill-switch.
  try {
    const ff = await db.collection('settings').doc('featureFlags').get();
    if (ff.exists && ff.data() && ff.data().journeysEnginePaused === true) return;
  } catch (_){}

  let jSnap;
  try {
    jSnap = await db.collection('journeys').where('status', '==', 'live').limit(50).get();
  } catch (e){
    console.error('[journeys] load failed:', e.message);
    return;
  }
  if (!jSnap || jSnap.empty) return;
  const journeys = jSnap.docs.map(d => Object.assign({ id: d.id }, d.data()));

  // ── Enrollment pass ──
  let enrolled = 0;
  for (const j of journeys){
    if (enrolled >= ENROLL_CAP_PER_RUN) break;
    if (!Array.isArray(j.steps) || !j.steps.length) continue;
    let people;
    try { people = await _eligibleCustomers(db, j); } catch (_){ people = []; }
    for (const p of people){
      if (enrolled >= ENROLL_CAP_PER_RUN) break;
      const enrollId = j.id + '_' + p.uid;
      const ref = db.collection('journeyEnrollments').doc(enrollId);
      try {
        const created = await db.runTransaction(async (tx) => {
          const ex = await tx.get(ref);
          if (ex.exists) return false;                 // already enrolled — never twice
          tx.set(ref, {
            journeyId: j.id,
            journeyName: j.name || '',
            uid: p.uid,
            email: p.email || null,
            phone: p.phone || null,
            firstName: p.firstName || null,
            stepIndex: 0,
            status: 'active',
            nextRunAt: admin.firestore.Timestamp.now(),
            enrolledAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return true;
        });
        if (created) enrolled++;
      } catch (e){ console.error('[journeys] enroll tx failed', enrollId, e.message); }
    }
  }

  // ── Processing pass ──
  const jById = {};
  journeys.forEach(j => { jById[j.id] = j; });
  let due;
  try {
    due = await db.collection('journeyEnrollments')
      .where('status', '==', 'active')
      .where('nextRunAt', '<=', admin.firestore.Timestamp.now())
      .limit(PROCESS_CAP_PER_RUN)
      .get();
  } catch (e){
    console.error('[journeys] due query failed (needs index?):', e.message);
    due = null;
  }
  if (!due || due.empty) return;

  for (const encDoc of due.docs){
    const enc = encDoc.data() || {};
    const j = jById[enc.journeyId];
    if (!j){ continue; }                     // journey paused/deleted since — leave enrollment
    const steps = Array.isArray(j.steps) ? j.steps : [];
    const nowMs = Date.now();

    // Advance state atomically FIRST (at-most-once), collect the sends,
    // then dispatch outside the transaction.
    let plan = null;
    try {
      plan = await db.runTransaction(async (tx) => {
        const fresh = await tx.get(encDoc.ref);
        if (!fresh.exists) return null;
        const e = fresh.data() || {};
        if (e.status !== 'active' || _ms(e.nextRunAt) > nowMs) return null;
        const a = _advance(steps, e.stepIndex || 0, nowMs);
        tx.update(encDoc.ref, {
          stepIndex: a.nextIndex,
          nextRunAt: admin.firestore.Timestamp.fromMillis(a.nextRunAtMs),
          status: a.done ? 'complete' : 'active',
          lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
          ...(a.done ? { completedAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
        });
        return a;
      });
    } catch (e){ console.error('[journeys] advance tx failed', encDoc.id, e.message); continue; }
    if (!plan || !plan.sends.length) continue;

    const person = { uid: enc.uid, email: enc.email, phone: enc.phone, firstName: enc.firstName || 'friend' };
    for (const step of plan.sends){
      try { await _enqueueSend(db, admin, step, person, j); }
      catch (e){ console.error('[journeys] send failed', encDoc.id, step.type, e.message); }
    }
  }
}

// Test-send a single step (or the first send step) to one address —
// used by the HQ "test send" button via the journeyTestSend endpoint.
async function testSendStep(db, admin, journey, step, to){
  const person = { uid: 'test', email: (to || '').toLowerCase(), phone: null, firstName: 'there' };
  await _enqueueSend(db, admin, step, person, journey || { id: 'test', name: 'test' });
}

module.exports = { runJourneys, testSendStep, _wrapEmail };
