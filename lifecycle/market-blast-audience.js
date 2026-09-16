/* ════════════════════════════════════════════════════════════════════
   Booth text-blast audience — pure resolver, no writes, no network.

   WHY THIS EXISTS instead of reusing sms-recipients.js: that resolver
   only ever queries `customers where smsOptIn == true`, and its filter
   is a closed enum ('all' | 'subscribers' | 'atRisk'). Booth customers
   are not in `customers` at all — a phone captured at a market lives in
   /leads (with its market tags) and /marketWallets (with its coins).
   They have no account, no email, and no name. So they need their own
   resolver.

   WHAT IT ANSWERS: "who signed up at <market>, and what do I know about
   each of them that's worth writing copy around?" Which is coins and
   whether they've come back, because those are the only per-person
   facts booth records actually hold.

   MARKET MATCHING goes through lib/marketNames.js — never string
   equality. The till spells markets differently from the catalogue
   ("Market B" vs "Market B Farmers Market"), so comparing raw
   names splits one market's audience in half.

   CONSENT is NOT decided here. This resolver reports what it sees
   (`optedIn`, `optedOut`) and the caller filters; the real enforcement
   is in functions/src/sms/queue.js, which re-checks by phone at send
   time. Two layers on purpose: this one so staff see an honest count
   before sending, that one so nothing slips out regardless of caller.
   ════════════════════════════════════════════════════════════════════ */

'use strict';

const { resolveMarketId, marketIdsFromTags } = require('./marketNames');

const MAX_LEADS = 5000;
const MAX_AUDIENCE = 1000;     // hard ceiling on one blast
const VISIT_LOOKUP_CHUNK = 20; // parallel txns queries per round

const d10of = (v) => {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
};

/**
 * Which bucket a recipient falls in. These are the three groups the copy
 * branches on, and they're deliberately about BEHAVIOUR (did they come
 * back?) rather than spend, because a booth sale is one flat coin grant
 * and spend tells you almost nothing.
 *
 *   'never'  — gave us their number, never bought. The welcome offer is
 *              still unused, so that's the thing to say.
 *   'first'  — bought once. Has coins sitting there doing nothing.
 *   'repeat' — came back two or more times. Closest to a reward.
 */
function _tierFor(visits){
  if (visits >= 2) return 'repeat';
  if (visits >= 1) return 'first';
  return 'never';
}

/**
 * Count qualifying purchases for a wallet phone.
 *
 * One 'earn' txn is written per purchase (idempotency key mw_earn_<ticketId>
 * in functions/src/loyalty/marketWallet.js), so counting them IS the visit
 * count. Cheaper proxies exist (earned / perOrderCoins) but they break the
 * moment the coin rate changes, and a wrong visit count puts the wrong copy
 * in front of a real customer.
 */
async function _visitCount(db, d10){
  try {
    const snap = await db.collection('marketWallets').doc(d10)
      .collection('txns').where('kind', '==', 'earn').limit(50).get();
    return snap.size;
  } catch (_){
    return 0;   // unknown → treated as 'never', the gentlest copy
  }
}

/**
 * Recover which market a WALLET-ONLY phone bought at.
 *
 * Some booth phones have a wallet but no /leads doc — they were captured
 * before the lead-capture path existed, so nothing wrote down their
 * market. Their purchases still know, though, via a chain of references:
 *
 *   wallet txn .ticketId → marketTickets .shiftId → marketShifts .marketName
 *
 * Kiosk joins are cheaper still: their ticketId literally embeds the
 * shift ("kiosk-<shiftId>-<digits>"), so no ticket read is needed.
 *
 * Returns a canonical market id, or null when the chain can't be walked
 * (no purchases, or a ticket doc that no longer exists). null means
 * "we genuinely don't know", never a guess.
 *
 * @param {Map<string,string>} shiftNames shiftId → marketName, preloaded
 */
async function _recoverMarketFromPurchases(db, d10, shiftNames, pickupMarkets){
  let txns;
  try {
    txns = await db.collection('marketWallets').doc(d10)
      .collection('txns').limit(10).get();
  } catch (_){ return null; }
  if (!txns || txns.empty) return null;

  for (const t of txns.docs){
    const tid = String((t.data() || {}).ticketId || '');
    if (!tid) continue;
    const kiosk = /^kiosk-(.+)-\d{10}$/.exec(tid);
    if (kiosk && shiftNames.has(kiosk[1])){
      const id = resolveMarketId(shiftNames.get(kiosk[1]), pickupMarkets);
      if (id) return id;
      continue;
    }
    try {
      const tk = await db.collection('marketTickets').doc(tid).get();
      if (!tk.exists) continue;
      const sid = (tk.data() || {}).shiftId;
      if (!sid || !shiftNames.has(sid)) continue;
      const id = resolveMarketId(shiftNames.get(sid), pickupMarkets);
      if (id) return id;
    } catch (_){ /* keep trying the next txn */ }
  }
  return null;
}

