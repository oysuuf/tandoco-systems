// ═════════════════════════════════════════════════════════════════════
// Market phone-wallet — earn & redeem TandoCoins at a market booth with
// nothing but a phone number, then link it to a real account later.
//
// THE MODEL (see the booth-rewards design):
//   • A customer buys at the booth and gives a phone number.
//   • If that phone is PROVEN (OTP-verified) to belong to a real account →
//     coins go straight onto it, exactly like a website order earns
//     (grantCoins). A merely typed-in number is not proof — see
//     findCustomerUidByPhone.
//   • If it isn't → we open a lightweight "wallet" keyed to the phone
//     (marketWallets/{digits}) and the coins live there. It's a digital
//     punch card: earn by buying, spend by buying, no account required.
//   • When that person later creates an account, claimWalletForCustomer
//     SWEEPS the wallet's coins into their new account — but ONLY for the
//     phone number on their own (OTP-verified at signup) record, so nobody
//     can claim a stranger's wallet.
//
// THE GUARD: a wallet only ever holds coins EARNED BY BUYING (real money
// changed hands), so they're spendable immediately. The free signup bonus
// is NOT minted into wallets — it's reserved for real account creation,
// which is the carrot to go official. (Per the locked abuse-guard rule.)
//
// Idempotency: every earn/redeem/claim is deduped by a deterministic key
// (the marketTicket id), mirroring the order-earn path. A retried request,
// a double-tap, or a re-synced offline ticket all collapse to one grant.
// ═════════════════════════════════════════════════════════════════════
'use strict';

const admin = require('firebase-admin');
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const { grantCoins } = require('./grantCoins');
const { loadLoyaltyConfig } = require('../lib/loyaltyConfig');

// Normalize a typed phone number to the SAME shape signup stores
// (scripts/auth-modal.js: `'+1' + digits`), so a booth number and the
// later account line up. Returns null for anything that isn't a US 10-digit
// number. `digits10` is the bare 10 digits (used as the wallet doc id —
// no '+' so it's a clean key); `e164` is the +1… form used on customer docs.
function normalizePhone(raw) {
  let d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10) return null;
  return { digits10: d, e164: '+1' + d };
}

// Find the customer account that PROVABLY owns this phone number.
//
// The only proof the server accepts is Firebase Auth's linked phone, which
// exists solely after a real OTP linkWithCredential (signup's code step, or
// the account page's "verify your number" card). Same standard
// claimMarketWallet holds — see its comment in functions/index.js.
//
// It deliberately does NOT query `customers.phone` (nor `phoneVerified`).
// Both are owner-writable contact fields — nothing in firestore.rules stops
// a customer setting them to anything — so routing coins by them let anyone
// type a booth regular's number onto their own profile and collect that
// regular's earnings, plus the coinsUnlocked flip that makes coins spendable
// on the website. `phoneVerified` is no better than `phone` here: it's a
// self-attested flag AND badly under-populated (3 docs carry it vs 12 whose
// number Auth has actually proven), so it fails in both directions.
//
// Bonus property: Auth enforces one account per verified number, so this
// can't silently pick between duplicates the way the old `.limit(1)` query
// did (three numbers currently sit on two customer docs each).
//
// No match → null, and the caller parks the coins in the phone wallet. That
// is never a loss: claimMarketWallet sweeps the wallet into the account the
// moment they verify their number.
async function findCustomerUidByPhone(norm) {
  let user;
  try {
    user = await admin.auth().getUserByPhoneNumber(norm.e164);
  } catch (e) {
    // Not a verified number on any account — the normal case for a booth
    // walk-up. Any OTHER error (Auth unreachable) also falls through to the
    // wallet on purpose: parking coins is recoverable, mis-routing them to
    // the wrong account is not.
    if (String(e && e.code) !== 'auth/user-not-found') {
      console.error('[marketWallet] auth phone lookup failed', e && e.message);
    }
    return null;
  }
  if (!user || !user.uid) return null;
  // ORPHAN-TWIN GUARD. An Auth record with no email is not a customer.
  // `signInWithPhoneNumber` mints one for any number it doesn't recognise,
  // and ALL TEN phone-linked Auth records in production are exactly that:
  // provider=phone only, no email, empty customer doc, 0 coins, 0 orders.
  // They predate the ghost-account guard in auth-modal's verifyOTP, which
  // now deletes them at creation. Auth still says the twin owns the number,
  // so without this check a booth purchase credits a nameless shell instead
  // of the real customer behind that number — the booth sale would have
  // credited an empty shell rather than the real account.
  //
  // It deliberately does NOT fall back to the customers.phone query: that
  // owner-writable field is the whole reason this function exists. An
  // unproven number parks in the wallet, which is recoverable.
  if (!user.email) return null;
  // customers/{uid} is keyed by the Auth uid. Require the doc to exist —
  // marketRedeem and grantCoins both expect a real customer record, and a
  // verified Auth user with no customer doc is better served by the wallet.
  const c = await db.collection('customers').doc(user.uid).get();
  return c.exists ? user.uid : null;
}

