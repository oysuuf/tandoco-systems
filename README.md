# Tandoco — the systems that run a food business

Tandoco is a high-protein bakery and prepared-foods company I co-founded and
run in Minneapolis. Five channels — farmers markets, wholesale, corporate
catering, a weekly DTC subscription, and a SaaS till for other market vendors
— and I wrote the software that runs all of them: the loyalty program, the
customer model and segments, the lifecycle campaigns, the pricing, the
inventory and market planning, the point of sale, and the reporting.

This isn't a side project with imaginary users. A bug in the pricing curve
charges a real customer the wrong amount; a bad churn model sends the wrong
person a win-back text; a wrong sell-through assumption means I bake forty
rolls nobody buys.

**This repository is a reading copy, not the product.** About forty files,
~16,000 lines, chosen because they show how each problem was reasoned about.
The company's data, customers and keys — and the other ~1,400 files — stay
private. The storefront itself is public at the company's site.

---

## Loyalty — [`loyalty/`](loyalty/)

**[`PROGRAM.md`](loyalty/PROGRAM.md)** is the program design: *v2 paid you for
spending; v3 pays you for staying.* For a weekly subscription the enemy is
churn, not small baskets, so the ladder is shallow, you earn by showing up, and
the rewards are food rather than credit — a free meal *feels* like its menu
price and costs only its food cost to give, which is the whole engine. The
benchmarking behind it (Domino's,
Starbucks, Chick-fil-A vs. the cash-back programs at the 1–2% floor) is in the
doc.

The code that keeps it honest:

- **[`grantCoins.js`](loyalty/grantCoins.js)** — one helper every earn path
  goes through (welcome, birthday, referral, tier-up, streaks, reviews, manual
  grants), idempotent by a deterministic key. Before this, each path had its
  own transaction and its own dedup, and each could be gamed differently.
- **[`coinsUnlocked.js`](loyalty/coinsUnlocked.js)** — *may this customer
  spend?* Only after real money has changed hands, and there are two ways that
  happens (a website order, or a booth purchase that is written as a ticket,
  not an order). One exported rule, so no screen re-derives it and drifts.
- **[`marketWallet.js`](loyalty/marketWallet.js)** — earning at a market booth
  with nothing but a phone number, then linking that wallet to a real account
  later. The linkage requires the customer to OTP-verify the same phone on
  their own record, so nobody can claim a stranger's balance.
- **[`loyaltyConfig.js`](loyalty/loyaltyConfig.js)** — every dial (earn rates,
  tiers, referral payouts) in one settings document the admin screen edits.

## Customers, segments and analytics — [`customers/`](customers/)

- **[`profileSchema.js`](customers/profileSchema.js)** ·
  **[`computeCustomerProfile.js`](customers/computeCustomerProfile.js)** — one
  derived profile document per customer (taste, constraints, goals, order
  behaviour) that every surface reads and *exactly one function writes*.
  Idempotent and replayable: same inputs, same profile.
- **[`customerStats.js`](customers/customerStats.js)** — the rollups
  (lifetime spend, order count, AOV, cadence, last order) maintained by
  trigger, so the CRM stops recomputing them from raw orders on every open.
- **[`ltv.js`](customers/ltv.js)** — predicted LTV and a churn-risk
  percentage. Deliberately not a model: `LTV = AOV × predicted remaining
  orders`, `churn risk = f(days since last order, that customer's own
  cadence)`. Heuristics tuned for a weekly food business, explainable to the
  person acting on them.
- **[`segments.js`](customers/segments.js)** — saved segments as named filter
  recipes. One evaluator powers the CRM's "show me this audience" count, the
  SMS/email audience pickers, and the `segment_entered` journey trigger, so a
  segment means the same thing everywhere it's used.
- **[`churnReasons.js`](customers/churnReasons.js)** — why people cancel, as
  a fixed list. The free-text box before it collected one answer across 21
  cancellations, and that one was a joke. A question nobody answers is a
  question you're not asking.

## Lifecycle marketing — [`lifecycle/`](lifecycle/)

- **[`journeys.js`](lifecycle/journeys.js)** — the automation engine: a
  trigger plus ordered steps (wait, email, SMS). Guarded hard because it sends
  real messages: journeys default to draft, a global kill-switch freezes
  everything, each customer enrolls in a journey at most once, and state
  advances in a transaction *before* any send — at-most-once, so a crash drops
  a message rather than duplicating it.
- **[`workflows.js`](lifecycle/workflows.js)** — the drip engine that
  preceded it, ticked every five minutes.
- **[`emailFrequency.js`](lifecycle/emailFrequency.js)** — every sender in the
  system guarded against *itself* repeating; none knew the others existed, and
  a subscriber collected five soft emails in a week. Now a shared weekly budget
  (two soft emails per person, chatter capped at one) that every job asks
  before sending.
- **[`emailCompliance.js`](lifecycle/emailCompliance.js)** — one-click
  unsubscribe and `List-Unsubscribe` headers on every marketing send, and a
  suppression list every sender checks (CAN-SPAM; Gmail/Yahoo bulk rules).
- **[`abtests.js`](lifecycle/abtests.js)** — subject/content split tests: A
  and B to small slices, a holdout waits, the winner (by opens or clicks) goes
  to the holdout automatically with the lift recorded.
- **[`scheduledBlasts.js`](lifecycle/scheduledBlasts.js)** ·
  **[`reviewRequests.js`](lifecycle/reviewRequests.js)** — scheduled sends,
  and *who gets asked "how was it?"* — split from the send loop so the dry-run
  board can call the real selector instead of a copy of it.
