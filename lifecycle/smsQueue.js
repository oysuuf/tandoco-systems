'use strict';

/* ════════════════════════════════════════════════════════════════════
   SMS Queue — consumer trigger for smsQueue/{id}

   Mirrors the mail/{id} → onMailCreated pattern. Producers (Firestore
   triggers, scheduled functions, HQ buttons) write a doc to smsQueue
   with { to, templateKey, vars, customerId? } and this trigger:
     1. Loads the matching commTemplates record (by `key`)
     2. Renders {{path.field}} placeholders against the provided vars
     3. Checks opt-in for marketing templates (transactional bypasses)
     4. Calls sendTwilioSms
     5. Writes back { status, twilioSid, sentAt, ... } so producers
        can read the outcome and HQ can show the audit trail.

   Queue doc shape (input):
     {
       to:          '+16125551234',         // E.164 phone
       templateKey: 'order_confirmation_sms',
       scenario:    'order.paid',           // optional, for log filtering
       customerId:  'abc123',               // optional, used for opt-in
       vars:        { customer: { firstName: 'Omar' }, order: {...} },
     }

   Status values written by the consumer:
     queued   — initial (writer sets this)
     sent     — Twilio accepted; twilioSid stored
     skipped  — opt-out, missing template, or pref-off
     failed   — render error, send error, or no `to`
   ──────────────────────────────────────────────────────────────────── */

const {onDocumentCreated} = require('firebase-functions/v2/firestore');
const {onSchedule}        = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const {sendTwilioSms} = require('../lib/twilio-client');
const _commSkip       = require('../comms/commSkip');

/* ────────────────────────────────────────────────────────────────────
   Marketing scenarios — these REQUIRE explicit smsOptIn=true on the
   customer doc. Transactional templates (order updates, payment
   problems, account security) are allowed to send WITHOUT an explicit
   opt-in because the customer initiated the underlying action (placed
   an order, signed up). All scenarios respect a hard opt-out
   (customer.smsOptOutAt set by the STOP keyword).
   ──────────────────────────────────────────────────────────────────── */
const _MARKETING_SCENARIOS = new Set([
  'welcome_sms',
  'cart_abandonment',
  // Review-request nudge — sent the day after an order completes. Treated
  // as MARKETING so it fires ONLY for customers who explicitly opted into
  // SMS (smsOptIn===true); a transactional order update it is not.
  'review_request_sms',
  'order.review_request',
  // Booth market blast (src/sms/marketBlast.js). MUST be here: it's a
  // promo to a list, so it may only reach phones with a real opt-in. Left
  // off this set it would default to transactional and skip that check.
  // Note the sibling booth texts 'market.welcome' and 'market.receipt'
  // are deliberately NOT marketing — those answer something the customer
  // just did in person, seconds earlier.
  'market.blast',
  // Add future marketing-only templates here. Default is transactional.
]);

function _isMarketing(templateKey, scenario){
  if (templateKey && _MARKETING_SCENARIOS.has(templateKey)) return true;
  if (scenario    && _MARKETING_SCENARIOS.has(scenario))    return true;
  return false;
}

/* ────────────────────────────────────────────────────────────────────
   Reminder scenarios — the gentle nudge texts a customer can switch off
   without losing the important confirmations. Covers the pickup-window
   reminder and the "your box renews tomorrow" renewal heads-up. These
   are still TRANSACTIONAL (they send by default, no opt-in needed), but
   when customers/{uid}.smsRemindersOff === true the customer has asked
   us to stop the reminder nudges specifically — order-paid / order-ready
   / payment-problem texts keep flowing. Set via setReminderPrefs from
   the atlas confirm-first flow (and the account portal, later).
   ──────────────────────────────────────────────────────────────────── */
const _REMINDER_SCENARIOS = new Set([
  'pickup_reminder_sms',
  'order.pickup_reminder',
  'renewal_coming_up_sms',
  'subscription.renewal_upcoming',
]);

function _isReminder(templateKey, scenario){
  if (templateKey && _REMINDER_SCENARIOS.has(templateKey)) return true;
  if (scenario    && _REMINDER_SCENARIOS.has(scenario))    return true;
  return false;
}