// Idempotent credit/debit to a phone wallet (marketWallets/{digits}), with
// an append-only ledger row in the same transaction. Refuses to overdraw.
// Mirrors grantCoins, but for the wallet collection instead of a customer.
async function walletGrant({ phone, delta, reason, idempotencyKey, source = 'marketWallet', meta = {} }) {
  const norm = normalizePhone(phone);
  if (!norm) return { ok: false, reason: 'bad_phone' };
  if (!idempotencyKey) throw new Error('walletGrant: idempotencyKey required');
  const amount = Math.round(Number(delta) || 0);
  if (amount === 0) return { ok: false, reason: 'zero_delta' };

  const wRef = db.collection('marketWallets').doc(norm.digits10);
  const tRef = wRef.collection('txns').doc(idempotencyKey);
  try {
    return await db.runTransaction(async (t) => {
      const [w, existing] = await Promise.all([t.get(wRef), t.get(tRef)]);
      const cur = w.exists ? (Number(w.data().coins) || 0) : 0;
      if (existing.exists) return { ok: false, reason: 'already', balanceAfter: cur };
      if (w.exists && w.data().claimedByUid) {
        // Wallet was claimed by a real account — coins now live there, not here.
        return { ok: false, reason: 'claimed', claimedByUid: w.data().claimedByUid };
      }
      if (amount < 0 && cur + amount < 0) return { ok: false, reason: 'insufficient', balanceAfter: cur };
      const balanceAfter = cur + amount;

      const upd = {
        phone: norm.e164,
        coins: FieldValue.increment(amount),
        updatedAt: FieldValue.serverTimestamp(),
        lastSeenAt: FieldValue.serverTimestamp(),
      };
      if (amount > 0) upd.earned = FieldValue.increment(amount);
      else upd.redeemed = FieldValue.increment(-amount);
      if (!w.exists) { upd.createdAt = FieldValue.serverTimestamp(); upd.claimedByUid = null; }
      t.set(wRef, upd, { merge: true });

      t.create(tRef, {
        phone: norm.e164,
        delta: amount,
        kind: amount > 0 ? 'earn' : 'redeem',
        reason: reason || (amount > 0 ? 'market_purchase' : 'market_redeem'),
        balanceAfter,
        source,
        ...meta,
        createdAt: FieldValue.serverTimestamp(),
      });
      return { ok: true, balanceAfter };
    });
  } catch (e) {
    if (String(e && e.code) === '6' || /already exists/i.test(String(e && e.message))) {
      return { ok: false, reason: 'already' };
    }
    throw e;
  }
}

