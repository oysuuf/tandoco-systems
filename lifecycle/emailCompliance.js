'use strict';

/* ════════════════════════════════════════════════════════════════════
   EMAIL COMPLIANCE — unsubscribe + suppression
   ────────────────────────────────────────────────────────────────────
   Gives marketing email the two things it legally + operationally needs:

     1. A visible one-click unsubscribe link + List-Unsubscribe headers on
        every marketing send (CAN-SPAM; Gmail/Yahoo bulk-sender rules).
     2. A suppression list the send path CHECKS before sending, and that
        the SendGrid event webhook FEEDS from hard bounces + spam
        complaints + unsubscribes — so a dead/angry address is never
        emailed again (protects domain reputation).

   Transactional mail (order confirmations, payment failures, etc.) is
   never suppressed or footer-stamped — only marketing.

   Storage: /emailSuppression/{emailKey} — { email, reason, source,
   createdAt }. Presence == suppressed. Staff can clear one from HQ.
   ════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

// Signing salt for unsubscribe tokens. Not a real secret (worst case a
// token forges an unsubscribe, which is reversible + low-stakes), but it
// stops trivial ?email=someone-else enumeration. Kept in code so no new
// declared secret can brick a deploy.
const UNSUB_SALT = 'tandoco.unsub.v1.9c1f';

// Cloud Function base — the unsubscribe endpoint lives here. Using the
// function URL directly avoids depending on a hosting rewrite.
const FN_BASE = 'https://us-central1-<project>.cloudfunctions.net';

// Templates that are MARKETING (get the footer + suppression gate). Any
// template NOT in this set is treated as transactional and always sends.
// `custom` covers HQ Compose blasts; the rest are the code-defined
// marketing templates.
const MARKETING_TEMPLATES = new Set([
  'custom',
  'welcome',
  'pre_launch_welcome',
  'founding_member',
  'winback',
  'referral_credit',
  'loyalty_reward',
  'weeklyWellness',
  'cart_abandoned_1h',
  'cart_abandoned_24h',
  'this-week-menu',
  // Added Jul 19 2026. Both were escaping this set, so they sent to
  // addresses that had unsubscribed, hard-bounced, or filed a spam
  // complaint, and shipped with no unsubscribe affordance at all:
  //   review_request — the post-order "how was it?" ask. Promotional
  //     relationship mail, not transactional; the customer owes us
  //     nothing once the food is delivered.
  //   order_reminder — DEFENSIVE ONLY, currently inert. Despite the name
  //     this is not a pickup reminder, it's the weekly Wednesday menu
  //     blast — but that blast writes its mail doc as template:'custom'
  //     (index.js:20297 and :20460) and only logs 'order_reminder' to
  //     email_sends for analytics. So no mail doc ever carries this value
  //     today, and the blast is ALREADY gated + footered via 'custom'.
  //     Kept so the classification is right if the blast is ever changed
  //     to write its real template name. Do not read this entry as
  //     evidence that the weekly menu was previously unprotected.
  // Nothing transactional was added: no receipts, payment failures, or
  // pickup/delivery logistics mail is suppressible.
  'review_request',
  'order_reminder',
  // Added Aug 2026. The three referral PROMPTS — as opposed to
  // referral_credit, which reports money earned and was already here.
  // All three are declared surface:'marketing' in the template catalog
  // (index.js) and were treated as transactional by this gate, so the
  // system disagreed with itself: they shipped with no unsubscribe
  // affordance and kept emailing addresses that had unsubscribed, hard
  // bounced, or filed a spam complaint. The share nudge is the one that
  // mattered — it repeated every 7 days for life.
  'referral_reminder_day7',
  'referral_reminder_day14',
  'referral_share_nudge',
]);

function isMarketingEmail(template){
  return MARKETING_TEMPLATES.has(String(template || ''));
}

// Firestore doc-id-safe key for an email. Lowercased; '/' can't appear in
// an email but we strip it defensively, and cap length.
function emailKey(email){
  return String(email || '').trim().toLowerCase().replace(/\//g, '_').slice(0, 400);
}

function _sign(emailLc){
  return crypto.createHmac('sha256', UNSUB_SALT).update(emailLc).digest('base64url').slice(0, 24);
}

// token = base64url(email) + '.' + hmac(email). Self-describing so the
// endpoint can recover the email and verify it in one shot.
function makeUnsubToken(email){
  const lc = String(email || '').trim().toLowerCase();
  return Buffer.from(lc, 'utf8').toString('base64url') + '.' + _sign(lc);
}

function parseUnsubToken(token){
  const s = String(token || '');
  const dot = s.lastIndexOf('.');
  if (dot < 1) return null;
  const emailLc = Buffer.from(s.slice(0, dot), 'base64url').toString('utf8');
  const sig = s.slice(dot + 1);
  if (!emailLc || sig !== _sign(emailLc)) return null;
  return emailLc;
}

function unsubscribeUrl(email){
  return FN_BASE + '/emailUnsubscribe?u=' + encodeURIComponent(makeUnsubToken(email));
}

// Whether a marketing send to this email must be skipped. Checks the
// suppression collection first, then a couple of global opt-out flags on
// the customer doc (best-effort — never throws).
async function isSuppressed(db, email){
  const key = emailKey(email);
  if (!key) return false;
  try {
    const doc = await db.collection('emailSuppression').doc(key).get();
    if (doc.exists) return true;
  } catch (_){}
  try {
    const qs = await db.collection('customers').where('email', '==', String(email).toLowerCase()).limit(1).get();
    if (!qs.empty){
      const c = qs.docs[0].data() || {};
      if (c.emailOptOut === true || c.unsubscribedAll === true) return true;
    }
  } catch (_){}
  return false;
}

// Adds (or refreshes) a suppression entry. Idempotent — merge on the key.
async function addSuppression(db, admin, email, reason, source){
  const key = emailKey(email);
  if (!key) return;
  try {
    await db.collection('emailSuppression').doc(key).set({
      email: String(email).toLowerCase(),
      reason: reason || 'unknown',
      source: source || 'system',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (e){
    console.error('[emailCompliance] addSuppression failed', key, e.message);
  }
}

// The visible compliance footer appended to marketing HTML. Matches the
// email shell's muted footer styling.
function complianceFooterHtml(email){
  const url = unsubscribeUrl(email);
  return '<div style="max-width:560px;margin:0 auto;padding:18px 32px 26px;text-align:center;font-family:\'Helvetica Neue\',Helvetica,Arial,sans-serif;">' +
    '<p style="font-size:10.5px;line-height:1.6;color:#9B9BA8;margin:0;">' +
      'you\'re receiving this because you signed up at tandoco.com. ' +
      '<a href="' + url + '" style="color:#6B6B7B;text-decoration:underline;">unsubscribe</a> · ' +
      'tandoco · minneapolis, mn' +
    '</p>' +
  '</div>';
}

// Inserts the footer before </body> (or appends if there's no body tag).
function injectFooter(html, email){
  const footer = complianceFooterHtml(email);
  const h = String(html || '');
  const idx = h.toLowerCase().lastIndexOf('</body>');
  if (idx === -1) return h + footer;
  return h.slice(0, idx) + footer + h.slice(idx);
}

// Headers to attach for a marketing send (one-click unsubscribe).
function unsubHeaders(email){
  return {
    'List-Unsubscribe': '<' + unsubscribeUrl(email) + '>, <mailto:you@example.com?subject=unsubscribe>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

module.exports = {
  // Exported so commSkip's test can assert the invariant that matters to a
  // staff hold: every template this module calls marketing must also be
  // skippable, or "pause this customer" covers marketing with holes in it.
  MARKETING_TEMPLATES,
  isMarketingEmail,
  emailKey,
  makeUnsubToken,
  parseUnsubToken,
  unsubscribeUrl,
  isSuppressed,
  addSuppression,
  complianceFooterHtml,
  injectFooter,
  unsubHeaders,
};
