'use strict';

/* ════════════════════════════════════════════════════════════════════
   SMS Producers — Firestore triggers + scheduled functions that queue
   transactional + marketing SMS sends. Each producer writes a doc to
   smsQueue/{id} which the onSmsQueued consumer (queue.js) then renders
   and dispatches via Twilio.

   The producers in this file:
     • onOrderPaidQueueSms        — Order confirmation
     • onOrderReadyQueueSms       — Order ready for pickup
     • onCustomerOptedInQueueSms  — Welcome SMS (smsOptIn flips →true)
     • pickupReminderSms          — Pickup reminder (every 15 min)
     • deliveryConfirmAskSms      — Evening-before delivery ask: window
                                    + "will you be home? reply YES/NO"
                                    + notes link (daily 18:00 CT)
     • renewalComingUpSms         — Renewal in 24hr (daily 09:00 CT)
     • onRenewalFailedQueueSms    — Renewal failed (Firestore trigger
                                    on subscription doc status→past_due)
     • cartAbandonmentSms         — Cart abandoned (extends existing
                                    email-only abandonedCartReminders)
     • queueAdHocSms              — Staff-triggered ad-hoc (HQ button
                                    for "order delayed / out of stock")

   Each producer is responsible for:
     1. Detecting the trigger event
     2. Looking up customer phone + first-name
     3. Building the `vars` object for template rendering
     4. Calling _queueSms (which handles opt-in checks + dispatch)
   ──────────────────────────────────────────────────────────────────── */

const {onDocumentWritten} = require('firebase-functions/v2/firestore');
const {onSchedule}        = require('firebase-functions/v2/scheduler');
const {onRequest}         = require('firebase-functions/v2/https');
const admin               = require('firebase-admin');
const {_queueSms}         = require('./queue');
const _fulfillmentSchedule = require('../lib/fulfillmentSchedule');

const {REMINDER_ELIGIBLE_STATUSES} = require('../lib/orderStatus');
const {joinPickupAddress}          = require('../lib/pickup-address');

// A delivery/pickup window label that is SAFE TO TEXT.
//
// formatWindowLabel() builds "8am–1pm" with an EN DASH, and U+2013 is not in
// the GSM-7 alphabet. One such character tips the whole message into UCS-2,
// which cuts the per-segment budget from 160/153 characters to 70/67 — so it
// roughly DOUBLES the Twilio bill for every text that carries it. A real
// order-confirmation body measured 164 characters: 3 billed segments with the
// en dash, 2 with a plain hyphen.
//
// The day-before ask at the bottom of this file already did this by hand, with
// a comment explaining the cost. The order.paid and order.ready producers never
// got the same treatment, so every delivery confirmation and every
// on-the-way text has been billed at the expensive encoding. One helper now, so
// there is a single place to get this right.
function _smsWindowLabel(ffSettings) {
  return String(_fulfillmentSchedule.formatWindowLabel(ffSettings) || '8am-1pm')
    .replace(/[\u2013\u2014]/g, '-');
}

// Build the short pickup-location string for the day-before SMS from the
// operator-configured /settings/fulfillment doc (HQ2 → Field service →
// Delivery schedule): "<Market> Farmers Market, <street>, <city>, MN
// <zip>". Returns '' when nothing's configured — pickup is ALWAYS a
// farmers-market booth, so we must NEVER fall back to the private kitchen
// address; the caller shows neutral copy instead. Mirrors the
// email rule in email-templates-v5.js _pickupLoc (Omar, jun 2026).
function _pickupLocationString(ff){
  // joinPickupAddress dedupes a "City, ST zip" that's already inside the
  // street line, so a full address typed into addressLine1 doesn't print the
  // city/state/zip twice.
  return joinPickupAddress([
    ff && ff.pickupLocationLabel,
    ff && ff.pickupAddressLine1,
    ff && ff.pickupAddressLine2,
  ]);
}

// Per-ORDER pickup-location string for the day-before SMS. Prefers the market
// the order is actually for — re-resolved against CURRENT settings by
// pickupMarketId so an edited address is up to date — then the snapshot baked
// on the order at purchase, then the first configured market.
function _orderPickupString(o, ff){
  const markets = (ff && Array.isArray(ff.pickupMarkets)) ? ff.pickupMarkets : [];
  const m = (o && o.pickupMarketId) ? markets.find(x => x && x.id === o.pickupMarketId) : null;
  const snap = (o && o.pickupLocation && typeof o.pickupLocation === 'object') ? o.pickupLocation : null;
  const parts = m
    ? [m.label, m.addressLine1, m.addressLine2]
    : (snap ? [snap.label, snap.line1, snap.line2] : []);
  const joined = joinPickupAddress(parts);
  return joined || _pickupLocationString(ff);
}

// Full pickup address for the customer pickup texts.
//   addr = "<Market Name>, <street>, <city>, MN <zip>" — current settings
//          → baked snapshot → first configured market; '' when nothing resolves
//          (NEVER the private kitchen, per _orderPickupString).
// Each producer applies its own leading separator so the sentence reads cleanly,
// and omits it when addr is '' (no dangling " · "). This is what put
// the full street address into the confirmation / ready / reminder texts — it
// used to be market-NAME-only there, with the address deferred to the day-before
// text (Omar, jun 2026: customers want the address in every transactional text).
// NO separate maps URL: phones auto-link the street address itself, so a
// "map: https://…" tail is redundant (Omar, jul 2026). Producers no longer
// supply {{order.pickupMapLink}}; _render blanks it in any older template.
function _pickupAddrParts(o, ff){
  const addr = _orderPickupString(o, ff);
  return { addr };
}

// The market an order is being picked up at (or null — delivery orders have
// pickupMarketId=null). Used to name the pickup window in the same-day reminder.
function _orderMarket(o, ff){
  const markets = (ff && Array.isArray(ff.pickupMarkets)) ? ff.pickupMarkets : [];
  return (o && o.pickupMarketId) ? (markets.find(x => x && x.id === o.pickupMarketId) || null) : null;
}

// Current hour (0-23) in America/Chicago. The server clock is UTC, so we can't
// read new Date().getHours() — that would be 5-6 hours off and break the
// morning-of send gate.
function _ctHour(ms){
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: '2-digit', hour12: false,
  }).formatToParts(new Date(ms)).reduce((o, x) => (o[x.type] = x.value, o), {});
  const h = parseInt(p.hour, 10);
  return h === 24 ? 0 : h;
}

// Catering jobs are hand-managed, event-dated sales — they must NEVER get
// the weekly automated copy. "Head to the market, we open at 8am" or "will
// you be home for your 12–5pm window?" is wrong (and embarrassing) on a
// $900 corporate lunch. Catering confirmations go out from the invoice
// flow itself; day-of coordination is a phone call, not a cron.
// Covers both shapes: the new orderType axis and the pre-consolidation
// fulfillmentType:'catering' single-axis docs.
function _isCateringOrder(o){
  if (!o) return false;
  if (String(o.orderType || '').toLowerCase() === 'catering') return true;
  return String(o.fulfillmentType || '').toLowerCase() === 'catering';
}

const _PAID_STATUSES      = new Set(['paid','succeeded','complete','completed']);
const _READY_STATUSES     = new Set(['ready','ready_for_pickup','ready-for-pickup','prepared']);
const _OFD_STATUSES       = new Set(['out_for_delivery','out for delivery','in_transit','in transit','shipped']);
const _SUB_FAILED_STATUSES = new Set(['past_due','payment_failed','renewal_failed','unpaid']);

/* ────────────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────────────── */
function _firstName(c){
  if (!c) return '';
  if (c.firstName) return c.firstName;
  const full = c.name || c.displayName || '';
  return String(full).split(' ')[0] || '';
}

function _money(n){
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return v.toFixed(2);
}