/* ────────────────────────────────────────────────────────────────────
   DAILY TEXT CAP — priority (must-send) list

   At most ONE planned text per recipient per day (see the cap gate in
   onSmsQueued). Texts in this set are the exception: they ALWAYS send,
   even as the 2nd text of the day, because withholding one hurts the
   customer more than an extra buzz — proof of a charge, "your food is
   ready, come get it", and a payment that needs fixing. They still COUNT
   toward the day, so a softer planned text after them is the one that
   gets held.

   Everything NOT listed here is "planned/soft" (locked-in, pickup
   address, pickup reminder, marketing, journeys) and is capped. Live
   delivery-in-motion texts (route kickoff, "you're up next", delivered)
   never reach this consumer — they send Twilio directly — so they're
   outside the cap entirely and need no entry here.

   The "will you be home?" delivery-confirm text is deliberately NOT
   priority (Omar's call, jul 2026): it's delivery-only and lands the
   day before (noon CT), so it rarely shares a day with another text; if
   it ever does, losing it matters less than losing a receipt. Easy to
   promote later by adding its keys here.
   ──────────────────────────────────────────────────────────────────── */
const _PRIORITY_SCENARIOS = new Set([
  // order confirmation (proof of charge)
  'order_confirmation_sms', 'order_confirmation_delivery_sms', 'order.paid',
  // order ready / on its way (actionable "come get it" / "it's moving")
  'order_ready_sms', 'order_out_for_delivery_sms', 'order.ready',
  // payment problems (action required)
  'renewal_failed_sms', 'subscription.renewal_failed',
  'card_preflight_failed_sms', 'subscription.card_preflight_failed',
]);

// A message is exempt from the daily cap when it's on the priority list,
// OR it's a freeform ad-hoc body with no template — a human typed and
// sent it by hand (queueAdHocSms), which shouldn't be swallowed by a cap.
//
// Deliberately does NOT key on `overrideQuietHours`: that flag means only
// "skip the quiet-hours clock", and flushDeferredSmsQueue sets it on EVERY
// text it re-sends the next morning — so treating it as cap-exempt would
// silently exempt anything that happened to be queued overnight. Quiet
// hours and the daily cap are independent gates.
// A bulk send opts INTO the cap with capBulk:true. The freeform-body
// exemption below exists for "a human typed this one text by hand", and a
// personalized blast is freeform by nature (every recipient gets a
// different body, so there's no templateKey to hang it on). Without this
// flag a 200-person blast would be entirely cap-exempt and could buzz the
// same phone on consecutive days — the exact thing the cap prevents.
function _isCapExempt(q){
  if (q.capBulk === true) return false;        // bulk send — cap always applies
  if (!q.templateKey && q.body) return true;   // freeform ad-hoc staff send
  if (q.templateKey && _PRIORITY_SCENARIOS.has(q.templateKey)) return true;
  if (q.scenario    && _PRIORITY_SCENARIOS.has(q.scenario))    return true;
  return false;
}

/* ────────────────────────────────────────────────────────────────────
   Consent for a phone that has NO customer account.

   The opt-in/opt-out gate below keys on `customerId`, which covers every
   text aimed at an account holder. But plenty of real recipients have no
   account: booth signups live in /leads, rewards-only phones live in
   /marketWallets, and both are things we deliberately text. For those,
   `customerId` is absent and the whole gate used to be skipped — so a
   phone-only recipient got NO consent enforcement at all.

   This resolves consent by phone across all three homes. Rules:
     • ANY source saying opted-out wins over any source saying opted-in.
       Opting out is a stronger signal than a stale opt-in, and we'd
       rather drop a message than send one someone asked us to stop.
     • `found` distinguishes "no record anywhere" from "a record that
       says nothing", so marketing can fail closed on the former.

   Costs up to 3 reads per message; only runs when customerId is absent.
   ──────────────────────────────────────────────────────────────────── */
