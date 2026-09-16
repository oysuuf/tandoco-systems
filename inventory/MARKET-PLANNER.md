# Market Planner — how it works today, and what to fix

> Working brief for a follow-up coding session. Plain-English first, then the
> exact formula, file locations, the bugs, and the data already on hand to fix
> them. Nothing here is deployed-sensitive — `docs/` is ignored by Firebase
> Hosting, so this file is never published.

## ⚠️ STATUS UPDATE (read this first) — most of "what's wrong" is already fixed

**This brief was written against an OLD copy of `MarketPlannerView.swift`** (the
`<branch>` branch forked from `main` before builds
42–50 landed). Several findings below were since implemented. Re-verify against
the CURRENT file before "fixing" anything — much of it is done:

- **#1 equal-average pricing** — largely addressed. Revenue/cost now come from a
  **margin-weighted recommended pack mix**, not the flat mean of all pack tiers.
  (Still theoretical, not history-weighted — see "Still open" below.)
- **#2 sampling model** — **DONE.** The planner now takes how many you **made**,
  carves out `samples = sampleRate × made`, charges samples ingredient cost but
  **never counts them as sales** (revenue applies to the sellable remainder),
  and shows a separate "Samples" line. The config writes `made` + `sampleRate`
  (not `bring`). This was the big "plan reads high, reality lands lower" gap — closed.
- **"recommended mix / batches" layout** — **DONE.** The screen IS now
  "enter how many made → recommended pack mix + samples, with per-item blended
  price/cost." The old `bring`-list/scenario-only layout this brief describes is
  gone.

**Still open (valid against current code):**
- **History-grounding** — defaults are theoretical (margin weighting + flat
  `sampleRate` + global sell-through). The brief's best idea stands: seed
  per-item realized price/unit, sell-through, and sample fraction from
  `marketTickets`/`marketShifts` (see "Data already available").
