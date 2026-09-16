// ═════════════════════════════════════════════════════════════════════
// volumeRamp.js — server counterpart of scripts/volume-ramp.js.
//
// SINGLE SOURCE OF TRUTH for how the per-meal price falls as the cart
// grows. This module and the browser file MUST stay byte-identical in
// their math: the server charge and the client display read the same
// curve, so they can never disagree by a penny (a mismatch is the one
// thing that breaks checkout).
//
// The curve is a list of anchor points [mealCount, perMealDollars],
// ascending. Between anchors the price slides linearly so every added
// meal ticks the per-meal price down (no "dead zone"). Below the first
// anchor the price is flat at the first anchor; above the last anchor
// it's flat at the last anchor.
//
// The default anchors below are ILLUSTRATIVE. The live ladder is set in
// subscriptionConfig.volumeCurve; with no override DEFAULT_CURVE is
// authoritative on BOTH runtimes.
// ═════════════════════════════════════════════════════════════════════
'use strict';

// [mealCount, perMealPriceDollars] — ascending by mealCount.
const DEFAULT_CURVE = [[3, 12.00], [5, 10.00], [10, 9.00]];   // illustrative

function _round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }

function _curve(cfg) {
  const raw = cfg && Array.isArray(cfg.volumeCurve) && cfg.volumeCurve.length
    ? cfg.volumeCurve
    : null;
  let pts = raw
    ? raw.map(function (p) {
        if (Array.isArray(p)) return [Number(p[0]), Number(p[1])];
        return [Number(p && p.meals), Number(p && p.perMeal)];
      })
    : DEFAULT_CURVE.map(function (p) { return [p[0], p[1]]; });
  pts = pts
    .filter(function (p) { return Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] > 0 && p[1] > 0; })
    .sort(function (a, b) { return a[0] - b[0]; });
  return pts.length ? pts : DEFAULT_CURVE.map(function (p) { return [p[0], p[1]]; });
}

// Standard (non-premium) per-meal price at a given cart meal count.
function perMealForCount(count, cfg) {
  const pts = _curve(cfg);
  const n = Number(count) || 0;
  if (n <= pts[0][0]) return pts[0][1];
  const last = pts[pts.length - 1];
  if (n >= last[0]) return last[1];
  for (let i = 0; i < pts.length - 1; i++) {
    const m0 = pts[i][0], p0 = pts[i][1];
    const m1 = pts[i + 1][0], p1 = pts[i + 1][1];
    if (n >= m0 && n <= m1) {
      if (m1 === m0) return p1;
      return _round2(p0 + (p1 - p0) * ((n - m0) / (m1 - m0)));
    }
  }
  return last[1];
}

// Fraction OFF the entry price implied by the curve at this count.
function discountFrac(count, cfg) {
  const pts = _curve(cfg);
  const top = pts[0][1];
  if (!(top > 0)) return 0;
  return (top - perMealForCount(count, cfg)) / top;
}

// Per-meal price for a meal whose own list price is `itemAnchor`
// (premium meals). Standard meals pass the entry price and get
// perMealForCount back.
function perMealForAnchor(itemAnchor, count, cfg) {
  const a = Number(itemAnchor) || 0;
  return _round2(a * (1 - discountFrac(count, cfg)));
}

// Entry (top) per-meal price before any volume discount.
function entryPrice(cfg) {
  return _curve(cfg)[0][1];
}

module.exports = {
  DEFAULT_CURVE,
  perMealForCount,
  perMealForAnchor,
  discountFrac,
  entryPrice,
};