async function _consentByPhone(db, toRaw){
  const digits = String(toRaw == null ? '' : toRaw).replace(/\D/g, '');
  const d10 = digits.length >= 10 ? digits.slice(-10) : '';
  const out = { found: false, optedOut: false, optedIn: false };
  if (d10.length !== 10) return out;
  const e164 = '+1' + d10;

  /* smsOptIn:false is NOT an opt-out. On most docs it means "never opted
     in" — 4 real customer docs carry false with no smsOptOutAt. Treating
     it as an opt-out would suppress their TRANSACTIONAL texts (a booth
     receipt for a purchase they just made), which nothing has ever done.

     So the two flags answer different questions, matching the
     account-path gate above:
       optedOut — a real opt-out signal only (smsOptOutAt, or the STOP
                  suppression list). Blocks everything.
       optedIn  — an explicit yes. Required for MARKETING, so a false or
                  absent value still keeps promos out. */
  const absorb = (data) => {
    if (!data) return;
    out.found = true;
    if (data.smsOptOutAt) out.optedOut = true;
    if (data.smsOptIn === true) out.optedIn = true;
  };

  const [stopSnap, walletSnap, leadSnap, custSnap] = await Promise.all([
    db.collection('smsOptOuts').doc(d10).get().catch(() => null),
    db.collection('marketWallets').doc(d10).get().catch(() => null),
    db.collection('leads').where('phone', '==', e164).limit(1).get().catch(() => null),
    db.collection('customers').where('phone', '==', e164).limit(1).get().catch(() => null),
  ]);
  // smsOptOuts is the authoritative "this number said STOP" list, and it
  // works even for a number we hold no other record of. Checked first
  // because nothing below can override it.
  if (stopSnap && stopSnap.exists){
    out.found = true;
    out.optedOut = true;
    return out;
  }
  if (walletSnap && walletSnap.exists) absorb(walletSnap.data());
  if (leadSnap && !leadSnap.empty) absorb(leadSnap.docs[0].data());
  if (custSnap && !custSnap.empty) absorb(custSnap.docs[0].data());
  return out;
}

// CT calendar day (YYYY-MM-DD) — the bucket the cap counts within.
function _ctDayStr(d){
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d instanceof Date ? d : new Date(d || Date.now()));
}

/* ────────────────────────────────────────────────────────────────────
   Render {{path.field}} placeholders against a nested vars object.
     _render('hi {{customer.firstName}}, order {{order.id}}', {
       customer: { firstName: 'Omar' },
       order:    { id: '5102' }
     }) === 'hi Omar, order 5102'

   Missing keys render as empty string (NOT the {{placeholder}} text)
   so half-rendered SMSes never get sent with raw braces visible.
   ──────────────────────────────────────────────────────────────────── */
function _render(body, vars){
  if (!body || typeof body !== 'string') return '';
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const keys = path.split('.');
    let v = vars || {};
    for (const k of keys){
      if (v == null || typeof v !== 'object') return '';
      v = v[k];
    }
    return v == null ? '' : String(v);
  });
}

async function _loadTemplate(db, queueDoc){
  // Producers may set either an explicit templateKey OR fall back to
  // looking up by scenario (handy for one-off ad-hoc sends).
  const tplKey = queueDoc.templateKey || queueDoc.scenario;
  if (!tplKey) return null;
  const snap = await db.collection('commTemplates').where('key', '==', tplKey).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].data();
}

/* ────────────────────────────────────────────────────────────────────
   Missing/mis-channelled template alarm

   A template_not_found (or wrong-channel) failure is a DEVELOPER error,
   not a customer one: code shipped referencing a commTemplates key that
   was never created, so EVERY send of that type fails until someone
   creates it. These went unnoticed for weeks — six times between May and
   Jul 2026, most recently review_request_sms, which failed for 13 days
   and was only found by hand-reading the queue. They're invisible
   because the failure lands on a queue doc nobody reads, AND producers
   typically stamp their "already sent" flag on the order BEFORE
   enqueueing (an anti-double-send measure), so the order looks fine.

   So: ping the staff phones instead. Deliberately push-only — an alarm
   about a broken SMS template must not itself depend on an SMS template.

   Throttled to one push per key per day by a marker doc created with
   .create(), which fails if the doc already exists. That's atomic, so
   a burst of failures across concurrent invocations still pushes once.
   Never throws: an alarm must not be able to break the queue.
   ──────────────────────────────────────────────────────────────────── */
