/* ════════════════════════════════════════════════════════════════════
   CRM — Workflow / drip engine.

   A workflow is a trigger + ordered list of steps. When the trigger
   fires for a customer, a workflowRuns/{id} doc is created. The
   scheduler ticks every 5 minutes, advances each run to its next
   step at or after `nextRunAt`, and marks the run completed when
   the step list runs out.

   Workflow definition (/workflows/{id}):
     {
       name:        string,
       active:      boolean,        // ship false; staff toggle when ready
       trigger: {
         type:   'segment_entered'|'event'|'manual',
         config: { segmentId?, event?: 'order_paid'|'signup'|'birthday' }
       },
       steps: [
         { type:'wait',       hours: number },
         { type:'send_email', template: string, subjectOverride?: string, data?: object },
         { type:'add_tag',    tag: string },
         { type:'remove_tag', tag: string },
         { type:'create_task',title: string, assignee?: uid },
         // 1B-3b adds: { type:'send_sms',    body: string }
         // 1B-3c adds: { type:'ai_message',  purpose: 'winback'|'upsell'|'reengage' }
       ],
       createdAt, updatedAt, createdBy
     }

   Run state (/workflowRuns/{id}):
     {
       workflowId, customerId,
       status: 'pending'|'running'|'completed'|'failed'|'cancelled',
       currentStep:  number,
       nextRunAt:    Timestamp,
       startedAt, finishedAt,
       lastError, attempts: number,
       triggerReason: string,
       log: [{step, type, at, ok, message}, ...]   // capped to last 25
     }

   IDEMPOTENCY: each run id = `${workflowId}__${customerId}` so the
   same trigger firing twice produces one run.

   KILL-SWITCH: settings/workflows.engineEnabled. Defaults false.
   Until staff explicitly flips it true, processDueRuns no-ops.
   This is the safety belt — deploying the engine + a template
   alone does not mail a single customer.

   STEP TYPES IN THIS PHASE (1B-3a): wait, send_email, add_tag,
   remove_tag, create_task. send_sms ships disabled (queues without
   a worker would be useless / confusing); ai_message defers to
   1B-3c. Both still parse — they just log a no-op so a workflow
   author defining them doesn't crash the engine.
   ════════════════════════════════════════════════════════════════════ */

'use strict';

const admin = require('firebase-admin');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { writeActivity } = require('./activities');
const segments = require('./segments');

const MAX_RUNS_PER_TICK = 50;
const MAX_LOG_ENTRIES = 25;
const MAX_ATTEMPTS = 8;

// Win-back enrollment sweep safety caps.
const MAX_ENROLL_PER_TICK = 25;      // never enroll more than this per run
const WINBACK_SCAN_CAP    = 2000;    // customers scanned per run
// Anyone carrying either tag is in-flight or resting — never (re-)enroll.
const WINBACK_SKIP_TAGS   = ['winback-active', 'winback-cooldown'];
// Default `lapsed` filter used only when /segments/lapsed doesn't exist
// yet. Matches the spec: 14+ days since last order, at least 2 orders.
const WINBACK_DEFAULT_FILTER = { lastOrderDaysMin: 14, orderCountMin: 2 };

// Step types we currently execute. Anything else is a no-op (logged)
// so an author defining a future step doesn't crash a run.
const SUPPORTED_STEPS = new Set([
  'wait', 'send_email', 'add_tag', 'remove_tag', 'create_task',
]);

function _runId(workflowId, customerId){
  return String(workflowId).replace(/[^A-Za-z0-9_-]/g, '_')
    + '__'
    + String(customerId).replace(/[^A-Za-z0-9_-]/g, '_');
}

// Check the kill-switch. Returns true when the engine should run.
async function _engineEnabled(db){
  try {
    const snap = await db.doc('settings/workflows').get();
    return !!(snap.exists && snap.data() && snap.data().engineEnabled === true);
  } catch (_){
    return false;
  }
}

/**
 * Enroll a customer in a workflow. Idempotent.
 * Returns the run id (whether new or pre-existing).
 */