- **[`smsProducers.js`](lifecycle/smsProducers.js)** ·
  **[`smsQueue.js`](lifecycle/smsQueue.js)** — nine producers (order
  confirmed, ready for pickup, renewal in 24h, renewal failed, delivery
  window ask, cart abandoned…) write one document each; one consumer renders,
  checks opt-in (transactional bypasses, marketing doesn't), sends via Twilio
  and writes back the outcome for the audit trail.
- **[`market-blast-audience.js`](lifecycle/market-blast-audience.js)** — booth
  customers aren't in the customer table at all (a phone captured at a market
  lives in a wallet), so the booth text-blast has its own pure audience
  resolver. **[`sms-segment.js`](lifecycle/sms-segment.js)** — GSM-7 vs UCS-2
  detection and the 160/153 vs 70/67 segment math, so the operator sees the
  real cost before sending.

## Pricing and the subscription — [`pricing/`](pricing/)

- **[`volumeRamp.js`](pricing/volumeRamp.js)** ·
  **[`calculateQuote.js`](pricing/calculateQuote.js)** — the per-meal price
  falls as the cart grows. The browser *shows* it, the server *charges* it,
  and the two are kept byte-identical behind a **price-match guard** that
  rejects the order if they ever disagree. Linear between anchors on purpose:
  a step function makes dead zones where adding a meal doesn't move the price,
  and customers notice.
- **[`renewalCharge.js`](pricing/renewalCharge.js)** — "if this renewed right
  now, what leaves the account?" Food, minus retention discount, plus
  re-priced delivery, plus tax, minus gift balance. One formula, read by both
  the renewal charge and the reminder email, so the number you were warned
  about is the number you were charged.

## Inventory, market planning and the kitchen — [`inventory/`](inventory/) · [`kitchen/`](kitchen/)

- **[`MarketPlanBuilderView.swift`](inventory/MarketPlanBuilderView.swift)** ·
  **[`MARKET-PLANNER.md`](inventory/MARKET-PLANNER.md)** — demand planning
  for a market day. Enter how many you'll make; get ingredients needed against
  on-hand stock with shortfalls, build cost, fully-loaded COGS, and a forecast
  that carves out samples (they cost ingredients and never count as sales) and
  applies observed sell-through. The doc is the working brief: what the
  formula was, what was wrong with it, and what the history says.
- **[`InventoryService.swift`](inventory/InventoryService.swift)** — purchase
  units to grams (weight directly, volume via density, "each" with none), and
  cost per gram from there — the basis every recipe cost is built on.
- **[`FreezerStore.swift`](inventory/FreezerStore.swift)** — freezing never
  creates product and never touches raw stock; frozen units carry their make
  cost as a weighted-average basis so margins stay honest when they sell.
- **[`CookSequencer.swift`](kitchen/CookSequencer.swift)** — a cook day for
  one person as list scheduling with real constraints: the cook is a
  capacity-1 resource, the oven is a single-temperature-zone bottleneck where
  a temp change costs a preheat, passive steps overlap by construction.
  Greedy least-slack, back-timed from the target.

## Point of sale — [`pos/`](pos/)

- **[`TapToPayPlugin.swift`](pos/TapToPayPlugin.swift)** — the native bridge
  to Stripe Terminal for Tap to Pay on iPhone at the booth: discovery,
  connection, collecting and confirming a payment, surfaced to the app layer.
- **[`till.js`](pos/till.js)** — from the SaaS till: direct charges on the
  vendor's own connected account. Sales are **idempotent by (org, client
  operation id)** — the sale's document id *is* the client op id, so a double
  tap, a retry or an outbox replay physically cannot create a second sale.
  That design is a scar: the parent system once fired three payment intents
  in 135 ms from one kiosk tap. Cash never touches Stripe and works with no
  signal.

## Analytics and SEO — [`analytics/`](analytics/) · [`seo/`](seo/)

- **[`weekly-digest.js`](analytics/weekly-digest.js)** — the owner's Monday
  email: orders, revenue, subscribers, churn, what moved — aggregated from
  Firestore and rendered, no dashboard to open.
- **[`ga4.js`](analytics/ga4.js)** — server-side `purchase` events mirrored
  from the Stripe webhook, so revenue attribution survives ad blockers.
  **[`cwv-report.js`](analytics/cwv-report.js)** — the five Core Web Vitals
  reported from real users into GA4.
- **[`build-blog-sitemap.js`](seo/build-blog-sitemap.js)** — a blog sitemap
  generated from the live posts collection, kept separate from the hand-curated
  main sitemap so a generator never clobbers it. The public pages carry
  FAQ/Product/LocalBusiness structured data and a per-page metadata pass.

---

## What this says about how I work

- **Write the reasoning where the code is.** Nearly every file opens with why
  it exists and what decision it encodes.
- **One source of truth, or a guard that catches the drift.** A rule that must
  live in two places gets a guard that fails loudly when they disagree.
- **Design for the retry.** Booths have no signal, cards get double-tapped,
  crons overlap. Idempotency isn't polish.
- **Ask questions people answer.** Fixed churn reasons over a free-text box; a
  frequency budget over a "please don't email me" reply.
- **Model the domain honestly.** Frozen inventory with a cost basis; coins that
  aren't spendable until real money moved; samples that never count as sales.

## Stack

Firebase (Firestore, Cloud Functions on Node, Hosting) · Stripe Payments,
Connect, Terminal, Tax · Twilio · SendGrid · GA4 · SwiftUI · Capacitor with
custom native plugins · Square and Plaid integrations

MIT licensed. Happy to walk through any of it.