async function _alarmTemplateProblem(db, key, detail){
  try {
    const day = new Date().toISOString().slice(0, 10);            // UTC day is fine — this is a dedupe bucket, not a schedule
    const id  = `smsTemplate__${String(key).replace(/[^\w-]/g, '_')}__${day}`;
    await db.collection('opsAlerts').doc(id).create({
      kind:        'sms_template_problem',
      templateKey: key,
      detail:      detail || '',
      at:          admin.firestore.FieldValue.serverTimestamp(),
    });
    const { pushAllStaff } = require('../comms/apnsPush');
    const r = await pushAllStaff(db, {
      key: 'smsTemplateBroken',
      title: 'a text type is broken',
      body:  `no message copy for "${key}" — that text fails for every customer until it's created in HQ2 → Communications.`,
    });
    if (!r.devices){
      console.warn('[sms-queue] template problem for', key, '— no staff devices to alert');
      return;
    }
    console.log('[sms-queue] alerted staff: template problem', key, detail || '');
  } catch (e){
    // ALREADY_EXISTS = we alerted for this key today; anything else is a
    // genuine alarm failure worth a log line, but never a thrown error.
    if (e && e.code !== 6) console.error('[sms-queue] template alarm failed:', e.message);
  }
}

exports.onSmsQueued = onDocumentCreated({
  document: 'smsQueue/{docId}',
  // APNS_AUTH_KEY: staff push when a template is missing (see
  // _alarmTemplateProblem). Already mounted on the staffAlerts functions.
  secrets: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'APNS_AUTH_KEY'],
}, async (event) => {
  const snap = event.data;
  if (!snap) return;
  const db = admin.firestore();
  const q = snap.data() || {};
  const FieldValue = admin.firestore.FieldValue;

  // Log-only records: the live delivery texts (route kickoff, "you're up
  // next", delivered confirmation) call Twilio directly for speed and then
  // drop an already-terminal doc here via _logDirectSms purely so the HQ
  // Comms log / Inbox / customer timeline show them. Only docs born
  // status:'queued' are ours to dispatch — sending a doc that records an
  // ALREADY-sent text would double-text the customer.
  if (q.status && q.status !== 'queued') return;

  // Guard: no recipient phone
  if (!q.to || typeof q.to !== 'string'){
    await snap.ref.update({
      status: 'failed',
      errorMessage: 'no_to_phone',
      failedAt: FieldValue.serverTimestamp(),
    }).catch(() => {});
    return;
  }

  // ── Quiet-hours guard ─────────────────────────────────────────────
  // Customer SMSes only dispatch between 08:00 and 21:00 in
  // America/Chicago. Outside that window the doc gets stamped
  // status:'deferred' with a deferredUntil ISO; flushDeferredSmsQueue
  // (cron at 08:00 CT daily) picks them up and re-creates them with
  // overrideQuietHours:true so the trigger fires fresh inside hours.
  //
  // To bypass quiet hours (e.g. critical staff-only ad-hoc messages),
  // the producer sets `overrideQuietHours: true` on the queue doc.
  if (!q.overrideQuietHours) {
    const ctParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: '2-digit', hour12: false,
    }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
    const ctHour = parseInt(ctParts.hour, 10);
    if (ctHour < 8 || ctHour >= 21) {
      const deferredUntil = _nextEightAmCT(new Date());
      await snap.ref.update({
        status:        'deferred',
        deferredUntil: deferredUntil.toISOString(),
        deferredAt:    FieldValue.serverTimestamp(),
      }).catch(() => {});
      return;
    }
  }

  // ── 1. Load template (skipped if the producer supplied a literal body) ─
  // Freeform-body shortcut: queueAdHocSms can pass `body` instead of
  // `templateKey` for one-off staff sends (HQ2 Compose → single phone).
  // In that case we skip template lookup entirely and use q.body
  // verbatim in step 2.
  let tpl = null;
  if (!q.body){
    try { tpl = await _loadTemplate(db, q); }
    catch (e){ console.error('[sms-queue] template load failed:', e.message); }
    if (!tpl){
      const missingKey = q.templateKey || q.scenario || '(none)';
      await snap.ref.update({
        status: 'failed',
        errorMessage: 'template_not_found:' + missingKey,
        failedAt: FieldValue.serverTimestamp(),
      }).catch(() => {});
      await _alarmTemplateProblem(db, missingKey, 'template_not_found');
      return;
    }
    if (tpl.enabled === false){
      await snap.ref.update({
        status: 'skipped',
        skippedReason: 'template_disabled',
        sentAt: FieldValue.serverTimestamp(),
      }).catch(() => {});
      return;
    }
    if (tpl.channel && tpl.channel !== 'sms'){
      await snap.ref.update({
        status: 'failed',
        errorMessage: 'template_wrong_channel:' + tpl.channel,
        failedAt: FieldValue.serverTimestamp(),
      }).catch(() => {});
      await _alarmTemplateProblem(db, q.templateKey || q.scenario || '(none)',
                                  'template_wrong_channel:' + tpl.channel);
      return;
    }
  }

  // ── 2. Render body ─────────────────────────────────────────────────
  // Template path: render tpl.body against vars.
  // Freeform path: q.body has already been composed by the producer;
  // we still pipe it through _render so {{customer.firstName}} style
  // placeholders work if vars were supplied.
  const body = tpl
    ? _render(tpl.body || '', q.vars || {})
    : _render(String(q.body || ''), q.vars || {});
  if (!body.trim()){
    await snap.ref.update({
      status: 'failed',
      errorMessage: 'render_empty',
      failedAt: FieldValue.serverTimestamp(),
    }).catch(() => {});
    return;
  }

  // ── 3. Opt-in / opt-out check ──────────────────────────────────────
  // Hard opt-out (STOP keyword) blocks EVERYTHING. Marketing requires
  // explicit opt-in; transactional is allowed by default.
  if (q.customerId){
    try {
      const cs = await db.collection('customers').doc(q.customerId).get();
      if (cs.exists){
        const c = cs.data();
        if (c.smsOptOutAt){
          await snap.ref.update({
            status: 'skipped',
            skippedReason: 'customer_opted_out',
            sentAt: FieldValue.serverTimestamp(),
          }).catch(() => {});
          return;
        }
        if (_isMarketing(q.templateKey, q.scenario) && c.smsOptIn !== true){
          await snap.ref.update({
            status: 'skipped',
            skippedReason: 'not_opted_in_for_marketing',
            sentAt: FieldValue.serverTimestamp(),
          }).catch(() => {});
          return;
        }
        // Scoped reminder opt-out — the customer asked us to stop the
        // pickup / renewal nudge texts specifically. Other transactional
        // texts (order ready, payment problems) are unaffected.
        if (_isReminder(q.templateKey, q.scenario) && c.smsRemindersOff === true){
          await snap.ref.update({
            status: 'skipped',
            skippedReason: 'reminders_disabled',
            sentAt: FieldValue.serverTimestamp(),
          }).catch(() => {});
          return;
        }
      }
    } catch (e){
      console.error('[sms-queue] pref lookup failed for', q.customerId, e.message);
      // For marketing, fail-closed. For transactional, fail-open (the
      // customer initiated the action; we still owe them the receipt).
      if (_isMarketing(q.templateKey, q.scenario)){
        await snap.ref.update({
          status: 'failed',
          errorMessage: 'pref_lookup_failed:' + e.message,
          failedAt: FieldValue.serverTimestamp(),
        }).catch(() => {});
        return;
      }
    }
  } else {
    // No account on this message — resolve consent by PHONE instead, so
    // booth leads and rewards-only wallets get the same protection an
    // account holder gets. Without this branch a phone-only recipient
    // sailed past every consent check.
    try {
      const pc = await _consentByPhone(db, q.to);
      if (pc.optedOut){
        await snap.ref.update({
          status: 'skipped',
          skippedReason: 'phone_opted_out',
          sentAt: FieldValue.serverTimestamp(),
        }).catch(() => {});
        return;
      }
      // Marketing to a phone we hold no consent record for: refuse. An
      // absent record is not permission. Transactional is unaffected —
      // booth receipts and welcome texts are freeform sends that aren't
      // classed as marketing, and the person just handed over the number.
      if (_isMarketing(q.templateKey, q.scenario) && !pc.optedIn){
        await snap.ref.update({
          status: 'skipped',
          skippedReason: pc.found ? 'not_opted_in_for_marketing' : 'no_consent_record',
          sentAt: FieldValue.serverTimestamp(),
        }).catch(() => {});
        return;
      }
    } catch (e){
      console.error('[sms-queue] phone consent lookup failed for', q.to, e.message);
      if (_isMarketing(q.templateKey, q.scenario)){
        await snap.ref.update({
          status: 'failed',
          errorMessage: 'pref_lookup_failed:' + e.message,
          failedAt: FieldValue.serverTimestamp(),
        }).catch(() => {});
        return;
      }
    }
  }

  // ── 3b. Staff "leave this alone" skip ──────────────────────────────
  // A per-order skip or an unexpired per-customer hold set by staff — see
  // src/comms/commSkip.js. Runs OUTSIDE the `if (q.customerId)` block
  // above because an order-scoped skip must work for guest orders too,
  // which carry an orderId but no customerId. Never blocks receipts,
  // payment failures, or cancellations (NEVER_SKIPPABLE), and fails open.
  {
    const _skip = await _commSkip.shouldSkip(db, {
      orderId:     q.orderId,
      customerId:  q.customerId,
      templateKey: q.templateKey,
      scenario:    q.scenario,
    });
    if (_skip){
      await snap.ref.update({
        status: 'skipped',
        skippedReason: _skip.reason,
        sentAt: FieldValue.serverTimestamp(),
      }).catch(() => {});
      console.log('[sms-queue] skipped', q.templateKey || q.scenario, '→', _skip.reason, '(' + _skip.scope + ')');
      return;
    }
  }

  // ── 3c. Daily text cap ────────────────────────────────────────────
  // At most one PLANNED text per recipient per day. Runs LAST among the
  // gates so a text that would've been skipped anyway (opt-out, hold)
  // never burns the day's single slot. Keyed on the recipient phone (not
  // customerId) so it also covers guests and matches who actually gets
  // buzzed. Priority + staff sends are exempt (see _isCapExempt) but
  // still counted, in the send step, so a soft text after them is held.
  // Fails OPEN: a lookup error sends the text rather than silently
  // dropping it. `_capRef`/`_capExempt` are reused in step 5.
  const _capDay    = _ctDayStr(new Date());
  const _phoneKey  = String(q.to).replace(/\D/g, '');
  const _capExempt = _isCapExempt(q);
  const _capRef    = _phoneKey
    ? db.collection('smsDailyLog').doc(_phoneKey + '__' + _capDay)
    : null;
  if (_capRef && !_capExempt){
    let alreadyToday = false;
    try {
      const capSnap = await _capRef.get();
      alreadyToday = capSnap.exists && (capSnap.data().count || 0) > 0;
    } catch (e){
      console.error('[sms-queue] daily-cap lookup failed:', e.message);  // fail open
    }
    if (alreadyToday){
      await snap.ref.update({
        status: 'skipped',
        skippedReason: 'daily_limit',
        sentAt: FieldValue.serverTimestamp(),
      }).catch(() => {});
      console.log('[sms-queue] daily cap · held', q.templateKey || q.scenario, '→', _phoneKey);
      return;
    }
  }

  // ── 4. Dispatch via Twilio ─────────────────────────────────────────
  const result = await sendTwilioSms({ to: q.to, body });

  // ── 5. Persist outcome ─────────────────────────────────────────────
  if (result.ok){
    await snap.ref.update({
      status: 'sent',
      renderedBody: body,
      twilioSid: result.sid || null,
      twilioStatus: result.status || null,
      sentAt: FieldValue.serverTimestamp(),
    }).catch(() => {});
    // Count this send toward the recipient's daily cap. Every sent text
    // counts — priority ones included — so a soft text later the same day
    // is held. Only counts on a real send, so a Twilio failure doesn't
    // wrongly gag the next text. expireAt lets a Firestore TTL policy on
    // smsDailyLog auto-clean these one-per-phone-per-day rows (~30 days).
    if (_capRef){
      _capRef.set({
        count: FieldValue.increment(1),
        lastAt: FieldValue.serverTimestamp(),
        lastTemplate: q.templateKey || q.scenario || null,
        phone: q.to,
        day: _capDay,
        expireAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      }, { merge: true }).catch(() => {});
    }
  } else {
    await snap.ref.update({
      status: 'failed',
      renderedBody: body,
      errorMessage: result.error || 'send_failed',
      twilioCode: result.twilioCode || null,
      failedAt: FieldValue.serverTimestamp(),
    }).catch(() => {});
  }
});