async function enrollInWorkflow(db, workflowId, customerId, opts){
  opts = opts || {};
  if (!workflowId || !customerId) throw new Error('workflowId + customerId required');

  const wfSnap = await db.collection('workflows').doc(workflowId).get();
  if (!wfSnap.exists) throw new Error('workflow not found');
  const wf = wfSnap.data();
  if (wf.active === false) throw new Error('workflow inactive');

  const id = _runId(workflowId, customerId);
  const ref = db.collection('workflowRuns').doc(id);
  const existing = await ref.get();
  if (existing.exists){
    const s = existing.data() || {};
    // Re-enroll only if the previous run terminated AND the caller
    // explicitly asked for it. Otherwise return the existing run id.
    const terminated = s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed';
    if (!opts.reEnroll || !terminated) return id;
  }

  await ref.set({
    workflowId,
    customerId,
    status: 'pending',
    currentStep: 0,
    nextRunAt:   admin.firestore.FieldValue.serverTimestamp(),
    startedAt:   admin.firestore.FieldValue.serverTimestamp(),
    finishedAt:  null,
    lastError:   null,
    attempts:    0,
    triggerReason: opts.reason || (wf.trigger && wf.trigger.type) || 'manual',
    log: [],
  });

  // Drop a 'workflow_started' activity so the customer's timeline
  // shows enrollment.
  try {
    await writeActivity(db, customerId, {
      type: 'workflow_started',
      title: 'Workflow started — ' + (wf.name || workflowId),
      payload: { workflowId, runId: id, reason: opts.reason || null },
    });
  } catch (e){
    logger.warn('[workflows] enroll activity failed', { e: e.message });
  }
  return id;
}

/**
 * Execute one step of a run. Returns { advance, retry?, delayHours?, log }.
 */