// Current spendable balance + who it belongs to. Lets the till show
// "you've got 240 coins" before a redeem.
async function getBalance({ phone }) {
  const norm = normalizePhone(phone);
  if (!norm) return { ok: false, reason: 'bad_phone' };
  const uid = await findCustomerUidByPhone(norm);
  if (uid) {
    const c = await db.collection('customers').doc(uid).get();
    const d = c.exists ? c.data() : {};
    return { ok: true, target: 'customer', uid, coins: Number(d.tandoCoins) || 0, name: d.name || null, coinsUnlocked: d.coinsUnlocked !== false };
  }
  const w = await db.collection('marketWallets').doc(norm.digits10).get();
  const coins = w.exists && !w.data().claimedByUid ? (Number(w.data().coins) || 0) : 0;
  return { ok: true, target: 'wallet', coins, name: null, coinsUnlocked: true };
}

// EARN on a market purchase. Flat per-qualifying-order coins (same config the
// website order-earn uses); orders under minEarnOrderCents earn nothing
// (farm guard). Routes to the real account if the phone is known, else the
// phone wallet. A market purchase is real money, so for a known customer it
// also flips coinsUnlocked true (their coins become spendable — the same
// "real once they've paid" rule the first online order uses).
async function marketEarn({ phone, amountCents, ticketId, source = 'marketWalletEarn' }) {
  const norm = normalizePhone(phone);
  if (!norm) return { ok: false, reason: 'bad_phone' };
  if (!ticketId) return { ok: false, reason: 'no_ticket' };
  const cfg = await loadLoyaltyConfig();
  const minCents = Number(cfg.minEarnOrderCents) || 0;
  const coins = (Number(amountCents) || 0) >= minCents ? Math.floor(Number(cfg.perOrderCoins) || 0) : 0;
  if (coins <= 0) return { ok: true, target: 'none', coins: 0, reason: 'below_min' };

  const idem = `mw_earn_${ticketId}`;
  const uid = await findCustomerUidByPhone(norm);
  if (uid) {
    const r = await grantCoins({
      uid, delta: coins, kind: 'earn', reason: 'market_purchase', idempotencyKey: idem,
      source, meta: { ticketId, phone: norm.e164, channel: 'market' },
    });
    // Real paid purchase → unlock their rewards (idempotent merge).
    try { await db.collection('customers').doc(uid).set({ coinsUnlocked: true }, { merge: true }); } catch (_) {}
    return { ok: r.granted || r.reason === 'already_granted', target: 'customer', uid, coins, balanceAfter: r.balanceAfter };
  }
  const r = await walletGrant({ phone: norm.e164, delta: coins, reason: 'market_purchase', idempotencyKey: idem, source, meta: { ticketId, channel: 'market' } });
  return { ok: r.ok || r.reason === 'already', target: 'wallet', coins, balanceAfter: r.balanceAfter };
}

// REDEEM coins at the booth (apply a reward). Routes to the account or the
// wallet, checks the balance, and is idempotent per ticket. For a real
// account we also respect coinsUnlocked (locked signup-bonus coins can't be
// spent until a first paid order); a phone wallet only ever holds earned
// coins, so it's always spendable.
async function marketRedeem({ phone, coins, ticketId, reason = 'market_redeem', source = 'marketWalletRedeem' }) {
  const norm = normalizePhone(phone);
  if (!norm) return { ok: false, reason: 'bad_phone' };
  if (!ticketId) return { ok: false, reason: 'no_ticket' };
  const spend = Math.abs(Math.round(Number(coins) || 0));
  if (spend <= 0) return { ok: false, reason: 'zero' };

  const idem = `mw_redeem_${ticketId}`;
  const uid = await findCustomerUidByPhone(norm);
  if (uid) {
    return await db.runTransaction(async (t) => {
      const cRef = db.collection('customers').doc(uid);
      const tRef = db.collection('tandoCoinTransactions').doc(idem);
      const [c, existing] = await Promise.all([t.get(cRef), t.get(tRef)]);
      if (existing.exists) return { ok: false, reason: 'already', target: 'customer' };
      if (!c.exists) return { ok: false, reason: 'no_customer' };
      const d = c.data();
      if (d.coinsUnlocked === false) return { ok: false, reason: 'locked' };
      const bal = Number(d.tandoCoins) || 0;
      if (bal < spend) return { ok: false, reason: 'insufficient', balance: bal };
      const balanceAfter = bal - spend;
      t.set(cRef, { tandoCoins: FieldValue.increment(-spend), tandoCoinsRedeemed: FieldValue.increment(spend) }, { merge: true });
      t.create(tRef, {
        uid, delta: -spend, kind: 'redeem', reason, balanceAfter, source,
        ticketId, phone: norm.e164, channel: 'market', createdAt: FieldValue.serverTimestamp(),
      });
      return { ok: true, target: 'customer', uid, spent: spend, balanceAfter };
    });
  }
  const r = await walletGrant({ phone: norm.e164, delta: -spend, reason, idempotencyKey: idem, source, meta: { ticketId, channel: 'market' } });
  return { ...r, target: 'wallet', spent: r.ok ? spend : 0 };
}

