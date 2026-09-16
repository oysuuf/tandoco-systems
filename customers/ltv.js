/* ════════════════════════════════════════════════════════════════════
   CRM — LTV + churn risk.

   Lightweight, deterministic scorers that extend the customer-derived
   block with predicted lifetime value and a churn-risk percentage.
   No machine learning model — these are heuristics tuned for a D2C
   food business with a weekly cadence:

     - LTV  = avgOrderValue × predictedRemainingOrders
     - churnRisk = f(daysSinceLastOrder, typicalCadenceDays)

   Inputs come from the existing customer-derived recompute, which
   already pulls the most recent paid orders. We expose this as a
   helper so the AI module + segments can both use it.
   ════════════════════════════════════════════════════════════════════ */

'use strict';

function _safeNumber(n, dflt) {
  const v = Number(n);
  return Number.isFinite(v) ? v : (dflt === undefined ? 0 : dflt);
}

/**
 * Scores a customer from a list of paid orders (newest first).
 * Returns { avgOrderValue, lifetimeSpend, predictedLtv, cadenceDays,
 *           daysSinceLastOrder, churnRisk }.
 */
function scoreFromOrders(orders, now) {
  now = now || new Date();
  if (!Array.isArray(orders) || orders.length === 0) {
    return {
      avgOrderValue: 0,
      lifetimeSpend: 0,
      predictedLtv: 0,
      cadenceDays: null,
      daysSinceLastOrder: null,
      churnRisk: 0.5,
    };
  }

  const totals = orders.map(o => _safeNumber(o.total, 0));
  const lifetimeSpend = totals.reduce((s, n) => s + n, 0);
  const avgOrderValue = lifetimeSpend / orders.length;

  // Cadence — average days between consecutive orders (chronological).
  // We have orders newest-first; reverse to compute deltas.
  const tsList = orders
    .map(o => o.createdAt && (o.createdAt.toMillis ? o.createdAt.toMillis()
            : (o.createdAt.seconds ? o.createdAt.seconds * 1000 : 0)))
    .filter(n => n > 0)
    .sort((a, b) => a - b);

  let cadenceDays = null;
  if (tsList.length >= 2) {
    const deltas = [];
    for (let i = 1; i < tsList.length; i++) deltas.push((tsList[i] - tsList[i-1]) / 86400000);
    cadenceDays = deltas.reduce((s, n) => s + n, 0) / deltas.length;
  }

  const lastTs = tsList.length ? tsList[tsList.length - 1] : 0;
  const daysSinceLastOrder = lastTs ? (now.getTime() - lastTs) / 86400000 : null;

  // Predict remaining orders assuming a 12-month forward horizon.
  // If we have cadence, project (365 / cadence) more orders; clip to
  // sensible bounds. If no cadence yet, use a flat 4-order assumption
  // for a 1-order customer (give them a chance to come back).
  let predictedRemaining;
  if (cadenceDays && cadenceDays > 0) {
    predictedRemaining = Math.min(60, 365 / cadenceDays);
    // Decay if churn looks imminent — a customer at 3× cadence is
    // unlikely to return at the same pace.
    if (daysSinceLastOrder && cadenceDays > 0) {
      const ratio = daysSinceLastOrder / cadenceDays;
      if (ratio > 1) {
        predictedRemaining *= Math.max(0.1, 1 - Math.min(1, (ratio - 1) / 3));
      }
    }
  } else {
    predictedRemaining = orders.length === 1 ? 4 : 8;
  }

  const predictedLtv = lifetimeSpend + (avgOrderValue * predictedRemaining);

  // Churn risk: 0 (loyal, recent) → 1 (likely lost).
  let churnRisk;
  if (!cadenceDays) {
    // Single-order customers — risk is purely recency-driven.
    churnRisk = daysSinceLastOrder
      ? Math.min(1, daysSinceLastOrder / 60)
      : 0.5;
  } else {
    const ratio = (daysSinceLastOrder || 0) / cadenceDays;
    if (ratio <= 1)      churnRisk = Math.min(0.2, ratio * 0.2);
    else if (ratio <= 2) churnRisk = 0.2 + (ratio - 1) * 0.4;
    else if (ratio <= 4) churnRisk = 0.6 + (ratio - 2) * 0.15;
    else                  churnRisk = Math.min(0.99, 0.9 + (ratio - 4) * 0.02);
  }

  return {
    avgOrderValue: Math.round(avgOrderValue * 100) / 100,
    lifetimeSpend: Math.round(lifetimeSpend * 100) / 100,
    predictedLtv:  Math.round(predictedLtv  * 100) / 100,
    cadenceDays:   cadenceDays != null ? Math.round(cadenceDays * 10) / 10 : null,
    daysSinceLastOrder: daysSinceLastOrder != null ? Math.round(daysSinceLastOrder * 10) / 10 : null,
    churnRisk:     Math.round(churnRisk * 100) / 100,
  };
}

module.exports = { scoreFromOrders };