async function _executeStep(db, run, step){
  const customerId = run.customerId;
  const cSnap = await db.collection('customers').doc(customerId).get();
  if (!cSnap.exists){
    return { advance: true, log: { ok: false, message: 'customer missing' } };
  }
  const customer = cSnap.data() || {};

  const type = String(step && step.type || '');

  if (!SUPPORTED_STEPS.has(type)){
    return { advance: true, log: { ok: false, message: 'unsupported step (logged): ' + (type || 'unknown') } };
  }

  switch (type){
    case 'wait': {
      const hours = Math.max(0, Number(step.hours) || 0);
      // Mark this step done, but push nextRunAt forward by `hours`
      // so the NEXT step doesn't execute until the wait elapses.
      return { advance: true, delayHours: hours, log: { ok: true, message: 'waited ' + hours + 'h' } };
    }
    case 'send_email': {
      // Hand off to the existing /mail collection trigger which is
      // wired to the Firebase Email extension on this project. We
      // never call SendGrid / SES directly here — the queue is the
      // existing infrastructure.
      const tpl = String(step.template || 'generic').slice(0, 80);
      if (!customer.email){
        return { advance: true, log: { ok: false, message: 'no email on file' } };
      }
      try {
        await db.collection('mail').add({
          to: customer.email,
          template: tpl,
          data: Object.assign({
            firstName: customer.firstName || customer.name || '',
          }, step.data || {}),
          subject: step.subjectOverride || null,
          source: 'workflow',
          workflowId: run.workflowId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return { advance: true, log: { ok: true, message: 'queued email ' + tpl } };
      } catch (e){
        return { advance: false, retry: true, log: { ok: false, message: 'mail enqueue failed: ' + e.message } };
      }
    }
    case 'add_tag': {
      const tag = String(step.tag || '').slice(0, 40);
      if (!tag) return { advance: true, log: { ok: false, message: 'empty tag' } };
      await db.collection('customers').doc(customerId).set({
        tags: admin.firestore.FieldValue.arrayUnion(tag),
      }, { merge: true });
      return { advance: true, log: { ok: true, message: 'tag +' + tag } };
    }
    case 'remove_tag': {
      const tag = String(step.tag || '').slice(0, 40);
      if (!tag) return { advance: true, log: { ok: false, message: 'empty tag' } };
      await db.collection('customers').doc(customerId).set({
        tags: admin.firestore.FieldValue.arrayRemove(tag),
      }, { merge: true });
      return { advance: true, log: { ok: true, message: 'tag -' + tag } };
    }
    case 'create_task': {
      const title = String(step.title || 'Workflow task').slice(0, 200);
      await db.collection('tasks').add({
        title,
        relatedCustomerId: customerId,
        assignedTo: step.assignee || null,
        source:     'workflow',
        workflowId: run.workflowId,
        status:     'open',
        createdAt:  admin.firestore.FieldValue.serverTimestamp(),
      });
      return { advance: true, log: { ok: true, message: 'task: ' + title } };
    }
    default:
      // Defensive — SUPPORTED_STEPS guard above should make this
      // unreachable, but keeps the function total in case the set
      // and the switch ever drift.
      return { advance: true, log: { ok: false, message: 'unhandled step: ' + type } };
  }
}

/**
 * Tick: pick up due runs and advance each. Called by the every-5-minute
 * scheduler. Returns counters for telemetry.
 */
async function processDueRuns(db, now){
  if (!await _engineEnabled(db)){
    return { skipped: 'engine disabled' };
  }

  now = now || new Date();
  const snap = await db.collection('workflowRuns')
    .where('status', 'in', ['pending', 'running'])
    .where('nextRunAt', '<=', now)
    .orderBy('nextRunAt', 'asc')
    .limit(MAX_RUNS_PER_TICK)
    .get();

  let advanced = 0, finished = 0, failed = 0;

  for (const doc of snap.docs){
    const run = doc.data();
    const wfSnap = await db.collection('workflows').doc(run.workflowId).get();
    if (!wfSnap.exists || wfSnap.data().active === false){
      await doc.ref.update({
        status: 'cancelled',
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      continue;
    }
    const wf = wfSnap.data();
    const steps = Array.isArray(wf.steps) ? wf.steps : [];

    if (run.currentStep >= steps.length){
      await doc.ref.update({
        status: 'completed',
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      finished++;
      try {
        await writeActivity(db, run.customerId, {
          type: 'workflow_completed',
          title: 'Workflow completed — ' + (wf.name || run.workflowId),
          payload: { workflowId: run.workflowId, runId: doc.id },
        });
      } catch (_){}
      continue;
    }

    const step = steps[run.currentStep];
    let result;
    try {
      result = await _executeStep(db, Object.assign({ _id: doc.id }, run), step);
    } catch (e){
      result = { advance: false, retry: true, log: { ok: false, message: 'step threw: ' + e.message } };
    }

    const log = Array.isArray(run.log) ? run.log.slice(-(MAX_LOG_ENTRIES - 1)) : [];
    log.push({
      step: run.currentStep,
      type: step.type,
      at:   new Date(),
      ok:   !!(result.log && result.log.ok),
      message: (result.log && result.log.message) || '',
    });

    const update = {
      log,
      attempts: (run.attempts || 0) + 1,
      status:   'running',
    };

    if (result.advance){
      update.currentStep = run.currentStep + 1;
      const delayMs = (Number(result.delayHours) || 0) * 3600000;
      update.nextRunAt = new Date(now.getTime() + delayMs);
      if (update.currentStep >= steps.length){
        update.status = 'completed';
        update.finishedAt = admin.firestore.FieldValue.serverTimestamp();
        finished++;
      } else {
        advanced++;
      }
    } else if (result.retry){
      const backoffMs = Math.min(3600000, 60000 * Math.pow(2, (run.attempts || 0) % 6));
      update.nextRunAt = new Date(now.getTime() + backoffMs);
      if ((run.attempts || 0) >= MAX_ATTEMPTS){
        update.status = 'failed';
        update.finishedAt = admin.firestore.FieldValue.serverTimestamp();
        update.lastError = (result.log && result.log.message) || 'too many retries';
        failed++;
      }
    } else {
      update.status = 'failed';
      update.finishedAt = admin.firestore.FieldValue.serverTimestamp();
      update.lastError = (result.log && result.log.message) || 'step failed';
      failed++;
    }

    await doc.ref.update(update);
  }

  return { picked: snap.size, advanced, finished, failed };
}

// ── SCHEDULED TRIGGER: every 5 minutes ─────────────────────────────
const workflowScheduler = onSchedule({
  schedule: 'every 5 minutes',
  timeZone: 'America/Chicago',
}, async () => {
  try {
    const result = await processDueRuns(admin.firestore());
    logger.info('[workflows] tick', result);
  } catch (err){
    logger.error('[workflows] tick failed', { err: err.message });
  }
});

// ── HTTP: enroll a customer manually (staff) ───────────────────────
const workflowEnrollHttp = onRequest({ cors: false }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const { verifyStaff } = require('../lib/auth');
  const staff = await verifyStaff(req);
  if (!staff) return res.status(403).json({ ok: false, error: 'forbidden' });

  const body = req.body || {};
  const workflowId = String(body.workflowId || '');
  const customerId = String(body.customerId || '');
  if (!workflowId || !customerId){
    return res.status(400).json({ ok: false, error: 'workflowId + customerId required' });
  }
  try {
    const id = await enrollInWorkflow(admin.firestore(), workflowId, customerId, {
      reason:   body.reason || 'manual',
      reEnroll: !!body.reEnroll,
    });
    return res.status(200).json({ ok: true, runId: id });
  } catch (e){
    return res.status(400).json({ ok: false, error: e.message });
  }
});

/* ════════════════════════════════════════════════════════════════════
   WIN-BACK ENROLLMENT SWEEP — nightly ~03:00 CT.

   Auto-enrolls lapsed customers into any active segment_entered
   workflow whose trigger points at the `lapsed` segment. The workflow
   ENGINE (processDueRuns) already gates every send behind the
   engineEnabled kill-switch; this sweep gates ENROLLMENT on the SAME
   switch too, so with the switch off nothing gets enrolled OR sent —
   the feature ships completely inert.

   SAFETY:
     • FIRST thing it does is check engineEnabled — returns if off.
     • MAX_ENROLL_PER_TICK hard cap on new enrollments per run.
     • Skips anyone tagged winback-active / winback-cooldown.
     • enrollInWorkflow is idempotent (run id = workflow__customer), so
       a customer already in a live run is never double-enrolled.
     • send_sms stays a no-op in the engine — email-only for now.
   ════════════════════════════════════════════════════════════════════ */
async function runWinbackEnrollmentSweep(db, now){
  now = now || new Date();

  // GATE 1 — the kill-switch. Same check the engine uses. Off ⇒ inert.
  if (!await _engineEnabled(db)){
    return { skipped: 'engine disabled' };
  }

  // Find active workflows triggered by entering the `lapsed` segment.
  let wfSnap;
  try {
    wfSnap = await db.collection('workflows')
      .where('active', '==', true)
      .where('trigger.type', '==', 'segment_entered')
      .limit(50)
      .get();
  } catch (e){
    logger.error('[workflows] winback sweep workflow query failed', { e: e.message });
    return { error: e.message };
  }

  const targets = wfSnap.docs.filter(d => {
    const t = (d.data() && d.data().trigger) || {};
    return t.config && t.config.segmentId === 'lapsed';
  });
  if (!targets.length){
    return { enrolled: 0, note: 'no active lapsed-segment workflow' };
  }

  // Resolve the `lapsed` segment filter — prefer the stored segment doc,
  // fall back to the spec default so the sweep still works before the
  // /segments/lapsed doc is seeded.
  let filter = WINBACK_DEFAULT_FILTER;
  try {
    const segSnap = await db.doc('segments/lapsed').get();
    if (segSnap.exists && segSnap.data() && segSnap.data().filter){
      filter = segSnap.data().filter;
    }
  } catch (_){}

  // Single capped scan; in-memory match (mirrors segments.evaluateSegment
  // but lets us short-circuit at the enrollment cap).
  let custSnap;
  try {
    custSnap = await db.collection('customers').limit(WINBACK_SCAN_CAP).get();
  } catch (e){
    logger.error('[workflows] winback sweep customer scan failed', { e: e.message });
    return { error: e.message };
  }

  let matched = 0, enrolled = 0, skippedTagged = 0;
  outer:
  for (const doc of custSnap.docs){
    const c = doc.data() || {};
    const tags = Array.isArray(c.tags) ? c.tags.map(String) : [];
    if (WINBACK_SKIP_TAGS.some(t => tags.includes(t))){ skippedTagged++; continue; }
    if (!segments.customerMatches(c, filter, now)) continue;
    matched++;

    for (const wf of targets){
      try {
        await enrollInWorkflow(db, wf.id, doc.id, { reason: 'winback_sweep' });
        enrolled++;
      } catch (e){
        // A single enrollment failing (e.g. workflow flipped inactive
        // mid-run) shouldn't abort the whole sweep.
        logger.warn('[workflows] winback enroll failed', { wf: wf.id, cust: doc.id, e: e.message });
      }
      if (enrolled >= MAX_ENROLL_PER_TICK) break outer;
    }
  }

  return { matched, enrolled, skippedTagged, workflows: targets.map(t => t.id), cap: MAX_ENROLL_PER_TICK };
}

const winbackEnrollmentSweep = onSchedule({
  schedule: '0 3 * * *',           // 03:00 CT, after the churn sweep (02:00)
  timeZone: 'America/Chicago',
}, async () => {
  try {
    const result = await runWinbackEnrollmentSweep(admin.firestore());
    logger.info('[workflows] winback sweep', result);
  } catch (err){
    logger.error('[workflows] winback sweep failed', { err: err.message });
  }
});

module.exports = {
  enrollInWorkflow,
  processDueRuns,
  runWinbackEnrollmentSweep,
  workflowScheduler,
  winbackEnrollmentSweep,
  workflowEnrollHttp,
  _runId,
};