/* ────────────────────────────────────────────────────────────────────
   Helper used by producers — wrapping admin.firestore().collection('smsQueue').add()
   with the standard initial fields so every producer writes a consistent shape.
   ──────────────────────────────────────────────────────────────────── */
exports._queueSms = async function _queueSms(payload){
  const db = admin.firestore();
  return db.collection('smsQueue').add(Object.assign({
    status: 'queued',
    queuedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, payload));
};

/* ────────────────────────────────────────────────────────────────────
   _logDirectSms — audit-trail record for texts sent OUTSIDE the queue.

   The live delivery texts (startDeliveryRoute's kickoff, delivery-eta-
   sms.js's "you're up next" + delivered confirmation) call Twilio
   directly — the queue's opt-in gates, quiet hours, and daily cap
   deliberately don't apply to a delivery already in motion. But that
   made them invisible in HQ: the Comms log, the Inbox, and the customer
   timeline all read smsQueue, and Twilio's delivery receipts
   (twilioStatusCallback) match on smsQueue.twilioSid — no doc, no trace.

   This writes the doc AFTER the fact, in the same terminal shape
   onSmsQueued leaves behind, so every downstream reader works unchanged:
     • HQ Comms SMS log (reads smsQueue by queuedAt)  → row appears
     • activityOnSmsQueueUpdated (crm/activities.js)  → mirrors to the
       /communications Inbox + customer timeline on the create
     • twilioStatusCallback                           → finds twilioSid,
       stamps deliveryStatus (delivered/undelivered/failed)
   onSmsQueued ignores these docs (born non-'queued', see the guard at
   the top of the trigger) so they can never dispatch a duplicate text.

   Never throws — a logging failure must not break a delivery flow.
   ──────────────────────────────────────────────────────────────────── */
exports._logDirectSms = async function _logDirectSms(entry){
  try {
    const db = admin.firestore();
    const FieldValue = admin.firestore.FieldValue;
    const doc = {
      status:       entry.ok ? 'sent' : 'failed',
      directSend:   true,
      scenario:     entry.scenario || null,
      to:           entry.to || null,
      renderedBody: String(entry.body || ''),
      customerId:   entry.customerId || null,
      orderId:      entry.orderId || null,
      vars:         entry.vars || null,
      queuedAt:     FieldValue.serverTimestamp(),
    };
    if (entry.ok){
      doc.twilioSid    = entry.sid || null;
      doc.twilioStatus = entry.twilioStatus || null;
      doc.sentAt       = FieldValue.serverTimestamp();
    } else {
      doc.errorMessage = entry.error || 'send_failed';
      doc.twilioCode   = entry.twilioCode || null;
      doc.failedAt     = FieldValue.serverTimestamp();
    }
    await db.collection('smsQueue').add(doc);
  } catch (e){
    console.warn('[sms-queue] direct-send log failed:', e.message);
  }
};

/* ────────────────────────────────────────────────────────────────────
   _nextEightAmCT — returns a Date instance for the next 08:00 in
   America/Chicago. If `from` is before today's 8am CT, returns today's.
   Otherwise returns tomorrow's. DST-aware via Intl round-trip.
   Used by the quiet-hours guard above to stamp deferredUntil.
   ──────────────────────────────────────────────────────────────────── */
function _nextEightAmCT(from){
  const now = from instanceof Date ? from : new Date(from || Date.now());
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now).reduce((o, p) => (o[p.type] = p.value, o), {});
  const hour = parseInt(parts.hour, 10);
  const min  = parseInt(parts.minute, 10);
  const addDays = (hour > 8 || (hour === 8 && min > 0)) ? 1 : 0;
  const y  = parseInt(parts.year, 10);
  const m  = parseInt(parts.month, 10);
  const dd = parseInt(parts.day, 10) + addDays;
  for (const utcOffset of [5, 6]) {
    const candidate = new Date(Date.UTC(y, m - 1, dd, 8 + utcOffset, 0, 0));
    const back = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(candidate).reduce((o, p) => (o[p.type] = p.value, o), {});
    if (parseInt(back.hour, 10) === 8 && parseInt(back.minute, 10) === 0) {
      return candidate;
    }
  }
  // Fallback — won't be reached unless Intl returns something bizarre.
  return new Date(Date.UTC(y, m - 1, dd, 13, 0, 0));
}

