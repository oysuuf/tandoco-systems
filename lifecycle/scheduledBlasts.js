'use strict';

/* ════════════════════════════════════════════════════════════════════
   SCHEDULED BLAST DISPATCHER
   ────────────────────────────────────────────────────────────────────
   Fires the "schedule for later" blasts queued from HQ2 → Communications
   → Compose. Those write a /scheduledBlasts doc with a `scheduledFor`
   timestamp; this module sends the ones that are now due.

   Invoked from an EXISTING 15-min cron (abandonedCartReminders) so it
   adds NO new Cloud Function — important because us-central1 has hit the
   function-count ceiling before (see CLAUDE-LESSONS.md). The call there
   is wrapped in its own try/catch so a dispatch error can never affect
   the host cron.

   What it auto-sends server-side (deterministic, low-risk):
     • email — single recipient, or category (/emailAlerts) + segment
       (/customers plan/tier) audiences → /mail docs (SendGrid via
       onMailCreated) + an /email_sends audit row.
     • SMS   — single phone → _queueSms (onSmsQueued dispatches, keeping
       every opt-in/quiet-hours check intact).

   What it leaves for the operator's one-click "send now" in HQ (it can't
   safely resolve these here): SMS-to-an-audience (needs the tested
   dry-run→simulate→send pipeline) and saved-audience email (needs the HQ
   rule engine). Those stay status:'scheduled' and show as "due now" on
   the Schedule tab. A note is stamped so it's clear why.

   Idempotency: each due blast is claimed inside a transaction (status
   scheduled → sending) before any send, so two overlapping cron runs
   can't double-send.
   ════════════════════════════════════════════════════════════════════ */

const ALERT_CATS = ['founding', 'news', 'training', 'recipe'];
const SEG_KEYS   = ['sub-standard', 'sub-committed', 'sub-monthly', 'newbie', 'foodie', 'connoisseur'];

// Can this blast be dispatched server-side without the HQ-only resolvers?
function _autoDispatchable(sb){
  if (sb.channel === 'sms'){
    return { ok: !!sb.smsSinglePhone, reason: sb.smsSinglePhone ? '' : 'sms-audience: send from HQ (uses the tested pipeline)' };
  }
  // email
  if (sb.singleEmail) return { ok: true, reason: '' };
  const keys = Array.isArray(sb.audiences) ? sb.audiences : [];
  if (keys.some(k => typeof k === 'string' && k.startsWith('saved:'))){
    return { ok: false, reason: 'saved-audience: send from HQ (needs the rule engine)' };
  }
  return { ok: keys.length > 0, reason: keys.length ? '' : 'no audience on doc' };
}

async function _resolveEmailRecipients(db, sb){
  const emails = new Set();
  if (sb.singleEmail){ emails.add(String(sb.singleEmail).toLowerCase()); return emails; }
  const keys = Array.isArray(sb.audiences) ? sb.audiences : [];
  const wantSubs = keys.filter(k => ALERT_CATS.includes(k));
  const wantSegs = keys.filter(k => SEG_KEYS.includes(k));
  if (wantSubs.length){
    const snap = await db.collection('emailAlerts').get();
    snap.forEach(d => {
      const r = d.data() || {};
      if (wantSubs.includes(r.category) && r.email) emails.add(String(r.email).toLowerCase());
    });
  }
  if (wantSegs.length){
    const snap = await db.collection('customers').limit(3000).get();
    snap.forEach(d => {
      const c = d.data() || {};
      if (!c.email) return;
      const e = String(c.email).toLowerCase();
      const spend = (c.totalSpent != null ? c.totalSpent : (c.lifetimeValue || 0)) || 0;
      const tier = spend < 200 ? 'newbie' : spend < 1000 ? 'foodie' : 'connoisseur';
      if (wantSegs.includes('sub-standard')  && c.subscriptionPlan === 'standard')  emails.add(e);
      if (wantSegs.includes('sub-committed') && c.subscriptionPlan === 'committed') emails.add(e);
      if (wantSegs.includes('sub-monthly')   && c.subscriptionType === 'monthly')   emails.add(e);
      if (wantSegs.includes(tier)) emails.add(e);
    });
  }
  return emails;
}

function _wrapEmailHtml(subject, body){
  const bodyHTML = String(body || '').replace(/\n/g, '<br>');
  return '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F5F3EE;font-family:\'Helvetica Neue\',Helvetica,Arial,sans-serif;">' +
    '<table role="presentation" width="100%" style="background:#F5F3EE;"><tr><td align="center" style="padding:32px 16px;">' +
    '<table role="presentation" width="100%" style="max-width:540px;background:#fff;border-radius:20px;border:1px solid #E8E4D8;">' +
    '<tr><td style="padding:32px 36px 16px;"><div style="font-size:22px;font-weight:900;color:#1B1A6B;margin-bottom:16px;">tandoco</div></td></tr>' +
    '<tr><td style="padding:0 36px 32px;font-size:15px;line-height:1.8;color:#2C2C3A;">' + bodyHTML + '</td></tr>' +
    '<tr><td style="padding:16px 36px 24px;border-top:1px solid #EDE8DC;text-align:center;"><p style="font-size:11px;color:#999;margin:0;">tandoco &middot; Minneapolis, MN &middot; <a href="https://tandoco.com" style="color:#1B1A6B;">tandoco.com</a></p></td></tr>' +
    '</table></td></tr></table></body></html>';
}

