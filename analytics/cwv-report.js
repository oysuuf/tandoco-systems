/* cwv-report.js — Core Web Vitals → GA4 RUM reporter
 *
 * Loaded as `<script defer>` on every GA4-enabled page (the same set
 * of pages that ship the gtag.js bootstrap in <head>). Dynamically
 * imports the web-vitals v4 library from a CDN, registers handlers
 * for the five standard Core Web Vitals (LCP, INP, CLS, FCP, TTFB),
 * and forwards each metric to GA4 as a `web_vital` custom event so
 * you can build LCP/INP/CLS dashboards from Real User Monitoring
 * instead of guessing from Lighthouse synthetic runs.
 *
 * web-vitals' PerformanceObservers register with `buffered: true`,
 * so metrics that fire before the dynamic import resolves are still
 * captured (notably FCP and the LCP candidate, which often land
 * before any deferred script gets a chance to run).
 *
 * COMPLEMENTARY to scripts/inp-report.js. That script captures
 * per-element INP labels for funnel optimization (which CTA was
 * slow). This script captures the page-level aggregate metrics that
 * match what PageSpeed Insights and Chrome UX Report (CrUX) report,
 * giving us field data that aligns with what Google sees.
 *
 * GA4 event shape:
 *   event_name      'web_vital'
 *   event_category  'performance'
 *   event_label     '<page-path>:<metric-name>'   e.g. '/store:LCP'
 *   value           integer ms (or CLS×1000 since CLS is unitless)
 *   metric_id       web-vitals-generated stable id (dedup key)
 *   metric_rating   'good' | 'needs-improvement' | 'poor'
 *   metric_delta    change since last report (INP/CLS update over time)
 *   non_interaction true
 *
 * To inspect in GA4: Reports → Engagement → Events → web_vital, then
 * pivot by event_label to compare metrics across pages.
 */
(function () {
  if (typeof window === 'undefined' || !window.location) return;
  if (window._tandocoCwvLoaded) return;
  window._tandocoCwvLoaded = true;

  var PAGE = (location.pathname || '/').replace(/\/$/, '') || '/';

  function send(metric) {
    if (typeof window.gtag !== 'function') return;
    try {
      var isCls = metric.name === 'CLS';
      var value = Math.round(isCls ? metric.value * 1000 : metric.value);
      var delta = metric.delta != null
        ? Math.round(isCls ? metric.delta * 1000 : metric.delta)
        : 0;
      window.gtag('event', 'web_vital', {
        event_category: 'performance',
        event_label: PAGE + ':' + metric.name,
        value: value,
        metric_id: metric.id || '',
        metric_rating: metric.rating || '',
        metric_delta: delta,
        non_interaction: true,
      });
    } catch (_) { /* gtag missing or threw — silently drop */ }
  }

  // Wrap dynamic import in `new Function` so the import() syntax is
  // evaluated lazily. Browsers that don't support dynamic import
  // (very old) throw at Function construction; we catch and bail
  // cleanly without breaking script parse.
  var importLib;
  try {
    importLib = new Function(
      'return import("https://cdn.jsdelivr.net/npm/web-vitals@4.2.4/+esm")'
    );
  } catch (_) { return; }

  try {
    importLib().then(function (mod) {
      if (typeof mod.onLCP  === 'function') mod.onLCP(send);
      if (typeof mod.onINP  === 'function') mod.onINP(send);
      if (typeof mod.onCLS  === 'function') mod.onCLS(send);
      if (typeof mod.onFCP  === 'function') mod.onFCP(send);
      if (typeof mod.onTTFB === 'function') mod.onTTFB(send);
    }).catch(function () { /* CDN unreachable: ignore */ });
  } catch (_) {}
})();
