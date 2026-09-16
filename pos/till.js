// TandoTill — the till: sales in, refunds out. The invariants live here.
//
//   IDEMPOTENT BY (orgId, clientOpId). The sale doc's ID *is* the clientOpId,
//   so a retry — outbox replay, network blip, double tap — physically cannot
//   create a second sale, and a second PaymentIntent for the same op returns
//   the FIRST intent instead of minting another. (The parent repo once fired
//   three intents in 135ms from one kiosk tap; this design is the scar.)
//
//   DIRECT CHARGES on the org's connected account, application fee for us.
//   Cash never touches Stripe and works with no signal via the app's outbox.
'use strict';

const { db, FieldValue, endpoint, refuse, audit } = require('./lib');
const { cents, applicationFeeCents, cleanLines, priceSale } = require('./money');
const { stripe } = require('./connect');

// The slice is CONFIG, not a constant: unset (0) until the beta settles it,
// then printed on the marketing page before it is ever charged.
function feeBps() {
  const n = Number(process.env.TANDOTILL_APP_FEE_BPS || 0);
  return Number.isInteger(n) && n >= 0 && n <= 500 ? n : 0;
}

function opId(body) {
  const id = String(body.clientOpId || '').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw refuse(400, 'clientOpId required (8-64 url-safe chars)');
  return id;
}

function saleRef(orgId, clientOpId) {
  return db.doc(`orgs/${orgId}/sales/op_${clientOpId}`);
}

async function requireOpenDay(orgId, dayId) {
  const snap = await db.doc(`orgs/${orgId}/days/${dayId}`).get();
  if (!snap.exists || snap.data().status !== 'open') throw refuse(409, 'no open day — open one first');
  return snap;
}

/** cardIntent { orgId, dayId, amountCents, clientOpId, items? }
 *      → { clientSecret, saleId, feeCents, alreadyPaid }
 *  Creates the pending sale AND the PaymentIntent together, idempotently.
 *  Same op again → the same intent back (or alreadyPaid if it finished). */