/**
 * Resolve the booth audience for one market (or every market).
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} opts
 * @param {string} opts.marketId  canonical market id, or 'all' for every booth signup
 * @param {number} [opts.limit=1000]
 * @returns {Promise<{recipients:Array, counts:object, marketLabel:string, error:string|null}>}
 */
async function resolveMarketAudience(db, opts){
  opts = opts || {};
  const wantMarket = String(opts.marketId || 'all');
  const limit = Math.max(1, Math.min(MAX_AUDIENCE, opts.limit | 0 || MAX_AUDIENCE));
  const out = {
    recipients: [],
    counts: {
      leads: 0, matchedMarket: 0, noPhone: 0, optedOut: 0, notOptedIn: 0, eligible: 0,
      // Booth phones with a wallet but no signup record — their market is
      // recovered from purchases, and marketUnknown counts the ones where
      // even that fails (so they only appear in an "every market" send).
      walletOnly: 0, marketUnknown: 0,
    },
    marketLabel: '',
    error: null,
  };

  let pickupMarkets = [];
  try {
    const s = await db.collection('settings').doc('fulfillment').get();
    const data = s.exists ? (s.data() || {}) : {};
    pickupMarkets = (Array.isArray(data.pickupMarkets) ? data.pickupMarkets : [])
      .filter(m => m && m.id)
      .map(m => ({ id: String(m.id), label: String(m.label || m.id) }));
  } catch (e){
    out.error = 'market catalogue read failed: ' + e.message;
    return out;
  }

  if (wantMarket !== 'all'){
    const hit = pickupMarkets.find(m => m.id === wantMarket);
    if (!hit){
      out.error = 'unknown market: ' + wantMarket;
      return out;
    }
    out.marketLabel = hit.label;
  } else {
    out.marketLabel = 'every market';
  }

  let leadSnap;
  try {
    leadSnap = await db.collection('leads').limit(MAX_LEADS).get();
  } catch (e){
    out.error = 'leads query failed: ' + e.message;
    return out;
  }

  // Suppression list first — a number that said STOP never appears in a
  // count, so staff are never shown an audience bigger than reality.
  const suppressed = new Set();
  try {
    const s = await db.collection('smsOptOuts').limit(5000).get();
    s.forEach(d => { const p = d10of(d.id); if (p) suppressed.add(p); });
  } catch (_){ /* non-fatal: queue.js re-checks per message */ }

  /* ── Pass 1: gather every booth phone. NO market filter yet. ───────
     Gathering first and filtering last is load-bearing, not style. An
     earlier version filtered by market inside this loop, which meant a
     lead that failed the market test returned before being recorded —
     so the wallet pass below saw its phone as having no signup record
     and double-counted it. Collecting first also lets one phone's
     signup market and its PURCHASE market both count: somebody who
     joined the list at Market B but buys at Market A is a
     Market A customer too.

     One phone can hold several lead docs (captured at several booths),
     so markets accumulate and consent takes the most protective answer. */
  const byPhone = new Map();   // d10 → { leadId, markets:Set, optedIn, optedOut }
  leadSnap.forEach(doc => {
    const l = doc.data() || {};
    const tags = Array.isArray(l.tags) ? l.tags.map(String) : [];
    const isBooth = String(l.source || '').toLowerCase() === 'market_booth'
      || tags.includes('market-lead');
    if (!isBooth) return;
    out.counts.leads++;

    const d10 = d10of(l.phone);
    if (d10.length !== 10){ out.counts.noPhone++; return; }

    const ids = marketIdsFromTags(tags, pickupMarkets);
    // Fall back to signupMarket when the tags carry no resolvable market
    // (older docs, or a market renamed in the catalogue since capture).
    if (!ids.length && l.signupMarket){
      const id = resolveMarketId(l.signupMarket, pickupMarkets);
      if (id) ids.push(id);
    }

    const rec = byPhone.get(d10) || { leadId: doc.id, markets: new Set(), optedIn: false, optedOut: false };
    ids.forEach(i => rec.markets.add(i));
    // optedOut is a REAL opt-out only (smsOptOutAt / the STOP list), not
    // smsOptIn:false — which usually means "never asked". Same split as
    // _consentByPhone in sms/queue.js, so the counts here mean what they
    // say: optedOut = told us to stop, notOptedIn = never said yes.
    if (l.smsOptIn === true) rec.optedIn = true;
    if (l.smsOptOutAt) rec.optedOut = true;
    byPhone.set(d10, rec);
  });

  // Wallet balances. One bulk read beats one get() per recipient.
  const walletByPhone = new Map();
  try {
    const w = await db.collection('marketWallets').limit(5000).get();
    w.forEach(d => {
      const p = d10of(d.data().phone || d.id);
      if (p) walletByPhone.set(p, d.data() || {});
    });
  } catch (_){ /* non-fatal — coins fall back to 0 */ }

  /* ── Wallet-only booth customers ──────────────────────────────────
     A phone with a wallet but NO /leads doc: captured before the lead
     path existed, so nothing recorded its market. They're real booth
     customers holding real coins, and leaving them out means a blast
     silently misses them — so recover their market from what they
     bought (see _recoverMarketFromPurchases) and include them.

     Kept separate from the lead pass on purpose: consent here comes off
     the WALLET doc, and a wallet with no recorded opt-in is skipped the
     same as a lead with none. */
  const shiftNames = new Map();
  try {
    const sh = await db.collection('marketShifts').limit(500).get();
    sh.forEach(d => {
      const nm = String((d.data() || {}).marketName || '').trim();
      if (nm) shiftNames.set(d.id, nm);
    });
  } catch (_){ /* no shifts readable → no recovery, counted below */ }

  for (const [p, w] of walletByPhone){
    if (w.claimedByUid) continue;              // swept into an account
    const rec = byPhone.get(p);
    if (rec){
      // Has a signup record too — just fold the wallet's consent in.
      // Same split as above: only a real opt-out counts as opted out.
      if (w.smsOptIn === true) rec.optedIn = true;
      if (w.smsOptOutAt) rec.optedOut = true;
      continue;
    }
    out.counts.walletOnly++;
    byPhone.set(p, {
      leadId: null,
      markets: new Set(),
      optedIn: w.smsOptIn === true,
      optedOut: !!w.smsOptOutAt,
      needsRecovery: true,
    });
  }

  /* ── Pass 2: consent, then market, then build ─────────────────────
     Consent is checked before the market so the optedOut / notOptedIn
     counts mean the same thing whichever market is selected.

     A phone with no signup market gets its market recovered from what it
     bought. We do that even for an "every market" send, where it isn't
     needed to decide inclusion, because it's what makes marketUnknown a
     real number — and "3 people we can't place at any market" is worth
     telling the operator regardless of which send they're doing. */
  const candidates = [];
  for (const [p, rec] of byPhone){
    if (suppressed.has(p) || rec.optedOut){ out.counts.optedOut++; continue; }
    if (!rec.optedIn){ out.counts.notOptedIn++; continue; }

    let markets = Array.from(rec.markets);
    if (!markets.length){
      const recovered = await _recoverMarketFromPurchases(db, p, shiftNames, pickupMarkets);
      if (recovered) markets = [recovered];
      else out.counts.marketUnknown++;
    }
    // A phone we can't place at a market only ever appears in an "every
    // market" send. Putting it in a named market's blast would be a
    // guess, and the message says that market's name out loud.
    if (wantMarket !== 'all' && !markets.includes(wantMarket)) continue;

    out.counts.matchedMarket++;
    candidates.push({ leadId: rec.leadId, d10: p, phoneE164: '+1' + p, marketIds: markets });
  }

  const chosen = candidates.slice(0, limit);
  for (let i = 0; i < chosen.length; i += VISIT_LOOKUP_CHUNK){
    const chunk = chosen.slice(i, i + VISIT_LOOKUP_CHUNK);
    const visits = await Promise.all(chunk.map(r => _visitCount(db, r.d10)));
    chunk.forEach((r, j) => {
      const w = walletByPhone.get(r.d10) || {};
      // A claimed wallet's coins moved onto the account doc, so the wallet
      // balance is stale zero — don't quote a number we know is wrong.
      const claimed = !!w.claimedByUid;
      out.recipients.push({
        leadId: r.leadId,
        phoneE164: r.phoneE164,
        d10: r.d10,
        marketIds: r.marketIds,
        coins: claimed ? 0 : Math.max(0, Number(w.coins) || 0),
        coinsKnown: !claimed && !!w,
        visits: visits[j],
        tier: _tierFor(visits[j]),
      });
    });
  }
  out.counts.eligible = out.recipients.length;
  out.capped = candidates.length > chosen.length;
  return out;
}

module.exports = {
  resolveMarketAudience,
  _tierFor,
  MAX_AUDIENCE,
};
