/* ════════════════════════════════════════════════════════════════════
   Weekly Owner Digest — data aggregation + email HTML builder.

   Phase 8 of the HQ v2 rollout. BACKEND-ONLY — no changes to HQ code.

   Consumed by index.js via:
     const { buildDigest, renderDigestHtml } = require('./src/lib/weekly-digest');

   Scheduling + delivery live in index.js (to match the existing codebase
   convention for scheduled functions). This module is deliberately pure:
   given a `db` (Firestore Admin SDK reference), it returns a data object.
   Easy to unit-test, easy to dry-run.

   SAFETY
   ------
   - Opt-in per user via users/{uid}.hqFeatureFlags.weeklyDigest === true.
     Default off — nobody receives it unless they explicitly turn it on.
   - All Firestore reads are bounded (last 14 days of orders, 500 cap).
   - Never throws. Every section wraps its aggregation in try/catch and
     falls back to a safe placeholder so one bad dataset can't kill the
     whole email.
   - HTML output is constructed from escaped values. Never interpolates
     raw strings from Firestore into markup.

   EMAIL STYLE
   -----------
   Per the project memory:
   - Send from you@example.com (configured in index.js caller)
   - #ffffff backgrounds throughout (no cream/tan in email)
   - Tandoco brand palette: navy #1B1A6B, gold #C8A96E
   ════════════════════════════════════════════════════════════════════ */

'use strict';

const {
  ORDER_STATUS,
  FULFILLED_STATUSES,
  MONEY_BACK_STATUSES,
  normalizeOrderStatus,
} = require('./orderStatus');

/* Revenue / active-order classification.
 *
 * These used to be capitalized ALLOWLISTS ({'Completed':1,'Ready':1,…}).
 * Two things were wrong with that:
 *   1. Case — everything writes lowercase, so only 'paid' ever matched.
 *   2. Rot — an allowlist has to be updated every time a status is added.
 *      'delivered' and 'picked_up' were never added, so an order counted
 *      toward revenue while it sat at 'paid' and then DROPPED OUT of the
 *      digest the moment it was marked delivered. The digest undercounted
 *      more the better we got at closing orders out.
 *
 * Now a DENYLIST, matching src/aggregates: an order counts unless the money
 * came back. A new status is counted by default instead of silently ignored.
 */

/** Revenue for one order, in dollars. Money-back statuses contribute 0. */
function orderRevenue(o){
  const s = normalizeOrderStatus(o && o.status);
  const total = Number(o && o.total) || 0;
  // Partial refunds keep the portion the customer actually paid.
  if (s === ORDER_STATUS.PARTIALLY_REFUNDED){
    return Math.max(0, total - (Number(o.refundedAmount) || 0));
  }
  if (MONEY_BACK_STATUSES.includes(s)) return 0;
  return total;
}

/* True when the order still represents real money this week. A PARTIAL refund
 * stays in — the customer kept most of what they paid, and orderRevenue()
 * subtracts the refunded slice. Only a full money-back drops out. */
function countsAsRevenue(o){
  const s = normalizeOrderStatus(o && o.status);
  if (s === ORDER_STATUS.PARTIALLY_REFUNDED) return true;
  return !MONEY_BACK_STATUSES.includes(s);
}

/** True when the order is still expected to happen (not fulfilled, not refunded). */
function isActiveOrder(o){
  const s = normalizeOrderStatus(o && o.status);
  return !MONEY_BACK_STATUSES.includes(s) && !FULFILLED_STATUSES.includes(s);
}

function escHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function money(n){
  const v = Number(n) || 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function pct(n){
  if (!isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return sign + Math.round(n) + '%';
}

function isoDate(d){
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${m < 10 ? '0' : ''}${m}-${day < 10 ? '0' : ''}${day}`;
}

/**
 * Aggregate the digest data from Firestore.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {Date}  [now] — override for tests.
 * @returns {Promise<object>} digest data struct
 */
async function buildDigest(db, now){
  now = now || new Date();
  const today = new Date(now); today.setHours(0,0,0,0);

  const weekStart = new Date(today); weekStart.setDate(weekStart.getDate() - 7);   // last 7 days
  const prevWeekStart = new Date(weekStart); prevWeekStart.setDate(prevWeekStart.getDate() - 7); // 8–14 days ago
  const windowStart = prevWeekStart;  // read everything back to 14 days ago once

  const out = {
    generatedAt: now,
    weekStart,
    today,
    thisWeek: { revenue: 0, orders: 0, newCustomers: 0, newAccountsCount: 0 },
    prevWeek: { revenue: 0, orders: 0 },
    deltas: { revenuePct: 0, ordersPct: 0 },
    topItems: [],
    newAccounts: [],
    atRiskCount: 0,
    upcomingPickups: [],
    errors: [],
  };

  // ── Orders (last 14 days, capped) ──────────────────────────────────
  let orders = [];
  try {
    const snap = await db.collection('orders')
      .where('createdAt', '>=', windowStart)
      .orderBy('createdAt', 'desc')
      .limit(1000)
      .get();
    orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    out.errors.push('orders query failed: ' + e.message);
  }

  // Revenue + order counts + item aggregation
  const itemTotals = {};
  const emailsThisWeek = new Set();
  const emailsAllWindow = new Set();
  const lastOrderByEmail = {};
  const orderCountByEmail = {};

  for (const o of orders){
    const tsMs = o.createdAt && o.createdAt.toMillis ? o.createdAt.toMillis() : null;
    if (tsMs == null) continue;
    const email = (o.customerEmail || '').toLowerCase().trim();
    if (email){
      emailsAllWindow.add(email);
      orderCountByEmail[email] = (orderCountByEmail[email] || 0) + 1;
      if (!lastOrderByEmail[email] || tsMs > lastOrderByEmail[email]) lastOrderByEmail[email] = tsMs;
    }

    const thisWeek = tsMs >= weekStart.getTime();
    const prevWeek = !thisWeek && tsMs >= prevWeekStart.getTime();

    if (thisWeek){
      if (countsAsRevenue(o)) {
        out.thisWeek.revenue += orderRevenue(o);
        out.thisWeek.orders++;
      }
      if (email) emailsThisWeek.add(email);
      if (Array.isArray(o.items)){
        for (const it of o.items){
          if (!it) continue;
          const name = String(it.name || 'Unnamed').trim();
          const qty = Number(it.qty); const q = (isFinite(qty) && qty > 0) ? qty : 1;
          itemTotals[name] = (itemTotals[name] || 0) + q;
        }
      }
    } else if (prevWeek){
      if (countsAsRevenue(o)) {
        out.prevWeek.revenue += orderRevenue(o);
        out.prevWeek.orders++;
      }
    }
  }

  out.deltas.revenuePct = out.prevWeek.revenue > 0
    ? ((out.thisWeek.revenue - out.prevWeek.revenue) / out.prevWeek.revenue) * 100
    : (out.thisWeek.revenue > 0 ? 100 : 0);
  out.deltas.ordersPct = out.prevWeek.orders > 0
    ? ((out.thisWeek.orders - out.prevWeek.orders) / out.prevWeek.orders) * 100
    : (out.thisWeek.orders > 0 ? 100 : 0);

  out.topItems = Object.keys(itemTotals)
    .map(n => ({ name: n, qty: itemTotals[n] }))
    .sort((a,b) => b.qty - a.qty)
    .slice(0, 5);

  // ── New customers this week (first order in this 7-day bucket) ──
  // Requires we haven't seen the email before the weekStart boundary.
  // Since we only queried 14 days, "new" approximates "first order in 14d
  // AND first order in this week". Good enough as a headline metric.
  let newCount = 0;
  for (const email of emailsThisWeek){
    const first = orders
      .filter(o => (o.customerEmail || '').toLowerCase().trim() === email
        && o.createdAt && o.createdAt.toMillis)
      .map(o => o.createdAt.toMillis())
      .reduce((min, t) => t < min ? t : min, Infinity);
    if (first >= weekStart.getTime()) newCount++;
  }
  out.thisWeek.newCustomers = newCount;

  // ── New ACCOUNTS this week (real signups from the customers
  // collection — distinct from the "first-time buyers" count above).
  // Pre-launch, most people who create an account never place an order,
  // so the order-derived number misses them entirely. createdAt is
  // backfilled on every customer doc + enforced on create, so this is a
  // reliable roster of who actually signed up in the last 7 days. ──
  try {
    const csnap = await db.collection('customers')
      .where('createdAt', '>=', weekStart)
      .orderBy('createdAt', 'desc')
      .limit(200)
      .get();
    out.newAccounts = csnap.docs.map(d => {
      const c = d.data() || {};
      return { email: (c.email || '').trim(), name: (c.name || '').trim() };
    });
    out.thisWeek.newAccountsCount = out.newAccounts.length;
  } catch (e) {
    out.errors.push('new-accounts query failed: ' + e.message);
  }

  // ── At-risk count (repeat customers, last order 14+ days ago) ──
  const nowMs = now.getTime();
  for (const email of Object.keys(lastOrderByEmail)){
    if ((orderCountByEmail[email] || 0) < 2) continue;
    const daysSince = (nowMs - lastOrderByEmail[email]) / 86400000;
    if (daysSince >= 14) out.atRiskCount++;
  }

  // ── Upcoming pickups (next 7 days) from the same orders list ──
  const pickupByDate = {};
  for (let i = 0; i < 7; i++){
    const d = new Date(today); d.setDate(d.getDate() + i);
    pickupByDate[isoDate(d)] = 0;
  }
  for (const o of orders){
    if (!o.pickupDate || !isActiveOrder(o)) continue;
    if (pickupByDate[o.pickupDate] != null) pickupByDate[o.pickupDate]++;
  }
  out.upcomingPickups = Object.keys(pickupByDate).sort().map(d => ({
    date: d,
    count: pickupByDate[d]
  }));

  return out;
}

/**
 * Render the digest as an HTML email body.
 *
 * @param {object} digest  — output of buildDigest
 * @param {object} [opts]
 * @param {string} [opts.recipientName]
 * @param {string} [opts.hqUrl] — for the CTA link
 */
function renderDigestHtml(digest, opts){
  opts = opts || {};
  const name = escHtml(opts.recipientName || 'there');
  const hqUrl = escHtml(opts.hqUrl || 'https://tandoco.com/hq2');
  const weekLabel = `${weekdayShort(digest.weekStart)} ${digest.weekStart.getMonth()+1}/${digest.weekStart.getDate()} – ${weekdayShort(digest.today)} ${digest.today.getMonth()+1}/${digest.today.getDate()}`;

  const tw = digest.thisWeek;
  const pw = digest.prevWeek;

  const deltaChip = (n, unit) => {
    if (!isFinite(n) || n === 0) return '';
    const color = n > 0 ? '#047857' : '#991B1B';
    const arrow = n > 0 ? '▲' : '▼';
    return `<span style="font-size:11px;font-weight:700;color:${color};margin-left:6px;">${arrow} ${pct(Math.abs(n))}${unit || ''}</span>`;
  };

  const topItemsRows = digest.topItems.length === 0
    ? `<tr><td style="padding:10px 0;color:#6B6B85;font-size:13px;">No items sold this week yet.</td></tr>`
    : digest.topItems.map((it, i) => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #F2EEE5;font-size:14px;color:#17182A;">
          <span style="display:inline-block;width:22px;color:#6B6B85;font-family:ui-monospace,monospace;font-weight:700;">${i+1}.</span>
          ${escHtml(it.name)}
        </td>
        <td style="padding:8px 0;border-bottom:1px solid #F2EEE5;font-size:14px;font-weight:700;color:#1B1A6B;text-align:right;">${it.qty}</td>
      </tr>`).join('');

  const newAccountsRows = (digest.newAccounts && digest.newAccounts.length)
    ? digest.newAccounts.map((c) => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #F2EEE5;font-size:14px;color:#17182A;">
          ${c.name ? `<strong style="color:#1B1A6B;">${escHtml(c.name)}</strong> &middot; ` : ''}${escHtml(c.email || '(no email)')}
        </td>
      </tr>`).join('')
    : `<tr><td style="padding:10px 0;color:#6B6B85;font-size:13px;">No new accounts this week.</td></tr>`;

  const pickupTotal = digest.upcomingPickups.reduce((s,p) => s + p.count, 0);
  const pickupCells = digest.upcomingPickups.map(p => {
    const d = new Date(p.date + 'T00:00:00');
    const wd = weekdayShort(d);
    const day = d.getDate();
    const intensity = Math.min(5, Math.ceil((p.count / Math.max(1, digest.upcomingPickups.reduce((m,x) => Math.max(m, x.count), 1))) * 5));
    const bg = ['#F2EEE5','#F5EFDA','#E8D5A0','#D4B26A','#C8A96E','#1B1A6B'][intensity] || '#F2EEE5';
    const fg = intensity >= 5 ? '#FFFFFF' : '#17182A';
    return `
      <td align="center" valign="middle" style="background:${bg};color:${fg};padding:10px 0;border-radius:6px;font-family:'Helvetica Neue',Arial,sans-serif;width:14%;">
        <div style="font-size:10px;font-weight:700;color:${fg};opacity:.8;text-transform:uppercase;letter-spacing:.06em;">${wd}</div>
        <div style="font-size:16px;font-weight:900;color:${fg};">${day}</div>
        <div style="font-size:10px;font-weight:700;color:${fg};">${p.count || '·'}</div>
      </td>`;
  }).join('');

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#ffffff;font-family:'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background:#ffffff;">
  <tr><td align="center" style="padding:32px 16px 22px;background:#ffffff;">

    <!-- Logo bar -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;margin-bottom:14px;"><tr><td align="center" style="padding:6px 0 14px;">
      <img src="https://tandoco.com/logo.png" alt="tandoco" width="150" style="display:block;border:0;outline:none;width:150px;height:auto;max-height:38px;margin:0 auto;" />
    </td></tr></table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #EDE8DC;">

      <!-- Hero (navy gradient + gold eyebrow rule) -->
      <tr><td style="background-color:#1B1A6B;background:linear-gradient(135deg,#0F0E47 0%,#1B1A6B 55%,#2D2FA8 130%);padding:30px 28px 26px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:10px;"><tr>
          <td style="width:22px;border-bottom:1.5px solid #E8C87A;line-height:0;font-size:0;">&nbsp;</td>
          <td style="padding-left:10px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:10.5px;font-weight:900;color:#E8C87A;letter-spacing:.18em;text-transform:uppercase;">internal · weekly digest</td>
        </tr></table>
        <h1 style="font-family:'Helvetica Neue',Arial,sans-serif;font-weight:800;font-size:26px;color:#ffffff;letter-spacing:-.024em;margin:0 0 4px;line-height:1.1;text-transform:lowercase;">${weekLabel.toLowerCase()}</h1>
        <p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:13.5px;color:rgba(255,255,255,.78);margin:0;line-height:1.5;font-weight:500;text-transform:lowercase;">hey ${name.toLowerCase()} — here's the week at a glance.</p>
      </td></tr>

      <!-- Body wrapper -->
      <tr><td style="padding:18px 28px 6px;background:#ffffff;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td>&nbsp;</td></tr>

      <!-- Headline metrics -->
      <tr><td style="padding:14px 0 6px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="50%" valign="top" style="padding-right:6px;">
              <div style="border:1px solid #E8E3D8;border-radius:10px;padding:14px 16px;background:#ffffff;">
                <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:10.5px;font-weight:800;color:#6B6B85;text-transform:uppercase;letter-spacing:.08em;">Revenue</div>
                <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:24px;font-weight:900;color:#1B1A6B;letter-spacing:-.02em;margin-top:4px;">${money(tw.revenue)}${deltaChip(digest.deltas.revenuePct)}</div>
                <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:#6B6B85;margin-top:3px;">vs ${money(pw.revenue)} prior week</div>
              </div>
            </td>
            <td width="50%" valign="top" style="padding-left:6px;">
              <div style="border:1px solid #E8E3D8;border-radius:10px;padding:14px 16px;background:#ffffff;">
                <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:10.5px;font-weight:800;color:#6B6B85;text-transform:uppercase;letter-spacing:.08em;">Orders</div>
                <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:24px;font-weight:900;color:#1B1A6B;letter-spacing:-.02em;margin-top:4px;">${tw.orders}${deltaChip(digest.deltas.ordersPct)}</div>
                <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:#6B6B85;margin-top:3px;">${tw.newCustomers} first-time buyer${tw.newCustomers === 1 ? '' : 's'}</div>
              </div>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- New accounts (real signups from the customers collection) -->
      <tr><td style="padding:22px 0 6px;">
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;font-weight:800;color:#1B1A6B;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">New accounts &middot; ${tw.newAccountsCount}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${newAccountsRows}</table>
      </td></tr>

      <!-- Top items -->
      <tr><td style="padding:22px 0 6px;">
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;font-weight:800;color:#1B1A6B;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">Top sellers</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${topItemsRows}</table>
      </td></tr>

      <!-- At-risk -->
      <tr><td style="padding:18px 0 6px;">
        <div style="border-left:3px solid #C8A96E;padding:10px 14px;background:#FFF8E8;border-radius:0 8px 8px 0;">
          <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;font-weight:800;color:#1B1A6B;">${digest.atRiskCount} customer${digest.atRiskCount === 1 ? '' : 's'} at churn risk</div>
          <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:#3D3E5C;margin-top:2px;">Repeat buyers with no order in 14+ days. Winback in HQ &rsaquo; Churn radar.</div>
        </div>
      </td></tr>

      <!-- Upcoming pickups -->
      <tr><td style="padding:22px 0 6px;">
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;font-weight:800;color:#1B1A6B;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">Next 7 days · ${pickupTotal} pickup${pickupTotal === 1 ? '' : 's'} scheduled</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="2" border="0">
          <tr>${pickupCells}</tr>
        </table>
      </td></tr>

      <!-- CTA -->
      <tr><td style="padding:18px 0 8px;" align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td style="background-color:#C8A96E;border-radius:14px;padding:14px 26px;">
          <a href="${hqUrl}" style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:13.5px;font-weight:900;color:#1A1508;text-decoration:none;display:block;text-transform:lowercase;letter-spacing:-.005em;">open hq →</a>
        </td></tr></table>
      </td></tr>

        </table>
      </td></tr>

      <!-- Sign-off -->
      <tr><td style="padding:6px 28px 16px;background:#ffffff;">
        <div style="display:inline-block;width:34px;height:1.5px;background-color:#C8A96E;margin-bottom:8px;line-height:0;font-size:0;">&nbsp;</div>
        <p style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:500;font-size:17px;color:#1B1A6B;margin:0 0 4px;line-height:1.25;text-transform:lowercase;">monday read · clean numbers <span style="color:#8B6914;">—</span></p>
        <p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:#6B6B7B;margin:0;letter-spacing:.06em;text-transform:uppercase;font-weight:800;"><span style="color:#1B1A6B;font-weight:900;">tandoco hq</span></p>
      </td></tr>

      <!-- Footer -->
      <tr><td style="padding:18px 28px 22px;background:#F2EEE3;border-top:1px solid #EDE8DC;">
        <p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:10.5px;color:#6B6B7B;line-height:1.6;margin:0;letter-spacing:.02em;text-transform:lowercase;">
          sent automatically every monday morning. to stop, set <code style="font-family:ui-monospace,monospace;font-size:10px;color:#1B1A6B;">hqFeatureFlags.weeklyDigest = false</code> on your user doc.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}

function weekdayShort(d){
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
}

// The status classifiers are exported for testing — they encode the revenue
// rules and were silently wrong for months, so they should be assertable
// without standing up Firestore.
module.exports = {
  buildDigest, renderDigestHtml,
  orderRevenue, countsAsRevenue, isActiveOrder,
};