const cardIntent = endpoint(async (user, body) => {
  const org = (await db.doc(`orgs/${body.orgId}`).get()).data();
  if (!org.stripeAccountId || !org.stripeChargesEnabled) throw refuse(409, 'finish card setup first');
  const id = opId(body);
  await requireOpenDay(body.orgId, String(body.dayId || ''));
  // The SERVER prices the sale. The client sends the basket and the
  // discount the operator chose; what gets charged is computed here, so a
  // tampered total can't undercharge a card.
  let priced, lines;
  try {
    lines = cleanLines(body.items, body.subtotalCents ?? body.amountCents);
    priced = priceSale({ lines, discount: body.discount, subtotalCents: body.subtotalCents ?? body.amountCents });
  } catch (e) { throw refuse(400, e.message); }
  const amount = priced.amountCents;
  if (amount < 50) throw refuse(400, 'card minimum is 50¢');

  const ref = saleRef(body.orgId, id);
  const existing = await ref.get();
  if (existing.exists) {
    const s = existing.data();
    if (s.status === 'paid') return { alreadyPaid: true, saleId: ref.id };
    if (s.paymentIntentId && s.amountCents === amount) {
      const pi = await stripe().paymentIntents.retrieve(s.paymentIntentId, { stripeAccount: org.stripeAccountId });
      if (pi.status === 'succeeded') {
        await ref.update({ status: 'paid', paidAt: FieldValue.serverTimestamp() });
        return { alreadyPaid: true, saleId: ref.id };
      }
      return { clientSecret: pi.client_secret, saleId: ref.id, feeCents: s.feeCents, alreadyPaid: false };
    }
    // Same op id with a DIFFERENT amount is a client bug — refuse, never guess.
    throw refuse(409, 'that operation was already started with a different amount');
  }

  const fee = applicationFeeCents(amount, feeBps());
  const pi = await stripe().paymentIntents.create({
    amount,
    currency: 'usd',
    payment_method_types: ['card_present'],
    capture_method: 'automatic',
    application_fee_amount: fee > 0 ? fee : undefined,
    metadata: { tandotillOrgId: body.orgId, tandotillOp: id },
  }, {
    stripeAccount: org.stripeAccountId,
    idempotencyKey: `tandotill_${body.orgId}_${id}`,     // Stripe-side backstop too
  });

  await ref.set({
    dayId: body.dayId, status: 'pending', tender: 'card',
    amountCents: amount, feeCents: fee,
    subtotalCents: priced.subtotalCents, discountCents: priced.discountCents,
    discountReason: String(body.discountReason || '').slice(0, 80),
    items: lines,
    paymentIntentId: pi.id, stripeAccountId: org.stripeAccountId,
    clientOpId: id, createdBy: user.uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { clientSecret: pi.client_secret, saleId: ref.id, feeCents: fee, alreadyPaid: false };
}, { member: true });

/** cardPaid { orgId, clientOpId } → { ok }
 *  The app confirms the charge collected; we verify WITH STRIPE, never trust
 *  the client, then settle the sale onto the day. Safe to call repeatedly. */
const cardPaid = endpoint(async (user, body) => {
  const id = opId(body);
  const ref = saleRef(body.orgId, id);
  const snap = await ref.get();
  if (!snap.exists) throw refuse(404, 'no such sale');
  const s = snap.data();
  if (s.status === 'paid') return { ok: true, already: true };

  const org = (await db.doc(`orgs/${body.orgId}`).get()).data();
  const pi = await stripe().paymentIntents.retrieve(s.paymentIntentId, { stripeAccount: org.stripeAccountId });
  if (pi.status !== 'succeeded') throw refuse(409, `charge is ${pi.status}, not succeeded`);

  await ref.update({ status: 'paid', paidAt: FieldValue.serverTimestamp() });
  await audit(body.orgId, user.uid, 'sale.cardPaid', { saleId: ref.id, amountCents: s.amountCents });
  return { ok: true };
}, { member: true });

/** recordCash { orgId, dayId, amountCents, tenderedCents?, clientOpId, items?, queuedAtMs? }
 *      → { saleId, changeCents, already }
 *  The offline workhorse: written by the outbox replay as well as live taps.
 *  Identical op → identical answer, sale recorded exactly once. */
const recordCash = endpoint(async (user, body) => {
  const id = opId(body);
  await requireOpenDay(body.orgId, String(body.dayId || ''));

  const ref = saleRef(body.orgId, id);
  let priced, lines;
  try {
    lines = cleanLines(body.items, body.subtotalCents ?? body.amountCents);
    priced = priceSale({ lines, discount: body.discount, subtotalCents: body.subtotalCents ?? body.amountCents });
  } catch (e) { throw refuse(400, e.message); }
  const amount = priced.amountCents;
  if (amount === 0) throw refuse(400, 'amount required');
  let change = 0;
  if (Number.isInteger(body.tenderedCents)) {
    const { changeCents } = require('./money');
    change = changeCents(amount, body.tenderedCents);
  }

  const already = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return true;
    tx.set(ref, {
      dayId: body.dayId, status: 'paid', tender: 'cash',
      amountCents: amount, feeCents: 0,
      subtotalCents: priced.subtotalCents, discountCents: priced.discountCents,
      discountReason: String(body.discountReason || '').slice(0, 80),
      items: lines,
      clientOpId: id, createdBy: user.uid,
      createdAt: FieldValue.serverTimestamp(),
      paidAt: FieldValue.serverTimestamp(),
      // When the outbox replays, keep the moment the sale really happened —
      // the day's story should read in booth time, not sync time.
      soldAtMs: Number.isFinite(body.queuedAtMs) ? body.queuedAtMs : Date.now(),
      replayed: Number.isFinite(body.queuedAtMs),
    });
    return false;
  });
  if (!already) await audit(body.orgId, user.uid, 'sale.cash', { saleId: ref.id, amountCents: amount });
  return { saleId: ref.id, changeCents: change, already };
}, { member: true });

/** refund { orgId, saleId, amountCents?, reason? } → { refundedCents }
 *  Owner-only. Cards refund through Stripe on the connected account; cash
 *  refunds are bookkeeping. Partial allowed; never more than remains. */
const refund = endpoint(async (user, body) => {
  const ref = db.doc(`orgs/${body.orgId}/sales/${String(body.saleId || '')}`);
  const snap = await ref.get();
  if (!snap.exists) throw refuse(404, 'no such sale');
  const s = snap.data();
  if (s.status !== 'paid') throw refuse(409, 'only a paid sale can be refunded');

  const remaining = s.amountCents - (s.refundedCents || 0);
  const amount = body.amountCents == null ? remaining : cents(body.amountCents, 'amountCents');
  if (amount <= 0 || amount > remaining) throw refuse(400, `up to $${(remaining / 100).toFixed(2)} can go back`);

  if (s.tender === 'card') {
    const org = (await db.doc(`orgs/${body.orgId}`).get()).data();
    await stripe().refunds.create({
      payment_intent: s.paymentIntentId,
      amount,
      // Give back our slice pro-rata — we don't earn on money that went back.
      refund_application_fee: !!s.feeCents,
    }, {
      stripeAccount: org.stripeAccountId,
      idempotencyKey: `tandotill_refund_${body.orgId}_${body.saleId}_${amount}`,
    });
  }

  await ref.update({
    refundedCents: FieldValue.increment(amount),
    refunds: FieldValue.arrayUnion({
      amountCents: amount, by: user.uid, atMs: Date.now(),
      reason: String(body.reason || '').slice(0, 200),
    }),
  });
  await audit(body.orgId, user.uid, 'sale.refund', { saleId: ref.id, amountCents: amount });
  return { refundedCents: amount };
}, { member: true, roles: ['owner'] });

module.exports = { cardIntent, cardPaid, recordCash, refund };