/* ════════════════════════════════════════════════════════════════════
   flushDeferredSmsQueue — daily 08:00 CT cron that picks up smsQueue
   docs that were deferred by the quiet-hours guard overnight and
   re-creates them with overrideQuietHours:true so onSmsQueued fires
   fresh and dispatches them inside hours.

   Why re-create rather than update: onDocumentCreated only fires on
   doc creation, not on updates. Re-creating means the trigger runs
   the dispatch path normally, with all opt-in checks intact. The
   original doc is marked status:'rescheduled' for audit.
   ════════════════════════════════════════════════════════════════════ */
exports.flushDeferredSmsQueue = onSchedule({
  schedule: '0 8 * * *',
  timeZone: 'America/Chicago',
  retryCount: 0,
  secrets: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'],
}, async () => {
  const db     = admin.firestore();
  const nowMs  = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Single-field query only. A composite (status + deferredUntil) query needs a
  // dedicated index; when that index was missing the query threw
  // FAILED_PRECONDITION every run and the whole flush silently did nothing —
  // deferred texts piled up unsent for weeks (Marta's "ready for pickup", Jul
  // 2026). status==deferred alone uses the automatic single-field index, so it
  // can never be broken by a missing composite index. We apply the
  // deferredUntil<=now cutoff in memory below.
  let snap;
  try {
    snap = await db.collection('smsQueue')
      .where('status', '==', 'deferred')
      .limit(500)
      .get();
  } catch (e) {
    console.error('[flushDeferredSmsQueue] query failed:', e.message);
    return;
  }

  // Safety valve: a legitimately-deferred text waits at most one overnight
  // (~11h, e.g. queued at 9:01pm → 8am next day). Anything whose deferredUntil
  // is more than a day in the past means the flush was stuck — sending a
  // days-old "your order is ready" text would confuse the customer, so expire
  // it instead of dispatching.
  const STALE_MS = 24 * 60 * 60 * 1000;

  let flushed = 0, expired = 0, notDue = 0;
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const du   = data.deferredUntil;
    if (!du || du > nowIso) { notDue++; continue; } // not yet inside sending hours

    if ((nowMs - new Date(du).getTime()) > STALE_MS) {
      await doc.ref.update({
        status:        'expired',
        expiredReason: 'deferred_too_long',
        expiredAt:     admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
      expired++;
      continue;
    }

    const next = Object.assign({}, data, {
      status:             'queued',
      overrideQuietHours: true,
      rescheduledFrom:    doc.id,
      queuedAt:           admin.firestore.FieldValue.serverTimestamp(),
    });
    // Strip the deferral bookkeeping from the new doc.
    delete next.deferredUntil;
    delete next.deferredAt;
    try {
      await db.collection('smsQueue').add(next);
      await doc.ref.update({
        status:        'rescheduled',
        rescheduledAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
      flushed++;
    } catch (e) {
      console.error('[flushDeferredSmsQueue] re-create failed for', doc.id, e.message);
    }
  }
  console.log(`[flushDeferredSmsQueue] flushed ${flushed}, expired ${expired}, not-due ${notDue} of ${snap.size} deferred`);
});