// CLAIM — sweep a phone wallet into a real account. `phone` MUST come from
// a proven source: the caller (claimMarketWallet) passes decoded.phone_number
// off the verified ID token, never customers/{uid}.phone, so a customer can
// only ever claim the wallet for a number they actually own.
// Idempotent: the grant is deduped, and the wallet is marked claimed + zeroed.
async function claimWalletForCustomer({ uid, phone }) {
  const norm = normalizePhone(phone);
  if (!norm) return { ok: false, reason: 'bad_phone' };
  const wRef = db.collection('marketWallets').doc(norm.digits10);
  const w = await wRef.get();
  if (!w.exists) return { ok: false, reason: 'no_wallet', coinsSwept: 0 };
  const wd = w.data();
  if (wd.claimedByUid && wd.claimedByUid !== uid) return { ok: false, reason: 'claimed_other' };

  const coins = Math.max(0, Number(wd.coins) || 0);
  let balanceAfter;
  if (coins > 0) {
    const r = await grantCoins({
      uid, delta: coins, kind: 'earn', reason: 'market_wallet_claim',
      idempotencyKey: `${uid}_mwclaim_${norm.digits10}`,
      source: 'claimMarketWallet', meta: { phone: norm.e164, walletId: norm.digits10 },
    });
    if (!r.granted && r.reason !== 'already_granted') return { ok: false, reason: r.reason };
    balanceAfter = r.balanceAfter;
    // A wallet only ever holds coins EARNED BY BUYING (see THE GUARD at the
    // top of this file) — real money changed hands at a booth. So sweeping
    // them in is proof of a paid purchase: unlock them. Without this, signing
    // up LOCKED coins the customer could already spend at the booth (the
    // signup handler stamps coinsUnlocked from firstOrderCompleted, false on
    // a new account), and the website's Guard ① refused them too.
    // Deliberately does NOT touch firstOrderCompleted: that flag also means
    // "hasn't used the website newcomer perks", and a booth purchase must not
    // quietly spend their first-order discount or referral free meal.
    try { await db.collection('customers').doc(uid).set({ coinsUnlocked: true }, { merge: true }); } catch (_) {}
  }
  // Sweep marketing consent captured at the booth onto the new account, so the
  // welcome text fires + they enter the campaign audience (no duplicate doc).
  if (wd.smsOptIn === true) {
    try {
      await db.collection('customers').doc(uid).set({
        smsOptIn: true,
        smsOptInAt: wd.smsOptInAt || FieldValue.serverTimestamp(),
        smsOptInSource: wd.smsOptInSource || 'market-booth',
      }, { merge: true });
    } catch (_) {}
  }
  await wRef.set({ claimedByUid: uid, claimedAt: FieldValue.serverTimestamp(), coins: 0 }, { merge: true });
  return { ok: true, coinsSwept: coins, balanceAfter };
}

module.exports = {
  normalizePhone,
  findCustomerUidByPhone,
  walletGrant,
  getBalance,
  marketEarn,
  marketRedeem,
  claimWalletForCustomer,
};
