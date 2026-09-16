// ═════════════════════════════════════════════════════════════════════
// Shared TandoCoin grant helper (v2).
//
// Before v2 every coin grant was hand-rolled (welcome, birthday, referral,
// tier-up each had their own transaction + idempotency scheme). The v2
// experiential engine adds many more grant paths (first sub, renewal streak,
// ordering streak, reviews, referral signup, manual admin grants), so they
// all funnel through this one helper to stay consistent and ungameable.
//
// Idempotency is the whole point: the ledger doc id IS the dedup key. A
// caller passes a deterministic idempotencyKey (e.g. `${uid}_signup`,
// `${uid}_streak_7`, `${uid}_review_${orderId}`) and grantCoins refuses to
// post twice — a retry, a duplicate webhook, or a double-tap all collapse
// to a single grant. Mirrors the order-earn transaction in functions/index.js.
// ═════════════════════════════════════════════════════════════════════
'use strict';

const admin = require('firebase-admin');
const db = admin.firestore();

/**
 * Grant (or debit, if delta<0) TandoCoins to a customer, exactly once per
 * idempotencyKey, writing an append-only ledger row in the same transaction.
 *
 * @param {Object}  args
 * @param {string}  args.uid             customers/{uid} to credit
 * @param {number}  args.delta           signed coin amount (positive = grant)
 * @param {string}  args.kind            ledger kind: 'earn' | 'redeem' | 'reversal' | 'adjust'
 * @param {string}  args.reason          semantic reason, e.g. 'signup' | 'first_sub' | 'renewal_streak'
 * @param {string}  args.idempotencyKey  tandoCoinTransactions doc id (deterministic — the dedup guarantee)
 * @param {string} [args.source]         where the grant came from, e.g. 'bootstrapCustomerDoc'
 * @param {Object} [args.meta]           extra ledger fields (orderId, subscriptionId, weekNumber, grantedBy, …)
 * @returns {Promise<{granted:boolean, reason?:string, balanceAfter?:number}>}
 */
async function grantCoins({ uid, delta, kind = 'earn', reason, idempotencyKey, source = 'system', meta = {} }) {
  if (!uid) throw new Error('grantCoins: uid is required');
  if (!idempotencyKey) throw new Error('grantCoins: idempotencyKey is required');
  const amount = Math.round(Number(delta) || 0);
  if (amount === 0) return { granted: false, reason: 'zero_delta' };

  const custRef = db.collection('customers').doc(uid);
  const txnRef = db.collection('tandoCoinTransactions').doc(idempotencyKey);

  try {
    return await db.runTransaction(async (t) => {
      // All reads before writes (Firestore transaction requirement).
      const [cust, existing] = await Promise.all([t.get(custRef), t.get(txnRef)]);
      if (!cust.exists) return { granted: false, reason: 'no_customer' };
      if (existing.exists) return { granted: false, reason: 'already_granted' };

      const c = cust.data();
      const balanceAfter = (Number(c.tandoCoins) || 0) + amount;

      const updates = { tandoCoins: admin.firestore.FieldValue.increment(amount) };
      if (amount > 0) {
        updates.tandoCoinsEarned = admin.firestore.FieldValue.increment(amount);
      } else {
        updates.tandoCoinsRedeemed = admin.firestore.FieldValue.increment(-amount);
      }
      t.set(custRef, updates, { merge: true });

      t.create(txnRef, {
        uid,
        delta: amount,
        kind,
        reason: reason || kind,
        balanceAfter,
        source,
        ...meta,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { granted: true, balanceAfter };
    });
  } catch (e) {
    // Lost the race on t.create (concurrent identical grant) → treat as a
    // successful no-op rather than an error. Firestore ALREADY_EXISTS = code 6.
    if (String(e && e.code) === '6' || /already exists/i.test(String(e && e.message))) {
      return { granted: false, reason: 'already_granted' };
    }
    throw e;
  }
}

module.exports = { grantCoins };