// Format a Firestore Timestamp / Date / ms-number as "Thu 5/14 4-7pm".
// Always renders in America/Chicago — the server's local clock is UTC,
// so reading d.getDay()/getMonth()/getHours() directly would shift the
// label by 5-6 hours and roll past midnight, which is how renewal SMS
// started saying "tomorrow" at 7pm Central.
function _fmtPickup(when, windowMinutes){
  if (!when) return '';
  let d;
  if (when && typeof when.toDate === 'function') d = when.toDate();
  else if (when instanceof Date)                  d = when;
  else                                            d = new Date(when);
  if (!d || isNaN(d.getTime())) return '';
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', month: 'numeric', day: 'numeric',
    hour: 'numeric', hour12: true,
  });
  const partsOf = (date) => fmt.formatToParts(date)
    .reduce((o, p) => (o[p.type] = p.value, o), {});
  const p     = partsOf(d);
  const ampm  = (p.dayPeriod || '').toLowerCase();
  if (windowMinutes){
    const end     = partsOf(new Date(d.getTime() + windowMinutes * 60000));
    const eAmpm   = (end.dayPeriod || '').toLowerCase();
    // Collapse "4pm-7pm" to "4-7pm" when both ends share a period —
    // matches the original output style the SMS templates were built
    // around.
    const startTime = ampm === eAmpm ? p.hour : `${p.hour}${ampm}`;
    return `${p.weekday} ${p.month}/${p.day} ${startTime}-${end.hour}${eAmpm}`;
  }
  return `${p.weekday} ${p.month}/${p.day} ${p.hour}${ampm}`;
}

/* ────────────────────────────────────────────────────────────────────
   Pickup-cutoff helper — mirrors _thisWeekSundayDateStr in
   functions/index.js. tandoco's order cycle:
     • Orders close Thursday 23:59 Central
     • Pickup is the very next Sunday
     • Orders placed Fri 00:00+ roll to the SUNDAY AFTER NEXT
   Returns a Date object (UTC midnight on the pickup day) AND
   a "Ddd M/D" formatted string (real weekday) for SMS body rendering.

   Why we re-implement instead of importing _thisWeekSundayDateStr:
   it's a private fn in index.js without a clean export, and we want
   the SMS path to compute on the source-of-truth (the ORDER's
   createdAt, not the function-execution time) so a delayed trigger
   doesn't slip a customer into the wrong bucket.
   ──────────────────────────────────────────────────────────────────── */
function _pickupSundayFromOrder(order){
  // Prefer the order's stored pickup date if it has one.
  if (order && order.pickupAt){
    const d = order.pickupAt.toDate ? order.pickupAt.toDate() : new Date(order.pickupAt);
    if (d && !isNaN(d.getTime())) return d;
  }
  if (order && order.pickupDate){
    // Stored as YYYY-MM-DD per the addon flow's _thisWeekSundayDateStr.
    const m = String(order.pickupDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(Date.UTC(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10)));
  }
  // Fall back to computing from the order's createdAt (or now).
  const baseTs = order && order.createdAt && order.createdAt.toDate
    ? order.createdAt.toDate()
    : (order && order.createdAt instanceof Date ? order.createdAt : new Date());
  return _nextPickupSunday(baseTs);
}

function _nextPickupSunday(now){
  // Mirrors the logic in functions/index.js _thisWeekSundayDateStr.
  // Cutoff: Thursday 23:59 Central. Past that → Sunday of the FOLLOWING
  // week. Wednesday → upcoming Sunday. Sunday-Wednesday → upcoming Sunday.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const parts = fmt.formatToParts(now || new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  const weekdayMap = {Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
  const dow  = weekdayMap[parts.weekday];
  const hour = parseInt(parts.hour, 10);
  const min  = parseInt(parts.minute, 10);
  // 11:59pm Thursday is still pre-cutoff. Friday 00:00+ is post.
  const pastCutoff = (dow > 4) || (dow === 4 && (hour === 23 && min >= 59 || hour > 23 /* unreachable */));
  // Days from today (CT) to next Sunday
  const daysToSunday = ((7 - dow) % 7);
  const shift = pastCutoff
    ? (daysToSunday === 0 ? 7 : daysToSunday)
    : (daysToSunday === 0 ? 0 : daysToSunday);
  const y = parseInt(parts.year,  10);
  const m = parseInt(parts.month, 10) - 1;
  const d = parseInt(parts.day,   10);
  const base = new Date(Date.UTC(y, m, d));
  base.setUTCDate(base.getUTCDate() + shift);
  return base;
}