async function _dispatchOne(db, admin, doc){
  const sb = doc.data() || {};

  // Skip (without claiming) the ones only HQ can send — cheap, no writes
  // beyond a one-time note so the operator knows to use "send now".
  const gate = _autoDispatchable(sb);
  if (!gate.ok){
    if (sb.autoSkipReason !== gate.reason){
      try { await doc.ref.update({ autoSkipReason: gate.reason }); } catch (_){}
    }
    return;
  }

  // Claim atomically so overlapping runs can't double-send.
  let claimed = false;
  try {
    claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      if (!fresh.exists || fresh.data().status !== 'scheduled') return false;
      tx.update(doc.ref, {
        status: 'sending',
        dispatchStartedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return true;
    });
  } catch (e){
    console.error('[scheduledBlasts] claim failed', doc.id, e.message);
    return;
  }
  if (!claimed) return;

  try {
    let summary = '';
    if (sb.channel === 'sms'){
      const raw = String(sb.smsBody || '').trim();
      if (!raw) throw new Error('empty sms body');
      const body = /reply\s+stop/i.test(raw) ? raw : raw + ' Reply STOP to opt out.';
      const { _queueSms } = require('../sms/queue');
      await _queueSms({ to: sb.smsSinglePhone, scenario: 'adhoc.scheduled_blast', body });
      summary = 'sms → ' + sb.smsSinglePhone;
    } else {
      const emails = await _resolveEmailRecipients(db, sb);
      if (!emails.size) throw new Error('no recipients resolved');
      const isTpl = !!sb.templateId;
      const subject = isTpl ? '' : String(sb.subject || '');
      // Design-mode blasts store pre-compiled HTML; plain ones wrap the body.
      const html = isTpl ? '' : (sb.html ? String(sb.html) : _wrapEmailHtml(subject, sb.body));

      // Personalization lookup for template sends.
      const custByEmail = {};
      if (isTpl){
        const cs = await db.collection('customers').limit(3000).get();
        cs.forEach(d => { const c = d.data() || {}; if (c.email) custByEmail[String(c.email).toLowerCase()] = c; });
      }

      const arr = Array.from(emails).slice(0, 5000);
      for (let i = 0; i < arr.length; i += 400){
        const chunk = arr.slice(i, i + 400);
        const batch = db.batch();
        chunk.forEach(e => {
          const ref = db.collection('mail').doc();
          if (isTpl){
            const c = custByEmail[e];
            const fn = (c && (c.firstName || (c.name && String(c.name).split(' ')[0]))) || 'friend';
            batch.set(ref, { to: e, template: sb.templateId, data: { first_name: fn, name: (c && c.name) || fn }, createdAt: admin.firestore.FieldValue.serverTimestamp() });
          } else {
            batch.set(ref, { to: e, template: 'custom', subject, html, createdAt: admin.firestore.FieldValue.serverTimestamp() });
          }
        });
        await batch.commit();
      }

      try {
        await db.collection('email_sends').add({
          template: isTpl ? sb.templateId : 'custom',
          category: 'marketing',
          subject: isTpl ? '[template: ' + sb.templateId + ']' : subject,
          audiences: sb.singleEmail ? ['single'] : (sb.audiences || []),
          recipientCount: arr.length,
          recipientEmails: arr,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          sentBy: 'cron · scheduled',
        });
      } catch (_){}
      summary = 'email → ' + arr.length;
    }

    await doc.ref.update({
      status: 'sent',
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      sentVia: 'cron',
      sentSummary: summary,
    });
    console.log('[scheduledBlasts] sent', doc.id, summary);
  } catch (e){
    console.error('[scheduledBlasts] dispatch failed', doc.id, e.message);
    try {
      await doc.ref.update({
        status: 'failed',
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
        failReason: String(e.message || 'error'),
      });
    } catch (_){}
  }
}

/**
 * Sends every /scheduledBlasts doc whose scheduledFor is now due.
 * @param {FirebaseFirestore.Firestore} db
 * @param {import('firebase-admin')} admin
 */
async function dispatchScheduledBlasts(db, admin){
  let snap;
  try {
    snap = await db.collection('scheduledBlasts')
      .where('status', '==', 'scheduled')
      .where('scheduledFor', '<=', admin.firestore.Timestamp.now())
      .limit(25)
      .get();
  } catch (e){
    console.error('[scheduledBlasts] query failed:', e.message);
    return;
  }
  if (!snap || snap.empty) return;
  for (const doc of snap.docs){
    await _dispatchOne(db, admin, doc);
  }
}

module.exports = { dispatchScheduledBlasts };
