'use strict';

/* ════════════════════════════════════════════════════════════════════
   A/B TEST ENGINE — email subject/content split test with auto-winner
   ────────────────────────────────────────────────────────────────────
   The client (HQ2 A/B builder) resolves the audience, splits it into a
   small A slice, a small B slice, and a holdout, sends A + B to their
   slices immediately, and writes an /abTests doc with status 'testing',
   the three recipient email lists, and a decideAt timestamp.

   This engine (runAbTests, on the 15-min cron) picks up tests whose
   decideAt has passed, measures A vs B by the chosen metric (opens or
   clicks, from /email_events), picks the winner, and sends the winning
   variant to the holdout. No new Cloud Function.

   Winner rule: higher metric count wins; a tie goes to A (the control).
   Everything is bounded + guarded; a failure marks the test 'error'
   without touching anyone else.
   ════════════════════════════════════════════════════════════════════ */

const EVENTS_SCAN_CAP = 8000;
const HOLDOUT_SEND_CAP = 20000;

function _ms(ts){
  if (!ts) return 0;
  if (ts.toMillis) return ts.toMillis();
  if (ts._seconds) return ts._seconds * 1000;
  if (ts.seconds) return ts.seconds * 1000;
  const n = new Date(ts).getTime();
  return isNaN(n) ? 0 : n;
}

// Build the set of lowercased emails that fired `metricEvent` since `since`.
async function _engagedEmails(db, metricEvent, sinceMs){
  const since = new Date(sinceMs);
  const set = new Set();
  try {
    let snap;
    try {
      snap = await db.collection('email_events').where('event', '==', metricEvent).where('createdAt', '>=', since).limit(EVENTS_SCAN_CAP).get();
    } catch (_){
      // No composite index for event+createdAt — fall back to a bounded
      // scan by event only.
      snap = await db.collection('email_events').where('event', '==', metricEvent).limit(EVENTS_SCAN_CAP).get();
    }
    snap.forEach(d => {
      const e = d.data() || {};
      if (_ms(e.createdAt || e.timestamp) < sinceMs) return;
      if (e.email) set.add(String(e.email).toLowerCase());
    });
  } catch (err){
    console.error('[abtests] events scan failed:', err.message);
  }
  return set;
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

async function _decideOne(db, admin, doc){
  const t = doc.data() || {};

  // Claim atomically so overlapping runs can't double-decide.
  let claimed = false;
  try {
    claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      if (!fresh.exists || fresh.data().status !== 'testing') return false;
      tx.update(doc.ref, { status: 'deciding', decidingAt: admin.firestore.FieldValue.serverTimestamp() });
      return true;
    });
  } catch (e){ console.error('[abtests] claim failed', doc.id, e.message); return; }
  if (!claimed) return;

  try {
    const metric = t.metric === 'clicks' ? 'click' : 'open';
    const aEmails = (t.aEmails || []).map(e => String(e).toLowerCase());
    const bEmails = (t.bEmails || []).map(e => String(e).toLowerCase());
    const engaged = await _engagedEmails(db, metric, _ms(t.testStartedAt) || (Date.now() - 24 * 3600000));
    const aScore = aEmails.filter(e => engaged.has(e)).length;
    const bScore = bEmails.filter(e => engaged.has(e)).length;
    const winner = aScore >= bScore ? 'A' : 'B';
    const win = winner === 'A' ? (t.variantA || {}) : (t.variantB || {});
    const winScore = Math.max(aScore, bScore);
    const loseScore = Math.min(aScore, bScore);
    const lift = loseScore > 0 ? Math.round(((winScore - loseScore) / loseScore) * 1000) / 10 : (winScore > 0 ? 100 : 0);

    // Send the winner to the holdout.
    const holdout = (t.holdoutEmails || []).slice(0, HOLDOUT_SEND_CAP);
    const subject = String(win.subject || t.name || 'tandoco');
    const html = win.html ? String(win.html) : _wrapEmail(subject, win.body);
    let sent = 0;
    for (let i = 0; i < holdout.length; i += 400){
      const chunk = holdout.slice(i, i + 400);
      const batch = db.batch();
      chunk.forEach(email => {
        const ref = db.collection('mail').doc();
        batch.set(ref, { to: String(email).toLowerCase(), template: 'custom', subject, html, abTestId: doc.id, abVariant: winner + '_winner', createdAt: admin.firestore.FieldValue.serverTimestamp() });
      });
      await batch.commit();
      sent += chunk.length;
    }

    await doc.ref.update({
      status: 'complete',
      aScore, bScore, winner, lift,
      winnerSentCount: sent,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log('[abtests] decided', doc.id, 'winner', winner, 'a', aScore, 'b', bScore, 'holdout', sent);
  } catch (e){
    console.error('[abtests] decide failed', doc.id, e.message);
    try { await doc.ref.update({ status: 'error', failReason: String(e.message || 'error') }); } catch (_){}
  }
}

async function runAbTests(db, admin){
  let snap;
  try {
    snap = await db.collection('abTests')
      .where('status', '==', 'testing')
      .where('decideAt', '<=', admin.firestore.Timestamp.now())
      .limit(10)
      .get();
  } catch (e){
    console.error('[abtests] due query failed (needs index?):', e.message);
    return;
  }
  if (!snap || snap.empty) return;
  for (const doc of snap.docs){
    await _decideOne(db, admin, doc);
  }
}

module.exports = { runAbTests };
