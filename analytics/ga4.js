// GA4 Measurement Protocol helper — server-side event mirror.
//
// This is the ad-blocker-proof companion to the client-side gtag events in
// checkout.html. The Stripe webhook calls `sendGa4Purchase` from inside its
// payment_intent.succeeded handler so every real payment produces a server
// `purchase` event regardless of whether the client event fired.
//
// Required env:
//   GA4_MEASUREMENT_ID   — G-XXXXXXXXXX
//   GA4_API_SECRET       — generated in GA4 Admin → Data Streams → Web →
//                          Measurement Protocol API secrets → Create.
//                          Add both as Firebase secrets so the deploy
//                          picks them up:
//                            firebase functions:secrets:set GA4_API_SECRET
//
// If either is missing we log a one-time warning and no-op — never fail the
// webhook because of analytics.

const https = require('https');

let _warned = false;
function warnOnce(msg) {
  if (_warned) return;
  _warned = true;
  console.warn(`[ga4] ${msg}`);
}

function send(payload, measurementId, apiSecret, endpoint = '/mp/collect') {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      method: 'POST',
      hostname: 'www.google-analytics.com',
      path: `${endpoint}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 4000,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { if (buf.length < 2000) buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', (e) => { console.error('[ga4] send error:', e.message); resolve({ status: 0 }); });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
    req.write(body);
    req.end();
  });
}

// Anonymous, stable client_id so GA4 groups events by paying user. Derive
// from the firestore uid if present; fall back to piId (stable per-order).
function clientIdFor({ uid, piId }) {
  const src = uid || piId || 'anon';
  // GA4 expects client_id of the form "123456789.987654321" (two integer
  // parts separated by a dot). Hash the source to two stable ints.
  let h1 = 5381, h2 = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    h1 = ((h1 << 5) + h1) ^ c;
    h2 = ((h2 * 31) + c) | 0;
  }
  return `${(h1 >>> 0)}.${(h2 >>> 0)}`;
}

// A 32-bit unsigned hash of any string — used for a per-ORDER session id.
function hash32(src) {
  let h = 5381;
  for (let i = 0; i < String(src).length; i++) h = ((h << 5) + h) ^ String(src).charCodeAt(i);
  return (h >>> 0);
}

/* Post the same payload to GA4's validation endpoint and log whatever it
   objects to.

   Why this exists: /mp/collect answers 204 to almost anything. A wrong
   measurement id, a malformed param, an event GA has decided to drop — all
   come back as success, so the caller logs "sent" and nobody is any the
   wiser. That is precisely the state this code was in: the webhook fired on
   15 of 17 paid orders in July and Analytics recorded 2 purchases, with the
   logs insisting every send succeeded.

   /debug/mp/collect takes the identical payload and returns
   validationMessages explaining the drop. One extra request per purchase —
   a handful a day — in exchange for never being blind about this again. */
async function validateGa4(payload, measurementId, apiSecret, tx) {
  try {
    const res = await send(payload, measurementId, apiSecret, '/debug/mp/collect');
    let msgs = [];
    try { msgs = (JSON.parse(res.body || '{}').validationMessages) || []; } catch (_) {}
    if (msgs.length) {
      console.error(`[ga4] purchase REJECTED by validator tx=${tx} — ${JSON.stringify(msgs)}`);
    } else {
      console.log(`[ga4] purchase validated clean tx=${tx}`);
    }
    return msgs;
  } catch (e) {
    console.warn('[ga4] validator call failed (non-fatal):', e && e.message);
    return [];
  }
}

async function sendGa4Purchase({ piId, orderId, uid, amountCents, currency = 'USD', items = [], couponCode, coinsEarned, coinsRedeemed, attribution }) {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_API_SECRET;
  if (!measurementId || !apiSecret) {
    warnOnce('GA4_MEASUREMENT_ID or GA4_API_SECRET not set — server-side purchase events are disabled.');
    return { skipped: true };
  }

  const value = Math.max(0, Number((amountCents || 0) / 100));

  const mpItems = (items || []).map((it, i) => ({
    item_id: String(it.id || it.recipeId || `item-${i}`),
    item_name: String(it.name || 'item'),
    item_category: String(it.type || it.category || 'misc'),
    quantity: Number(it.qty || 1),
    price: Number(it.price || 0),
  }));

  // Where the order came from, carried onto the server purchase event.
  // This event uses a hashed client_id that does NOT match the browser's
  // GA cookie, so GA4's own session model can't attribute it — for
  // ad-blocked customers (the whole reason this server mirror exists) the
  // source would otherwise be lost. We attach the captured source/medium/
  // campaign both as GA4's reserved campaign params (best-effort session
  // attribution) and as explicit `order_*` custom params so the origin is
  // always visible on the event even if the reserved fields are ignored.
  const a = attribution && typeof attribution === 'object' ? attribution : null;
  const clip = (v) => (v == null ? undefined : String(v).slice(0, 100));
  const attrParams = a ? {
    ...(a.source ? { source: clip(a.source) } : {}),
    ...(a.medium ? { medium: clip(a.medium) } : {}),
    ...(a.campaign ? { campaign: clip(a.campaign) } : {}),
    ...(a.term ? { term: clip(a.term) } : {}),
    ...(a.content ? { content: clip(a.content) } : {}),
    ...(a.channel ? { order_channel: clip(a.channel) } : {}),
    ...(a.source ? { order_source: clip(a.source) } : {}),
    ...(a.medium ? { order_medium: clip(a.medium) } : {}),
    ...(a.campaign ? { order_campaign: clip(a.campaign) } : {}),
  } : {};

  // session_id + engagement_time_msec are REQUIRED for a Measurement
  // Protocol event to appear in standard GA4 reports. Without them GA4
  // still ACCEPTS the event (the payload passes the debug validator and
  // /mp/collect returns 204), but it is dropped from every report as a
  // non-session hit — which is exactly the "validates fine, zero events
  // recorded" symptom. We synthesize a stable session_id from the order
  // (there is no browser GA session to borrow server-side) and send a
  // nominal engagement time so the purchase counts. This is the fix for
  // the server mirror producing zero events.
  // Per-ORDER session id. It used to be the first half of the client_id,
  // which for a signed-in customer depends only on their uid — so every
  // order that person ever placed was posted into ONE session id, reused
  // for weeks. GA4 sessions expire after 30 minutes, and events posted
  // against a long-dead session are a known way to have Measurement
  // Protocol hits accepted (204) and then dropped from every report.
  // Hashing the order instead gives each purchase its own clean session.
  const sessionId = String(hash32(orderId || piId || `s${Date.now()}`));
  const payload = {
    client_id: clientIdFor({ uid, piId }),
    ...(uid ? { user_id: String(uid) } : {}),
    timestamp_micros: Date.now() * 1000,
    non_personalized_ads: true,
    events: [{
      name: 'purchase',
      params: {
        transaction_id: String(orderId || piId || ''),
        value,
        currency,
        // Session/engagement — without these the event never shows in reports.
        session_id: sessionId,
        engagement_time_msec: 1000,
        ...(couponCode ? { coupon: String(couponCode) } : {}),
        ...(coinsEarned ? { coins_earned: Number(coinsEarned) } : {}),
        ...(coinsRedeemed ? { coins_redeemed: Number(coinsRedeemed) } : {}),
        ...attrParams,
        items: mpItems,
      }
    }]
  };

  const tx = payload.events[0].params.transaction_id;
  const res = await send(payload, measurementId, apiSecret);
  if (!res.status || res.status >= 400) {
    console.warn(`[ga4] purchase MP FAILED status=${res.status} tx=${tx} body=${String(res.body || '').slice(0, 300)}`);
  } else {
    // Info-level so a real (or 55¢ test) order proves the path end-to-end.
    // NOTE: a 2xx here means GA ACCEPTED the request, NOT that the event
    // will appear in any report — see validateGa4 below, which is the part
    // that actually tells you.
    console.log(`[ga4] purchase MP sent status=${res.status} tx=${tx} value=${value} client_id=${payload.client_id} session_id=${sessionId}`);
  }
  // Ask the validator the question /mp/collect refuses to answer. Awaited so
  // the answer is in the same invocation's logs, but never allowed to throw.
  await validateGa4(payload, measurementId, apiSecret, tx);
  return res;
}

module.exports = { sendGa4Purchase, clientIdFor };