// Format a pickup Date as "Sun 5/17" / "Sat 7/18". Pickup dates arrive as
// UTC midnight of the pickup day (see _pickupSundayFromOrder), so the
// weekday must come from the UTC getters like month/day already do —
// rendering in CT would slip the whole thing back a day. The weekday used
// to be a hardcoded "Sun", which mislabeled Saturday market pickups.
const _FMT_WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function _fmtPickupSunday(d){
  if (!d || isNaN(d.getTime())) return '';
  const wd  = _FMT_WEEKDAYS[d.getUTCDay()];
  const m   = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${wd} ${m}/${day}`;
}

// Surface the customer-facing order number. Falls back to doc id for
// pre-orderNumber legacy orders.
function _orderNumberOf(order, fallbackDocId){
  return (order && (order.orderNumber || order.number)) || fallbackDocId || '';
}

// Same safe alphabet + format as generateOrderNumber() in functions/index.js
// and the client-side copy in checkout.html. Kept in sync by convention.
const _ORDER_NUM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function _genOrderNumber(){
  let code = '';
  for (let i = 0; i < 5; i++){
    code += _ORDER_NUM_ALPHABET[Math.floor(Math.random() * _ORDER_NUM_ALPHABET.length)];
  }
  return `TDC-${code}`;
}

// Return the customer-facing TDC-XXXXX order number, generating and
// persisting one onto the order doc when it's missing (legacy/test orders
// written before the unified generator) so the SMS never shows the raw
// Firestore doc id.
async function _ensureOrderNumber(doc, order){
  const existing = order && (order.orderNumber || order.number);
  if (existing) return existing;
  const code = _genOrderNumber();
  try { await doc.ref.set({ orderNumber: code }, { merge: true }); } catch (_) {}
  return code;
}

/* THE `order_ready` EMAIL IS NOT SENT FROM THIS FILE — see
   src/comms/orderReadyEmail.js (onOrderReadyQueueEmail).

   A _queueReadyEmail helper lived here from Jul 30 → Aug 1 2026, added on
   the reasoning that the written-but-unsent order_ready template had no
   producer. It had one: orderReadyEmail.js, added five days earlier. Both
   watched the same status edge and wrote to the same `mail` collection, so
   every pickup customer got the email twice (order TDC-93RSF, Aug 1). The
   stamp this helper carried couldn't help — the other sender never read it.

   Do not re-add an email send here. This file owns the TEXT; the email twin
   fires off the same two edges from its own trigger, and covers the case
   this producer can't (no phone on the order). */

async function _lookupCustomer(db, customerId){
  if (!customerId) return null;
  try {
    const cs = await db.collection('customers').doc(customerId).get();
    return cs.exists ? cs.data() : null;
  } catch (e){
    console.error('[sms-producer] customer lookup failed:', e.message);
    return null;
  }
}

// Did this customer place an order AFTER their cart was last touched?
// If so the cart converted and there is nothing to recover — never nudge
// them about it. This is the last line of defence for the "your cart's
// still waiting" text that went to a customer ~24h after they'd paid:
// the abandonedCarts snapshot is supposed to be flipped to completed:true
// at checkout, and now is (order-confirmed.html + the order-created
// trigger in crm/customerStats.js), but a stale doc — one written before
// that fix, or left behind by any future path that forgets — must not be
// able to produce a wrong text. Uses the existing uid+createdAt index.
// Errs on the side of NOT sending: a lookup failure returns true (skip).
async function _orderedSinceCart(db, uid, cartUpdatedAt){
  if (!uid) return true;
  const cartMs = cartUpdatedAt && cartUpdatedAt.toDate
    ? cartUpdatedAt.toDate().getTime()
    : (cartUpdatedAt instanceof Date ? cartUpdatedAt.getTime() : null);
  if (!cartMs) return true;               // no usable timestamp → don't guess
  try {
    const snap = await db.collection('orders')
      .where('uid', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    if (snap.empty) return false;
    const o = snap.docs[0].data() || {};
    const at = o.createdAt && o.createdAt.toDate ? o.createdAt.toDate().getTime() : null;
    if (!at) return false;
    // 5-minute grace: the cart doc is written on a 2s debounce from the
    // browser while the order is stamped server-side, so a converted cart
    // can look a hair "newer" than the order it turned into.
    return at >= (cartMs - 5 * 60_000);
  } catch (e){
    console.error('[sms-producer] ordered-since-cart check failed:', e.message);
    return true;                          // fail closed — skip the nudge
  }
}

// The contact phone for an ORDER text. The number the customer typed at
// checkout lives ON the order (delivery.phoneE164/phone for delivery,
// customerPhone for pickup — checkout requires it in both modes and guests
// have no profile at all), so it is the primary source. The customer
// profile phone is only a fallback for legacy orders that predate the
// checkout-phone capture. Prior bug: these producers read ONLY the profile
// phone and bailed silently, so Google/Apple sign-ups, phone-verify
// skippers, and guests got no confirmation / ready / reminder texts even
// though they gave us a number. Mirrors delivery-eta-sms.js precedence.
function _orderPhone(order, customer){
  return (order && order.delivery && (order.delivery.phoneE164 || order.delivery.phone))
      || (order && (order.customerPhone || order.phone))
      || (customer && (customer.phoneE164 || customer.phone))
      || '';
}

/* Shared with src/comms/orderLockedIn.js, which is a multi-channel cron
   rather than an SMS producer but needs the same customer/phone/order-
   number resolution. Exported here rather than copied: _orderPhone in
   particular encodes a real bug fix (order phone beats profile phone),
   and a second copy would silently miss the next fix. Only index.js's
   explicit mounts become deployed functions, so plain-value exports on
   this module are inert. */
exports._firstName        = _firstName;
exports._lookupCustomer   = _lookupCustomer;
exports._orderPhone       = _orderPhone;
exports._ensureOrderNumber = _ensureOrderNumber;
/* Also shared with functions/index.js's abandonedCartReminders (the EMAIL
   half of cart recovery). Both nudge channels read the same snapshot, so
   they must agree on "this cart already converted" — one copy, one rule. */
exports._orderedSinceCart = _orderedSinceCart;

/* ════════════════════════════════════════════════════════════════════
   1. ORDER CONFIRMATION — fires on orders/{id} status → paid
   ════════════════════════════════════════════════════════════════════ */
exports.onOrderPaidQueueSms = onDocumentWritten('orders/{orderId}', async (event) => {
  const db    = admin.firestore();
  const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  const after  = event.data && event.data.after  && event.data.after.exists  ? event.data.after.data()  : null;
  if (!after) return;
  const beforeStatus = String((before && before.status) || '').toLowerCase().trim();
  const afterStatus  = String(after.status || '').toLowerCase().trim();
  if (!_PAID_STATUSES.has(afterStatus)) return;
  if (_PAID_STATUSES.has(beforeStatus)) return; // already paid

  // Unscheduled staff sales ('none'/legacy 'other') are neither pickup nor
  // delivery — both templates here would lie to the customer. Catering is
  // skipped even when it IS a real delivery/pickup: the invoice flow sends
  // its own confirmation and the weekly copy doesn't fit an event.
  const _ftPaid = String(after.fulfillmentType || '').toLowerCase();
  if (_ftPaid && _ftPaid !== 'pickup' && _ftPaid !== 'delivery') return;
  if (_isCateringOrder(after)) return;

  const customerId = after.customerId || after.uid;
  const customer   = await _lookupCustomer(db, customerId);
  const toPhone    = _orderPhone(after, customer);
  if (!toPhone) return;

  const pickupSunday = _pickupSundayFromOrder(after);
  // Delivery vs pickup branching — same lifecycle event, different copy.
  // Legacy orders without fulfillmentType fall to pickup (the only mode
  // pre-delivery launch).
  // Delivery-only launch: default to delivery unless explicitly pickup.
  const isDelivery      = after.fulfillmentType !== 'pickup';
  const templateKey     = isDelivery ? 'order_confirmation_delivery_sms' : 'order_confirmation_sms';
  const deliveryAddress = isDelivery
    ? _fmtDeliveryAddress(after.delivery || after.deliveryAddress || {})
    : '';
  // Delivery window wording from /settings/fulfillment so the SMS tracks the
  // HQ control. {{order.deliveryWindow}} → "12–5pm". Loaded once and reused
  // below to name the chosen pickup market.
  const ffSettingsPaid  = await _fulfillmentSchedule.loadSettings(db).catch(() => null);
  // Full street address in the confirmation text (was market NAME only, with
  // the address deferred to the day-before text). pickupWhere carries its own
  // leading separator so the template reads cleanly with no market. Same
  // treatment on ready/reminder.
  let pickupWhere = '';
  if (!isDelivery){
    const pa = _pickupAddrParts(after, ffSettingsPaid);
    pickupWhere = pa.addr ? ` · ${pa.addr}` : '';
  }
  await _queueSms({
    to:          toPhone,
    templateKey,
    scenario:    'order.paid',
    customerId,
    orderId:     event.params.orderId,   // lets the skip gate resolve a per-order hold
    vars: {
      customer: { firstName: _firstName(customer), name: customer.name || '' },
      order: {
        id:              _orderNumberOf(after, event.params.orderId),
        total:           _money(after.total),
        pickupDate:      _fmtPickupSunday(pickupSunday),    // "Sun 5/17"
        pickupTime:      _fmtPickupSunday(pickupSunday),    // backward-compat alias
        pickupWhere,                                        // " · <full address>" or ""
        deliveryAddress,
        deliveryWindow:  _smsWindowLabel(ffSettingsPaid),
      },
    },
  }).catch(e => console.error('[order.paid sms] queue failed:', e.message));
});

/* ════════════════════════════════════════════════════════════════════
   2. ORDER READY / OUT FOR DELIVERY — one trigger, two lifecycle edges
      (kept as a single Cloud Function on purpose — us-central1 is near
      its function-count cap, see CLAUDE-LESSONS).

      pickup   orders: status → ready            ⇒ "ready for pickup" text
      delivery orders: status → ready            ⇒ NO text (ready = packed,
                       the customer doesn't care yet — this used to send
                       the "on the way" copy and staff flipping READY was
                       texting customers their order was en route)
                       status → out_for_delivery ⇒ "on the way" text,
                       UNLESS startDeliveryRoute is handling this flip —
                       the route kickoff sends its own richer ETA-window
                       SMS and stamps kickoffSmsPlannedAt in the SAME
                       write, so we yield to it with no race.

      TEXT ONLY. The email twin for both edges is onOrderReadyQueueEmail
      (src/comms/orderReadyEmail.js) — same gates, same two edges, its own
      trigger. It is the ONLY sender of the order_ready email; see the note
      above _lookupCustomer for the duplicate-send this arrangement fixed.
   ════════════════════════════════════════════════════════════════════ */
exports.onOrderReadyQueueSms = onDocumentWritten('orders/{orderId}', async (event) => {
  const db     = admin.firestore();
  const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  const after  = event.data && event.data.after  && event.data.after.exists  ? event.data.after.data()  : null;
  if (!after) return;
  const beforeStatus = String((before && before.status) || '').toLowerCase().trim();
  const afterStatus  = String(after.status || '').toLowerCase().trim();

  // Unscheduled staff sales + catering: neither the pickup-ready nor the
  // out-for-delivery copy applies — skip (same guard as onOrderPaidQueueSms).
  const _ftReady = String(after.fulfillmentType || '').toLowerCase();
  if (_ftReady && _ftReady !== 'pickup' && _ftReady !== 'delivery') return;
  if (_isCateringOrder(after)) return;
  // Delivery-only launch: default to delivery unless explicitly pickup.
  const isDeliveryReady = after.fulfillmentType !== 'pickup';
  const readyEdge = _READY_STATUSES.has(afterStatus) && !_READY_STATUSES.has(beforeStatus);
  const ofdEdge   = _OFD_STATUSES.has(afterStatus)   && !_OFD_STATUSES.has(beforeStatus);

  if (isDeliveryReady){
    if (!ofdEdge) return;   // delivery texts on the out-for-delivery flip only
    // Route starts send their own kickoff SMS (with the ETA window) —
    // the planned/sent stamps mean "startDeliveryRoute owns this text".
    if (after.kickoffSmsPlannedAt || after.kickoffSmsSentAt) return;
  } else {
    if (!readyEdge) return; // pickup texts on the ready flip only
  }

  // ONE TEXT PER MARKET MORNING — the other half of the rule documented on
  // pickupReminderSms below. If the late-morning reminder already went for
  // this order, it has already told them to come to the market today, at this
  // address; a second text three minutes later is the doubling being fixed.
  // The flag is only ever written on the order's own pickup day (that cron
  // queries pickupDate == today), so its presence alone is the answer — no
  // date comparison needed. Delivery orders never carry it.
  //
  // Only the TEXT yields. onOrderReadyQueueEmail still emails, because the
  // reminder has no email twin — one text and one email is not the problem.
  if (after.pickupReminderSentAt){
    console.log('[order.ready sms] pickup reminder already sent today for', event.params.orderId, '— skipping the ready text');
    return;
  }

  const customerId = after.customerId || after.uid;
  const customer   = await _lookupCustomer(db, customerId);
  const toPhone    = _orderPhone(after, customer);
  // No number: nothing to send from HERE. The customer is not left in
  // silence — onOrderReadyQueueEmail (src/comms/orderReadyEmail.js) fires
  // off this same edge and emails them, which is the whole reason it exists.
  if (!toPhone) return;

  const pickupSundayReady = _pickupSundayFromOrder(after);
  const templateKeyReady     = isDeliveryReady ? 'order_out_for_delivery_sms' : 'order_ready_sms';
  const deliveryAddressReady = isDeliveryReady
    ? _fmtDeliveryAddress(after.delivery || after.deliveryAddress || {})
    : '';
  // Delivery window wording from /settings/fulfillment ({{order.deliveryWindow}}).
  // Loaded once and reused below to name the chosen pickup market.
  const ffSettingsReady = await _fulfillmentSchedule.loadSettings(db).catch(() => null);
  // Full street address in the "ready" text (was market NAME only).
  let pickupWhereReady = '';
  if (!isDeliveryReady){
    const pa = _pickupAddrParts(after, ffSettingsReady);
    pickupWhereReady = pa.addr ? ` at ${pa.addr}` : '';
  }
  await _queueSms({
    to:          toPhone,
    templateKey: templateKeyReady,
    scenario:    'order.ready',
    customerId,
    orderId:     event.params.orderId,   // lets the skip gate resolve a per-order hold
    vars: {
      customer: { firstName: _firstName(customer) },
      order: {
        id:              _orderNumberOf(after, event.params.orderId),
        pickupDate:      _fmtPickupSunday(pickupSundayReady),
        pickupTime:      _fmtPickup(after.pickupAt || after.pickupTime || after.deliveryDate, 180),
        pickupWhere:     pickupWhereReady,                  // " at <full address>" or ""
        deliveryAddress: deliveryAddressReady,
        deliveryWindow:  _smsWindowLabel(ffSettingsReady),
      },
    },
  }).catch(e => console.error('[order.ready sms] queue failed:', e.message));
});

/* ════════════════════════════════════════════════════════════════════
   2b. REVIEW REQUEST SMS — REMOVED (Jul 19 2026, Omar's call: "no texts").
       Review asks go out by EMAIL only, via the sendReviewRequests cron
       in index.js. Do not re-add an SMS twin without asking — a second
       channel for the same nudge means two independent idempotency flags
       on the order (reviewRequestSent / reviewRequestSmsSent), which is
       exactly what made a manual "stop this review request" edit unsafe.

       Note this never actually worked: the commTemplates doc it asked for
       ('review_request_sms') was never created, so every send failed with
       template_not_found — but the order was already stamped
       reviewRequestSmsSent BEFORE the enqueue, so the failure was silent
       and unretried. One order (TDC-VKZ94) carries that stale flag;
       harmless now that nothing reads it.
   ════════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════
   ORPHANED CONSENT ADOPTION — the guest who ticked the box (Aug 2026)

   `recordSmsConsent` (scripts/payment/consent.js) always writes the
   /smsSubscribers audit record, but mirrors smsOptIn + phone onto the
   customer doc only `if (user)`. A GUEST ticking "text me" at checkout
   therefore leaves a consent record with `uid: null` and no customer
   doc to write to — and when they create or claim an account later,
   nothing goes back for it.

   The result is a person who genuinely opted in and is invisible to
   every audience, forever. Seven of them had accumulated by Aug 2026
   and the SMS-reachable list was half what it should have been. Exactly the same shape as the
   subscriber-field bug: the record exists, the link was never written,
   and every reader downstream confidently reports "no".

   This runs inside the existing welcome-SMS trigger ON PURPOSE. It
   wants precisely the same document and edge, and adding a Cloud
   Function of its own would spend against the us-central1 quota that
   has bricked whole deploys before (see CLAUDE-LESSONS.md).

   Consent rules, none of which may be relaxed:
     • only `status:'active'` records — never an unsubscribed one,
     • never for a customer carrying `smsOptOutAt` (they replied STOP;
       an old consent record must never resurrect them),
     • `smsOptedInAt` is backdated to the record's real `optedInAt`,
       never to now — the audit trail has to say when they agreed,
     • a record with no `consentText` is SKIPPED. Without the wording
       there is no evidence of what they agreed to, and consent is not
       something to infer. (One such record exists and was deliberately
       left alone.)

   Adopting writes smsOptIn + phone in ONE write, so this trigger
   re-enters, sees the false→true edge, and sends the welcome text
   normally. That is intended: for a guest who checks out and makes an
   account minutes later, the welcome is the promised experience. The
   historical backlog above was repaired quietly by hand instead,
   because a "welcome" three months late reads as a glitch.
   ════════════════════════════════════════════════════════════════════ */
async function _adoptOrphanedSmsConsent(db, customerId, after){
  // Cheap gates first — once adopted, smsOptIn is true and we never look
  // again, so a customer costs at most one extra query per doc write
  // while they remain un-opted-in.
  if (after.smsOptIn === true) return;
  if (after.smsOptOutAt) return;            // replied STOP — never resurrect
  const email = String(after.email || '').toLowerCase().trim();
  if (!email) return;

  const snap = await db.collection('smsSubscribers')
    .where('email', '==', email).limit(10).get().catch(() => null);
  if (!snap || snap.empty) return;

  const usable = snap.docs
    .map(d => ({ id: d.id, s: d.data() || {} }))
    .filter(r => String(r.s.status || '').toLowerCase() === 'active')
    .filter(r => String(r.s.consentText || '').trim())   // no wording, no adoption
    .filter(r => String(r.s.phone || '').trim());
  if (!usable.length) return;

  // Oldest first — the moment they actually agreed.
  usable.sort((a, b) => {
    const at = a.s.optedInAt && a.s.optedInAt.toMillis ? a.s.optedInAt.toMillis() : 0;
    const bt = b.s.optedInAt && b.s.optedInAt.toMillis ? b.s.optedInAt.toMillis() : 0;
    return at - bt;
  });
  const pick = usable[0];

  const raw = String(pick.s.phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  const phone = /^\+[1-9]\d{7,14}$/.test(raw) ? raw
              : digits.length === 10 ? '+1' + digits
              : digits.length === 11 && digits[0] === '1' ? '+' + digits
              : null;
  if (!phone) return;

  await db.collection('customers').doc(customerId).set({
    phone,
    smsOptIn: true,
    smsOptInSource: pick.s.source || 'cart-drawer',
    smsOptedInAt: pick.s.optedInAt || null,
  }, { merge: true });

  // Link every matching record, so this can't silently re-orphan.
  await Promise.all(snap.docs
    .filter(d => !(d.data() || {}).uid)
    .map(d => d.ref.set({ uid: customerId }, { merge: true }).catch(() => {})));

  console.log('[sms-consent] adopted orphaned consent for', customerId, 'from', pick.id);
}

/* ════════════════════════════════════════════════════════════════════
   3. WELCOME SMS — fires on customers/{id} when smsOptIn flips →true
   Used by:
     • Self-service: checkout form, account-page toggle, etc.
     • JOIN keyword path: twilioWebhook already flips smsOptIn=true on
                          "START / JOIN / YES", which fires this trigger.
     • Orphan adoption above, which flips it for a guest whose consent
       never reached their customer doc.
   ════════════════════════════════════════════════════════════════════ */
exports.onCustomerOptedInQueueSms = onDocumentWritten('customers/{customerId}', async (event) => {
  const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  const after  = event.data && event.data.after  && event.data.after.exists  ? event.data.after.data()  : null;
  if (!after) return;

  // Runs BEFORE the false→true early-return below: adoption is for
  // customers who are NOT opted in yet, which is exactly the case that
  // return throws away. Its write re-enters this trigger, and that pass
  // sends the welcome.
  try {
    await _adoptOrphanedSmsConsent(admin.firestore(), event.params.customerId, after);
  } catch (e) {
    // Never let a reconcile failure swallow a real welcome text.
    console.error('[sms-consent] adopt failed:', e && e.message);
  }

  const wasIn  = before && before.smsOptIn === true;
  const nowIn  = after.smsOptIn === true;
  if (!nowIn || wasIn) return; // only act on the false→true edge

  if (!after.phone) return;

  await _queueSms({
    to:          after.phone,
    templateKey: 'welcome_sms',
    scenario:    'customer.opted_in',
    customerId:  event.params.customerId,
    vars: {
      customer: { firstName: _firstName(after) },
    },
  }).catch(e => console.error('[welcome sms] queue failed:', e.message));
});

/* ════════════════════════════════════════════════════════════════════
   4. PICKUP REMINDER — the LATE-MORNING catch-up, for orders staff
      haven't packed yet.

      ONE TEXT PER MARKET MORNING (Omar, Aug 1 2026 — "it's ready wins")
      This reminder and the ready text (producer 2 above) used to be
      blind to each other, and both land in the market morning: the
      reminder fired on the first cron run after 7am, and staff mark
      orders ready AT the market from 7am. So a customer got "pickup
      day, we're there 7am-12pm today" at 8:00 and "your order is ready
      for pickup" at 8:03 — two texts, same address, three minutes
      apart (order TDC-M6YGV). That is not a race that occasionally
      trips; it is what a normal market Saturday does to every order.

      The two now exclude each other, and the ready text is the one
      worth keeping — it says the food is packed and waiting, which the
      generic reminder can't:
        • this cron SKIPS orders already marked ready, and
        • it holds until the 9am CT hour, so staff have the first two
          hours of market to mark orders ready before it speaks, and
        • producer 2 skips the ready TEXT when pickupReminderSentAt is
          set, which closes the other order of events (order marked
          ready at 10:30, after this already went at 10:00).
      Net effect on a normal day: almost nobody gets this text, because
      almost every order is marked ready first. That is the intent, not
      a fault — it is the safety net for the order nobody got to.

      The ready EMAIL is deliberately NOT suppressed. This reminder is
      SMS-only, so a customer who gets it still has no email about the
      order; one text plus one email is not the doubling being fixed.

      Idempotent via the pickupReminderSentAt flag.
   ════════════════════════════════════════════════════════════════════ */
exports.pickupReminderSms = onSchedule({
  schedule: 'every 15 minutes',
  timeZone: 'America/Chicago',
  secrets:  ['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM_NUMBER'],
}, async () => {
  const db  = admin.firestore();
  const now = Date.now();
  // Pickup is a whole market DAY, not a per-order clock time — orders store
  // pickupDate 'YYYY-MM-DD' (the CT fulfillment day), never a pickupAt
  // timestamp. So this fires on the pickup day itself: "your pickup opens at
  // <window> today".
  //
  // The send hour is 9am CT, NOT the old 7am. It used to go on the first run
  // after 7am, which is the same hour staff start marking orders ready at the
  // market — see the header. Holding to 9 gives a 7am market two hours to pack
  // before this speaks, so most handled orders never hear from it. A market
  // that opens later isn't harmed: this text says "today", not a clock time,
  // and 9am was already inside the old window.
  //
  // 9 rather than 10 is Omar's call (Aug 1 2026), knowing the trade: the
  // earlier this runs, the more orders are still unpacked when it fires, and
  // each of those customers gets the weaker "pickup day" text INSTEAD of the
  // better "your order is ready" one (which then yields — see producer 2).
  // Moving it earlier again walks back toward the 7am collision; if it ever
  // needs to move, move it LATER.
  //
  // Kept to a single hour deliberately. The pickupReminderSentAt flag means
  // only the first run in it sends, so widening the range buys nothing but a
  // later, less useful text — an 11:50 "pickup opens today" to a market that
  // closes at noon is worse than silence.
  const hourCT = _ctHour(now);
  if (hourCT < 9 || hourCT >= 10){
    console.log(`[pickupReminderSms] outside the 9am CT send hour (CT hour ${hourCT}) — skip`);
    return;
  }
  const todayStr = _fulfillmentSchedule.ctDateStr(now);

  let snap;
  try {
    snap = await db.collection('orders')
      .where('status', 'in', REMINDER_ELIGIBLE_STATUSES)
      .where('pickupDate', '==', todayStr)
      .limit(200)
      .get();
  } catch (e){
    // Composite index missing — log + skip rather than crashing the cron.
    console.error('[pickupReminderSms] query failed:', e.message);
    return;
  }

  // Current market settings — to name each order's pickup spot in the reminder.
  const ffSettings = await _fulfillmentSchedule.loadSettings(db).catch(() => null);

  let queued = 0, skipped = 0;
  for (const doc of snap.docs){
    const o = doc.data();
    if (o.pickupReminderSentAt) { skipped++; continue; }
    // Delivery orders share the pickupDate fulfillment-day field but have no
    // customer-side pickup window to show up for — texting them to "head to
    // pickup" is the bug. Skip anything that isn't explicitly pickup. (No flag
    // stamp needed: the query is scoped to today's date, so they won't recur.)
    if (o.fulfillmentType !== 'pickup'){ skipped++; continue; }
    // A catering pickup is collected at the kitchen on the event day — the
    // market-window copy below ("we open at 8am") would be flatly wrong.
    if (_isCateringOrder(o)){ skipped++; continue; }
    // ALREADY PACKED — the ready text has said everything this one would, and
    // said it better ("it's ready" beats "today's the day"). REMINDER_ELIGIBLE_
    // STATUSES deliberately includes READY, because the same list drives the
    // day-before address text where a ready order still needs the address; so
    // the filter belongs here, not in the query. This is half of the one-text-
    // per-morning rule — the other half is in producer 2.
    if (_READY_STATUSES.has(String(o.status || '').toLowerCase().trim())){ skipped++; continue; }
    const customer = await _lookupCustomer(db, o.customerId || o.uid);
    const toPhone  = _orderPhone(o, customer);
    if (!toPhone) { skipped++; continue; }

    const orderNo = await _ensureOrderNumber(doc, o);
    const pa = _pickupAddrParts(o, ffSettings);
    // The pickup window comes from the order's market ("8am-1pm"). There is no
    // per-order clock time, so the market window is the closest truthful value.
    //
    // Two things fixed here, Jul 2026. The window carries an EN DASH, which
    // tips the whole text into UCS-2 and roughly doubles the Twilio bill (see
    // _smsWindowLabel), so it is sanitised. And some markets store the weekday
    // inside windowLabel ("saturday 7am - 12pm"), which the old template
    // rendered as "opens at saturday 7am - 12pm today" — so the day word is
    // stripped, leaving just the clock range for the copy to sit around.
    const market = _orderMarket(o, ffSettings);
    const pickupWindow = String((market && market.windowLabel) || '')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/^\s*(sun|mon|tues?|wed(nes)?|thur?s?|fri|satur?)(day)?\s*[\u00b7,:-]?\s*/i, '')
      .trim();
    try {
      await _queueSms({
        to:          toPhone,
        templateKey: 'pickup_reminder_sms',
        scenario:    'order.pickup_reminder',
        customerId:  o.customerId || o.uid,
        orderId:     doc.id,                 // lets the skip gate resolve a per-order hold
        vars: {
          customer: { firstName: _firstName(customer) },
          order: {
            id:           orderNo,
            pickupTime:   pickupWindow,
            pickupWhere:   pa.addr ? ` at ${pa.addr}` : '',   // " at <full address>" or ""
          },
        },
      });
      await doc.ref.update({
        pickupReminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(()=>{});
      queued++;
    } catch (e){
      console.error('[pickupReminderSms] enqueue failed for', doc.id, e.message);
    }
  }
  console.log(`[pickupReminderSms] queued=${queued} skipped=${skipped}`);
});

/* ════════════════════════════════════════════════════════════════════
   5. LEGACY: RENEWAL COMING UP (SMS-only Wednesday cron)
   ────────────────────────────────────────────────────────────────────
   2026-05-27 — superseded by renewalPreflightAndNotify in
   functions/index.js, which validates the saved card via Stripe
   SetupIntent and branches the heads-up SMS / email based on the
   result (friendly "renews tomorrow" on pass, action-required "update
   your card" on fail). Keeping this export as a no-op stub avoids
   orphaning the existing Cloud Run service — the workflow uses
   --non-interactive so removing the export would just stop redeploys,
   not delete the live function.
   ════════════════════════════════════════════════════════════════════ */
exports.renewalComingUpSms = onSchedule({
  schedule: 'every day 09:00',
  timeZone: 'America/Chicago',
}, async () => {
  console.log('[renewalComingUpSms] no-op — superseded by renewalPreflightAndNotify');
});

/* ════════════════════════════════════════════════════════════════════
   6. RENEWAL FAILED — Firestore trigger on subscriptions/{id} when
       status transitions to past_due / payment_failed / renewal_failed.
       Stripe webhook flips this status, this trigger reacts.
   ════════════════════════════════════════════════════════════════════ */
exports.onRenewalFailedQueueSms = onDocumentWritten('subscriptions/{subId}', async (event) => {
  const db     = admin.firestore();
  const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  const after  = event.data && event.data.after  && event.data.after.exists  ? event.data.after.data()  : null;
  if (!after) return;
  const beforeStatus = String((before && before.status) || '').toLowerCase().trim();
  const afterStatus  = String(after.status || '').toLowerCase().trim();
  if (!_SUB_FAILED_STATUSES.has(afterStatus)) return;
  if (_SUB_FAILED_STATUSES.has(beforeStatus)) return;

  const customer = await _lookupCustomer(db, after.customerId || after.uid);
  if (!customer || !customer.phone) return;

  // What the charge actually TRIED to take. `after.total` is the sub doc's
  // PRE-TAX subtotal, so quoting it here understated the failed attempt by
  // its sales tax — the same bug the Wednesday heads-up had (a sub carrying
  // total 107.78 was quoted "$107.78" against a ~$117.51 attempt). Ask the
  // charge path's own formula instead. Best-effort: if the preview can't be
  // computed we fall back to the pre-tax figure rather than send a
  // payment-failure text with no number in it at all.
  let _failedAmount = _money(after.total || after.amount || after.weeklyTotal);
  try {
    const _renewalCharge  = require('../subscriptions/renewalCharge');
    const _deliveryPricing = require('../pricing/deliveryPricing');
    const _preview = await _renewalCharge.computeRenewalCharge({
      db, sub: after, customerData: customer, deliveryPricing: _deliveryPricing,
    });
    if (_preview.taxEstimated) _failedAmount = _money(_preview.cardChargeCents / 100);
  } catch (e) {
    console.error('[renewal.failed sms] charge preview failed, using pre-tax total:', e.message);
  }

  await _queueSms({
    to:          customer.phone,
    templateKey: 'renewal_failed_sms',
    scenario:    'subscription.renewal_failed',
    customerId:  after.customerId || after.uid,
    vars: {
      customer: { firstName: _firstName(customer) },
      subscription: {
        id:     event.params.subId,
        amount: _failedAmount,
      },
    },
  }).catch(e => console.error('[renewal.failed sms] queue failed:', e.message));
});

/* ════════════════════════════════════════════════════════════════════
   6b. PICKUP ADDRESS — Saturday morning sweep, sends the actual pickup
       address the day BEFORE pickup (i.e. Saturday for Sunday pickup).
       Order confirmation + ready SMS just say "Minneapolis, MN" — the
       full street address only goes out 24h before pickup so it's
       fresh in the customer's thread when they're heading over.

       Idempotent via pickupAddressSentAt flag on the order doc.
   ════════════════════════════════════════════════════════════════════ */
exports.pickupAddressDayBeforeSms = onSchedule({
  schedule: 'every day 09:00',
  timeZone: 'America/Chicago',
}, async () => {
  const db  = admin.firestore();
  // Runs EVERY morning and looks at tomorrow's fulfillment day, so it covers
  // both Sunday markets (fires Saturday) AND Saturday markets like Market A
  // (fires Friday) — the old "every saturday" schedule silently skipped every
  // Saturday-market customer. Orders store the fulfillment day as pickupDate
  // 'YYYY-MM-DD' (CT), for pickup AND delivery, so a direct equality match on
  // tomorrow's date is exact — no timestamp bracketing / full-table fallback.
  const tomorrowStr = _fulfillmentSchedule.ctDateStr(Date.now() + 24 * 3600 * 1000);
  const tomorrow    = _pickupSundayFromOrder({ pickupDate: tomorrowStr });

  let snap;
  try {
    snap = await db.collection('orders')
      .where('status', 'in', REMINDER_ELIGIBLE_STATUSES)
      .where('pickupDate', '==', tomorrowStr)
      .limit(500)
      .get();
  } catch (e){
    // Composite index missing — log + skip rather than crashing the cron.
    console.error('[pickupAddressDayBeforeSms] query failed:', e.message);
    return;
  }

  // Current market settings — used to re-resolve each order's market address.
  const ffSettings = await _fulfillmentSchedule.loadSettings(db).catch(() => null);

  let queued = 0, skipped = 0;
  for (const doc of snap.docs){
    const o = doc.data();
    if (o.pickupAddressSentAt) { skipped++; continue; }
    // The query already guarantees pickupDate == tomorrow; this is just the
    // Date used to render the "Sun 5/17" / "Sat 7/18" line.
    const pickupDate = _pickupSundayFromOrder(o);

    const customer = await _lookupCustomer(db, o.customerId || o.uid);
    const toPhone  = _orderPhone(o, customer);
    if (!toPhone) { skipped++; continue; }

    // This cron is PICKUP-only. Delivery orders get their day-before text
    // from deliveryConfirmAskSms (noon CT the day before) — the
    // window + "will you be home?" ask replaced the old 09:00
    // delivery_window_sms here so customers get ONE day-before text, not
    // two (Omar, jul 2026). Legacy orders without a fulfillmentType
    // default to delivery, same as before.
    const isDelivery = o.fulfillmentType !== 'pickup';
    if (isDelivery) { skipped++; continue; }
    if (_isCateringOrder(o)) { skipped++; continue; }   // never market copy
    const orderNo = await _ensureOrderNumber(doc, o);
    const templateKey = 'pickup_address_sms';
    const scenario    = 'order.pickup_address';
    // Pickup address for THIS order's market (current settings → baked snapshot).
    // Neutral copy if somehow unresolved — never the private kitchen address.
    const pa = _pickupAddrParts(o, ffSettings);
    const pickupLocation = pa.addr || 'your saved pickup spot (map + details in your account)';

    try {
      await _queueSms({
        to:          toPhone,
        templateKey,
        scenario,
        customerId:  o.customerId || o.uid,
        orderId:     doc.id,                 // lets the skip gate resolve a per-order hold
        vars: {
          customer: { firstName: _firstName(customer) },
          order: {
            id:              orderNo,
            pickupDate:      _fmtPickupSunday(pickupDate),
            pickupLocation,
          },
        },
      });
      await doc.ref.update({
        pickupAddressSentAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(()=>{});
      queued++;
    } catch (e){
      console.error('[pickupAddressDayBeforeSms] enqueue failed for', doc.id, e.message);
    }
  }
  console.log(`[pickupAddressDayBeforeSms] queued=${queued} skipped=${skipped} for pickup ${_fmtPickupSunday(tomorrow)}`);
});

// Format a delivery address into a short SMS-friendly string.
// Accepts two shapes:
//   V2 (current, written by writeOrderV2Live):
//     { address: { street, unit, city, state, zip, dropoffNotes }, phone, ... }
//   Legacy / demo:
//     { address: 'flat string', address2, city, state, zip }
// If `d.address` is itself an object, read fields off it; otherwise read
// them off `d` directly. Without this, the V2 shape passes the object
// through `String(...)` and produces "[object Object]" in the SMS.
function _fmtDeliveryAddress(d){
  if (!d || typeof d !== 'object') return 'your address';
  const nested = (d.address && typeof d.address === 'object') ? d.address : null;
  const src    = nested || d;
  const legacyStreet = nested ? '' : (typeof d.address === 'string' ? d.address : '');
  const street = String(src.street || src.line1 || legacyStreet || '').trim();
  const apt    = String(src.unit || src.address2 || '').trim();
  const city   = String(src.city || '').trim();
  // Twin Cities customers know their city — keep the SMS short.
  if (street){
    return apt ? (street + ' #' + apt) : street;
  }
  return city || 'your address';
}

/* ════════════════════════════════════════════════════════════════════
   6c. DELIVERY CONFIRM ASK — day-before sweep (daily 12:00 CT — moved
       from 18:00 so customers have the afternoon to reply and plan;
       jul 2026), texts tomorrow's DELIVERY customers the window
       + address and asks "will you be home? reply YES or NO", plus a
       link to a notes page (gate code / leave-with-neighbor / etc.).
       This REPLACED the old 09:00 delivery_window_sms so the customer
       gets one day-before text, not two (Omar, jul 2026).

       The reply side lives in functions/delivery-confirm.js
       (handleDeliveryConfirmReply, called from twilioWebhook): YES →
       deliveryConfirmation.status 'home', NO → 'drop-ok', anything
       else → 'unclassified' + the sms_inbound review queue. HQ2's
       delivery manifest shows the answer as a chip per stop.

       Copy is code-default (composed below) but HQ can override it by
       creating a commTemplates doc with key 'delivery_confirm_sms' —
       checked once per run. Idempotent via deliveryConfirmation.sentAt.
   ════════════════════════════════════════════════════════════════════ */
exports.deliveryConfirmAskSms = onSchedule({
  schedule: 'every day 12:00',
  timeZone: 'America/Chicago',
}, async () => {
  const db = admin.firestore();
  // Same tomorrow-targeting as pickupAddressDayBeforeSms: orders store the
  // fulfillment day as pickupDate 'YYYY-MM-DD' (CT) for pickup AND delivery,
  // so a direct equality match on tomorrow's date is exact. Reuses the same
  // (status, pickupDate) composite index.
  const tomorrowStr = _fulfillmentSchedule.ctDateStr(Date.now() + 24 * 3600 * 1000);

  let snap;
  try {
    snap = await db.collection('orders')
      .where('status', 'in', REMINDER_ELIGIBLE_STATUSES)
      .where('pickupDate', '==', tomorrowStr)
      .limit(500)
      .get();
  } catch (e){
    console.error('[deliveryConfirmAskSms] query failed:', e.message);
    return;
  }
  if (snap.empty) return; // tomorrow isn't a fulfillment day — nothing to ask

  const ffSettings = await _fulfillmentSchedule.loadSettings(db).catch(() => null);
  // "12–5pm" from HQ's delivery-schedule control, dash-sanitised for SMS.
  const windowLabel = _smsWindowLabel(ffSettings);

  // HQ copy override — one lookup per run, not per order. When the template
  // exists the queue consumer renders it against the vars below; otherwise
  // we compose the default body per order.
  let hasTemplate = false;
  try {
    const t = await db.collection('commTemplates').where('key', '==', 'delivery_confirm_sms').limit(1).get();
    hasTemplate = !t.empty;
  } catch (_) {}

  let queued = 0, skipped = 0;
  for (const doc of snap.docs){
    const o = doc.data();
    if (o.fulfillmentType === 'pickup') { skipped++; continue; }
    // Catering drops are scheduled with the client directly — the "will you
    // be home for your 12–5pm window?" ask doesn't apply to an event.
    if (_isCateringOrder(o)) { skipped++; continue; }
    if (o.deliveryConfirmation && o.deliveryConfirmation.sentAt) { skipped++; continue; }

    // Delivery phone is fulfillment data and lives ON the order (guests
    // included — checkout requires it for delivery), so prefer it over the
    // customer-doc phone. Same precedence as delivery-eta-sms.js.
    const customer = await _lookupCustomer(db, o.customerId || o.uid);
    const to = (o.delivery && (o.delivery.phoneE164 || o.delivery.phone))
      || (customer && customer.phone) || '';
    if (!to) { skipped++; continue; }

    const orderNo   = await _ensureOrderNumber(doc, o);
    const dateLabel = _fmtPickupSunday(_pickupSundayFromOrder(o));
    const addr      = _fmtDeliveryAddress(o.delivery || o.deliveryAddress || {});
    const first     = _firstName(customer) || _firstName({ name: o.customerName });
    const notesLink = 'https://example.com/delivery-notes?o=' + doc.id;

    const payload = {
      to,
      scenario:   'order.delivery_confirm',
      customerId: o.customerId || o.uid || null,
      orderId:    doc.id,                    // lets the skip gate resolve a per-order hold
      vars: {
        customer: { firstName: first },
        order: {
          id:              orderNo,
          pickupDate:      dateLabel,
          deliveryWindow:  windowLabel,
          deliveryAddress: addr,
          notesLink,
        },
      },
    };
    if (hasTemplate){
      payload.templateKey = 'delivery_confirm_sms';
    } else {
      // Question first, minimal clutter (Omar, jul 2026). The street rides
      // in a parenthetical — it's the last chance to catch a wrong/moved
      // address before the driver leaves, and the standing rule is the
      // address goes in every transactional text (Omar, jun 2026). Date
      // stays out — "tomorrow" carries it; full date is in vars for an HQ
      // template override.
      payload.body = (first ? 'hi ' + first + ', ' : '')
        + 'will you be home for your tandoco delivery tomorrow, ' + windowLabel
        + ' (' + addr + ')? reply YES if so, or NO and we\'ll leave it at your door. '
        + 'gate code or notes: ' + notesLink
        + ' Reply STOP to opt out.';
    }

    try {
      await _queueSms(payload);
      // Stamp the ask on the order. 'no-response' is the pack-out default —
      // the insulated drop-ready bag covers an unanswered ask, so this reads
      // as "drop-ready, unconfirmed", never as a blocker.
      await doc.ref.update({
        deliveryConfirmation: {
          status:      'no-response',
          channel:     null,
          notes:       null,
          respondedAt: null,
          sentAt:      admin.firestore.FieldValue.serverTimestamp(),
        },
      }).catch(()=>{});
      queued++;
    } catch (e){
      console.error('[deliveryConfirmAskSms] enqueue failed for', doc.id, e.message);
    }
  }
  console.log(`[deliveryConfirmAskSms] queued=${queued} skipped=${skipped} for delivery ${tomorrowStr}`);
});

/* ════════════════════════════════════════════════════════════════════
   7. CART ABANDONMENT — scheduled hourly, finds carts older than 24h
       that haven't checked out and haven't been SMS'd yet.
       Marketing template → requires explicit smsOptIn.
   ════════════════════════════════════════════════════════════════════ */
exports.cartAbandonmentSms = onSchedule({
  schedule: 'every 60 minutes',
  timeZone: 'America/Chicago',
  secrets:  ['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM_NUMBER'],
}, async () => {
  const db  = admin.firestore();
  const now = Date.now();
  // Look at carts created 23-25h ago. The 2hr window gives an hourly
  // cron coverage without double-texting.
  const start = new Date(now - 25 * 60 * 60_000);
  const end   = new Date(now - 23 * 60 * 60_000);

  let snap;
  try {
    // The real cart-recovery collection is `abandonedCarts` (written by the
    // storefront + read by the email producer abandonedCartReminders in
    // functions/index.js) — NOT `carts`, which nothing writes. Docs carry
    // { completed:bool, updatedAt, uid (==docId), firstName, itemCount }.
    // `completed==false` + `updatedAt` range reuses the existing composite
    // index — no new index needed.
    snap = await db.collection('abandonedCarts')
      .where('completed', '==', false)
      .where('updatedAt', '>=', start)
      .where('updatedAt', '<', end)
      .limit(200)
      .get();
  } catch (e){
    console.error('[cartAbandonmentSms] query failed:', e.message);
    return;
  }

  let queued = 0, skipped = 0;
  for (const doc of snap.docs){
    const c = doc.data();
    if (c.abandonmentSmsSentAt) { skipped++; continue; }
    // Same guards as the email path: a real authenticated uid whose doc id
    // equals the uid (blocks legacy guest `e_<email>` docs), non-empty cart.
    if (!c.uid || doc.id !== c.uid) { skipped++; continue; }
    if (!c.itemCount || c.itemCount <= 0) { skipped++; continue; }
    // Converted, not abandoned — see _orderedSinceCart.
    if (await _orderedSinceCart(db, c.uid, c.updatedAt)) { skipped++; continue; }
    // Subscribers are not abandoners — an active subscriber's open cart
    // is usually next week's order being tweaked, and their food ships
    // regardless. Mirrors the same guard in the email cron
    // (abandonedCartReminders, functions/index.js).
    try {
      const activeSub = await db.collection('subscriptions')
        .where('uid', '==', c.uid).where('status', '==', 'active')
        .limit(1).get();
      if (!activeSub.empty) { skipped++; continue; }
    } catch (_) { /* fail open, same as the other guards */ }
    const customer = await _lookupCustomer(db, c.uid);
    if (!customer || !customer.phone) { skipped++; continue; }
    // Marketing — queue.js will gate on smsOptIn=true. We still need a
    // phone but the consumer enforces opt-in.

    try {
      await _queueSms({
        to:          customer.phone,
        templateKey: 'cart_abandonment_sms',
        scenario:    'cart_abandonment',
        customerId:  c.uid,
        vars: {
          customer: { firstName: _firstName(customer) },
          cart: {
            itemCount: c.itemCount || 0,
          },
        },
      });
      await doc.ref.update({
        abandonmentSmsSentAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(()=>{});
      queued++;
    } catch (e){
      console.error('[cartAbandonmentSms] enqueue failed for', doc.id, e.message);
    }
  }
  console.log(`[cartAbandonmentSms] queued=${queued} skipped=${skipped}`);
});

/* ════════════════════════════════════════════════════════════════════
   8. AD-HOC TEMPLATE FIRE — HTTP endpoint staff can hit from HQ for
       "order delayed / out of stock" and other one-off transactional
       sends. Staff-only, takes { customerId, templateKey, vars }.
   ════════════════════════════════════════════════════════════════════ */
exports.queueAdHocSms = onRequest({cors: true}, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ok: false, error: 'POST only'});
    return;
  }
  // Inline staff verification — mirrors verifyStaff used elsewhere
  const authHeader = req.headers.authorization || '';
  const match      = authHeader.match(/^Bearer (.+)$/);
  if (!match) { res.status(401).json({ok: false, error: 'auth required'}); return; }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(match[1]);
  } catch (e){
    res.status(401).json({ok: false, error: 'invalid token'}); return;
  }
  // Confirm staff role — the /users/{uid} doc must exist AND not carry the
  // market-till-only role ('till' has a users doc but is NOT staff, Aug 2026).
  const userSnap = await admin.firestore().collection('users').doc(decoded.uid).get().catch(() => null);
  if (!userSnap || !userSnap.exists
      || !require('../lib/auth').isFullStaffData(userSnap.data())){
    res.status(403).json({ok: false, error: 'staff only'}); return;
  }

  const {customerId, templateKey, vars, to: explicitTo, body: literalBody} = req.body || {};
  // Either templateKey OR literalBody must be present. literalBody is
  // the "single-phone freeform SMS" path used by HQ2 → Communications
  // → Compose → single-phone shortcut. The consumer (onSmsQueued) uses
  // the body directly when no templateKey resolves a template.
  if (!templateKey && !literalBody){
    res.status(400).json({ok: false, error: 'templateKey or body required'}); return;
  }
  // Body length cap mirrors createSmsBlastDryRun's guard so the
  // freeform path can't slip past the size limit.
  if (literalBody && (typeof literalBody !== 'string' || literalBody.length > 800)){
    res.status(400).json({ok: false, error: 'body must be a string ≤800 chars'}); return;
  }

  // Resolve recipient phone — either passed explicitly OR looked up from customer doc
  const _db = admin.firestore();
  let toPhone = explicitTo;
  let _customer = null;
  if (customerId) _customer = await _lookupCustomer(_db, customerId);
  if (!toPhone && _customer) toPhone = _customer.phone || null;

  // ── EMAIL TWIN ─────────────────────────────────────────────────────
  // Some of these ad-hoc sends have a v5 email that says the same thing.
  // Send it alongside the text so a customer with no usable phone number
  // still hears about it. Only keys listed here get one; every other
  // ad-hoc send behaves exactly as before.
  const AD_HOC_EMAIL_TWIN = { order_delayed_sms: 'order_delayed' };
  const _emailTwin = templateKey ? AD_HOC_EMAIL_TWIN[templateKey] : null;
  const _toEmail = String((_customer && _customer.email) || '').trim();
  let _emailed = false;
  if (_emailTwin && _toEmail){
    try {
      const _v = (vars && vars.order) || {};
      await _db.collection('mail').add({
        to: _toEmail,
        template: _emailTwin,
        data: {
          first_name: _firstName(_customer),
          orderNumber: _v.id || '',
          reason: _v.delayReason || '',
        },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        _source: 'queueAdHocSms:emailTwin',
      });
      _emailed = true;
    } catch (e){
      console.error('[queueAdHocSms] email twin failed:', e.message);
    }
  }

  if (!toPhone){
    // Used to be a flat 400. That meant an order-delayed notice could not be
    // sent AT ALL to a customer with no phone on file, which is precisely the
    // customer who most needs the email version.
    if (_emailed){ res.json({ok: true, emailOnly: true}); return; }
    res.status(400).json({ok: false, error: 'no recipient phone or email'}); return;
  }

  try {
    const payload = {
      to:          toPhone,
      scenario:    'adhoc.' + (templateKey || 'freeform'),
      customerId:  customerId || null,
      vars:        vars || {},
      queuedBy:    decoded.uid,
    };
    if (templateKey) payload.templateKey = templateKey;
    if (literalBody) payload.body = literalBody;
    const ref = await _queueSms(payload);
    res.json({ok: true, queueId: ref.id});
  } catch (e){
    console.error('[queueAdHocSms] failed:', e.message);
    res.status(500).json({ok: false, error: e.message});
  }
});