- **Per-item sell-through (#3)** — still one global strong/steady/slow.
- **Markdowns (#4)** — till records them now (PR #3850), planner still assumes
  full price on the unsold tail.

Everything below is the original brief, kept for the math + data-source detail.

## What the Market Planner is

It's the "how much should I bake for next market, and what will I net" tool in
the **Staff-Native** iOS app (the Front-tab world). You type how many of each
item you're **bringing**; it projects gross revenue, food cost, and net profit
under a strong / steady / slow day, plus a season view against the equipment
cost. It reads recipe prices + ingredient costs and a small saved-assumptions
doc.

It is a *planning* tool only — it does not write sales. Real sales live in
`marketTickets` / `marketShifts` (see "Data already available" below).

## Where it lives

| Piece | Location |
| --- | --- |
| The planner screen + all math | `mise-app/MarketPlannerView.swift` (whole file, ~293 lines) |
| Saved assumptions (Firestore) | `settings/marketPlanner` |
| Opened from | the Front tab — `mise-app/FrontView.swift` (`showPlanner` / `MarketPlannerView()`), and the no-shift screen's "Plan today's market" button |
| Item prices + costs come from | `recipes/*` (`packOptions` / `marketPackOptions`, `ingredientCostPerUnit`) |

### `settings/marketPlanner` fields (as of June 2026)

```
boothFee:       number   // flat $ per market (e.g. 26.25)
equipmentCost:  number   // one-time season equipment $ (e.g. 500)
netGoal:        number   // per-market net target (e.g. 200)
seasonMarkets:  number   // markets in the season (e.g. 11)
strong/steady/slow: number   // sell-through scenarios (1.0 / 0.8 / 0.6)
sellingPct:     number   // card + selling cost as a fraction of sold revenue (0.09)
bring:          map<recipeId, number>   // units to bring  ← what the native view reads/writes
// --- present in the doc but NOT used by MarketPlannerView.swift: ---
sampleRate:     number   // 0.1 — intended sample fraction (currently dead)
made:           map<recipeId, number>   // bake target (written by some other surface)
bringPacks:     map<"recipeId#packQty", number>   // older pack-level plan (legacy?)
```

> NOTE: `MarketPlannerView.save()` only writes the native fields
> (`boothFee, equipmentCost, netGoal, seasonMarkets, strong, steady, slow,
> sellingPct, bring, updatedAt`). It uses the Firestore SDK's patch, so it
> should merge — but confirm it does **not** clobber `made` / `bringPacks` /
> `sampleRate` if you extend the save. (External edits to `bring` should use a
> Firestore `updateMask=bring` PATCH to be safe.)

## The exact math (today)

Per product (`MarketPlannerModel.load`, ~lines 38–48):

```
revPerUnit  = average over pack tiers of (pack.price / pack.qty)      // SIMPLE mean of tiers
foodPerUnit = recipe.ingredientCostPerUnit  (fallback: computed from ingredients)
packs       = marketPackOptions if present, else packOptions          // (~lines 88–99)
```

Totals (`MarketPlannerView`, ~lines 129–139):

```
grossRevenue = Σ  bring[id] * revPerUnit[id]
foodCost     = Σ  bring[id] * foodPerUnit[id]        // food charged on EVERYTHING baked
net(sell)    = grossRevenue*sell
             − foodCost
             − grossRevenue*sell*sellingPct
             − boothFee
```

`sell` is the scenario fraction (strong=1.0, steady=0.8, slow=0.6). One global
`sell` is applied to every item.

## What's wrong / what to fix

These are ordered by how much they distort the number. Evidence is the June 13
Market A (the first real market — numbers came in within ~4% of the
plan in aggregate, so the framework is sound; these are refinements).

### 1. `revPerUnit` understates real revenue (biggest distortion)

`revPerUnit` is the **simple average of every pack tier's per-unit price**, so a
swole roll is valued at the flat mean of its single, 3-pack, half-dozen and
dozen per-unit prices — as if customers buy dozens as often as singles. They
don't. On the June market the realized mix was mostly singles and 3-packs, so
the planner **under-valued the best seller by roughly a quarter**, which is why
a healthy plan reads as missing the net goal.

**Fix options (any one helps; combine for best):**
- Weight `revPerUnit` by the **actual historical pack mix** from `marketTickets`
  (group sold items by `recipeId` base + pack, weight price/unit by quantity).
- Failing history, weight toward the **smallest pack** (real behavior) instead
  of a flat mean — small packs dominate at a market table.
- Let the operator pick an "expected mix" per item.

### 2. No sampling model (`sampleRate` is dead)

Several items — cinnie minnies especially — are **partly given away as free
samples** (operator target: 30–40%). The planner assumes you can *sell* 100% of
what you bake on a strong day, so a tray of 100 cinnies reads as 100 sales. In
reality ~35 are samples and can never produce revenue, yet they still incur food
cost. On the June market about half the tray was sampled (not waste —
deliberate traffic-building). The config already has `sampleRate: 0.1` and each
shift records `samplesExpected` (see below), but the native view ignores both.

**Fix:**
- Add a per-item sample fraction (default from `sampleRate`, override per item).
- Cap sellable units: `sellable = bring * (1 − sampleRate_item)`.
- Revenue scenario applies to **sellable**, not to `bring`.
- Show samples as their own small "marketing cost" line (= sampled units ×
  `foodPerUnit`) so the operator sees it's intentional spend, not lost profit.

### 3. Sell-through is global, should be per-item

One `strong/steady/slow` multiplier hits every item, but the items behave very
differently: swole **sold out** (100%), cinnies sold ~50–80% of the *sellable*
portion, cookies only moved ~38% at full price (the rest needed markdowns).

**Fix:** per-item sell-through, ideally seeded from each item's last-market
actuals (sold ÷ (brought − sampled)). Keep the global strong/steady/slow as a
day-quality multiplier on top.

### 4. Markdowns aren't modeled

Slow movers get discounted at end of day (June 13: 30 cookies cleared via
markdown). The planner treats every sale at full `revPerUnit`. Now that the
till records markdowns (`marketTickets.items[].markdownCents`,
`listCentsAtSale`, and a ticket-level `markdownCents`), the planner could assume
a clearance discount on the unsold tail rather than full price or zero.

## Data already available to ground all of this

Real history exists — prefer it over theoretical averages.

**`marketTickets/*`** (one per sale). Item rows now carry:
`recipeId`, `nameAtSale`, `unitCentsAtSale` (actual charged price),
`listCentsAtSale` (regular price), `markdownCents`, `taxIncluded`, `qty`,
`packUnits`, `unitsSold`. Ticket-level: `subtotalCents`, `discountCents`,
`markdownCents`, `taxCents`, `totalCents`, `payment`, `status`
(`paid`/`pending-card`/`voided`), `isTestOnly`, `shiftId`, `createdAt`.

**`marketShifts/*`** (one per market day). Useful for the planner:
`produced` (map recipeId→units made), `producedUnits`, `samplesExpected`
(map recipeId→samples planned), `inventorySold` (map recipeId→units sold),
`topSellers`, `ticketCount`, `cashSalesCents`, `cardSalesCents`, `marketName`,
`startedAt`/`closedAt`.

A good "fix" pulls the most recent N closed shifts and derives, per item:
realized price/unit, realized sell-through of the sellable portion, and the
sample fraction — then uses those as the planner's defaults.

## Heads-up: a richer "recommended mix" layout once existed (not in code now)

The chart the operator shared (columns: **PRODUCT · BATCHES → UNITS ·
RECOMMENDED MIX · REVENUE · PROFIT**) does **not** match the current
`MarketPlannerView` layout (bring-list + strong/steady/slow scenario card +
season card). I grepped the repo (June 2026): there is **no other live planner**
— `settings/marketPlanner` has exactly one consumer (`MarketPlannerView.swift`),
and nothing in `scripts/hq2.js` or elsewhere renders "recommended mix" or a
batches→units table. So that richer view was an **earlier/removed design or a
mockup that never shipped**, not a second surface to reconcile.

Treat it as the **target UX**, not existing code: the operator clearly found the
"X batches → N units · recommended pack mix · projected revenue/profit per item"
presentation useful. Rebuilding that per-item table (with the fixes below baked
in) is the likely north star. The leftover `bringPacks` map in the config
(`"recipeId#packQty" → count`) is a fossil of that pack-aware plan and can seed
the "recommended mix" column.

## Acceptance criteria for the fix

- [ ] `revPerUnit` reflects real pack mix (history-weighted, not flat mean).
- [ ] Sampling is modeled: sampled units cost food but never count as sales;
      shown as a separate marketing line.
- [ ] Sell-through is per-item, seeded from last-market actuals where possible.
- [ ] Net for a "strong" day matches what the operator actually nets (validate
      the plan against the realized gross/net from the June market).
- [ ] No regression to `settings/marketPlanner` (don't drop `made` /
      `bringPacks` / `sampleRate` on save).
- [ ] If a second (web) planner exists, the two agree on the same inputs.
```
