# TandoCoins v3 — Program Spec & Build Plan

*Status: design locked, pre-build. Pre-launch (no real customers/data — clean swap, no migration).*

---

## 1. The one-line change

**v2 paid you for spending. v3 pays you for staying.** The whole program
is re-pointed from rewarding basket size to rewarding retention — because
for a weekly subscription, churn is the enemy, not small orders.

---

## 2. The "why" (how we got here)

- **The loyalty-ROI chart.** Across ~30 big brands, the programs that give
  back *food* (Domino's, Starbucks, Chick-fil-A) top the generosity charts;
  the ones that give back *cash/credit* (Nordstrom, Kroger) sit at the
  1–2% floor. Food rewards win.
- **COGS leverage.** A free meal *feels* like its full menu price but costs
  only its food cost to give — a multiple of difference. Cash can never do
  that: a dollar off costs a dollar. That gap is the entire engine.
- **The Domino's mechanic.** Their eye-popping headline comes from a
  *shallow ladder* + *earning by showing up* (per order), not from the food
  alone. We copy the structure, not the exact numbers.
- **Subscription fit.** Earning per active week rewards loyalty directly and
  fits a business where the customer already orders weekly.

---

## 3. How you earn

- **50 TandoCoins per active subscription week** (+ a flat 50 per qualifying
  one-time order above a minimum floor, to block farming).
- **Experiential earns carry over unchanged:** signup bonus, first-sub,
  photo reviews, referrals, birthday, renewal streak.
- **Abuse guards stay:** signup coins are display-only until the first paid
  order clears; review coins require a real completed order.

---

## 4. Tiers — now by active tenure, and they ONLY speed you up

| Tier | Reached by | Earn rate | Time to a free meal |
|---|---|---|---|
| newbie | weeks 1–7 | 50/wk (1.0×) | ~6 weeks |
| foodie | ~2 months active | ~65/wk (1.25×) | ~4½ weeks |
| connoisseur | ~6 months active | 75/wk (1.5×) | ~4 weeks |

- **No reward is ever tier-locked.** Tiers are pure accelerant — a higher
  tier earns coins faster, so rewards arrive sooner. That's the only effect.
- **Pauses freeze tenure** (you don't lose status while paused).
- **A real lapse — cancelled, not paused — of 2+ continuous months resets
  you to newbie.** Continuous loyalty is the thing being rewarded.

---

## 5. The rungs — 3 only, no gates, items chosen by you in HQ

| Rung | Coins | ≈ when | Pick one of… (you set the exact items in HQ) |
|---|---|---|---|
| 1 · *On the house* | 100 | ~2 weeks | cookie bite · drink · sauce/dip |
| 2 · *Treat yourself* | 200 | ~4 weeks | smoothie multipack · premium side · bakery box |
| 3 ⭐ · *Meal's on us* | 300 | ~6 weeks | **free meal** · 2-meal combo · dessert flight |

- One redemption per order. Coins alone unlock everything.
- **Put your cheapest item at Rung 1** (a single cookie / a sauce) — the
  fast first win should cost pennies, like Domino's dip cup.
- **Milestone free 5-meal week: dropped for now** (too many moving parts).
- Coin scale is 50/wk → 100/200/300. Could go 100/wk → 200/400/600 for
  juicier numbers; same cadence either way.

---

## 6. The money — cost to Tandoco

Live model: `docs/tandocoins-v3-cost-model.html`.

- **Costs a low single-digit % of subscription revenue.**
- **Customers *feel* several times that** — they see the menu price of a
  free meal; you pay only its food cost.
- **Cost is structurally capped:** nobody can ever redeem coins for more real
  money than the food costs to make. Cash has no such ceiling.
- Net: **cash-back money for Domino's-tier excitement.**
- Cost is bounded further by breakage, the cheap Rung-1 item, and the
  2-month reset clawing back the multiplier from churned accounts.

---

## 7. Messaging — make rewards EXTREMELY apparent

A customer should never wonder what their coins did.

- **Order summary / confirmation:** a loud, top-of-receipt line — both
  "**+X TandoCoins earned**" *and*, when a reward was redeemed, "**you saved
  $Y with [reward name]**" — not buried in the totals rows.
- **Cart / checkout:** "you'll earn X coins" + "**N coins from your next free
  meal**" so the next reward is always in sight.
- **Emails** (receipt, welcome, referral, tenure-milestone) all rewritten to
  v3 — and the stale v2 copy killed ("$15 off unlocks at foodie", "1 coin
  per $1").
- **The cadence line, everywhere:** *"Every couple weeks you stay, something's
  on the house — and a free meal every six."*

---

## 8. What a *good* reward moment looks like (the bar)

> **Good:** A subscriber hits week 6 and opens their order confirmation. Right
> at the top — not buried — a gold card: *"🎉 Your free meal is here. You just
> earned $11 of food for staying with us 6 weeks. Tap to use it on your next
> box."* One tap. They *feel* rewarded, and they know exactly why.

> **Bad (today's risk):** coins tick up silently in a totals row nobody reads;
> the reward sits three taps deep in the account screen; the customer never
> realizes they earned anything. Generosity the customer can't see is money
> spent for nothing.

Every surface we touch should pass the "good" bar.

---

## 9. Build plan — 3 staged PRs

**PR 1 — Catalog + apparency + gates** *(no payment-webhook risk)*
- Reshape `settings/rewardCatalog` to 3 rungs.
- Remove the `tier_locked` gate (server `calculateQuote.js:145` + client).
- Update the two hand-synced fallback arrays (`account.html`,
  `store-personalization.js`).
- Make the order summary, account screen, cart, and email copy loud about
  rewards (Section 7) and v3-correct.

**PR 2 — HQ rung-item picker**
- New "Rung config" section in `/hq2#/commerce/loyalty`, reusing the existing
  reward-eligibility form → Firestore pattern, so you pick which items/
  categories belong to each of the 3 rungs.

**PR 3 — The engine** *(isolated, delicate)*
- Earn-per-active-week replaces earn-per-dollar in the Stripe webhook.
- Tiers flip from spend to tenure in all sites (`account.html`,
  `calculateQuote.js`, `hq2.js`, `loyaltyConfig.js`), reusing
  `subscriptions.createdAt` + `derived.streakWeeks` + pause state.
- 2-month lapse → reset to newbie.
- Retire spend-tier logic; fix the threshold disagreement between the two
  places tiers were defined.

---

## 10. Open / assumed (confirm during build)

- Exact rung items — you choose in HQ (PR 2).
- One-time order earn floor — assumed a small minimum.
- Coin scale — assumed 50/wk → 100/200/300.
- Tenure thresholds — assumed foodie ~8 wks, connoisseur ~26 wks.
