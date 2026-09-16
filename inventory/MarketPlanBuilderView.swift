import SwiftUI

// ============================================================================
//  Market Plan Builder — pick what you'll make for a market, see exactly what
//  it needs and what it costs, then "start" it to pull the ingredients.
//
//  A plan is a SAVED record (marketPlans/{id}), shared 1:1 with the /hq2 web
//  builder, with a lifecycle:
//      draft   — editable: pick items + how many of each you'll make.
//      started — "cooked": the ingredients have been deducted from stock once.
//      closed  — archived.
//
//  Three things the plan rolls up, live as you pick:
//   1. INGREDIENTS NEEDED — every recipe's ingredients added up across the whole
//      plan, matched to the stock catalog, with on-hand vs needed + shortfalls.
//   2. BUILD COST — the raw ingredient $ to make everything (cost basis: each
//      ingredient's costPerUnit / costPerGram). What it costs YOU in ingredients.
//   3. COGS — fully-loaded cost of goods, from the Cost Lab loaded pack costs
//      (recipe.loadedPackCosts), per the locked margin/COGS source-of-truth rule.
//
//  The rollup reuses the SAME explosion the deduction uses (InventoryWriter.pull
//  + Units.convert into the stock unit), so "what you'll need" is exactly "what
//  gets deducted" — never a guess that drifts from reality.
//
//  Deduction is guarded by the plan's `ingredientsDeducted` flag: tapping start
//  twice, or reopening a started plan, never double-pulls. Shortfalls warn but
//  don't block (stock floors at zero, matching the rest of the app).
// ============================================================================

// MARK: - Model

@MainActor @Observable final class MarketPlanModel {
    // A sellable product, from a published recipe with pack pricing. We keep the
    // raw recipe doc so the ingredient explosion (pull) reads the true list.
    // One pack size with its selling price + STRIPE-FREE make cost (per whole pack).
    struct Pack { let qty: Int; let price: Double; let cost: Double }
    struct Product: Identifiable {
        let id: String          // recipeId
        let name: String
        let foodPerUnit: Double // raw ingredient $ for one finished unit
        let pkgPerUnit: Double  // packaging $/unit (from the Cost Lab packCostBreakdown; 0 until backfilled)
        let loadedPerUnit: Double // blended STRIPE-FREE make cost $/unit (makeCostPacks)
        let loadedLow: Double   // cheapest per-unit make cost (e.g. sold as a dozen)
        let loadedHigh: Double  // priciest per-unit make cost (e.g. sold as a single)
        let revPerUnit: Double  // selling price per unit, blended across the recipe's packs
        let packs: [Pack]       // per-pack price + stripe-free cost, for pack-aware forecasting
        let rec: FSDoc          // for InventoryWriter.pull
    }

    // ── History-grounded forecast assumptions (mirrors HQ2 _mhHistoryAssumptions):
    //    realistic sell-through, the tender mix → card-fee rate, and the booth fee,
    //    all pulled from CLOSED market shifts. Defaults apply before any history.
    struct Assumptions {
        var n = 0
        var sellThrough = 0.85; var haveSellThrough = false
        var cardPct = 0.6; var cashPct = 0.4; var venmoPct = 0.0; var tokenPct = 0.0
        var procRate = 0.025; var haveMix = false
        var booth = 26.25
    }
    // Full net-profit forecast for a plan (mirrors HQ2 _mhForecastPnl).
    struct Forecast {
        var made = 0, samplesCount = 0, sellable = 0, sold = 0, leftover = 0
        var revenue = 0.0, cogs = 0.0, margin = 0.0
        // COGS of what sold, split into its parts (sum to cogs) — so the plan's P&L
        // reads like a closed market's: food + packaging + labor/overhead.
        var foodCost = 0.0, pkgCost = 0.0, laborOhCost = 0.0
        var samplesCost = 0.0, wasteCost = 0.0, processing = 0.0, booth = 0.0, net = 0.0
    }
    // One aggregated ingredient line across the whole plan. `needed`/`onHand` are
    // both in the ingredient's own stock unit, so they're directly comparable —
    // and `needed` equals exactly what the deduction will subtract.
    struct NeedLine: Identifiable {
        let id: String          // normalized ingredient key
        let name: String
        let stockUnit: String
        var needed: Double
        var onHand: Double
        var cost: Double        // build cost contribution (raw ingredient $)
        var vendor: String
        var matched: Bool       // found in the stock catalog
        var reviewLines: Int    // pulls that couldn't convert into the stock unit
        var par: Double
        var short: Double { max(0, needed - onHand) }
        var isShort: Bool { matched && needed > onHand + 1e-6 }
        // What the shortfall costs to buy: the ingredient's build cost is for the
        // full `needed` amount, so scale it by the fraction we're short. This is
        // "how much do I need to spend to cover what I don't already have."
        var shortfallCost: Double {
            guard needed > 0, cost > 0 else { return 0 }
            return cost * (short / needed)
        }
    }

    var products: [Product] = []
    var plans: [FSDoc] = []
    var ingredients: [FSDoc] = []
    var packagingDocs: [FSDoc] = []   // /packaging catalog (boxes, stickers…) — read-only here
    // AI auto-components (shared sub-recipes, functions/src/autoComponents.js)
    // — the Week totals view rolls them into a make-ahead batch list. Display
    // only: nothing here deducts or costs anything.
    var autoComponents: [AutoComponent] = []
    // settings/equipmentMap (HQ2-edited): component normalizedName →
    // {equipmentName, batchesPerRound} — the Week totals component rows show
    // "N batches → M mixer rounds of K" when a mapping exists. Display only.
    var equipmentMap: [String: EquipRound] = [:]
    // /equipment catalog: lowercased name → minutesPerUnit (min to produce ONE
    // unit — for a PRINTER, one sheet). Printed packaging items reference a
    // printer by name (printEquipmentName) and inherit its rate; drives print
    // time on packaging rows + the plan TIME roll-up. Display only.
    var equipMinutesPerUnit: [String: Double] = [:]
    var shifts: [FSDoc] = []          // closed market shifts → forecast assumptions
    var tickets: [FSDoc] = []         // past tickets → per-product pack mix
    var cfgBooth = 26.25              // settings/marketPlanner booth-fee fallback
    var cfgGoal = 0.0                 // settings/marketPlanner net-$ goal per market (0 = unset)
    private var _packMix: [String: [Int: Double]]? = nil
    var loaded = false
    // Marketing capture only (DEBUG, --demo-plan / --demo-deduct): the model is
    // seeded in memory and every WRITE below short-circuits, so the screen is
    // fully interactive without a login. Never true in a release build.
    var isDemo = false

    // Re-pull just the plan list from Firestore (after an edit) so the list shows
    // the saved name/items — saveItems only patches the doc, it doesn't touch the
    // in-memory array, so without this the list shows stale values and it LOOKS
    // like the edit didn't save.
    func reloadPlans(token: String?) async {
        if isDemo { return }
        plans = await Self.listPlans(token: token)
        computePlanNets()
    }

    // ❄ Freezer shelf (finishedGoods): available frozen units per recipe.
    // Loaded with the products so the plan can offer "use from freezer".
    var freezer: [String: Freezer.Item] = [:]
    func loadFreezer(token: String?) async {
        if isDemo { return }
        let list = await Freezer.list(token: token)
        freezer = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
    }
    func load(token: String?) async {
        async let recsT = FS.list("recipes", limit: 400, token: token)
        async let ingsT = FS.list("ingredients", limit: 800, token: token)
        async let plansT = Self.listPlans(token: token)
        async let shiftsT = FS.list("marketShifts", limit: 200, token: token)
        async let ticketsT = FS.list("marketTickets", limit: 2000, token: token)
        async let cfgT = FS.get("settings", "marketPlanner", token: token)
        async let pkgT = FS.list("packaging", limit: 300, token: token)
        async let compT = FS.list("autoComponents", limit: 100, token: token)
        async let equipT = FS.get("settings", "equipmentMap", token: token)
        async let equipCatT = FS.list("equipment", limit: 100, token: token)
        let recs = await recsT
        ingredients = await ingsT
        plans = await plansT
        shifts = await shiftsT
        tickets = await ticketsT
        packagingDocs = await pkgT
        autoComponents = (await compT).compactMap(AutoComponent.from)
        equipmentMap = EquipRound.parse(await equipT)
        // Printer rates: lowercased name → minutesPerUnit (min per sheet).
        var mpu: [String: Double] = [:]
        for d in await equipCatT {
            guard let n = d.str("name")?.lowercased().trimmingCharacters(in: .whitespaces), !n.isEmpty,
                  let m = d.dbl("minutesPerUnit"), m > 0 else { continue }
            mpu[n] = m
        }
        equipMinutesPerUnit = mpu
        if let c = await cfgT {
            if let b = c.dbl("boothFee") { cfgBooth = b }
            if let g = c.dbl("netGoal"), g > 0 { cfgGoal = g }
        }
        _packMix = nil
        var ps: [Product] = []
        for r in recs {
            // Market-only items (availableAtMarket) are plannable too — they sell
            // at the booth without being published to the public site.
            if r.bool("published") == false && r.bool("availableAtMarket") != true { continue }
            var packs = Self.packs(of: r)
            // Menu-price fallback: a brand-new recipe priced only via menuPrice
            // (no pack options yet — e.g. brewski) shouldn't silently vanish
            // from the plan. Treat the menu price as a single until real pack
            // options are set in the recipe editor.
            if packs.isEmpty, let mp = r.dbl("menuPrice") ?? r.dbl("price"), mp > 0 {
                packs = [(qty: 1, price: mp, label: "single")]
            }
            guard !packs.isEmpty else { continue }   // sellable in packs only
            let food = r.dbl("ingredientCostPerUnit")
                ?? (Double(FrontModel.recipeIngredientCostCents(r, ings: ingredients)) / 100)
            // COGS basis: average the Cost-Lab loaded per-unit across the packs
            // (a dozen costs less per unit than a single), then fall back to the
            // recipe's stored loaded-per-unit, then to food cost. Mirrors the
            // Market Planner's `loaded` so the two screens never disagree.
            // Prefer the STRIPE-FREE make cost (makeCostPacks), same basis as the
            // finished-market COGS — so a separate card-fee line in the forecast
            // doesn't double-count processing. loadedPackCosts is the fallback.
            let pm = r.map("makeCostPacks") ?? r.map("loadedPackCosts")
            let fallback = r.dbl("loadedCostPerUnit") ?? food
            // Per-unit make cost for EACH pack the recipe sells in (cost ÷ pack
            // size). The cheapest is the best case (a dozen), the priciest the
            // worst (a single); the average is the midpoint we show by default.
            var perUnit: [Double] = []
            var packList: [Pack] = []
            for pk in packs.sorted(by: { $0.qty < $1.qty }) {
                let perPack = pm.flatMap { FS.dbl($0[String(pk.qty)]) }
                if let pp = perPack, pp > 0 { perUnit.append(pp / Double(max(1, pk.qty))) }
                let costPerPack = (perPack ?? 0) > 0 ? (perPack ?? 0) : fallback * Double(pk.qty)
                packList.append(Pack(qty: pk.qty, price: pk.price, cost: costPerPack))
            }
            let loadedU = perUnit.isEmpty ? fallback : perUnit.reduce(0, +) / Double(perUnit.count)
            let lo = perUnit.min() ?? fallback
            let hi = perUnit.max() ?? fallback
            let rev = packs.map { $0.price / Double(max(1, $0.qty)) }.reduce(0, +) / Double(max(1, packs.count))
            // Packaging $/unit ESTIMATE from the Cost-Lab packCostBreakdown
            // (packaging ÷ pack size, averaged across packs). This flat estimate
            // is what's baked into makeCostPacks; the rollup SWAPS it out for the
            // real linked-packaging cost so the plan's P&L reflects the actual
            // containers + stickers (same math as the packaging section).
            // NOTE: packCostBreakdown["6"] is a nested map — its value is still a
            // raw Firestore REST wrapper, so it MUST be unwrapped with FS.map. The
            // old bare `as? [String:Any]` cast reached one level too shallow and
            // always found nil, silently zeroing the plan's packaging line.
            let bd = r.map("packCostBreakdown")
            var pkgPer: [Double] = []
            for pk in packs {
                if let comp = FS.map(bd?[String(pk.qty)]), let pg = FS.dbl(comp["packaging"]), pk.qty > 0 {
                    pkgPer.append(pg / Double(pk.qty))
                }
            }
            let pkgU = pkgPer.isEmpty ? 0 : pkgPer.reduce(0, +) / Double(pkgPer.count)
            ps.append(Product(id: r.id, name: r.str("name") ?? "item",
                              foodPerUnit: food, pkgPerUnit: pkgU, loadedPerUnit: loadedU,
                              loadedLow: lo, loadedHigh: hi, revPerUnit: rev, packs: packList, rec: r))
        }
        products = ps.sorted { $0.name.lowercased() < $1.name.lowercased() }
        await loadFreezer(token: token)
        computePlanNets()
        loaded = true
    }

    func product(_ id: String) -> Product? { products.first { $0.id == id } }

    // Pack pricing → [(qty, price, label)]. Market packs override normal packs.
    // (Moved here from the retired Market Planner / Forecast screen — this was
    // the one helper the two screens shared.)
    static func packs(of r: FSDoc) -> [(qty: Int, price: Double, label: String)] {
        func tuples(_ arr: [[String: Any]]) -> [(Int, Double, String)] {
            arr.compactMap { p in
                let price = FS.dbl(p["price"]) ?? 0
                guard price > 0 else { return nil }
                let qty = max(1, FS.int(p["qty"]) ?? 1)
                let lbl = (p["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (qty == 1 ? "single" : "\(qty)-pack")
                return (qty, price, lbl)
            }
        }
        let mk = tuples(r.mapArr("marketPackOptions"))
        let arr = mk.isEmpty ? tuples(r.mapArr("packOptions")) : mk
        return arr.map { (qty: $0.0, price: $0.1, label: $0.2) }
    }

    // ── AI component batches (SHARED — week totals + single plan) ─────────────
    // One row per auto-detected shared sub-recipe a set of plans builds. This is
    // the ONE place the batch math lives so the single-plan editor and the week
    // view never drift. The week view passes each selected plan's items map; the
    // single-plan editor passes just its own [items].
    struct ComponentRow: Identifiable {
        let id: String; let name: String; let batches: Int
        let prepAhead: Bool; let holdDays: Int?; let memberNames: [String]
        // DOUGH WEIGHT: per-batch grams (extractor batchWeightG; nil on old
        // docs), the "≈/~" prefix, and the per-member weigh-out lines.
        let weightG: Double?; let weightPrefix: String; let weighOuts: [WeighOut]
        // EQUIPMENT ROUNDS: "18 batches → 5 mixer rounds of 4" when
        // settings/equipmentMap maps this component; nil otherwise.
        let rounds: String?
        // MAKE TIME: batches × the mapped equipment's minutesPerBatch — summed
        // into the plan TIME roll-up. 0 when the component has no timed equipment.
        var makeMinutes: Double = 0
    }
    // One member SKU's weigh-out facts: name, this scope's quantity, grams per
    // finished piece, and the per-SKU TOTAL (qty × per-piece). qty 0 → the card
    // has no quantity context, so the total is omitted and only per-piece shows.
    struct WeighOut: Identifiable {
        let id: String; let name: String; let qty: Int
        let perPieceG: Double; let skuTotalG: Double
        // "<sku> ×<qty> · ≈<per-piece> g/piece · ≈<per-sku-total>" — three facts
        // on one line. Per-piece = whole grams (fmtGrams); per-SKU total = whole
        // grams <1000 g else kg 1-decimal (fmtQty), matching the "week ≈X kg"
        // headline. qty 0 (no quantity context) → omit ×qty + total, per-piece only.
        func line(prefix: String) -> String {
            let head = qty > 0 ? "\(name) ×\(qty)" : name
            let perPiece = "\(prefix)\(fmtGrams(perPieceG))/piece"
            let total = qty > 0 ? " · \(prefix)\(fmtQty(skuTotalG, "g"))" : ""
            return "\(head) · \(perPiece)\(total)"
        }
    }
    // BATCHES: computed PER PLAN first (sum members' fractional batches within
    // the plan, ceil once), THEN summed across plans. Why per-plan: each plan is
    // its own cook day — Saturday's part-used bowl of dough doesn't roll into
    // Sunday's build (freshness + plans cook/deduct independently), so rounding
    // up inside each day matches what the kitchen physically makes. Ceiling the
    // WEEK once would under-count by hiding the per-day remainders. For a SINGLE
    // plan there's just one entry in perPlanItems, so this collapses to a plain
    // per-plan ceil. Membership is judged across the COMBINED items: a component
    // surfaces when ≥2 of its member recipes appear anywhere in the given plans;
    // otherwise there's nothing shared to consolidate.
    func components(perPlanItems: [[String: Int]]) -> [ComponentRow] {
        guard !autoComponents.isEmpty, !perPlanItems.isEmpty else { return [] }
        var combinedItems: [String: Int] = [:]
        for items in perPlanItems { for (k, v) in items { combinedItems[k, default: 0] += v } }
        var out: [ComponentRow] = []
        for c in autoComponents {
            let members = c.members.filter { (combinedItems[$0.recipeId] ?? 0) > 0 }
            guard members.count >= 2 else { continue }   // hide: nothing shared to consolidate
            var total = 0
            for items in perPlanItems {
                let raw = c.members.reduce(0.0) { acc, m in
                    acc + Double(items[m.recipeId] ?? 0) / m.unitsPerRecipeBatch
                        * m.componentBatchesPerRecipeBatch
                }
                if raw > 0 { total += max(1, Int(raw.rounded(.up))) }
            }
            guard total > 0 else { continue }
            // PER-PIECE weigh-outs: how much of this component goes into one
            // finished unit of each member SKU. These DIFFER per SKU (a minnie
            // and a swole both use dough but scoop very different amounts),
            // unlike the old per-batch rows which were identical for every
            // member (componentBatchesPerRecipeBatch=1 across the board).
            //   g/piece = batchWeightG × componentBatchesPerRecipeBatch / unitsPerRecipeBatch
            // PER-SKU TOTAL: (units of that SKU in this scope) × g/piece — breaks
            // the "week ≈X kg" headline down by SKU. combinedItems already sums
            // units across the plans passed in (single plan → its count; week →
            // summed across selected plans).
            let weighOuts: [WeighOut] = (c.batchWeightG ?? 0) > 0
                ? members.compactMap { m in
                    guard m.unitsPerRecipeBatch > 0 else { return nil }
                    let perPiece = (c.batchWeightG ?? 0) * m.componentBatchesPerRecipeBatch / m.unitsPerRecipeBatch
                    let qty = combinedItems[m.recipeId] ?? 0
                    return WeighOut(id: m.recipeId, name: m.recipeName.lowercased(),
                                    qty: qty, perPieceG: perPiece,
                                    skuTotalG: qty > 0 ? Double(qty) * perPiece : 0)
                }
                : []
            let eq = EquipRound.lookup(equipmentMap, c)
            let makeMin = (eq?.minutesPerBatch ?? 0) > 0 ? Double(total) * (eq?.minutesPerBatch ?? 0) : 0
            out.append(ComponentRow(id: c.id, name: c.name, batches: total,
                                    prepAhead: c.prepAhead, holdDays: c.holdDays,
                                    memberNames: members.map(\.recipeName),
                                    weightG: c.batchWeightG, weightPrefix: c.weightPrefix,
                                    weighOuts: weighOuts,
                                    rounds: eq?.label(batches: total),
                                    makeMinutes: makeMin))
        }
        return out.sorted { $0.batches != $1.batches ? $0.batches > $1.batches : $0.name < $1.name }
    }

    // A plan a market shift has USED (consumedByShiftId set) is history — its
    // numbers should read in past tense, and where the shift has real figures
    // those replace the stale projection.
    static func isUsed(_ p: FSDoc) -> Bool { !((p.str("consumedByShiftId") ?? "").isEmpty) }

    // ACTUAL net (cents) for the shift that ran a plan — the same formula the
    // Past Shifts P&L uses: (ex-tax revenue − COGS of what sold) − samples −
    // waste − coin-reward giveaways − card fees − booth. Only answers once the
    // shift's cost side is frozen (pnlFrozen, written at close), so we never
    // show a half-real number.
    //
    // Deliberately built out of ShiftPnL rather than re-typed, because a
    // re-typed copy drifted: this screen went on subtracting stall rent for
    // five days after the till stopped (PRs #5198/#5202, Jul 31 2026), and had
    // never subtracted the coin-reward line at all. So a finished plan read
    // ~$35–50 poorer than the very same market day on the close screen and in
    // HQ2's Market Review. Twin of `_mhShiftStats`'s `net` (scripts/hq2.js) —
    // all three move together.
    static func actualNetCents(_ s: FSDoc) -> Int? {
        guard let fz = s.map("pnlFrozen"), let cogs = FS.int(fz["cogsCents"]) else { return nil }
        let p = FrontModel.ShiftPnL(
            revenueCents: FrontModel.shiftSalesCents(s) - (s.int("taxCollectedCents") ?? 0),
            cogsSoldCents: cogs,
            foodCents: FS.int(fz["foodCents"]) ?? 0,
            pkgCents: FS.int(fz["pkgCents"]) ?? 0,
            pkgActual: FS.bool(fz["pkgActual"]) ?? false,
            ohCents: FS.int(fz["ohCents"]) ?? 0,
            samplesCents: FS.int(fz["samplesCents"]) ?? 0,
            samplesCount: FS.int(fz["samplesCount"]) ?? 0,
            wasteCents: FS.int(fz["wasteCents"]) ?? 0,
            wasteCount: FS.int(fz["wasteCount"]) ?? 0,
            rewardsCents: FS.int(fz["rewardsCents"]) ?? 0,
            rewardsCount: FS.int(fz["rewardsCount"]) ?? 0,
            processingCents: FrontModel.processingCents(s),
            feeActual: FrontModel.feeIsActual(s))
        // A TILL NEVER CHARGES STALL RENT — `boothChargedCents` is always 0 and
        // exists so this stays greppable. The day's rent is still RECORDED on
        // the shift; it's settled in /expenses, where the money actually moved.
        return p.netCents(boothCents: FrontModel.boothChargedCents(s))
    }

    // Pre-compute each plan's glance net ONCE (the list row), so the plan list
    // doesn't run an ingredient-explosion rollup per row on every render — e.g.
    // while typing a new plan's name. Refreshed on load + when plans change.
    // For a USED plan (a shift consumed it) the glance is the shift's ACTUAL
    // net when its books are frozen; otherwise the projection, labeled planned.
    struct PlanNet { let net: Double; let actual: Bool }
    var planNets: [String: PlanNet] = [:]
    func computePlanNets() {
        let hist = assumptions()
        var out: [String: PlanNet] = [:]
        for p in plans {
            if Self.isUsed(p) {
                if let s = shifts.first(where: { $0.id == p.str("consumedByShiftId") }),
                   let net = Self.actualNetCents(s) {
                    out[p.id] = PlanNet(net: Double(net) / 100, actual: true)
                    continue
                }
                // Used but not frozen yet (market still open / old unfrozen
                // shift): fall through to the projection — the row labels it
                // "planned", not "expected".
            }
            guard (p.str("status") ?? "draft") != "closed" else { continue }
            var itemsMap: [String: Int] = [:]
            for (k, v) in (p.map("items") ?? [:]) { if let n = FS.int(v), n > 0 { itemsMap[k] = n } }
            guard !itemsMap.isEmpty else { continue }
            // Hand-set pack mixes merged over the sales-history suggestions —
            // the same pack basis the editor computes with.
            let r = rollup(items: itemsMap, packMix: effectiveMix(items: itemsMap, manual: Self.planPackMix(p)),
                           fromFreezer: Self.planFromFreezer(p))
            if r.revenue > 0 {
                out[p.id] = PlanNet(net: forecast(r, sampleFrac: (p.dbl("samplePct") ?? 0) / 100, hist: hist, sellThrough: hist.sellThrough).net, actual: false)
            }
        }
        planNets = out
    }

    // List plans newest-first WITHOUT a server orderBy (some Firestore projects
    // don't keep a single-field index on every collection, which makes an
    // orderBy'd list silently return nothing); sort client-side instead.
    static func listPlans(token: String?) async -> [FSDoc] {
        let all = await FS.list("marketPlans", limit: 200, token: token)
        return all.sorted { ($0.date("updatedAt") ?? .distantPast) > ($1.date("updatedAt") ?? .distantPast) }
    }

    // ── The rollup ────────────────────────────────────────────────────────
    // Aggregate every picked item's ingredient pull into one list, converting
    // each line into the matched ingredient's stock unit (exactly as the
    // deduction does). Cross-family lines that can't convert are counted as
    // "review" rather than guessed.
    struct Rollup {
        var lines: [NeedLine]
        var buildCost: Double      // Σ raw ingredient $ (from the ingredient explosion)
        var foodComp: Double       // Σ units × foodPerUnit — the food slice of COGS (Cost-Lab basis)
        var pkgComp: Double        // Σ units × pkgPerUnit — the packaging slice of COGS
        var cogs: Double           // Σ units × Cost-Lab loaded per-unit (midpoint/avg)
        var cogsLow: Double        // best case — everything sold in the cheapest pack
        var cogsHigh: Double       // worst case — everything sold as singles
        var revenue: Double        // Σ units × selling price (if it all sells)
        var unitsTotal: Int
        var shortCount: Int
        var shortfallCost: Double  // Σ cost of only the amounts we're short — the buy list total
        var untrackedCount: Int    // ingredients not in the stock catalog
        var reviewCount: Int       // lines with a unit we couldn't reconcile
    }
    func rollup(items: [String: Int], packMix pmm: [String: [Int: Int]] = [:],
                fromFreezer ff: [String: Int] = [:]) -> Rollup {
        var byKey: [String: NeedLine] = [:]
        var order: [String] = []
        var build = 0.0, foodC = 0.0, pkgC = 0.0, cogs = 0.0, cogsLo = 0.0, cogsHi = 0.0, rev = 0.0, units = 0
        for (rid, qty) in items where qty > 0 {
            guard let p = product(rid) else { continue }
            units += qty
            // ❄ Units pulled from the freezer: they still SELL (revenue on the
            // full qty) but consume NO new ingredients and cost their original
            // make-cost BASIS instead of today's make cost (Omar, Jul 16 —
            // honest margins, zero new cash-out).
            let frozenN = min(max(0, ff[rid] ?? 0), qty)
            let freshQty = qty - frozenN
            // Pack-aware revenue + COGS (manual override → history pack mix → blended).
            let fc = itemForecast(p, units: qty, override: pmm[rid])
            cogs += fc.cogs
            if frozenN > 0 {
                let basis = Double(freezer[rid]?.basisCents ?? 0) / 100
                cogs += Double(frozenN) * (basis - p.loadedPerUnit)   // swap make→basis for frozen units
                cogsLo += Double(frozenN) * (basis - p.loadedLow)
                cogsHi += Double(frozenN) * (basis - p.loadedHigh)
            }
            rev += fc.revenue
            foodC += Double(qty) * p.foodPerUnit       // food slice of COGS (Cost-Lab basis)
            pkgC += Double(qty) * p.pkgPerUnit         // packaging slice of COGS
            cogsLo += Double(qty) * p.loadedLow
            cogsHi += Double(qty) * p.loadedHigh
            for pull in InventoryWriter.pull(from: p.rec, qty: freshQty) where freshQty > 0 {
                let nm = pull.name.trimmingCharacters(in: .whitespaces)
                guard !nm.isEmpty, pull.qty > 0 else { continue }
                let ing = FrontModel.matchIng(nm, ingredients)
                // Key by the matched catalog ingredient so the SAME ingredient
                // referenced with different recipe wording ("Eggs, Large" vs
                // "large eggs") rolls into ONE line. Fall back to the name only
                // when it isn't in the stock catalog.
                let key = ing?.id ?? nm.lowercased()
                if byKey[key] == nil {
                    order.append(key)
                    let stockUnit = (ing?.str("unit") ?? "").trimmingCharacters(in: .whitespaces)
                    byKey[key] = NeedLine(id: key, name: ing?.str("name") ?? nm,
                                          stockUnit: stockUnit, needed: 0,
                                          onHand: ing?.dbl("currentQty") ?? 0, cost: 0,
                                          vendor: (ing?.str("vendor") ?? "").trimmingCharacters(in: .whitespaces),
                                          matched: ing != nil, reviewLines: 0,
                                          par: ing?.dbl("par") ?? 0)
                }
                if let ing {
                    let cost = FrontModel.costOfPull(pull, ing: ing)
                    byKey[key]?.cost += cost
                    build += cost
                    if let amt = InventoryWriter.stockAmount(pull.qty, from: pull.unit, ing: ing) {
                        byKey[key]?.needed += amt
                    } else {
                        byKey[key]?.reviewLines += 1
                    }
                } else {
                    byKey[key]?.reviewLines += 1   // untracked: can't cost or deduct
                }
            }
        }
        // REAL packaging cost: swap the flat Cost-Lab estimate (pkgC, which is
        // baked into makeCostPacks/COGS) for the actual linked containers +
        // sticker sheets, priced from the /packaging catalog — the SAME math the
        // plan's packaging section uses, so the two never disagree. Adjust COGS
        // by the difference so the packaging line reflects the real materials and
        // the net honestly absorbs them (food + labor/overhead stay unchanged;
        // the three slices still sum back to the adjusted COGS).
        var freshItems = items
        for (rid, n) in ff { freshItems[rid] = max(0, (items[rid] ?? 0) - max(0, n)) }
        let realPkg = packagingRollup(items: freshItems, packMix: pmm).totalCost
        let pkgDelta = realPkg - pkgC
        cogs += pkgDelta; cogsLo += pkgDelta; cogsHi += pkgDelta
        pkgC = realPkg
        let lines = order.compactMap { byKey[$0] }.sorted { ($0.cost, $0.needed) > ($1.cost, $1.needed) }
        return Rollup(lines: lines, buildCost: build, foodComp: foodC, pkgComp: pkgC, cogs: cogs, cogsLow: cogsLo, cogsHigh: cogsHi,
                      revenue: rev, unitsTotal: units,
                      shortCount: lines.filter { $0.isShort }.count,
                      shortfallCost: lines.reduce(0) { $0 + $1.shortfallCost },
                      untrackedCount: lines.filter { !$0.matched }.count,
                      reviewCount: lines.filter { $0.matched && $0.reviewLines > 0 }.count)
    }

    // ── The PACKAGING rollup ─────────────────────────────────────────────────
    // Parallel to the ingredient rollup: add up every picked item's packaging
    // needs (boxes, stickers, containers) in PIECES, matched to the /packaging
    // catalog, with on-hand vs needed and what to BUY in purchase units. Read-
    // only — packaging stock is never deducted here.
    //
    // One aggregated packaging line. Needs/on-hand are in PIECES (one box, one
    // sticker) so they compare directly; buying happens in the PURCHASE unit (a
    // sheet that prints 12 stickers), hence the separate whole-unit buy fields.
    struct PkgLine: Identifiable {
        let id: String           // packaging doc id, or normalized name if unmatched
        let name: String
        let pieceName: String    // what one piece is called ("sticker"); "pc" default
        let unitName: String     // the PURCHASE unit ("sheet", "roll", "ea")
        let yieldPerUnit: Double // usable pieces per purchase unit (≥ 1)
        let costPerPiece: Double // catalog costPerUnit — already per PIECE
        var neededPieces: Double
        var onHandPieces: Double // stock (purchase units) × yieldPerUnit
        var matched: Bool        // found in the packaging catalog
        // PRINT TIME: minutes to print ONE purchase unit (one sheet), inherited
        // from the linked printer (printEquipmentName → equipment minutesPerUnit).
        // 0 when not a printed item. printMinutes = neededUnits × this rate.
        var printMinutesPerUnit: Double = 0
        var printMinutes: Double { printMinutesPerUnit > 0 ? Double(neededUnits) * printMinutesPerUnit : 0 }
        var shortPieces: Double { max(0, neededPieces - onHandPieces) }
        var isShort: Bool { matched && neededPieces > onHandPieces + 1e-6 }
        // You buy whole sheets/rolls, not pieces — round the shortfall up.
        var buyUnits: Double { (shortPieces / yieldPerUnit).rounded(.up) }
        // Sheets-first display (Omar, Jul 3 2026): for multi-piece purchase units
        // ("12 stickers per sheet") the useful number is PAGES, not stickers —
        // lead with purchase units, pieces become the footnote.
        var multiPiece: Bool { yieldPerUnit > 1.001 }
        var neededUnits: Int { Int((neededPieces / yieldPerUnit).rounded(.up)) }
        var onHandUnits: Int { Int(onHandPieces / yieldPerUnit) }
        func unitsLabel(_ n: Int) -> String { "\(n) \(unitName)\(n == 1 ? "" : "s")" }
        var buyCost: Double { buyUnits * yieldPerUnit * costPerPiece }
        var neededCost: Double { neededPieces * costPerPiece }
    }
    // ── PACKAGING BY SKU (Omar, Jul 2026) ────────────────────────────────
    // The same demand the rollup sums, retained per member recipe — so the
    // packaging card can expand into "swole rolls: 5\" hinged ×50 · sticker
    // sheets ~4 · …". Display only; the aggregate lines stay authoritative.
    struct PkgSkuLine: Identifiable {
        let id: String           // packaging line key (same key space as PkgLine)
        let name: String
        let pieceName: String
        let unitName: String
        let yieldPerUnit: Double
        var neededPieces: Double
        var multiPiece: Bool { yieldPerUnit > 1.001 }
        // Sheets-first: multi-piece materials read in purchase units ("~4 sheets").
        var neededUnits: Int { Int((neededPieces / yieldPerUnit).rounded(.up)) }
        var display: String {
            multiPiece
                ? "~\(neededUnits) \(unitName)\(neededUnits == 1 ? "" : "s")"
                : "×\(Int(neededPieces.rounded(.up)))"
        }
    }
    struct PkgSku: Identifiable {
        let id: String           // recipeId
        let name: String
        var lines: [PkgSkuLine]
    }
    struct PkgRollup {
        var lines: [PkgLine]
        var totalCost: Double    // Σ needed pieces × per-piece cost — the plan's packaging $
        var buyCost: Double      // Σ shortfall buys (whole purchase units) — the buy-list total
        var shortCount: Int
        var unmatchedCount: Int  // entries not in the packaging catalog
        var bySku: [PkgSku] = [] // per-recipe breakdown of the same demand
    }
    // How each recipe entry's `per` is charged:
    //   "pack"  — once per PACK sold (a half-dozen box, its sticker): counts the
    //             manual pack mix; units not hand-packed count as single-unit packs.
    //   "unit"  — per single sellable unit (a container per meal).
    //   "batch" / missing — legacy: once per batch, where a batch makes
    //             recipeYield × unitsPerYield units (same convention as pull()).
    func packagingRollup(items: [String: Int], packMix pmm: [String: [Int: Int]] = [:]) -> PkgRollup {
        // Catalog lookups: by doc id first, then by normalized name.
        var byId: [String: FSDoc] = [:]
        var byName: [String: FSDoc] = [:]
        for d in packagingDocs {
            byId[d.id] = d
            if let n = d.str("name")?.lowercased().trimmingCharacters(in: .whitespaces), !n.isEmpty { byName[n] = d }
        }
        var byKey: [String: PkgLine] = [:]
        var order: [String] = []
        // Per-SKU retention of the same demand (display-only "by SKU" section).
        var skuOrder: [String] = []
        var skuNames: [String: String] = [:]
        var skuTally: [String: [String: Double]] = [:]      // rid → pkg key → pieces
        var skuLineOrder: [String: [String]] = [:]
        for (rid, qty) in items where qty > 0 {
            guard let p = product(rid) else { continue }
            var entries = p.rec.mapArr("packaging")
            if entries.isEmpty { entries = p.rec.mapArr("linkedPackaging") }
            guard !entries.isEmpty else { continue }
            // Packs for this item BY SIZE: the hand-set mix, plus one single-unit
            // "pack" for every unit it doesn't cover. No mix at all → each unit
            // is its own single (the conservative box count). Kept per-size so a
            // material restricted to certain pack sizes (the single's small box
            // vs the 3-pack's big box) counts only its own packs.
            var packsBySize: [Int: Int] = [:]
            if let mix = pmm[rid], !mix.isEmpty {
                for (size, count) in mix where size > 0 && count > 0 { packsBySize[size, default: 0] += count }
                let covered = mix.reduce(0) { $0 + $1.key * $1.value }
                if qty > covered { packsBySize[1, default: 0] += qty - covered }
            } else {
                packsBySize[1] = qty
            }
            let totalPacks = packsBySize.values.reduce(0, +)
            let yieldN = max(1, InventoryWriter.num(p.rec, "recipeYield") ?? 1)
            let upyN   = max(1, InventoryWriter.num(p.rec, "unitsPerYield") ?? 1)
            let batchUnits = max(1, yieldN * upyN)
            // itemsPerContainer — per-"unit" packaging on a several-to-a-box
            // meal is charged once per BOX, so unit-scoped pieces scale by
            // box count (ceil(unitsFor / ipc)). ipc defaults to 1 → no-op.
            let ipc = max(1, InventoryWriter.num(p.rec, "itemsPerContainer") ?? 1)
            for e in entries {
                let pid = (FS.str(e["packagingId"]) ?? "").trimmingCharacters(in: .whitespaces)
                let nm = (FS.str(e["name"]) ?? "").trimmingCharacters(in: .whitespaces)
                let perQty = FS.dbl(e["qty"]) ?? FS.dbl(e["quantity"]) ?? 0
                guard perQty > 0, !(pid.isEmpty && nm.isEmpty) else { continue }
                // Optional pack-size restriction — empty means every size.
                // NOTE: `e` comes from mapArr, so every field is still a RAW
                // Firestore REST wrapper — the sizes array is
                // {"arrayValue":{"values":[{"integerValue":"6"}]}} and must be
                // unwrapped with FS.arr + FS.dbl. The old bare `as? [Any]` cast
                // always failed, silently turning every size-scoped material
                // into an every-size material (the 81/181/191 rollup bug).
                let sizes = Set((FS.arr(e["sizes"]) ?? []).compactMap { FS.dbl($0) }.map { Int($0) }.filter { $0 > 0 })
                let packsFor = sizes.isEmpty ? totalPacks
                    : packsBySize.reduce(0) { $0 + (sizes.contains($1.key) ? $1.value : 0) }
                let unitsFor = sizes.isEmpty ? qty
                    : packsBySize.reduce(0) { $0 + (sizes.contains($1.key) ? $1.key * $1.value : 0) }
                let need: Double = switch (FS.str(e["per"]) ?? "").lowercased() {
                    case "pack": perQty * Double(packsFor)
                    case "unit": perQty * (Double(unitsFor) / ipc).rounded(.up)
                    default:     perQty * (Double(qty) / batchUnits).rounded(.up)  // legacy: per batch
                }
                guard need > 0 else { continue }
                let doc = byId[pid] ?? byName[nm.lowercased()]
                // Key by the matched catalog doc so the same box referenced with
                // different wording rolls into ONE line (as the ingredient rollup does).
                let key = doc?.id ?? nm.lowercased()
                if byKey[key] == nil {
                    order.append(key)
                    let yld = max(1, doc?.dbl("yieldPerUnit") ?? 1)
                    // Two HQ2 forms write different stock field names — read whichever is present.
                    let stock = doc?.dbl("currentQty") ?? doc?.dbl("currentStock") ?? doc?.dbl("qty") ?? 0
                    let piece = (doc?.str("pieceName") ?? "").trimmingCharacters(in: .whitespaces)
                    let unit = (doc?.str("unit") ?? "").trimmingCharacters(in: .whitespaces)
                    // Printed sheet? Look up the linked printer's per-sheet minutes.
                    let printerName = (doc?.str("printEquipmentName") ?? "").lowercased().trimmingCharacters(in: .whitespaces)
                    let printMpu = printerName.isEmpty ? 0 : (equipMinutesPerUnit[printerName] ?? 0)
                    byKey[key] = PkgLine(id: key,
                                         name: doc?.str("name") ?? (nm.isEmpty ? "packaging" : nm),
                                         pieceName: piece.isEmpty ? "pc" : piece,
                                         unitName: unit.isEmpty ? "unit" : unit,
                                         yieldPerUnit: yld,
                                         costPerPiece: doc?.dbl("costPerUnit") ?? 0,
                                         neededPieces: 0, onHandPieces: stock * yld,
                                         matched: doc != nil,
                                         printMinutesPerUnit: printMpu)
                }
                byKey[key]?.neededPieces += need
                // per-SKU tally (same key space as the aggregate lines)
                if skuTally[rid] == nil { skuOrder.append(rid); skuNames[rid] = p.name }
                if skuTally[rid]?[key] == nil { skuLineOrder[rid, default: []].append(key) }
                skuTally[rid, default: [:]][key, default: 0] += need
            }
        }
        let lines = order.compactMap { byKey[$0] }.sorted { ($0.neededCost, $0.neededPieces) > ($1.neededCost, $1.neededPieces) }
        let bySku: [PkgSku] = skuOrder.map { rid in
            let lines: [PkgSkuLine] = (skuLineOrder[rid] ?? []).compactMap { k in
                guard let base = byKey[k], let pieces = skuTally[rid]?[k], pieces > 0 else { return nil }
                return PkgSkuLine(id: k, name: base.name, pieceName: base.pieceName,
                                  unitName: base.unitName, yieldPerUnit: base.yieldPerUnit,
                                  neededPieces: pieces)
            }.sorted { $0.neededPieces > $1.neededPieces }
            return PkgSku(id: rid, name: skuNames[rid] ?? rid, lines: lines)
        }
        return PkgRollup(lines: lines,
                         totalCost: lines.reduce(0) { $0 + $1.neededCost },
                         buyCost: lines.reduce(0) { $0 + $1.buyCost },
                         shortCount: lines.filter { $0.isShort }.count,
                         unmatchedCount: lines.filter { !$0.matched }.count,
                         bySku: bySku)
    }

    // ── TIME roll-up (display only; nothing scheduled/deducted) ──────────────
    // Sums the three wall-clock pieces we have data for:
    //   make  — Σ component makeMinutes (batches × minutesPerBatch)
    //   cook  — Σ recipe cook minutes  (rounds × minutesPerRound)
    //   print — Σ printed pkg lines    (neededSheets × printer minutesPerUnit)
    // Callers pass the component rows + a recipeId→units map + the matching
    // packaging rollup for the scope (plan or week). total = the sum of what
    // exists; a piece with no data stays 0.
    struct TimeRollup { var make = 0.0; var cook = 0.0; var print = 0.0
        var total: Double { make + cook + print }
        var hasAny: Bool { total > 0 } }
    func timeRollup(components: [ComponentRow], units: [String: Int], packaging: PkgRollup?) -> TimeRollup {
        var t = TimeRollup()
        t.make = components.reduce(0) { $0 + $1.makeMinutes }
        for (rid, u) in units where u > 0 {
            if let re = RecipeEquip.parse(product(rid)?.rec) { t.cook += re.cookMinutes(units: u) }
        }
        t.print = (packaging?.lines ?? []).reduce(0) { $0 + $1.printMinutes }
        return t
    }

    // ── Per-market-series demand history (Omar, Jul 16) ──────────────────────
    // Shifts group into a "series" by their (trimmed, case-insensitive) market
    // name — Market A vs Market C vs Market B. No manual tagging:
    // the names already carry the series. A sellout is CENSORED demand (you
    // can't observe demand above what you brought), so sellouts push the
    // suggestion UP instead of anchoring to the sold number.
    struct SeriesItemStat {
        var name: String
        var avgSold: Double
        var avgMade: Double
        var avgMarkedDown: Double   // avg units/day that only moved at a price cut
        var avgSampled: Double      // avg units/day sampled here — DISPLAY ONLY
        var sellouts: Int
        var appearances: Int
        // The sell target: FULL-PRICE-equivalent sales. Samples are
        // deliberately NOT added here (Omar, Jul 16: "let the sample % at
        // the P&L line do that work") — the plan's own sample-% field owns
        // the giveaway allowance. Samples still count on the SELLABLE side
        // (made − sampled) so heavy sampling can't fake a demand sellout.
        var suggested: Int
    }
    struct SeriesStats {
        var label: String
        var shiftCount: Int
        var avgUnitsSold: Double
        var sellThrough: Double     // 0…1 across the series
        var items: [String: SeriesItemStat]   // by recipeId
    }
    var seriesLabels: [String] {
        var seen = Set<String>(); var out: [String] = []
        for s in shifts where s.str("status") == "closed" {
            let nm = (s.str("marketName") ?? "").trimmingCharacters(in: .whitespaces)
            guard !nm.isEmpty else { continue }
            if seen.insert(nm.lowercased()).inserted { out.append(nm) }
        }
        return out.sorted()
    }
    func seriesStats(label: String) -> SeriesStats? {
        let key = label.trimmingCharacters(in: .whitespaces).lowercased()
        guard !key.isEmpty else { return nil }
        let ss = shifts.filter {
            $0.str("status") == "closed" &&
            ($0.str("marketName") ?? "").trimmingCharacters(in: .whitespaces).lowercased() == key
        }
        guard !ss.isEmpty else { return nil }
        var madeSum: [String: Double] = [:], soldSum: [String: Double] = [:], sampSum: [String: Double] = [:]
        var appear: [String: Int] = [:], sellouts: [String: Int] = [:]
        var names: [String: String] = [:]
        var totSold = 0.0, totSellable = 0.0
        // Sold lines tag the recipe id with a pack size ("rid::4") or a
        // build-a-box slot ("rid::box2") — strip to the BASE recipe so a
        // 4-pack, a box slot and a single all count as the same product.
        // (Custom "$X" lines have no recipeId and stay excluded.)
        func baseRid(_ rid: String) -> String { rid.components(separatedBy: "::").first ?? rid }
        // Untagged "Custom $X" rings carry a one-off timestamp id
        // ("custom-1781…") — each is a unique fake item that sold 1 and was
        // never brought. They can't inform a plan (tag them with linkedItems
        // at the till and they attribute to the REAL recipe instead), so they
        // stay out of the panel and out of the sell-through math.
        func isCustom(_ rid: String) -> Bool { rid.hasPrefix("custom") }
        for s in ss {
            var madeBy: [String: Double] = [:], soldBy: [String: Double] = [:], sampBy: [String: Double] = [:]
            for l in s.mapArr("producedLines") {
                if let rid = FS.str(l["recipeId"]), let q = FS.int(l["qty"]), q > 0 {
                    madeBy[baseRid(rid), default: 0] += Double(q)
                    if let nm = FS.str(l["name"]) { names[baseRid(rid)] = nm }
                }
            }
            for l in s.mapArr("inventorySoldLines") {
                if let rid = FS.str(l["recipeId"]), !isCustom(rid), let q = FS.int(l["qty"]), q > 0 { soldBy[baseRid(rid), default: 0] += Double(q) }
            }
            for (rid, v) in (s.map("samplesActual") ?? [:]) {
                if let n = FS.int(v), n > 0 { sampBy[baseRid(rid), default: 0] += Double(n) }
            }
            for rid in Set(madeBy.keys).union(soldBy.keys) {
                let made = madeBy[rid] ?? 0
                let sold = soldBy[rid] ?? 0
                let sellable = max(0, made - (sampBy[rid] ?? 0))
                appear[rid, default: 0] += 1
                madeSum[rid, default: 0] += made
                soldSum[rid, default: 0] += sold
                sampSum[rid, default: 0] += sampBy[rid] ?? 0
                if made > 0 && sellable > 0 && sold >= sellable { sellouts[rid, default: 0] += 1 }
                totSold += sold; totSellable += sellable
            }
        }
        // Marked-down units come out of the demand anchor: a sale that needed a
        // late-day price cut is proof of a leftover, not of full-price demand
        // (Omar, Jul 16 — "that's what I wanted to get to"). The markdown data
        // loads async per series and is cached; until it lands, suggestions
        // read as plain avg-sold and tighten on the next render.
        let disc = discounts(label: label)
        var items: [String: SeriesItemStat] = [:]
        for rid in appear.keys {
            let a = appear[rid] ?? 1
            let avgSold = (soldSum[rid] ?? 0) / Double(a)
            let avgMade = (madeSum[rid] ?? 0) / Double(a)
            let avgMd = disc.map { Double($0.unitsByItem[rid] ?? 0) / Double(a) } ?? 0
            let avgTrim = disc.map { ($0.trimByItem[rid] ?? 0) / Double(a) } ?? 0
            let so = sellouts[rid] ?? 0
            // Anchor on FULL-PRICE sales. Sellouts half the time or more →
            // demand was capped, bump 15% — but ONLY with 2+ appearances
            // (be conservative on thin history: one day of evidence never
            // argues for bringing MORE than provably sold; over-supply with
            // no demand is the expensive mistake).
            var base = max(0, avgSold - avgTrim)
            if a >= 2 && Double(so) >= Double(a) / 2 && so > 0 { base *= 1.15 }
            let suggested = base > 0 ? max(1, Int(base.rounded(.up))) : 0
            let nm = names[rid] ?? product(rid)?.name ?? rid
            items[rid] = SeriesItemStat(name: nm, avgSold: avgSold, avgMade: avgMade,
                                        avgMarkedDown: avgMd,
                                        avgSampled: (sampSum[rid] ?? 0) / Double(a),
                                        sellouts: so, appearances: a, suggested: suggested)
        }
        return SeriesStats(label: label, shiftCount: ss.count,
                           avgUnitsSold: ss.isEmpty ? 0 : totSold / Double(ss.count),
                           sellThrough: totSellable > 0 ? min(1, totSold / totSellable) : 0,
                           items: items)
    }
    // ── Markdown lever per series (Omar, Jul 16) ─────────────────────────────
    // Markdowns are how unsold stock gets moved late in a market — so the
    // demand panel shows, per item, how many of its sold units needed a price
    // cut and how much was given up. From ticket LINES (markdownCents > 0),
    // grouped to the base recipe like everything else. Cached per series;
    // one tickets query per historical shift, loaded once per panel open.
    struct SeriesDiscounts {
        var unitsByItem: [String: Int] = [:]      // base rid → units sold marked down (display)
        var centsByItem: [String: Int] = [:]      // base rid → markdown $ given up
        var trimByItem: [String: Double] = [:]    // base rid → demand-units to TRIM (price-weighted)
        var totalUnits = 0
        var totalCents = 0
    }
    var seriesDiscounts: [String: SeriesDiscounts] = [:]   // by lowercased label
    func loadSeriesDiscounts(label: String, token: String?) async {
        if isDemo { return }
        let key = label.trimmingCharacters(in: .whitespaces).lowercased()
        guard !key.isEmpty, seriesDiscounts[key] == nil else { return }
        let ss = shifts.filter {
            $0.str("status") == "closed" &&
            ($0.str("marketName") ?? "").trimmingCharacters(in: .whitespaces).lowercased() == key
        }
        guard !ss.isEmpty else { return }
        var d = SeriesDiscounts()
        for s in ss {
            let tix = await FS.query("marketTickets",
                                     where: [FSWhere(field: "shiftId", op: "EQUAL", value: s.id)],
                                     limit: 500, token: token)
            for t in tix where t.str("status") == "paid" && t.bool("isTestOnly") != true {
                for l in t.mapArr("items") {
                    guard FS.bool(l["isTest"]) != true,
                          let md = FS.int(l["markdownCents"]), md > 0,
                          let rid = FS.str(l["recipeId"]), !rid.isEmpty,
                          !rid.hasPrefix("custom") else { continue }
                    let base = rid.components(separatedBy: "::").first ?? rid
                    // UNITS, not line-quantities: a marked-down 4-pack is 4
                    // units (same packUnits math the sold counts use).
                    let units = (FS.int(l["qty"]) ?? 1) * max(1, FS.int(l["packUnits"]) ?? 1)
                    // PRICE-WEIGHTED trim (Omar, Jul 16): a discounted sale is
                    // ambiguous evidence — the buyer paid, just not full price.
                    // Credit it by the fraction of the tag it fetched: a $9
                    // dozen on a $14 tag counts as 64% demand, so only 36% of
                    // those units trim the anchor. Deeper cut → weaker
                    // evidence → bigger trim. List price unknown → trim fully
                    // (the conservative side).
                    let paid = (FS.int(l["unitCentsAtSale"]) ?? 0) * (FS.int(l["qty"]) ?? 1)
                    let list = paid + md
                    let weight = list > 0 ? Double(md) / Double(list) : 1.0
                    d.unitsByItem[base, default: 0] += units
                    d.centsByItem[base, default: 0] += md
                    d.trimByItem[base, default: 0] += Double(units) * weight
                    d.totalUnits += units
                    d.totalCents += md
                }
            }
        }
        seriesDiscounts[key] = d
    }
    func discounts(label: String) -> SeriesDiscounts? {
        seriesDiscounts[label.trimmingCharacters(in: .whitespaces).lowercased()]
    }

    // The plan's series tag — editable ANY time (display + tagging only; never
    // touches money or stock, so a started plan can re-tag freely).
    func setPlanMarket(_ planId: String, label: String, token: String?) async {
        if isDemo { return }
        await FS.patch("marketPlans", planId, ["marketLabel": label, "updatedAt": Date()], token: token)
    }

    // ── History-grounded forecast (mirrors the HQ2 plan summary) ─────────────
    // Assumptions from CLOSED shifts: sell-through (sold ÷ sellable, where sellable
    // = made − samples), the tender mix + effective card-fee rate, and the booth.
    func assumptions() -> Assumptions {
        var a = Assumptions(); a.booth = cfgBooth
        var tender = 0.0, card = 0.0, cash = 0.0, venmo = 0.0, tokens = 0.0, tax = 0.0, proc = 0.0
        var sold = 0.0, sellable = 0.0, boothSum = 0.0, boothN = 0
        for s in shifts where s.str("status") == "closed" {
            let c = Double(s.int("cashSalesCents") ?? 0), cd = Double(s.int("cardSalesCents") ?? 0)
            let tk = Double(s.int("tokenSalesCents") ?? 0), dg = Double(s.int("digitalSalesCents") ?? 0), ot = Double(s.int("otherSalesCents") ?? 0)
            let tnd = c + cd + tk + dg + ot; if tnd <= 0 { continue }
            a.n += 1
            tender += tnd; card += cd; cash += c + ot; venmo += dg; tokens += tk
            tax += Double(s.int("taxCollectedCents") ?? 0)
            // Actual fee where Stripe's number was recorded, card-present
            // estimate for the rest — see FrontModel.processingCents.
            proc += Double(FrontModel.processingCents(s))
            var made = 0.0, soldU = 0.0, samp = 0.0
            for l in s.mapArr("producedLines") { made += Double(FS.int(l["qty"]) ?? 0) }
            for l in s.mapArr("inventorySoldLines") { soldU += Double(FS.int(l["qty"]) ?? 0) }
            for (_, v) in (s.map("samplesActual") ?? [:]) { samp += Double(FS.int(v) ?? 0) }
            let sell = max(0, made - samp)
            if sell > 0, soldU > 0 { sold += soldU; sellable += sell }
            if let bf = s.int("boothFeeCents") { boothSum += Double(bf); boothN += 1 }
        }
        let rev = tender - tax
        if sellable > 0 { a.sellThrough = min(1, sold / sellable); a.haveSellThrough = true }
        if tender > 0 { a.cardPct = card / tender; a.cashPct = cash / tender; a.venmoPct = venmo / tender; a.tokenPct = tokens / tender; a.haveMix = true }
        if rev > 0 { a.procRate = proc / rev }
        if boothN > 0 { a.booth = boothSum / Double(boothN) / 100 }
        return a
    }

    // Per-product pack-size mix from past tickets: fraction OF UNITS sold at each
    // pack size (e.g. [6: .6, 1: .3, 12: .1]). Cached.
    func packMix() -> [String: [Int: Double]] {
        if let m = _packMix { return m }
        var tally: [String: [Int: Double]] = [:]
        for t in tickets {
            if t.str("status") != "paid" || t.bool("isTestOnly") == true { continue }
            for it in t.mapArr("items") {
                if FS.bool(it["isTest"]) == true || FS.bool(it["isCustom"]) == true { continue }
                let rid = (FS.str(it["recipeId"]) ?? "").components(separatedBy: "::").first ?? ""
                if rid.isEmpty || rid.hasPrefix("custom") { continue }
                let pu = max(1, FS.int(it["packUnits"]) ?? 1)
                let u = Double(FS.int(it["unitsSold"]) ?? ((FS.int(it["qty"]) ?? 0) * pu))
                if u <= 0 { continue }
                tally[rid, default: [:]][pu, default: 0] += u
            }
        }
        var out: [String: [Int: Double]] = [:]
        for (rid, m) in tally {
            let tot = m.values.reduce(0, +); if tot <= 0 { continue }
            var frac: [Int: Double] = [:]; for (sz, u) in m { frac[sz] = u / tot }
            out[rid] = frac
        }
        _packMix = out; return out
    }

    // ── Suggested pack mix (auto-fill) ───────────────────────────────────────
    // How `qty` made units would most likely be packed, from the product's
    // historical pack-size fractions. Largest-remainder rounding: floor each
    // size's ideal pack count, then grant extra packs to the biggest fractional
    // remainders while the units still fit — so covered units NEVER exceed qty,
    // and anything left un-packed is implicitly singles (the forecast and the
    // box count both already treat un-covered units as single-unit packs).
    // No sales history → everything in the largest pack the product offers,
    // remainder in singles if it sells singles. Only sizes the product actually
    // offers ever appear.
    func suggestedMix(rid: String, qty: Int) -> [Int: Int] {
        guard qty > 0, let p = product(rid), !p.packs.isEmpty else { return [:] }
        let hist = packMix()[rid] ?? [:]
        let sizes = hist.keys.filter { sz in sz > 0 && p.packs.contains { $0.qty == sz } }
        if sizes.isEmpty {
            let big = max(1, p.packs.map(\.qty).max() ?? 1)
            var c: [Int: Int] = [big: qty / big]
            let rem = qty - (c[big] ?? 0) * big
            if rem > 0, big != 1, p.packs.contains(where: { $0.qty == 1 }) { c[1] = rem }
            return c.filter { $0.value > 0 }
        }
        let totF = sizes.reduce(0.0) { $0 + (hist[$1] ?? 0) }
        guard totF > 0 else { return [:] }
        var c: [Int: Int] = [:]
        var covered = 0
        var fracs: [(sz: Int, frac: Double)] = []
        for sz in sizes {
            let ideal = Double(qty) * (hist[sz] ?? 0) / totF / Double(sz)
            let base = Int(ideal.rounded(.down))
            if base > 0 { c[sz] = base }
            covered += base * sz
            fracs.append((sz, ideal - Double(base)))
        }
        for f in fracs.sorted(by: { $0.frac > $1.frac }) where f.frac > 0.0001 {
            if covered + f.sz <= qty { c[f.sz, default: 0] += 1; covered += f.sz }
        }
        return c.filter { $0.value > 0 }
    }

    // The pack mix the math should USE for a set of picked items: hand-set
    // entries win untouched; every other item gets the sales-history suggestion —
    // so packaging counts and pack-priced forecasts are realistic by default
    // instead of worst-casing every unit as its own pack. These are display/
    // compute defaults ONLY — nothing here is ever written to the plan doc.
    func effectiveMix(items: [String: Int], manual: [String: [Int: Int]] = [:]) -> [String: [Int: Int]] {
        var out: [String: [Int: Int]] = [:]
        for (rid, m) in manual { let nz = m.filter { $0.value > 0 }; if !nz.isEmpty { out[rid] = nz } }
        // Suggestions fill ONLY never-touched items. The PRESENCE of a manual
        // entry — even one the owner zeroed out entirely (deliberately no
        // packs) — blocks the overlay, so an explicit deselection is never
        // resurrected from sales history. Touched-but-all-zero items simply
        // have no mix: the packaging math prices every unit as its own single
        // (the conservative pre-mix behavior).
        for (rid, qty) in items where qty > 0 && manual[rid] == nil {
            let s = suggestedMix(rid: rid, qty: qty)
            if !s.isEmpty { out[rid] = s }
        }
        return out
    }

    // One product's revenue + COGS for `units` made, pack-aware: manual override →
    // historical pack mix → blended per-unit. COGS is the stripe-free make cost.
    func itemForecast(_ p: Product, units: Int, override packsOv: [Int: Int]?) -> (revenue: Double, cogs: Double, units: Int) {
        if units <= 0 { return (0, 0, max(0, units)) }
        if let ov = packsOv, !ov.isEmpty {
            var rev = 0.0, cogs = 0.0, u = 0
            for (sz, cnt) in ov where cnt > 0 {
                if let pk = p.packs.first(where: { $0.qty == sz }) {
                    rev += Double(cnt) * pk.price; cogs += Double(cnt) * pk.cost; u += cnt * pk.qty
                } else {
                    rev += Double(cnt) * p.revPerUnit * Double(sz); cogs += Double(cnt) * p.loadedPerUnit * Double(sz); u += cnt * sz
                }
            }
            // Any made units not yet packed are still made — price the remainder at
            // the blended rate so a partial pack edit never under-counts the plan.
            let rem = units - u
            if rem > 0 { rev += Double(rem) * p.revPerUnit; cogs += Double(rem) * p.loadedPerUnit }
            return (rev, cogs, max(units, u))
        }
        if let mix = packMix()[p.id], !p.packs.isEmpty {
            let sizes = mix.keys.filter { sz in p.packs.contains { $0.qty == sz } }
            let totF = sizes.reduce(0.0) { $0 + (mix[$1] ?? 0) }
            if totF > 0 {
                var rev = 0.0, cogs = 0.0
                for sz in sizes {
                    let f = (mix[sz] ?? 0) / totF
                    let uAt = Double(units) * f
                    if let pk = p.packs.first(where: { $0.qty == sz }) {
                        let packsCount = uAt / Double(max(1, pk.qty))
                        rev += packsCount * pk.price; cogs += packsCount * pk.cost
                    }
                }
                return (rev, cogs, units)
            }
        }
        return (Double(units) * p.revPerUnit, Double(units) * p.loadedPerUnit, units)
    }

    // Full net-profit P&L at a given sell-through (mirrors HQ2 _mhForecastPnl).
    // `sampleFrac` is 0–1. Revenue & COGS scale to what SELLS; samples + unsold
    // waste are ingredient-cost; card fees from the historical mix; booth flat.
    func forecast(_ roll: Rollup, sampleFrac: Double, hist: Assumptions, sellThrough: Double) -> Forecast {
        let made = roll.unitsTotal
        let samplesCount = Int((Double(made) * max(0, min(1, sampleFrac))).rounded())
        let sellable = max(0, made - samplesCount)
        let sold = Int((Double(sellable) * max(0, min(1, sellThrough))).rounded())
        let leftover = max(0, sellable - sold)
        let perRev = made > 0 ? roll.revenue / Double(made) : 0
        let perCogs = made > 0 ? roll.cogs / Double(made) : 0
        let perFood = made > 0 ? roll.buildCost / Double(made) : 0
        let revenue = perRev * Double(sold)
        let cogs = perCogs * Double(sold)
        let margin = revenue - cogs
        // Split COGS-of-sold into its parts the same way HQ2's closed statement does:
        // food + packaging from the Cost-Lab basis, labor/overhead = the remainder
        // (so the three always sum back to COGS).
        let foodCost = made > 0 ? roll.foodComp / Double(made) * Double(sold) : 0
        let pkgCost = made > 0 ? roll.pkgComp / Double(made) * Double(sold) : 0
        let laborOhCost = max(0, cogs - foodCost - pkgCost)
        let samplesCost = perFood * Double(samplesCount)
        let wasteCost = perFood * Double(leftover)
        let processing = revenue * hist.procRate
        let net = margin - samplesCost - wasteCost - processing - hist.booth
        return Forecast(made: made, samplesCount: samplesCount, sellable: sellable, sold: sold, leftover: leftover,
                        revenue: revenue, cogs: cogs, margin: margin,
                        foodCost: foodCost, pkgCost: pkgCost, laborOhCost: laborOhCost, samplesCost: samplesCost,
                        wasteCost: wasteCost, processing: processing, booth: hist.booth, net: net)
    }

    // ── Persistence ─────────────────────────────────────────────────────────
    func createPlan(name: String, token: String?) async -> String? {
        let id = await FS.add("marketPlans", [
            "name": name.isEmpty ? "Market plan" : name,
            "status": "draft", "items": [String: Any](), "samplesExpected": [String: Any](),
            "ingredientsDeducted": false,
            "createdAt": Date(), "updatedAt": Date(),
        ], token: token)
        if id != nil { plans = await Self.listPlans(token: token); computePlanNets() }
        return id
    }

    // REUSE (duplicate): make a brand-new DRAFT from an existing plan, copying the
    // item picks, hand-set pack mix and samples %, with the name + " (copy)". Every
    // lifecycle field is CLEARED so the copy is a clean, un-cooked draft — no shift
    // link, nothing deducted, no start/close timestamps, a fresh createdAt. The
    // original is never touched, so this is the safe way to run a similar lineup
    // again. Returns the new plan's id (the caller opens it in the editor).
    func duplicatePlan(_ planId: String, token: String?) async -> String? {
        guard let src = await FS.get("marketPlans", planId, token: token) else { return nil }
        var itemsMap: [String: Any] = [:]
        for (k, v) in (src.map("items") ?? [:]) { if let n = FS.int(v), n > 0 { itemsMap[k] = n } }
        var samplesMap: [String: Any] = [:]
        for (k, v) in (src.map("samplesExpected") ?? [:]) { if let n = FS.int(v) { samplesMap[k] = n } }
        // Carry the saved pack mix (shared 1:1 with HQ2) verbatim — zeros included,
        // since a zeroed size is a deliberate "none of this pack" choice.
        var pmMap: [String: Any] = [:]
        for (rid, sizes) in (src.map("packMix") ?? [:]) {
            guard let inner = FS.map(sizes) else { continue }
            var m: [String: Any] = [:]; for (sz, c) in inner { if let n = FS.int(c), n >= 0 { m[sz] = n } }
            if !m.isEmpty { pmMap[rid] = m }
        }
        let baseName = src.str("name") ?? "Market plan"
        let id = await FS.add("marketPlans", [
            "name": "\(baseName) (copy)",
            "status": "draft",
            "items": itemsMap, "samplesExpected": samplesMap,
            "packMix": pmMap, "samplePct": src.dbl("samplePct") ?? 0,
            "ingredientsDeducted": false,
            "createdAt": Date(), "updatedAt": Date(),
        ], token: token)
        if id != nil { plans = await Self.listPlans(token: token); computePlanNets() }
        return id
    }

    func saveItems(_ planId: String, name: String, items: [String: Int], samplePct: Double, packMix: [String: [Int: Int]] = [:], fromFreezer: [String: Int] = [:], token: String?) async {
        if isDemo { return }
        var itemsMap: [String: Any] = [:]; for (k, v) in items where v > 0 { itemsMap[k] = v }
        // packMix is ADDITIVE metadata shared 1:1 with HQ2 ({recipeId:{size:count}}):
        // `items` stays the authoritative total-unit map that drives ingredient
        // deduction, so writing packMix never changes what gets pulled.
        // ZERO counts are saved on purpose: they record "the owner touched this
        // item's mix and deliberately picked none of this size", which stops
        // effectiveMix from re-filling the item from sales history on the next
        // open. HQ2 tolerates them (its reader filters n > 0).
        var pmMap: [String: Any] = [:]
        for (rid, sizes) in packMix where items[rid] ?? 0 > 0 {
            var inner: [String: Any] = [:]; for (sz, cnt) in sizes where cnt >= 0 { inner[String(sz)] = cnt }
            if !inner.isEmpty { pmMap[rid] = inner }
        }
        var ffMap: [String: Any] = [:]
        for (rid, n) in fromFreezer where n > 0 && (items[rid] ?? 0) > 0 { ffMap[rid] = n }
        await FS.patch("marketPlans", planId, [
            "name": name.isEmpty ? "Market plan" : name,
            "items": itemsMap, "samplePct": samplePct, "packMix": pmMap,
            "fromFreezerItems": ffMap, "updatedAt": Date(),
        ], token: token)
    }
    // Saved ❄ from-freezer counts on a plan doc (mirrors planPackMix).
    static func planFromFreezer(_ p: FSDoc) -> [String: Int] {
        var out: [String: Int] = [:]
        for (rid, v) in (p.map("fromFreezerItems") ?? [:]) { if let n = FS.int(v), n > 0 { out[rid] = n } }
        return out
    }

    // Delete a plan. If it was already cooked (ingredientsDeducted) and the caller
    // asks to returnStock, REVERSE the deduction first — add the pulled ingredients
    // back to stock from the plan's `deductedItems` snapshot — so deleting a
    // mistakenly-cooked plan doesn't silently lose the stock (which then double-
    // counts when the production is re-made). returnStock:false keeps it deducted
    // (the right choice when you actually made + used the product).
    func deletePlan(_ planId: String, returnStock: Bool = false, actor: String = "", token: String?) async {
        if returnStock, let fresh = await FS.get("marketPlans", planId, token: token),
           fresh.bool("ingredientsDeducted") == true {
            var changes: [(recipeKey: String, recipeName: String, deltaUnits: Int, recipe: FSDoc?)] = []
            for (rid, v) in (fresh.map("deductedItems") ?? [:]) {
                guard let n = FS.int(v), n > 0 else { continue }
                let rec = await FS.get("recipes", rid, token: token)
                changes.append((recipeKey: rid, recipeName: rec?.str("name") ?? "product", deltaUnits: -n, recipe: rec))
            }
            if !changes.isEmpty {
                await InventoryWriter.adjustPlanProduction(changes, planId: planId, planName: fresh.str("name") ?? "", actor: actor, token: token)
            }
            // ❄ Return frozen units to the shelf too (basis unchanged).
            for (rid, v) in (fresh.map("fromFreezerItems") ?? [:]) {
                if let n = FS.int(v), n > 0 { _ = await Freezer.restore(recipeId: rid, units: n, token: token) }
            }
            await loadFreezer(token: token)
        }
        _ = await FS.delete("marketPlans", planId, token: token)
        plans.removeAll { $0.id == planId }
    }

    // Start the plan. Two modes:
    //  • pullStock=true ("cook"): deduct each product's ingredients ONCE, guarded by
    //    the plan's `ingredientsDeducted` flag, and snapshot the build cost + COGS.
    //  • pullStock=false ("run plan"): mark it started but DON'T touch inventory —
    //    no pull, no `deductedItems` snapshot (nothing left stock, so nothing can be
    //    returned later). `ingredientsDeducted` stays false and `stockPulled:false`
    //    records it, so close/reopen/delete never assume phantom deductions. This is
    //    the "reuse a lineup without pulling ingredients again" path.
    // Re-reads the plan first so a stale screen can't re-pull. Returns false if the
    // requested start can't proceed (already pulled, or already started as a run plan).
    @discardableResult
    func startPlan(_ planId: String, items: [String: Int], fromFreezer: [String: Int] = [:], pullStock: Bool = true, actor: String, token: String?) async -> Bool {
        #if DEBUG
        if isDemo { return demoStartPlan(planId, items: items, pullStock: pullStock) }
        #endif
        guard let fresh = await FS.get("marketPlans", planId, token: token) else { return false }

        if !pullStock {
            // Only a draft can be started as a run plan (an already-started plan is
            // a no-op here; pulling stock later goes through the pullStock=true path).
            guard (fresh.str("status") ?? "draft") == "draft" else { return false }
            var lines: [[String: Any]] = []
            for (rid, qty) in items where qty > 0 { if let p = product(rid) { lines.append(["recipeId": rid, "name": p.name, "qty": qty]) } }
            let roll = rollup(items: items)
            await FS.patch("marketPlans", planId, [
                "status": "started", "ingredientsDeducted": false, "stockPulled": false,
                "startedAt": Date(), "startedBy": actor,
                "producedLines": lines,
                "buildCostCents": Int((roll.buildCost * 100).rounded()),
                "cogsCents": Int((roll.cogs * 100).rounded()),
                "updatedAt": Date(),
            ], token: token)
            plans = await Self.listPlans(token: token); computePlanNets()
            return true
        }

        guard fresh.bool("ingredientsDeducted") != true else { return false }
        // CLAIM the deduction immediately — before the slow ingredient pulls — so a
        // double-tap or concurrent call hits the guard above (now true) and can't
        // pull a second time. (The brown-sugar ledger showed a plan deducting the
        // same recipe twice in one second; the old code only set the flag AFTER the
        // pulls, leaving the whole pull window racy.)
        await FS.patch("marketPlans", planId, [
            "status": "started", "ingredientsDeducted": true, "stockPulled": true,
            "startedAt": Date(), "startedBy": actor, "updatedAt": Date(),
        ], token: token)
        var pulls: [(recipeKey: String, recipeName: String, pull: [PullItem])] = []
        var lines: [[String: Any]] = []
        for (rid, qty) in items where qty > 0 {
            guard let p = product(rid) else { continue }
            // ❄ Frozen units come off the finishedGoods shelf, not raw stock —
            // their ingredients were deducted when originally made. Only the
            // FRESH remainder pulls ingredients. producedLines stays the FULL
            // qty (frozen units still go to market and can sell/waste/refreeze).
            let frozenN = min(max(0, fromFreezer[rid] ?? 0), qty)
            let freshQty = qty - frozenN
            if freshQty > 0 {
                pulls.append((recipeKey: rid, recipeName: p.name, pull: InventoryWriter.pull(from: p.rec, qty: freshQty)))
            }
            lines.append(["recipeId": rid, "name": p.name, "qty": qty])
        }
        await InventoryWriter.applyPlanProduction(pulls, planId: planId, sourceName: fresh.str("name") ?? "", actor: actor, token: token)
        for (rid, n) in fromFreezer where n > 0 && (items[rid] ?? 0) > 0 {
            _ = await Freezer.consume(recipeId: rid, units: min(n, items[rid] ?? 0), token: token)
        }
        await loadFreezer(token: token)
        let roll = rollup(items: items, fromFreezer: fromFreezer)
        var deducted: [String: Any] = [:]
        for (k, v) in items where v > 0 {
            let freshQ = v - min(max(0, fromFreezer[k] ?? 0), v)
            if freshQ > 0 { deducted[k] = freshQ }   // snapshot = what actually pulled stock
        }
        var ffSnap: [String: Any] = [:]
        for (k, v) in fromFreezer where v > 0 && (items[k] ?? 0) > 0 { ffSnap[k] = min(v, items[k] ?? 0) }
        await FS.patch("marketPlans", planId, [
            "producedLines": lines,
            "deductedItems": deducted,   // snapshot of what was pulled, for delta edits
            "fromFreezerItems": ffSnap,  // ❄ snapshot — restored if the plan is deleted
            "buildCostCents": Int((roll.buildCost * 100).rounded()),
            "cogsCents": Int((roll.cogs * 100).rounded()),
            "updatedAt": Date(),
        ], token: token)
        plans = await Self.listPlans(token: token); computePlanNets()
        // Refresh on-hand so the rollup reflects the just-deducted stock.
        ingredients = await FS.list("ingredients", limit: 800, token: token)
        return true
    }

    /// After a plan is cooked, the operator can still correct counts. This pulls
    /// or returns ONLY the difference between what's now entered and what was last
    /// deducted (`deductedItems`), then re-snapshots — so stock always reflects
    /// reality and is never double-counted. Returns false if nothing changed.
    @discardableResult
    func applyAdjustment(_ planId: String, current items: [String: Int], actor: String, token: String?) async -> Bool {
        guard let fresh = await FS.get("marketPlans", planId, token: token) else { return false }
        var deducted: [String: Int] = [:]
        for (k, v) in (fresh.map("deductedItems") ?? [:]) { if let n = FS.int(v) { deducted[k] = n } }
        var changes: [(recipeKey: String, recipeName: String, deltaUnits: Int, recipe: FSDoc?)] = []
        for rid in Set(deducted.keys).union(items.keys) {
            let delta = (items[rid] ?? 0) - (deducted[rid] ?? 0)
            if delta != 0, let p = product(rid) { changes.append((rid, p.name, delta, p.rec)) }
        }
        guard !changes.isEmpty else { return false }
        await InventoryWriter.adjustPlanProduction(changes, planId: planId, planName: fresh.str("name") ?? "", actor: actor, token: token)
        let roll = rollup(items: items)
        var snap: [String: Any] = [:]; for (k, v) in items where v > 0 { snap[k] = v }
        var itemsMap: [String: Any] = [:]; for (k, v) in items where v > 0 { itemsMap[k] = v }
        await FS.patch("marketPlans", planId, [
            "items": itemsMap, "deductedItems": snap,
            "buildCostCents": Int((roll.buildCost * 100).rounded()),
            "cogsCents": Int((roll.cogs * 100).rounded()),
            "updatedAt": Date(),
        ], token: token)
        plans = await Self.listPlans(token: token); computePlanNets()
        ingredients = await FS.list("ingredients", limit: 800, token: token)
        return true
    }

    func closePlan(_ planId: String, token: String?) async {
        await FS.patch("marketPlans", planId, ["status": "closed", "closedAt": Date(), "updatedAt": Date()], token: token)
        plans = await Self.listPlans(token: token); computePlanNets()
    }

    // UNLOCK (reopen): flip a closed or shift-used plan back to editable. If the
    // ingredients were already pulled we go back to "started" (NOT "draft") and
    // LEAVE `ingredientsDeducted` as-is, so the idempotent deduction guard never
    // re-pulls stock on reopen; an un-cooked closed plan simply returns to "draft".
    // `closedAt` is cleared. For a plan a shift USED we KEEP `consumedByShiftId`
    // intact (severing it would orphan the shift's Plan-vs-Actual join) and instead
    // set a `reopened` flag — the editor's lock gate honors that flag so a used plan
    // can be edited without breaking the shift link. Never re-pulls stock.
    func reopenPlan(_ planId: String, token: String?) async {
        guard let fresh = await FS.get("marketPlans", planId, token: token) else { return }
        let wasCooked = fresh.bool("ingredientsDeducted") == true || fresh.date("startedAt") != nil
        await FS.patchFields("marketPlans", planId,
            set: [
                "status": wasCooked ? "started" : "draft",
                "reopened": true,
                "updatedAt": Date(),
            ],
            delete: ["closedAt"],
            token: token)
        plans = await Self.listPlans(token: token); computePlanNets()
    }
}

// MARK: - Plan list

struct MarketPlanBuilderView: View {
    @Environment(Auth.self) private var auth
    @Environment(\.dismiss) private var dismiss
    @State private var model = MarketPlanModel()
    @State private var newName = ""
    @State private var creating = false
    @State private var openPlanId: String? = nil
    @State private var deleteTarget: FSDoc? = nil
    @State private var reopenTarget: FSDoc? = nil    // shift-used plan awaiting reopen confirmation
    @State private var showWeek = false
    @State private var goalEdit = false          // net-$ goal editor alert
    @State private var goalText = ""

    private func statusOf(_ p: FSDoc) -> String { p.str("status") ?? "draft" }

    var body: some View {
        NavigationStack {
            ScrollView {
                if !model.loaded {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 240)
                } else {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Build a plan for a market: pick what you'll make, see the ingredients it needs, what it costs to build, and the COGS. Start it when you cook to pull the stock.")
                            .font(.ui(12)).foregroundStyle(Mise.ink4)
                        // Net-$ goal per market (settings/marketPlanner.netGoal) — drives
                        // the Pace chart's goal line + the "beat it by $X" check on used
                        // plans. Editable here since Forecast (its old home) is retired.
                        HStack(spacing: 8) {
                            Text("🎯").font(.system(size: 13))
                            Text("net goal per market:").font(.ui(12, .semibold)).foregroundStyle(Mise.ink3)
                            Text(model.cfgGoal > 0 ? "$\(Int(model.cfgGoal.rounded()))" : "not set")
                                .font(.ui(13, .heavy)).foregroundStyle(model.cfgGoal > 0 ? Mise.navy : Mise.ink4)
                            Spacer()
                            Button {
                                goalText = model.cfgGoal > 0 ? String(Int(model.cfgGoal.rounded())) : ""
                                goalEdit = true
                            } label: {
                                Text("edit").font(.ui(12, .bold)).foregroundStyle(Mise.navy)
                                    .padding(.horizontal, 12).padding(.vertical, 5)
                                    .background(Capsule().fill(Mise.navy.opacity(0.10)))
                            }.buttonStyle(.plain)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Mise.surface))
                        newPlanCard
                        if model.plans.isEmpty {
                            Text("No plans yet — name one above to begin.")
                                .font(.ui(12)).foregroundStyle(Mise.ink4).padding(.top, 4)
                        } else {
                            planSection("DRAFTS", model.plans.filter { statusOf($0) == "draft" })
                            planSection("STARTED", model.plans.filter { statusOf($0) == "started" })
                            planSection("CLOSED", model.plans.filter { statusOf($0) == "closed" })
                        }
                    }
                    .padding(18)
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Mise.bg)
            .navigationTitle("Market plans").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    // Roll several plans into one weekly shopping list.
                    if model.plans.contains(where: { ($0.str("status") ?? "draft") != "closed" && !MarketPlanModel.planItems($0).isEmpty }) {
                        Button { Haptics.tap(); showWeek = true } label: { Label("Week totals", systemImage: "sum") }
                    }
                }
            }
            .navigationDestination(item: $openPlanId) { pid in
                MarketPlanEditorView(model: model, planId: pid)
            }
            .navigationDestination(isPresented: $showWeek) {
                MarketWeekTotalsView(model: model)
            }
            .confirmationDialog("Delete this plan?",
                                isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }),
                                titleVisibility: .visible) {
                if deleteTarget?.bool("ingredientsDeducted") == true {
                    // Cooked plan — its ingredients are already out of stock. Frame the
                    // choice by what ACTUALLY happened (matching HQ2's wording), not two
                    // identical red "Delete" buttons: did you make + sell it, or not?
                    Button("I didn't make it — put stock back") {
                        if let p = deleteTarget {
                            deleteTarget = nil
                            Task { await model.deletePlan(p.id, returnStock: true, actor: auth.uid, token: await auth.token()) }
                        }
                    }
                    Button("I made + sold it — keep stock out", role: .destructive) {
                        if let p = deleteTarget {
                            deleteTarget = nil
                            Task { await model.deletePlan(p.id, returnStock: false, actor: auth.uid, token: await auth.token()) }
                        }
                    }
                } else {
                    Button("Delete \"\(deleteTarget?.str("name") ?? "plan")\"", role: .destructive) {
                        if let p = deleteTarget {
                            deleteTarget = nil
                            Task { await model.deletePlan(p.id, returnStock: false, actor: auth.uid, token: await auth.token()) }
                        }
                    }
                }
                Button("Cancel", role: .cancel) { deleteTarget = nil }
            } message: {
                Text(deleteTarget?.bool("ingredientsDeducted") == true
                     ? "This plan already pulled its ingredients out of stock. Return them if you didn’t actually make it; keep them out if you made + used the product."
                     : "This can’t be undone.")
            }
            // Reopen a shift-used plan — plain-English risk warning before unlocking.
            .confirmationDialog("Reopen this plan?",
                                isPresented: Binding(get: { reopenTarget != nil }, set: { if !$0 { reopenTarget = nil } }),
                                titleVisibility: .visible) {
                Button("Reopen to edit") {
                    if let p = reopenTarget {
                        reopenTarget = nil
                        Task { await model.reopenPlan(p.id, token: await auth.token()) }
                    }
                }
                Button("Cancel", role: .cancel) { reopenTarget = nil }
            } message: {
                Text("This plan was used by a market shift. Reopening lets you edit it again, but its numbers still feed that shift's record — so changes here change what that shift reports.")
            }
        }
        .task { if !model.loaded { await model.load(token: await auth.token()) } }
        // Edit the net-$ goal per market — persists to settings/marketPlanner.netGoal
        // (the same doc the Pace chart's goal line + the used-plan goal check read).
        .alert("Net goal per market", isPresented: $goalEdit) {
            TextField("e.g. 200", text: $goalText).keyboardType(.numberPad)
            Button("Save") {
                let v = Double(goalText.trimmingCharacters(in: .whitespaces)) ?? 0
                model.cfgGoal = max(0, v)
                Task {
                    await FS.patch("settings", "marketPlanner",
                                   ["netGoal": max(0, v), "updatedAt": Date()],
                                   token: await auth.token())
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The profit target for one market day — drives the goal line on the pace chart and the \"beat it by $X\" check on used plans. Enter 0 to unset.")
        }
    }

    private var newPlanCard: some View {
        HStack(spacing: 8) {
            TextField("Name a new plan — e.g. \"Sat market · Jun 27\"", text: $newName)
                .font(.ui(14)).foregroundStyle(Mise.ink)
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(RoundedRectangle(cornerRadius: 12).fill(Mise.surface2))
            Button {
                Haptics.tap()
                Task {
                    creating = true
                    if let id = await model.createPlan(name: newName, token: await auth.token()) {
                        newName = ""; openPlanId = id
                    }
                    creating = false
                }
            } label: {
                Text(creating ? "…" : "New").font(.ui(14, .bold)).foregroundStyle(.white)
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Mise.navy))
            }.buttonStyle(.plain).disabled(creating)
        }
    }

    private func planSection(_ title: String, _ rows: [FSDoc]) -> some View {
        Group {
            if !rows.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(title).font(.ui(11, .bold)).tracking(0.5).foregroundStyle(Mise.ink4)
                    ForEach(rows) { p in planRow(p) }
                }
            }
        }
    }

    private func planRow(_ p: FSDoc) -> some View {
        let items = (p.map("items") ?? [:]).reduce(into: 0) { $0 += FS.int($1.value) ?? 0 }
        let kinds = (p.map("items") ?? [:]).count
        let st = statusOf(p)
        // Quick-glance net — PRE-COMPUTED in the model (not per render), so
        // typing the new-plan name doesn't re-explode every plan's ingredients.
        // Tense follows the plan's life: a shift-used plan reads "actual net"
        // (its market's real number) or "planned net" (books not frozen yet);
        // an unused plan reads "exp. net" (still a projection).
        let netVal = model.planNets[p.id]
        let netLabel = (netVal?.actual == true) ? "actual net"
            : (MarketPlanModel.isUsed(p) ? "planned net" : "exp. net")
        let baseSub = kinds == 0 ? "empty" : "\(kinds) item\(kinds == 1 ? "" : "s") · \(items) made"
        return Button {
            Haptics.tap(); openPlanId = p.id
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(p.str("name") ?? "Market plan").font(.ui(15, .semibold)).foregroundStyle(Mise.ink).lineLimit(1)
                    (Text(baseSub).font(.ui(11)).foregroundStyle(Mise.ink4)
                     + (netVal == nil ? Text("")
                        : Text(" · \(netVal!.net < 0 ? "−" : "")$\(Int(abs(netVal!.net).rounded())) \(netLabel)")
                            .font(.ui(11, .semibold)).foregroundStyle(netVal!.net >= 0 ? Mise.success : Mise.danger)))
                }
                Spacer(minLength: 8)
                statusPill(st)
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Mise.ink5)
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 12).fill(Mise.surface))
        }
        .buttonStyle(.plain)
        .contextMenu {
            // Reuse — always available (any plan, any status). Copies the lineup into
            // a fresh draft and opens it; no stock is pulled until that draft starts.
            Button {
                Haptics.tap()
                Task { if let newId = await model.duplicatePlan(p.id, token: await auth.token()) { openPlanId = newId } }
            } label: { Label("Reuse as new plan", systemImage: "doc.on.doc") }
            // Reopen — only on a locked (closed or shift-used) plan. A shift-used plan
            // routes through a confirmation dialog first.
            if st == "closed" || MarketPlanModel.isUsed(p) {
                Button {
                    Haptics.tap()
                    if MarketPlanModel.isUsed(p) { reopenTarget = p }
                    else { Task { await model.reopenPlan(p.id, token: await auth.token()) } }
                } label: { Label("Reopen to edit", systemImage: "lock.open") }
            }
            Button(role: .destructive) { deleteTarget = p } label: { Label("Delete plan", systemImage: "trash") }
        }
    }

    @ViewBuilder private func statusPill(_ st: String) -> some View {
        let (label, color): (String, Color) = switch st {
            case "started": ("STARTED", Mise.success)
            case "closed":  ("CLOSED", Mise.ink5)
            default:        ("DRAFT", Mise.navy)
        }
        Text(label).font(.ui(9, .bold)).tracking(0.4).foregroundStyle(color)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.12)))
    }
}

// MARK: - Plan editor

struct MarketPlanEditorView: View {
    let model: MarketPlanModel
    let planId: String
    @Environment(Auth.self) private var auth
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var madeText: [String: String] = [:]   // recipeId → units
    @State private var sampleText = "0"                    // % of made units given away free
    @State private var search = ""
    @State private var status = "draft"
    @State private var deducted = false
    @State private var consumedByShift = false              // a market shift has used this plan → locked
    @State private var shiftId = ""                         // the shift that ran this plan (consumedByShiftId)
    @State private var runShift: FSDoc? = nil               // its closed doc → Plan vs Actual card
    @State private var deductedItems: [String: Int] = [:]   // what stock was last pulled for (delta basis)
    @State private var reopened = false                     // a locked plan was unlocked for editing (keeps the shift link)
    @State private var seeded = false
    @State private var starting = false
    @State private var applying = false
    @State private var reopening = false
    @State private var duplicating = false
    @State private var confirmStart = false
    @State private var confirmPull = false                  // "pull stock now" on a run-plan that started without pulling
    @State private var confirmReopen = false                // unlock a shift-used plan (needs the warning)
    @State private var openCopyId: String? = nil            // navigate to a freshly-duplicated draft
    @State private var saveTask: Task<Void, Never>? = nil
    // The rollup explodes every recipe's ingredients — too heavy to run on every
    // keystroke. Compute it on a short debounce and cache it here so typing stays
    // snappy; the summary + ingredient list read this cached value.
    @State private var calcRoll: MarketPlanModel.Rollup? = nil
    @State private var calcPkg: MarketPlanModel.PkgRollup? = nil   // packaging rollup, same debounce
    @State private var calcComps: [MarketPlanModel.ComponentRow] = []   // AI shared sub-recipe batches for THIS plan (shared model.components)
    @State private var displaySample: Double = 0
    @State private var calcTask: Task<Void, Never>? = nil
    // Manual pack mix per item (recipeId → pack qty → how many of that pack). Any
    // non-zero entry = manual mode for that item; empty = the historical mix.
    @State private var packCounts: [String: [Int: Int]] = [:]
    // ❄ per-item "use N from the freezer" (persisted on the plan doc).
    @State private var fromFreezer: [String: Int] = [:]
    // Which market SERIES this plan is for (Market A / Market C / …).
    // Display + history only — editable in ANY plan state, even after start.
    @State private var planMarket = ""
    @State private var demandOpen = true
    @State private var newMarketAsk = false      // "New market…" name alert
    @State private var newMarketName = ""
    @State private var expandedPacks: Set<String> = []

    private func made(_ id: String) -> Int { Int((madeText[id] ?? "").trimmingCharacters(in: .whitespaces)) ?? 0 }
    private var sampleFrac: Double { max(0, min(1, (Double(sampleText.trimmingCharacters(in: .whitespaces)) ?? 0) / 100)) }
    private var items: [String: Int] {
        var m: [String: Int] = [:]; for p in model.products { let n = made(p.id); if n > 0 { m[p.id] = n } }; return m
    }
    // Editable while drafting AND after cooking (so counts can be corrected) —
    // but locked once it's been closed or used to open a market shift. A plan the
    // owner explicitly REOPENED (unlocked) edits again even if a shift used it:
    // `reopened` overrides the shift lock, and the shift link stays intact.
    private var editable: Bool { status != "closed" && (!consumedByShift || reopened) }
    // Stock was actually pulled from inventory (a real cook). A plan STARTED as a
    // run-plan reference has status "started" but never pulled stock, so `cooked`
    // stays false — its counts still edit freely and nothing returns to stock.
    private var cooked: Bool { deducted }
    // The plan has been kicked off (started or closed), as opposed to a fresh draft.
    private var started: Bool { status != "draft" }
    // True when the entered counts differ from what stock was last pulled for.
    private var hasUnappliedChanges: Bool {
        guard cooked else { return false }
        let cur = items
        if cur.count != deductedItems.count { return true }
        for (k, v) in cur where deductedItems[k] != v { return true }
        return false
    }
    private var roll: MarketPlanModel.Rollup { model.rollup(items: items, fromFreezer: fromFreezer) }
    private var picked: [MarketPlanModel.Product] { model.products.filter { made($0.id) > 0 } }
    private var filtered: [MarketPlanModel.Product] {
        let q = search.lowercased().trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return model.products }
        return model.products.filter { $0.name.lowercased().contains(q) }
    }

    #if DEBUG
    /// Scroll anchors for the marketing capture script.
    fileprivate static let ingAnchor = "ing-block"
    fileprivate static let demandAnchor = "demand-block"
    #endif

    var body: some View {
        ScrollViewReader { scrollProxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if started { startedBanner }
                if consumedByShift, let s = runShift { vsActualCard(s) }
                nameField
                marketRow
                if !planMarket.isEmpty {
                    if let st = model.seriesStats(label: planMarket) {
                        #if DEBUG
                        demandCard(st).id(Self.demandAnchor)
                        #else
                        demandCard(st)
                        #endif
                    }
                    else if editable, !model.seriesLabels.isEmpty { noHistoryCard }
                }
                pickerSection
                if let r = calcRoll, r.unitsTotal > 0 {
                    summaryCard(r)
                    #if DEBUG
                    ingredientsCard(r).id(Self.ingAnchor)
                    #else
                    ingredientsCard(r)
                    #endif
                    if !calcComps.isEmpty { componentsCard }
                    if let pk = calcPkg { packagingCard(pk) }
                    TimeCard(time: model.timeRollup(components: calcComps, units: items, packaging: calcPkg))
                    actionRow
                }
            }
            .padding(18)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Mise.bg)
        .navigationTitle("Plan").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { if editable, !items.isEmpty { Text("auto-saved").font(.ui(11)).foregroundStyle(Mise.ink5) } } }
        // Seed SYNCHRONOUSLY from the already-loaded plan (createPlan refreshes
        // model.plans before opening, so a brand-new plan is here too). Doing this
        // in onAppear — before the fields are interactive — means a late async load
        // can never overwrite what you type (the bug where renames/number edits
        // silently reverted). The async fetch below is only a fallback for the rare
        // case the plan isn't in memory yet, and it's still guarded by !seeded.
        .onAppear {
            if !seeded, let p = model.plans.first(where: { $0.id == planId }) {
                seedFrom(p); seeded = true; recalcNow()
            }
        }
        .task {
            if !seeded {
                if let p = await FS.get("marketPlans", planId, token: await auth.token()) { seedFrom(p) }
                seeded = true
                recalcNow()
            }
        }
        .task(id: shiftId) {
            guard !shiftId.isEmpty, runShift == nil else { return }
            runShift = await FS.get("marketShifts", shiftId, token: await auth.token())
        }
        .task(id: planMarket) {
            guard !planMarket.isEmpty else { return }
            await model.loadSeriesDiscounts(label: planMarket, token: await auth.token())
        }
        #if DEBUG
        // Marketing capture (--demo-plan --demo-autoplay): scroll to the
        // ingredient list FIRST, then pull the stock, so the on-hand column is
        // on screen at the moment it comes down.
        .task {
            guard model.isDemo, MarketingDemo.autoplay, status == "draft" else { return }
            if MarketingDemo.forecastScript {
                // "What should I bring?" — open on this market's own history and
                // take its suggestion, so the counts visibly fill themselves in.
                try? await Task.sleep(nanoseconds: 200_000_000)
                scrollProxy.scrollTo(Self.demandAnchor, anchor: .top)
                try? await Task.sleep(nanoseconds: 3_400_000_000)
                if let st = model.seriesStats(label: planMarket) {
                    Haptics.tap()
                    withAnimation(.easeOut(duration: 0.3)) {
                        for (rid, r) in st.items where r.suggested > 0 && model.product(rid) != nil {
                            madeText[rid] = "\(r.suggested)"
                        }
                    }
                    scheduleCalc()
                }
                return
            }
            try? await Task.sleep(nanoseconds: 200_000_000)
            scrollProxy.scrollTo(Self.ingAnchor, anchor: .top)
            try? await Task.sleep(nanoseconds: 2_600_000_000)
            await start(pullStock: true)
        }
        #endif
        .onChange(of: madeText) { _, _ in scheduleSave(); scheduleCalc() }
        .onChange(of: name) { _, _ in scheduleSave() }
        .onChange(of: sampleText) { _, _ in scheduleSave(); scheduleCalc() }
        .onDisappear { saveTask?.cancel(); persistAndReload() }
        // Open a just-duplicated plan (Reuse) as a fresh draft, pushed on top.
        .navigationDestination(item: $openCopyId) { pid in
            MarketPlanEditorView(model: model, planId: pid)
        }
        // Starting a plan: pull stock (a real cook) OR start as a run-plan reference
        // that never touches inventory — the owner's "reuse a lineup without pulling
        // ingredients again" ask.
        .confirmationDialog("Start this plan?", isPresented: $confirmStart, titleVisibility: .visible) {
            Button("Start & pull stock") { Task { await start(pullStock: true) } }
            Button("Start — don't pull stock") { Task { await start(pullStock: false) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(roll.shortCount > 0
                 ? "“Pull stock” deducts the ingredients for \(roll.unitsTotal) item\(roll.unitsTotal == 1 ? "" : "s") from inventory (\(roll.shortCount) ingredient\(roll.shortCount == 1 ? " is" : "s are") short — you can still proceed, stock floors at zero). “Don't pull stock” just marks it started as a run plan — inventory stays untouched, for reusing a lineup you already have stock for."
                 : "“Pull stock” deducts the ingredients for \(roll.unitsTotal) item\(roll.unitsTotal == 1 ? "" : "s") from inventory (for a real cook). “Don't pull stock” just marks it started as a run plan — inventory stays untouched, for reusing a lineup you already have stock for.")
        }
        // Pull stock later on a plan that was started as a reference.
        .alert("Pull stock for this plan?", isPresented: $confirmPull) {
            Button("Cancel", role: .cancel) {}
            Button("Pull stock") { Task { await start(pullStock: true) } }
        } message: {
            Text("Deducts every ingredient above from inventory now. You can correct counts afterward — only the difference will move.")
        }
        // Unlock a plan a market shift already used — plain-English risk warning.
        .confirmationDialog("Reopen this plan?", isPresented: $confirmReopen, titleVisibility: .visible) {
            Button("Reopen to edit") { Task { await reopen() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This plan was used by the \(runShift?.str("marketName") ?? "market") shift. Reopening lets you edit it again, but its numbers still feed that shift's record — so changes here change what that shift reports.")
        }
        }
    }

    // ── Plan vs Actual ───────────────────────────────────────────────────────
    // Once a market shift has RUN this plan (consumedByShiftId → a closed shift),
    // compare what we projected to what actually happened. All data already
    // lives on the shift doc; this is a read-only summary (full P&L is in HQ2).
    private func money(_ cents: Int) -> String { String(format: "$%.2f", Double(cents) / 100) }
    // Units SOLD for a recipe — inventorySold is keyed by recipeId OR
    // recipeId::packIndex, so sum every key whose base id matches.
    private func soldFor(_ rid: String, _ s: FSDoc) -> Int {
        guard let m = s.map("inventorySold") else { return 0 }
        var t = 0
        for (k, v) in m where (k.components(separatedBy: "::").first ?? k) == rid { t += FS.int(v) ?? 0 }
        return t
    }
    // Units actually MADE (producedLines = what was brought); falls back to the
    // plan's planned count if the shift didn't record a made line.
    private func madeActual(_ rid: String, _ s: FSDoc) -> Int {
        for l in s.mapArr("producedLines") where FS.str(l["recipeId"]) == rid { return FS.int(l["qty"]) ?? made(rid) }
        return made(rid)
    }
    private func soldOutMillis(_ rid: String, _ s: FSDoc) -> Double? { FS.dbl(s.map("soldOutAt")?[rid]) }
    private func leftoverFor(_ rid: String, _ s: FSDoc) -> Int { FS.int(s.map("leftovers")?[rid]) ?? 0 }
    // Suggested make count for next time: sold out → +30% (left money on the
    // table); big leftover (sell-through < 60%) → make about what sold; else keep.
    private func suggestNext(_ rid: String, _ s: FSDoc) -> Int {
        let m = madeActual(rid, s), sold = soldFor(rid, s)
        if soldOutMillis(rid, s) != nil { return Int((Double(max(m, sold)) * 1.3).rounded()) }
        let thru = m > 0 ? Double(sold) / Double(m) : 0
        if thru < 0.6 { return max(sold, Int((Double(sold) * 1.1).rounded())) }
        return m
    }
    private func clockLabel(_ millis: Double) -> String {
        let f = DateFormatter(); f.dateFormat = "h:mma"; f.amSymbol = "am"; f.pmSymbol = "pm"
        return f.string(from: Date(timeIntervalSince1970: millis / 1000))
    }
    private func vaStat(_ label: String, _ val: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.ui(9, .bold)).tracking(0.4).foregroundStyle(Mise.ink4)
            Text(val).font(.ui(15, .heavy)).foregroundStyle(color)
        }
    }
    @ViewBuilder private func vsActualCard(_ s: FSDoc) -> some View {
        let picks = model.products.filter { made($0.id) > 0 || soldFor($0.id, s) > 0 }
        let planRevC = picks.reduce(0) { $0 + Int((Double(made($1.id)) * $1.revPerUnit * 100).rounded()) }
        // Revenue is EX-TAX (locked accounting scheme + HQ2 report parity): back
        // the collected sales tax out of the cash+card total so the app headline
        // matches the HQ2 Plan-vs-Actual report to the dollar.
        let actRevC = (s.int("cashSalesCents") ?? 0) + (s.int("cardSalesCents") ?? 0)
            - (s.int("refundsCents") ?? 0) - (s.int("taxCollectedCents") ?? 0)
        let dRev = planRevC > 0 ? Int((Double(actRevC - planRevC) / Double(planRevC) * 100).rounded()) : 0
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Plan vs Actual").font(.ui(16, .heavy)).foregroundStyle(Mise.ink)
                Spacer()
                Text(s.str("marketName") ?? "market").font(.ui(11, .semibold)).foregroundStyle(Mise.ink4)
            }
            HStack(spacing: 14) {
                vaStat("PLANNED $", money(planRevC), Mise.ink3)
                Image(systemName: "arrow.right").font(.system(size: 11, weight: .bold)).foregroundStyle(Mise.ink5)
                vaStat("ACTUAL $", money(actRevC), Mise.ink)
                Spacer()
                Text("\(dRev >= 0 ? "+" : "")\(dRev)%").font(.ui(15, .heavy))
                    .foregroundStyle(dRev >= 0 ? Mise.success : Mise.danger)
            }.padding(12).background(RoundedRectangle(cornerRadius: 12).fill(Mise.surface2))
            VStack(spacing: 0) {
                ForEach(Array(picks.enumerated()), id: \.element.id) { i, p in
                    let m = madeActual(p.id, s), sold = soldFor(p.id, s), left = leftoverFor(p.id, s)
                    let thru = m > 0 ? Int((Double(sold) / Double(m) * 100).rounded()) : 0
                    let so = soldOutMillis(p.id, s)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(p.name).font(.ui(13, .semibold)).foregroundStyle(Mise.ink).lineLimit(1)
                            Spacer()
                            Text("made \(m) · sold \(sold)").font(.ui(11)).foregroundStyle(Mise.ink3)
                        }
                        HStack(spacing: 6) {
                            Text("\(thru)% sold").font(.ui(10, .bold))
                                .foregroundStyle(thru >= 90 ? Mise.success : (thru < 60 ? Mise.warning : Mise.ink3))
                            if let so {
                                Text("SOLD OUT \(clockLabel(so))").font(.ui(9, .heavy)).foregroundStyle(.white)
                                    .padding(.horizontal, 5).padding(.vertical, 2).background(Capsule().fill(Mise.danger))
                            } else if left > 0 {
                                Text("\(left) left").font(.ui(9, .bold)).foregroundStyle(Mise.warning)
                            }
                            Spacer()
                            Text("next time: \(suggestNext(p.id, s))").font(.ui(11, .bold)).foregroundStyle(Mise.navy)
                        }
                    }.padding(.vertical, 8)
                    if i < picks.count - 1 { Divider().overlay(Mise.rule) }
                }
            }.padding(.horizontal, 12).padding(.vertical, 2).background(RoundedRectangle(cornerRadius: 12).fill(Mise.surface2))
            Text("Full money + waste breakdown in HQ2 → Plan vs Actual.")
                .font(.ui(10)).foregroundStyle(Mise.ink5)
        }.padding(14).background(RoundedRectangle(cornerRadius: 14).fill(Mise.surface))
    }

    // Fill the editor's fields from a plan doc (used by both the synchronous
    // onAppear seed and the async fallback).
    private func seedFrom(_ p: FSDoc) {
        name = p.str("name") ?? "Market plan"
        status = p.str("status") ?? "draft"
        deducted = p.bool("ingredientsDeducted") == true
        reopened = p.bool("reopened") == true
        consumedByShift = !((p.str("consumedByShiftId") ?? "").isEmpty)
        shiftId = p.str("consumedByShiftId") ?? ""
        if let sp = p.dbl("samplePct"), sp > 0 { sampleText = fmtNum(sp) }
        for (k, v) in (p.map("deductedItems") ?? [:]) { if let n = FS.int(v), n > 0 { deductedItems[k] = n } }
        for (k, v) in (p.map("items") ?? [:]) { if let n = FS.int(v), n > 0 { madeText[k] = "\(n)" } }
        // Restore any saved manual pack mix (shared with HQ2). Zero counts are
        // kept — they mark the item as hand-touched (deliberately-none sizes),
        // which keeps the auto suggestion from overwriting the owner's choice.
        for (rid, sizes) in (p.map("packMix") ?? [:]) {
            guard let inner = FS.map(sizes) else { continue }
            var m: [Int: Int] = [:]; for (sz, c) in inner { if let s = Int(sz), let nn = FS.int(c), nn >= 0 { m[s] = nn } }
            if !m.isEmpty { packCounts[rid] = m }
        }
        fromFreezer = MarketPlanModel.planFromFreezer(p)
        planMarket = (p.str("marketLabel") ?? "").trimmingCharacters(in: .whitespaces)
    }

    // ── auto-save (debounced) ────────────────────────────────────────────────
    private func scheduleSave() {
        guard editable else { return }
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(nanoseconds: 600_000_000)
            if Task.isCancelled { return }
            persistNow()
        }
    }
    private func persistNow() {
        guard editable else { return }
        Task { await model.saveItems(planId, name: name, items: items, samplePct: sampleFrac * 100, packMix: manualPM(), fromFreezer: fromFreezer, token: await auth.token()) }
    }
    // Used when leaving the editor: save, THEN refresh the plan list so it shows the
    // saved values (ordered awaits — the patch is done before the list re-reads).
    private func persistAndReload() {
        guard editable else {
            Task { await model.reloadPlans(token: await auth.token()) }   // still refresh (e.g. a locked plan that was just cooked)
            return
        }
        Task {
            let token = await auth.token()
            await model.saveItems(planId, name: name, items: items, samplePct: sampleFrac * 100, packMix: manualPM(), fromFreezer: fromFreezer, token: token)
            await model.reloadPlans(token: token)
        }
    }

    // ── recompute the (heavy) rollup off the keystroke path ──────────────────
    private func scheduleCalc() {
        calcTask?.cancel()
        calcTask = Task {
            try? await Task.sleep(nanoseconds: 200_000_000)
            if Task.isCancelled { return }
            recalcNow()
        }
    }
    private func recalcNow() {
        // Hand-set pack mixes win; every other item gets the sales-history
        // suggestion — so the packaging count (and pack-priced math) is realistic
        // by default instead of worst-casing every unit as its own box.
        let pm = model.effectiveMix(items: items, manual: manualPM())
        calcRoll = model.rollup(items: items, packMix: pm, fromFreezer: fromFreezer)
        calcPkg = model.packagingRollup(items: items, packMix: pm)
        // Same shared helper as the week view, scoped to just THIS plan's items
        // (one "day" in perPlanItems). Shows only components with ≥2 members here.
        calcComps = model.components(perPlanItems: [items])
        displaySample = sampleFrac
    }

    // Start the plan. pullStock=true does the real cook (deducts inventory); false
    // starts it as a run-plan reference and leaves inventory untouched (nothing is
    // pulled, so nothing is ever returned to stock either).
    private func start(pullStock: Bool) async {
        starting = true
        let ok = await model.startPlan(planId, items: items, fromFreezer: fromFreezer, pullStock: pullStock, actor: auth.uid.isEmpty ? "staff" : auth.uid, token: await auth.token())
        starting = false
        if ok {
            status = "started"
            deducted = pullStock
            deductedItems = pullStock ? items : [:]
            // Pulling stock changes every on-hand number in the list above, and
            // the rollup is cached on a debounce — without this the "have"
            // column keeps showing pre-cook stock until the next keystroke.
            if pullStock { recalcNow() }
            Haptics.success()
        }
    }

    // REUSE: duplicate this plan into a fresh draft and open it. Persists any
    // in-flight edits first so the copy captures the latest picks.
    private func duplicate() async {
        duplicating = true
        let token = await auth.token()
        if editable { await model.saveItems(planId, name: name, items: items, samplePct: sampleFrac * 100, packMix: manualPM(), token: token) }
        let newId = await model.duplicatePlan(planId, token: token)
        duplicating = false
        if let newId { openCopyId = newId }
    }

    // REOPEN (unlock): flip a closed/used plan back to editable, then reflect it
    // locally so the editor unlocks without a round-trip. Never re-pulls stock.
    private func reopen() async {
        reopening = true
        await model.reopenPlan(planId, token: await auth.token())
        reopening = false
        reopened = true
        status = (deducted || started) ? "started" : "draft"
        Haptics.success()
    }

    // Pull/return only the difference vs what was last deducted (count correction
    // after cooking). Re-snapshots so the next edit measures from here.
    private func applyChanges() async {
        applying = true
        let ok = await model.applyAdjustment(planId, current: items, actor: auth.uid.isEmpty ? "staff" : auth.uid, token: await auth.token())
        applying = false
        if ok { deductedItems = items; Haptics.success() }
    }

    // ── sections ─────────────────────────────────────────────────────────────
    private var startedBanner: some View {
        let locked = !editable
        let icon = locked ? "lock.fill" : (cooked ? "checkmark.seal.fill" : "doc.text.fill")
        let msg = status == "closed"
                    ? (cooked ? "This plan is closed (archived). Its ingredients were deducted from stock."
                              : "This plan is closed (archived). It was started as a run plan — no stock was pulled.")
                : (consumedByShift && reopened) ? "Reopened for editing. It still feeds the \(runShift?.str("marketName") ?? "market") shift's record, so changes here change that shift's numbers."
                : consumedByShift ? "Used to open a market shift — locked so stock can't be double-counted."
                : cooked ? "Cooked — ingredients were pulled from stock. You can still correct counts below; only the difference is pulled or returned."
                : "Started as a run plan — no stock was pulled, inventory is untouched. Edit freely, or use “Pull stock now” below to deduct it."
        return HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 14)).foregroundStyle(locked ? Mise.ink4 : Mise.success)
            Text(msg)
                .font(.ui(11)).foregroundStyle(Mise.ink3).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 10).fill((locked ? Mise.ink5 : Mise.success).opacity(0.10)))
    }

    private var nameField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("PLAN NAME").font(.ui(11, .bold)).tracking(0.4).foregroundStyle(Mise.ink4)
            TextField("Market plan", text: $name)
                .font(.ui(16, .semibold)).foregroundStyle(Mise.ink).disabled(!editable)
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(RoundedRectangle(cornerRadius: 12).fill(Mise.surface))
        }
    }

    // ── Which market? (series picker — the key to the demand history) ───────
    private var marketRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("WHICH MARKET?").font(.ui(11, .bold)).tracking(0.4).foregroundStyle(Mise.ink4)
            Menu {
                ForEach(model.seriesLabels, id: \.self) { lb in
                    Button {
                        planMarket = lb
                        Task { await model.setPlanMarket(planId, label: lb, token: await auth.token()) }
                    } label: {
                        if lb == planMarket { Label(lb, systemImage: "checkmark") } else { Text(lb) }
                    }
                }
                Divider()
                Button {
                    newMarketName = ""; newMarketAsk = true
                } label: { Label("New market…", systemImage: "plus") }
                if !planMarket.isEmpty {
                    Button(role: .destructive) {
                        planMarket = ""
                        Task { await model.setPlanMarket(planId, label: "", token: await auth.token()) }
                    } label: { Text("Clear") }
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "mappin.and.ellipse").font(.system(size: 13))
                        .foregroundStyle(planMarket.isEmpty ? Mise.ink4 : Mise.navySoft)
                    Text(planMarket.isEmpty ? "Pick a market to see its history" : planMarket)
                        .font(.ui(15, planMarket.isEmpty ? .regular : .semibold))
                        .foregroundStyle(planMarket.isEmpty ? Mise.ink4 : Mise.ink)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 11)).foregroundStyle(Mise.ink4)
                }
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(RoundedRectangle(cornerRadius: 12).fill(Mise.surface))
            }
        }
        // Tag a plan with a market you've never run — the series starts
        // collecting history the day its first shift closes under this name.
        .alert("New market", isPresented: $newMarketAsk) {
            TextField("Market name — e.g. \"Fulton\"", text: $newMarketName)
            Button("Tag plan") {
                let nm = newMarketName.trimmingCharacters(in: .whitespaces)
                guard !nm.isEmpty else { return }
                planMarket = nm
                Task { await model.setPlanMarket(planId, label: nm, token: await auth.token()) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Name it exactly how you'll name the shift when you open the till there — that's how its history links up.")
        }
    }

    // ── First-timer card: a market with NO history yet ───────────────────────
    // Conservative by design (Omar, Jul 16): unknown demand means the costly
    // mistake is over-supply. Borrow a known market's suggestions at 75% as
    // the starting lineup; every count stays editable.
    private var noHistoryCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("NO HISTORY YET — GO IN LIGHT").font(.ui(11, .bold)).tracking(0.4).foregroundStyle(Mise.ink4)
            Text("First time at \(planMarket): demand is unknown, so bring less than you think — selling out beats hauling leftovers home, and the freezer catches real extras. Start from a market you know, trimmed to 75%:")
                .font(.ui(12)).foregroundStyle(Mise.ink3).fixedSize(horizontal: false, vertical: true)
            ForEach(model.seriesLabels.filter { $0.lowercased() != planMarket.lowercased() }, id: \.self) { lb in
                Button {
                    Haptics.tap()
                    guard let ref = model.seriesStats(label: lb) else { return }
                    for (rid, st) in ref.items where st.suggested > 0 {
                        guard model.product(rid) != nil else { continue }
                        madeText[rid] = "\(max(1, Int((Double(st.suggested) * 0.75).rounded(.up))))"
                    }
                    scheduleSave(); scheduleCalc()
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.down.right.circle").font(.system(size: 13)).foregroundStyle(Mise.navySoft)
                        Text("Start from \(lb) at 75%").font(.ui(13, .bold)).foregroundStyle(Mise.navySoft)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 10).stroke(Mise.navySoft.opacity(0.4), lineWidth: 1))
                }.buttonStyle(.plain)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Mise.surface))
    }

    // ── Demand history for the picked series ─────────────────────────────────
    // Sellouts are CENSORED demand (you can't sell what you didn't bring), so
    // they push the suggestion UP; the panel says so out loud.
    private func demandCard(_ st: MarketPlanModel.SeriesStats) -> some View {
        let rows = st.items
            .filter { $0.value.avgSold > 0 || $0.value.avgMade > 0 }
            .sorted { $0.value.avgSold > $1.value.avgSold }
        let disc0 = model.discounts(label: st.label)
        return VStack(alignment: .leading, spacing: 10) {
            Button {
                Haptics.tap(); withAnimation(.snappy(duration: 0.2)) { demandOpen.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Text("HOW \(st.label.uppercased()) USUALLY GOES")
                        .font(.ui(11, .bold)).tracking(0.4).foregroundStyle(Mise.ink4)
                    Spacer(minLength: 0)
                    Text("\(st.shiftCount) market\(st.shiftCount == 1 ? "" : "s")")
                        .font(.ui(10, .semibold)).foregroundStyle(Mise.ink5)
                    Image(systemName: demandOpen ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10, weight: .semibold)).foregroundStyle(Mise.ink4)
                }
            }
            .buttonStyle(.plain)
            if demandOpen {
                let disc = model.discounts(label: st.label)
                HStack(spacing: 14) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("\(Int(st.avgUnitsSold.rounded()))").font(.brand(18)).foregroundStyle(Mise.ink)
                        Text("avg units sold").font(.ui(10)).foregroundStyle(Mise.ink4)
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text("\(Int((st.sellThrough * 100).rounded()))%").font(.brand(18)).foregroundStyle(Mise.ink)
                        Text("sell-through").font(.ui(10)).foregroundStyle(Mise.ink4)
                    }
                    if let d = disc, d.totalUnits > 0 {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("−$\(String(format: "%.0f", Double(d.totalCents) / 100))")
                                .font(.brand(18)).foregroundStyle(Mise.warning)
                            Text("\(d.totalUnits) marked down").font(.ui(10)).foregroundStyle(Mise.ink4)
                        }
                    }
                    Spacer(minLength: 0)
                }
                if let d = disc, d.totalUnits > 0 {
                    Text("Discounted sales count at the fraction of the tag they fetched — a $9 dozen on a $14 tag credits 64% demand. Deeper cut, weaker evidence. Works best when you clear step-down (smallest cut that moves it) and only after full-price sales stall.")
                        .font(.ui(10)).foregroundStyle(Mise.ink5).fixedSize(horizontal: false, vertical: true)
                }
                VStack(spacing: 0) {
                    ForEach(Array(rows.prefix(10).enumerated()), id: \.element.key) { i, kv in
                        let r = kv.value
                        let mdU = disc0?.unitsByItem[kv.key] ?? 0
                        let mdC = disc0?.centsByItem[kv.key] ?? 0
                        HStack(spacing: 8) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(r.name).font(.ui(13, .semibold)).foregroundStyle(Mise.ink).lineLimit(1)
                                Text("avg \(fmtNum(r.avgSold)) sold of \(fmtNum(r.avgMade)) brought · \(r.appearances)×\(r.sellouts > 0 ? " · sold out \(r.sellouts)" : "")")
                                    .font(.ui(10)).foregroundStyle(r.sellouts > 0 ? Mise.warning : Mise.ink5)
                                if mdU > 0 {
                                    let credit = max(0, Double(mdU) - (disc0?.trimByItem[kv.key] ?? 0))
                                    Text("\(mdU) sold marked down · −$\(String(format: "%.2f", Double(mdC) / 100)) · count as ~\(Int(credit.rounded())) full-price")
                                        .font(.ui(10)).foregroundStyle(Mise.warning)
                                }
                                // Display only — the bring chip stays a pure sell
                                // target; samples are the plan's sample-% line.
                                if r.avgSampled >= 0.5 {
                                    Text("usually ~\(Int(r.avgSampled.rounded())) sampled here — make that many extra")
                                        .font(.ui(10)).foregroundStyle(Mise.info)
                                }
                            }
                            Spacer(minLength: 4)
                            if r.suggested > 0 {
                                Text("bring \(r.suggested)")
                                    .font(.ui(11, .bold)).foregroundStyle(Mise.navySoft)
                                    .padding(.horizontal, 8).padding(.vertical, 4)
                                    .background(Capsule().fill(Mise.navySoft.opacity(0.10)))
                            }
                        }
                        .padding(.vertical, 7)
                        if i < min(rows.count, 10) - 1 { Divider().overlay(Mise.ink5.opacity(0.25)) }
                    }
                }
                if editable, rows.contains(where: { $0.value.suggested > 0 }) {
                    Button {
                        Haptics.tap()
                        for (rid, r) in st.items where r.suggested > 0 {
                            guard model.product(rid) != nil else { continue }
                            madeText[rid] = "\(r.suggested)"
                        }
                        scheduleSave(); scheduleCalc()
                    } label: {
                        Text("Use suggested counts")
                            .font(.ui(13, .bold)).foregroundStyle(Mise.navySoft)
                            .frame(maxWidth: .infinity).padding(.vertical, 10)
                            .background(RoundedRectangle(cornerRadius: 10).stroke(Mise.navySoft.opacity(0.4), lineWidth: 1))
                    }
                    Text(st.shiftCount == 1
                         ? "Only 1 day of history — suggestions stick to what provably sold, with no upside guessing. A second day here unlocks real averaging (and the sellout nudge)."
                         : "Sold-out items are nudged up — a sellout means you could've sold more than you brought.")
                        .font(.ui(10)).foregroundStyle(Mise.ink5).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Mise.surface))
    }

    private var pickerSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(consumedByShift ? "WHAT YOU MADE" : "PICK WHAT YOU'LL MAKE").font(.ui(11, .bold)).tracking(0.4).foregroundStyle(Mise.ink4)
            if model.products.isEmpty {
                Text("No market products found. Add pack pricing to a recipe and it'll appear here.")
                    .font(.ui(12)).foregroundStyle(Mise.ink4)
            } else {
                if editable {
                    TextField("Search items…", text: $search)
                        .font(.ui(13)).padding(.horizontal, 12).padding(.vertical, 9)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Mise.surface2))
                }
                ForEach(editable ? filtered : picked) { p in itemRow(p) }
            }
        }
    }

    private func itemRow(_ p: MarketPlanModel.Product) -> some View {
        let n = made(p.id)
        let multiPack = p.packs.count > 1
        let expanded = expandedPacks.contains(p.id)
        return VStack(spacing: 0) {
            headerRow(p, n: n, multiPack: multiPack, expanded: expanded)
            // ❄ freezer row — FULL width beneath the header (living inside the
            // name column crushed the label to one char per line and pushed
            // the row past the screen edge → sideways scrolling).
            if let fz = model.freezer[p.id], fz.units > 0 || (fromFreezer[p.id] ?? 0) > 0 {
                freezerRow(p, fz: fz, n: n)
            }
            if editable, multiPack, n > 0, expanded { packPanel(p).padding(.top, 9) }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 12).fill(Mise.surface))
    }

    private func freezerRow(_ p: MarketPlanModel.Product, fz: Freezer.Item, n: Int) -> some View {
        let using = fromFreezer[p.id] ?? 0
        let cap = min(fz.units, n)
        return HStack(spacing: 4) {
            Text("❄ \(fz.units) frozen · \(fz.frozenAgo)\(fz.isStale ? " ⚠" : "")")
                .font(.ui(10, .semibold)).foregroundStyle(fz.isStale ? Mise.warning : Mise.info)
                .lineLimit(1).layoutPriority(1)
            Spacer(minLength: 4)
            if editable, n > 0 {
                Button {
                    Haptics.tap()
                    let v = max(0, using - 1)
                    fromFreezer[p.id] = v == 0 ? nil : v
                    scheduleSave(); scheduleCalc()
                } label: {
                    Image(systemName: "minus.circle.fill").font(.system(size: 20)).foregroundStyle(using > 0 ? Mise.info : Mise.ink5)
                        .frame(width: 34, height: 36).contentShape(Rectangle())
                }.buttonStyle(.plain).buttonRepeatBehavior(.enabled).disabled(using == 0)
                Text("use \(using)").font(.ui(11, .bold)).foregroundStyle(using > 0 ? Mise.info : Mise.ink4)
                    .frame(minWidth: 40).lineLimit(1)
                Button {
                    Haptics.tap()
                    if using < cap {
                        fromFreezer[p.id] = using + 1
                        scheduleSave(); scheduleCalc()
                    }
                } label: {
                    Image(systemName: "plus.circle.fill").font(.system(size: 20)).foregroundStyle(using < cap ? Mise.info : Mise.ink5)
                        .frame(width: 34, height: 36).contentShape(Rectangle())
                }.buttonStyle(.plain).buttonRepeatBehavior(.enabled).disabled(using >= cap)
                Button {
                    Haptics.tap()
                    fromFreezer[p.id] = using == cap ? nil : cap
                    scheduleSave(); scheduleCalc()
                } label: {
                    Text("all").font(.ui(10, .bold)).foregroundStyle(Mise.info)
                        .frame(width: 30, height: 36).contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
        }
        .padding(.top, 2)
    }

    private func headerRow(_ p: MarketPlanModel.Product, n: Int, multiPack: Bool, expanded: Bool) -> some View {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(p.name).font(.ui(14, .semibold)).foregroundStyle(n > 0 ? Mise.ink : Mise.ink3).lineLimit(1)
                    // ea numbers follow the operator's ACTUAL pack picks when
                    // set (Omar: "show selected pack blended"); otherwise the
                    // all-packs blend, labeled so nobody mistakes it for the
                    // single price the margin board shows.
                    let ea = eaDisplay(p)
                    Text("$\(String(format: "%.2f", ea.cost))/ea cost · $\(String(format: "%.2f", ea.price))/ea price · \(ea.sel ? "your packs" : "blended")")
                        .font(.ui(10)).foregroundStyle(Mise.ink5)
                }
                Spacer(minLength: 8)
                if editable, multiPack, n > 0 {
                    Button {
                        Haptics.tap()
                        withAnimation(.easeInOut(duration: 0.15)) {
                            if expanded { expandedPacks.remove(p.id) } else { expandedPacks.insert(p.id) }
                        }
                    } label: {
                        HStack(spacing: 3) {
                            Image(systemName: isManual(p) ? "square.grid.2x2.fill" : "square.grid.2x2")
                                .font(.system(size: 10))
                            Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.system(size: 8, weight: .bold))
                        }
                        .foregroundStyle(isManual(p) ? Mise.navy : Mise.ink4)
                        .padding(.horizontal, 8).padding(.vertical, 6)
                        .background(Capsule().fill(Mise.navy.opacity(isManual(p) ? 0.12 : 0.05)))
                    }.buttonStyle(.plain)
                }
                if editable {
                    TextField("0", text: Binding(get: { madeText[p.id] ?? "" }, set: { madeText[p.id] = $0 }))
                        .keyboardType(.numberPad).multilineTextAlignment(.center)
                        .font(.ui(16, .bold)).foregroundStyle(Mise.ink).frame(width: 60)
                        .padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Mise.navy.opacity(n > 0 ? 0.12 : 0.05)))
                } else {
                    Text("\(n)").font(.ui(16, .bold)).foregroundStyle(Mise.ink).frame(width: 60)
                }
            }
    }

    // ── Per-item pack mix (mirrors the Market Planner's pack panel) ───────────
    // Units already allocated into packs by a counts map.
    private func packedUnits(_ c: [Int: Int]) -> Int {
        c.reduce(0) { $0 + $1.key * $1.value }
    }
    // Touched = the item HAS a counts map, even if every count is zero — an
    // explicit "no packs of these sizes" is still the owner's choice and must
    // not be silently replaced by the auto suggestion.
    private func isManual(_ p: MarketPlanModel.Product) -> Bool {
        packCounts[p.id] != nil
    }
    // What the pack panel SHOWS: the hand-set mix when there is one, otherwise
    // the sales-history suggestion (a display default — NOTHING is saved to the
    // plan doc until the user actually edits a count).
    private func displayCounts(_ p: MarketPlanModel.Product) -> [Int: Int] {
        isManual(p) ? (packCounts[p.id] ?? [:]) : model.suggestedMix(rid: p.id, qty: made(p.id))
    }
    // The manual pack mix to feed the rollup + save: each touched item's counts
    // as-is, zeros included — a zeroed size is a deliberate deselection and the
    // key's presence is what keeps effectiveMix from re-filling it.
    // Per-unit price/cost for the item row: weighted by the SELECTED pack
    // counts when the operator has set them, else the all-packs blend.
    private func eaDisplay(_ p: MarketPlanModel.Product) -> (cost: Double, price: Double, sel: Bool) {
        if let m = packCounts[p.id], !m.isEmpty {
            var rev = 0.0, cost = 0.0, units = 0
            for (sz, cnt) in m where cnt > 0 {
                if let pk = p.packs.first(where: { $0.qty == sz }) {
                    rev += Double(cnt) * pk.price; cost += Double(cnt) * pk.cost; units += cnt * pk.qty
                }
            }
            if units > 0 { return (cost / Double(units), rev / Double(units), true) }
        }
        return (p.loadedPerUnit, p.revPerUnit, false)
    }
    private func manualPM() -> [String: [Int: Int]] { packCounts }
    // Step a pack count up/down. "+" is capped so packs can't exceed how many you
    // made (you can't sell more than you brought). The first touch ADOPTS the
    // on-screen suggestion as hand-set, then edits it — so tapping + on a
    // prefilled panel tweaks what you see, not a blank slate. Zeroing every
    // count STAYS hand-set ("deliberately no packs") — only the explicit
    // "Auto mix" button goes back to the suggestion.
    private func stepPack(_ p: MarketPlanModel.Product, _ qty: Int, _ delta: Int) {
        var c = displayCounts(p)
        let next = (c[qty] ?? 0) + delta
        if next < 0 { return }
        if delta > 0, packedUnits(c) + qty > made(p.id) { Haptics.warning(); return }
        c[qty] = next
        packCounts[p.id] = c
        scheduleSave(); scheduleCalc()
    }
    private func setPack(_ p: MarketPlanModel.Product, _ qty: Int, _ value: Int) {
        var c = displayCounts(p)
        // A focus/no-op write of the same suggested value must NOT silently turn
        // the suggestion into a hand-set mix — only a real change adopts it.
        if !isManual(p), (c[qty] ?? 0) == max(0, value) { return }
        c[qty] = max(0, value)
        packCounts[p.id] = c
        scheduleSave(); scheduleCalc()
    }
    // Materialize the suggestion (historical mix → largest pack fallback) into a
    // hand-set mix, so you can tweak from a sensible starting point.
    private func fillBestMix(_ p: MarketPlanModel.Product) {
        let m = made(p.id); guard m > 0 else { return }
        let c = model.suggestedMix(rid: p.id, qty: m)
        packCounts[p.id] = c.values.contains { $0 > 0 } ? c : nil
        scheduleSave(); scheduleCalc()
    }
    private func packPanel(_ p: MarketPlanModel.Product) -> some View {
        let m = made(p.id)
        let counts = displayCounts(p)
        let packed = packedUnits(counts)
        let leftover = max(0, m - packed)
        return VStack(alignment: .leading, spacing: 6) {
            Text("Set how many of each pack you'll sell — the cost, packaging & forecast update. Prefilled from your sales history until you edit.")
                .font(.ui(9)).foregroundStyle(Mise.ink5).fixedSize(horizontal: false, vertical: true)
            ForEach(p.packs, id: \.qty) { b in
                let c = counts[b.qty] ?? 0
                let lbl = b.qty == 1 ? "single" : "\(b.qty)-pack"
                HStack {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(lbl).font(.ui(11, .semibold)).foregroundStyle(c > 0 ? Mise.ink : Mise.ink3)
                        Text(c > 0 ? "= \(c * b.qty) units" : "$\(String(format: "%.2f", b.price))/pack").font(.ui(8)).foregroundStyle(Mise.ink5)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 7) {
                        stepBtn("minus.circle.fill", enabled: c > 0) { stepPack(p, b.qty, -1) }
                        TextField("0", text: Binding(
                            get: { c > 0 ? "\(c)" : "" },
                            set: { setPack(p, b.qty, Int($0.filter(\.isNumber)) ?? 0) }))
                            .keyboardType(.numberPad).multilineTextAlignment(.center)
                            .font(.ui(15, .bold)).foregroundStyle(c > 0 ? Mise.ink : Mise.ink5)
                            .frame(width: 46).padding(.vertical, 4)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Mise.navy.opacity(c > 0 ? 0.10 : 0.04)))
                        stepBtn("plus.circle.fill", enabled: m > 0 && packed + b.qty <= m) { stepPack(p, b.qty, 1) }
                    }.frame(width: 116, alignment: .trailing)
                }
            }
            Divider().overlay(Mise.rule)
            Text(isManual(p)
                 ? "Packing \(packed) of \(m) made" + (leftover > 0 ? " · \(leftover) priced at the blended rate" : "")
                 : (counts.isEmpty
                    ? "No pack fits yet — enter how many you'll make and the mix fills in"
                    : "Auto from sales history — packing \(packed) of \(m) made" + (leftover > 0 ? " · \(leftover) as singles" : "") + ". Edit any count to set your own."))
                .font(.ui(10, .semibold)).foregroundStyle(isManual(p) ? Mise.ink2 : Mise.ink4)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                Button { Haptics.tap(); withAnimation(.easeInOut(duration: 0.15)) { fillBestMix(p) } } label: {
                    HStack(spacing: 4) { Image(systemName: "sparkles").font(.system(size: 9)); Text("Fill best mix").font(.ui(10, .semibold)) }
                        .foregroundStyle(Mise.navy).padding(.horizontal, 8).padding(.vertical, 4)
                        .background(Capsule().fill(Mise.navy.opacity(0.10)))
                }.buttonStyle(.plain).disabled(m == 0)
                if isManual(p) {
                    // The ONE road back to the auto suggestion: drops the hand-set
                    // marker entirely (zeroing counts keeps it — that's a choice).
                    Button { Haptics.tap(); withAnimation(.easeInOut(duration: 0.15)) { packCounts[p.id] = nil; scheduleSave(); scheduleCalc() } } label: {
                        HStack(spacing: 4) { Image(systemName: "arrow.uturn.backward").font(.system(size: 9)); Text("Auto mix").font(.ui(10, .semibold)) }
                            .foregroundStyle(Mise.ink4)
                    }.buttonStyle(.plain)
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Mise.surface2))
    }
    private func stepBtn(_ icon: String, enabled: Bool, _ action: @escaping () -> Void) -> some View {
        Button { action() } label: {
            Image(systemName: icon).font(.system(size: 22))
                .foregroundStyle(enabled ? Mise.navy : Mise.ink5.opacity(0.35))
        }.buttonStyle(.plain).disabled(!enabled)
    }

    // Full net-profit forecast, mirroring the HQ2 plan summary: expected NET is the
    // headline; the ledger and break-even use history-grounded assumptions.
    // PAST TENSE once a market shift has USED this plan (consumedByShiftId):
    // the headline flips to the shift's ACTUAL net (frozen books) — or "planned
    // net" until the books freeze — and the what-if ledger/scenarios retire
    // (the Plan-vs-Actual card above tells the real story).
    private func summaryCard(_ r: MarketPlanModel.Rollup) -> some View {
        let hist = model.assumptions()
        let F = model.forecast(r, sampleFrac: displaySample, hist: hist, sellThrough: hist.sellThrough)
        let marginPct = F.revenue > 0 ? Int((F.margin / F.revenue * 100).rounded()) : 0
        let netPct = F.revenue > 0 ? Int((F.net / F.revenue * 100).rounded()) : 0
        let stPct = Int((hist.sellThrough * 100).rounded())
        let actNetC: Int? = consumedByShift ? runShift.flatMap { MarketPlanModel.actualNetCents($0) } : nil
        let actRevC: Int = runShift.map { FrontModel.shiftSalesCents($0) - ($0.int("taxCollectedCents") ?? 0) } ?? 0
        return VStack(spacing: 10) {
            HStack {
                statBox("\(r.unitsTotal)", consumedByShift ? "items made" : "items to make", Mise.ink)
                statBox("$\(String(format: "%.2f", r.cogs))", consumedByShift ? "planned cost" : "cost", Mise.navy)
                if let a = actNetC {
                    netBox(Double(a) / 100, actRevC > 0 ? Int((Double(a) / Double(actRevC) * 100).rounded()) : 0, label: "actual net")
                } else {
                    netBox(F.net, netPct, label: consumedByShift ? "planned net" : "expected net")
                }
            }
            if editable { samplesField(F) }
            if consumedByShift {
                usedFootnote(actNetC)
            } else {
                if r.revenue > 0 { ledger(r, hist, F, marginPct, netPct, stPct) }
                warnings(r)
            }
        }
        .padding(14).background(RoundedRectangle(cornerRadius: 14).fill(Mise.surface))
    }
    private func netBox(_ net: Double, _ pct: Int, label: String) -> some View {
        VStack(spacing: 2) {
            Text((net < 0 ? "−$" : "$") + "\(Int(abs(net).rounded()))").font(.ui(18, .heavy)).foregroundStyle(net >= 0 ? Mise.success : Mise.danger).lineLimit(1).minimumScaleFactor(0.6)
            Text("\(pct)% margin").font(.ui(9, .semibold)).foregroundStyle(Mise.ink5).lineLimit(1).minimumScaleFactor(0.6)
            Text(label).font(.ui(9)).foregroundStyle(Mise.ink4)
        }.frame(maxWidth: .infinity)
    }
    // Where a used plan's headline number comes from, plus the goal check when
    // a net-$ goal is set in settings/marketPlanner.
    private func usedFootnote(_ actNetC: Int?) -> some View {
        let market = runShift?.str("marketName") ?? "market"
        let txt: String
        if let a = actNetC {
            var t = "Actual net from the \(market) shift's closed books — the pre-market projection is retired. Planned-vs-actual detail is in the card above."
            if model.cfgGoal > 0 {
                let d = Double(a) / 100 - model.cfgGoal
                t += " Goal $\(Int(model.cfgGoal.rounded())): \(d >= 0 ? "beat it by" : "missed by") $\(Int(abs(d).rounded()))."
            }
            txt = t
        } else {
            txt = "This plan ran the \(market) shift. The real net lands when the market's books close; until then the planned figure stands."
        }
        return Text(txt).font(.ui(9)).foregroundStyle(Mise.ink5)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
    @ViewBuilder private func samplesField(_ F: MarketPlanModel.Forecast) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "gift").font(.system(size: 11)).foregroundStyle(Mise.ink4)
            Text("Samples").font(.ui(11, .semibold)).foregroundStyle(Mise.ink3)
            TextField("0", text: $sampleText)
                .keyboardType(.numberPad).multilineTextAlignment(.center)
                .font(.ui(13, .bold)).foregroundStyle(Mise.ink).frame(width: 38)
                .padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 8).fill(Mise.surface2))
            Text("%").font(.ui(11, .semibold)).foregroundStyle(Mise.ink4)
            Spacer(minLength: 0)
            if F.samplesCount > 0 {
                Text("\(F.samplesCount) free · \(F.sellable) to sell").font(.ui(10)).foregroundStyle(Mise.ink4)
            }
        }
    }
    // The P&L ledger + scenarios + break-even + assumptions, in one column.
    @ViewBuilder private func ledger(_ r: MarketPlanModel.Rollup, _ hist: MarketPlanModel.Assumptions, _ F: MarketPlanModel.Forecast, _ marginPct: Int, _ netPct: Int, _ stPct: Int) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            plRow("Revenue", sub: "~\(F.sold) sold · \(stPct)% sell-through", "$\(String(format: "%.2f", F.revenue))", bold: true)
            let foodPct = F.revenue > 0 ? Int((F.foodCost / F.revenue * 100).rounded()) : 0
            plRow("Food cost", sub: "\(foodPct)% of rev", "$\(String(format: "%.2f", F.foodCost))", minus: true, indent: true)
            plRow("Packaging", "$\(String(format: "%.2f", F.pkgCost))", minus: true, indent: true)
            plRow("Labor + overhead", "$\(String(format: "%.2f", F.laborOhCost))", minus: true, indent: true)
            plRow("Product margin", sub: "\(marginPct)% · rev − COGS", "$\(String(format: "%.2f", F.margin))", bold: true, rule: true)
            plRow("Samples · marketing", sub: "\(F.samplesCount) free", "$\(String(format: "%.2f", F.samplesCost))", minus: true)
            plRow("Waste · unsold", sub: "\(F.leftover) left", "$\(String(format: "%.2f", F.wasteCost))", minus: true)
            plRow("Card fees · card/Venmo", sub: "\(Int((hist.cardPct * 100).rounded()))% card", "$\(String(format: "%.2f", F.processing))", minus: true)
            plRow("Booth fee", "$\(String(format: "%.2f", F.booth))", minus: true)
            plRow("Expected net profit", sub: "\(netPct)%", "$\(String(format: "%.2f", F.net))", bold: true, good: F.net >= 0, neg: F.net < 0, rule: true)
            // vs the per-market net-$ goal (ported from the retired Forecast screen).
            if model.cfgGoal > 0 {
                let d = F.net - model.cfgGoal
                plRow("vs $\(Int(model.cfgGoal.rounded())) goal", (d >= 0 ? "+$" : "−$") + "\(Int(abs(d).rounded()))",
                      good: d >= 0, neg: d < 0)
            }
            scenRow(r, hist)
            breakEvenLine(r, hist, F)
            assumptionsFooter(hist, stPct)
        }
        .padding(.top, 2)
    }
    private func plRow(_ label: String, sub: String? = nil, _ value: String,
                       bold: Bool = false, minus: Bool = false, indent: Bool = false,
                       good: Bool = false, neg: Bool = false, rule: Bool = false) -> some View {
        VStack(spacing: 0) {
            if rule { Divider().overlay(Mise.rule).padding(.vertical, 4) }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(label).font(.ui(13, bold ? .bold : .regular)).foregroundStyle(bold ? Mise.ink : Mise.ink3)
                if let sub { Text(sub).font(.ui(10)).foregroundStyle(Mise.ink5) }
                Spacer(minLength: 6)
                Text((minus ? "−" : "") + value).font(.ui(13, bold ? .bold : .regular))
                    .foregroundStyle(good ? Mise.success : (neg ? Mise.danger : (bold ? Mise.ink : Mise.ink3)))
            }
            .padding(.leading, indent ? 12 : 0).padding(.vertical, 3)
        }
    }
    private func scenRow(_ r: MarketPlanModel.Rollup, _ hist: MarketPlanModel.Assumptions) -> some View {
        HStack(spacing: 6) {
            scenBox("Slow", 0.6, model.forecast(r, sampleFrac: displaySample, hist: hist, sellThrough: 0.6).net)
            scenBox("Steady", 0.8, model.forecast(r, sampleFrac: displaySample, hist: hist, sellThrough: 0.8).net)
            scenBox("Strong", 1.0, model.forecast(r, sampleFrac: displaySample, hist: hist, sellThrough: 1.0).net)
        }.padding(.top, 11)
    }
    private func scenBox(_ label: String, _ frac: Double, _ net: Double) -> some View {
        VStack(spacing: 2) {
            Text(label).font(.ui(10, .bold)).foregroundStyle(Mise.ink3)
            Text("\(Int(frac * 100))% sold").font(.ui(8)).foregroundStyle(Mise.ink5)
            Text((net < 0 ? "−$" : "$") + "\(Int(abs(net).rounded()))").font(.ui(14, .heavy)).foregroundStyle(net >= 0 ? Mise.success : Mise.danger)
        }.frame(maxWidth: .infinity).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 9).fill(Mise.surface2))
    }
    // Break-even: units that must sell for net to hit $0 (net is linear in units).
    @ViewBuilder private func breakEvenLine(_ r: MarketPlanModel.Rollup, _ hist: MarketPlanModel.Assumptions, _ F: MarketPlanModel.Forecast) -> some View {
        let made = r.unitsTotal
        let perRev = made > 0 ? r.revenue / Double(made) : 0
        let perCogs = made > 0 ? r.cogs / Double(made) : 0
        let perFood = made > 0 ? r.buildCost / Double(made) : 0
        let marginal = (perRev - perCogs) + perFood - perRev * hist.procRate
        let fixedLoad = perFood * Double(F.samplesCount) + perFood * Double(F.sellable) + hist.booth
        if F.sellable > 0 {
            if marginal <= 0 {
                beBanner("Every sale loses money at these prices — check pricing or cost before this market.", Mise.danger)
            } else if fixedLoad / marginal > Double(F.sellable) {
                let short = -model.forecast(r, sampleFrac: displaySample, hist: hist, sellThrough: 1).net
                beBanner("Even a full sellout won't cover the day — about $\(String(format: "%.2f", short)) short.", Mise.warning)
            } else {
                let beSold = fixedLoad / marginal
                let bePct = Int((beSold / Double(F.sellable) * 100).rounded())
                let clears = hist.sellThrough >= beSold / Double(F.sellable)
                beBreakEven(bePct, Int(beSold.rounded(.up)), F.sellable, clears, Int((hist.sellThrough * 100).rounded()))
            }
        }
    }
    private func beBreakEven(_ pct: Int, _ units: Int, _ sellable: Int, _ clears: Bool, _ avgPct: Int) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "scalemass").font(.system(size: 11)).foregroundStyle(Mise.ink3)
            (Text("Break-even: sell ").font(.ui(11, .semibold)).foregroundStyle(Mise.ink2)
             + Text("~\(pct)%").font(.ui(11, .bold)).foregroundStyle(Mise.success)
             + Text(" (≈\(units) of \(sellable)) to cover the day. ").font(.ui(11, .semibold)).foregroundStyle(Mise.ink2)
             + Text(clears ? "Your ~\(avgPct)% average clears this comfortably." : "That's above your ~\(avgPct)% average — a soft day could dip below cost.").font(.ui(11)).foregroundStyle(Mise.ink4))
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 10).fill(Mise.success.opacity(0.07)))
        .padding(.top, 10)
    }
    private func beBanner(_ text: String, _ color: Color) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 11)).foregroundStyle(color)
            Text(text).font(.ui(11, .semibold)).foregroundStyle(color).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 10).fill(color.opacity(0.09)))
        .padding(.top, 10)
    }
    private func assumptionsFooter(_ hist: MarketPlanModel.Assumptions, _ stPct: Int) -> some View {
        let mix = hist.haveMix
            ? "\(Int((hist.cardPct * 100).rounded()))% card · \(Int((hist.cashPct * 100).rounded()))% cash" + (hist.venmoPct > 0.005 ? " · \(Int((hist.venmoPct * 100).rounded()))% Venmo" : "")
            : "60% card / 40% cash (assumed)"
        let txt = hist.n > 0
            ? "Based on your last \(hist.n) market\(hist.n == 1 ? "" : "s") — \(stPct)% sell-through · \(mix) · $\(Int(hist.booth.rounded())) booth. Unit costs exclude card fees — the P&L adds them as their own line, at the rate your past markets actually paid (tender mix above). Scored the same way a closed market is."
            : "No closed markets yet — using defaults (85% sell-through, 60% card, $\(Int(hist.booth.rounded())) booth). These sharpen after your first close."
        return Text(txt).font(.ui(9)).foregroundStyle(Mise.ink5).fixedSize(horizontal: false, vertical: true).padding(.top, 9)
    }
    @ViewBuilder private func warnings(_ r: MarketPlanModel.Rollup) -> some View {
        if r.shortCount > 0 || r.untrackedCount > 0 || r.reviewCount > 0 {
            VStack(alignment: .leading, spacing: 3) {
                if r.shortCount > 0 {
                    warnLine("triangle.exclamationmark.fill", Mise.warning, "\(r.shortCount) ingredient\(r.shortCount == 1 ? "" : "s") short of what this plan needs")
                }
                if r.untrackedCount > 0 {
                    warnLine("questionmark.circle", Mise.ink4, "\(r.untrackedCount) ingredient\(r.untrackedCount == 1 ? "" : "s") not in your stock list — can't cost or deduct")
                }
                if r.reviewCount > 0 {
                    warnLine("ruler", Mise.ink4, "\(r.reviewCount) line\(r.reviewCount == 1 ? "" : "s") with a unit mismatch — review, not auto-deducted")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func statBox(_ v: String, _ l: String, _ c: Color) -> some View {
        VStack(spacing: 3) {
            Text(v).font(.ui(18, .heavy)).foregroundStyle(c).lineLimit(1).minimumScaleFactor(0.6)
            Text(l).font(.ui(9)).foregroundStyle(Mise.ink4).multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity)
    }
    private func warnLine(_ icon: String, _ color: Color, _ text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon).font(.system(size: 10)).foregroundStyle(color)
            Text(text).font(.ui(10)).foregroundStyle(Mise.ink3).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func ingredientsCard(_ r: MarketPlanModel.Rollup) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(consumedByShift ? "INGREDIENTS USED" : "INGREDIENTS NEEDED").font(.ui(11, .bold)).tracking(0.4).foregroundStyle(Mise.ink4)
            ForEach(r.lines) { l in
                // Once the plan's market has run, "short" is history — the stock
                // already moved, so the buy-list warnings retire with the tense.
                let short = l.isShort && !consumedByShift
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(l.name).font(.ui(13, .semibold)).foregroundStyle(Mise.ink).lineLimit(1)
                        if l.matched {
                            Text("have \(fmtQty(l.onHand, l.stockUnit))" + (l.vendor.isEmpty ? "" : " · \(l.vendor)"))
                                .font(.ui(9)).foregroundStyle(short ? Mise.warning : Mise.ink5)
                        } else {
                            Text("not in stock list").font(.ui(9)).foregroundStyle(Mise.ink5)
                        }
                    }
                    Spacer(minLength: 6)
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(l.matched ? "\(consumedByShift ? "used" : "need") \(fmtQty(l.needed, l.stockUnit))" : "—")
                            .font(.ui(12, .semibold)).foregroundStyle(short ? Mise.warning : Mise.ink2)
                        if l.cost > 0 { Text("$\(String(format: "%.2f", l.cost))").font(.ui(10)).foregroundStyle(Mise.ink4) }
                    }
                    if short {
                        Text("SHORT").font(.ui(8, .bold)).foregroundStyle(Mise.warning)
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(Capsule().fill(Mise.warning.opacity(0.12)))
                    }
                }
                .padding(.vertical, 6)
                if l.id != r.lines.last?.id { Divider().overlay(Mise.rule) }
            }
        }
        .padding(14).background(RoundedRectangle(cornerRadius: 14).fill(Mise.surface))
    }

    // ── AI component batches (THIS plan) ──────────────────────────────────────
    // The auto-detected shared sub-recipes THIS plan builds, with how many
    // consolidated batches it needs (per-plan ceil — same shared model.components
    // the week view uses) and make-ahead hints. Read-only, nothing deducts.
    private var componentsCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text("COMPONENTS").font(.ui(11, .bold)).tracking(0.4).foregroundStyle(Mise.ink4)
                Text("AUTO").font(.ui(9, .heavy)).tracking(0.6)
                    .foregroundStyle(AutoAccent.ink)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Capsule().fill(AutoAccent.bg))
                    .overlay(Capsule().strokeBorder(AutoAccent.line.opacity(0.45), lineWidth: 1))
                Spacer()
            }.padding(.bottom, 8)
            Text("Shared sub-recipes the detector found in this plan — one consolidated build instead of one per recipe.")
                .font(.ui(10)).foregroundStyle(Mise.ink5).padding(.bottom, 10)
            ForEach(calcComps) { comp in componentRow(comp) }
        }
        .padding(14).background(RoundedRectangle(cornerRadius: 14).fill(Mise.surface))
    }

    private func componentRow(_ c: MarketPlanModel.ComponentRow) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(c.name).font(.ui(13, .semibold)).foregroundStyle(Mise.ink).lineLimit(1)
                Text("feeds " + c.memberNames.joined(separator: " + "))
                    .font(.ui(10)).foregroundStyle(Mise.ink5).lineLimit(2)
                // dough weight: per batch + the plan's total mass (batches × weight)
                if let w = c.weightG, w > 0 {
                    Text("\(c.weightPrefix)\(fmtGrams(w))/batch · plan \(c.weightPrefix)\(fmtQty(w * Double(c.batches), "g"))")
                        .font(.ui(10, .semibold)).foregroundStyle(Mise.ink3)
                    ForEach(c.weighOuts) { wo in
                        Text(wo.line(prefix: c.weightPrefix))
                            .font(.ui(9.5)).foregroundStyle(Mise.ink4)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                // equipment rounds: "18 batches → 5 mixer rounds of 4"
                if let r = c.rounds {
                    Text(r).font(.ui(10, .semibold)).foregroundStyle(Mise.navy)
                }
                if c.prepAhead {
                    Text("make-ahead (D-1)" + ((c.holdDays ?? 0) > 0 ? " · holds \(c.holdDays!)d" : ""))
                        .font(.ui(10, .semibold)).foregroundStyle(AutoAccent.ink)
                }
            }
            Spacer(minLength: 6)
            Text("\(c.batches) batch\(c.batches == 1 ? "" : "es")")
                .font(.ui(13, .bold)).foregroundStyle(Mise.ink)
        }
        .padding(.vertical, 7)
        .overlay(alignment: .bottom) { Rectangle().fill(Mise.ink5.opacity(0.08)).frame(height: 1) }
    }

    // Packaging the plan needs (boxes, stickers, containers) — read-only, in the
    // same shape as the ingredient list: need vs have in pieces, and when short,
    // what to BUY in whole purchase units (you buy a sheet, not a sticker).
    private func packagingCard(_ r: MarketPlanModel.PkgRollup) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("PACKAGING").font(.ui(11, .bold)).tracking(0.4).foregroundStyle(Mise.ink4)
                Spacer()
                if !r.lines.isEmpty {
                    Text("≈$\(String(format: "%.2f", r.totalCost)) this plan" + (r.shortCount > 0 && !consumedByShift ? " · \(r.shortCount) short" : ""))
                        .font(.ui(10, .bold)).foregroundStyle(r.shortCount > 0 && !consumedByShift ? Mise.warning : Mise.ink4)
                }
            }
            if r.lines.isEmpty {
                Text("no packaging linked — link boxes/stickers to items in HQ")
                    .font(.ui(12)).foregroundStyle(Mise.ink4)
            } else {
                ForEach(r.lines) { l in
                    // Post-market the tense flips (used, not need) and the
                    // buy-list hints retire — the shift already happened.
                    let verb = consumedByShift ? "used" : "need"
                    let short = l.isShort && !consumedByShift
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(l.name + (l.pieceName == "pc" ? "" : " · \(l.pieceName)s"))
                                .font(.ui(13, .semibold)).foregroundStyle(Mise.ink).lineLimit(1)
                            if l.matched, l.multiPiece {
                                Text("\(verb) \(l.unitsLabel(l.neededUnits)) · have \(l.unitsLabel(l.onHandUnits)) — \(fmtNum(l.neededPieces)) \(l.pieceName)s")
                                    .font(.ui(9)).foregroundStyle(short ? Mise.warning : Mise.ink5)
                            } else if l.matched {
                                Text("\(verb) \(fmtNum(l.neededPieces)) · have \(fmtNum(l.onHandPieces)) \(l.pieceName)")
                                    .font(.ui(9)).foregroundStyle(short ? Mise.warning : Mise.ink5)
                            } else {
                                Text("\(verb) \(fmtNum(l.neededPieces)) · not in packaging list")
                                    .font(.ui(9)).foregroundStyle(Mise.ink5)
                            }
                            // PRINT TIME: printed sheets (needed SHEETS × per-sheet minutes).
                            if l.printMinutes > 0, let t = fmtDuration(l.printMinutes) {
                                Text("≈\(t) to print").font(.ui(9, .semibold)).foregroundStyle(AutoAccent.ink)
                            }
                        }
                        Spacer(minLength: 6)
                        if short {
                            VStack(alignment: .trailing, spacing: 1) {
                                Text("buy \(Int(l.buyUnits)) \(l.unitName)\(Int(l.buyUnits) == 1 ? "" : "s")")
                                    .font(.ui(12, .semibold)).foregroundStyle(Mise.warning)
                                if l.buyCost > 0 { Text("$\(String(format: "%.2f", l.buyCost))").font(.ui(10)).foregroundStyle(Mise.warning) }
                            }
                        } else if l.matched, l.neededCost > 0 {
                            Text("$\(String(format: "%.2f", l.neededCost))").font(.ui(10)).foregroundStyle(Mise.ink4)
                        }
                    }
                    .padding(.vertical, 6)
                    if l.id != r.lines.last?.id { Divider().overlay(Mise.rule) }
                }
                // per-recipe breakdown of the same demand (Omar's "by SKU" view)
                PkgBySkuSection(bySku: r.bySku)
            }
        }
        .padding(14).background(RoundedRectangle(cornerRadius: 14).fill(Mise.surface))
    }

    @ViewBuilder private var actionRow: some View {
        if !started {
            // Draft → start. The confirm dialog asks whether to pull stock or start
            // it as a run-plan reference that leaves inventory alone.
            Button {
                Haptics.tap(); confirmStart = true
            } label: {
                Text(starting ? "Starting…" : "Start plan")
                    .font(.ui(16, .heavy)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 15)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Mise.navy))
            }.buttonStyle(Pressable()).disabled(starting || items.isEmpty)
            Text("You'll choose whether to pull ingredients from stock (a real cook) or just start it as a run plan (inventory untouched).")
                .font(.ui(10)).foregroundStyle(Mise.ink5).frame(maxWidth: .infinity, alignment: .center)
            reuseButton
        } else if editable {
            if cooked {
                // Cooked + still editable → apply count corrections (pull/return the
                // difference), and close when done.
                if hasUnappliedChanges {
                    Button {
                        Haptics.tap(); Task { await applyChanges() }
                    } label: {
                        Text(applying ? "Adjusting…" : "Apply changes · adjust stock by the difference")
                            .font(.ui(15, .heavy)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                            .background(RoundedRectangle(cornerRadius: 14).fill(Mise.navy))
                    }.buttonStyle(Pressable()).disabled(applying)
                    Text("Pulls more (or returns) only the change since you cooked.")
                        .font(.ui(10)).foregroundStyle(Mise.ink5).frame(maxWidth: .infinity, alignment: .center)
                }
            } else {
                // Started as a run plan (no stock pulled) → optionally pull now.
                Button {
                    Haptics.tap(); confirmPull = true
                } label: {
                    Text(starting ? "Pulling…" : "Pull stock now · deduct ingredients")
                        .font(.ui(15, .heavy)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(RoundedRectangle(cornerRadius: 14).fill(Mise.navy))
                }.buttonStyle(Pressable()).disabled(starting || items.isEmpty)
                Text("Optional — deducts the ingredients from inventory. Leave it be to keep this a stock-free run plan.")
                    .font(.ui(10)).foregroundStyle(Mise.ink5).frame(maxWidth: .infinity, alignment: .center)
            }
            Button {
                Haptics.tap(); Task { await model.closePlan(planId, token: await auth.token()); dismiss() }
            } label: {
                Text("Close plan").font(.ui(15, .bold)).foregroundStyle(Mise.ink3)
                    .frame(maxWidth: .infinity).padding(.vertical, 13)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Mise.surface2))
            }.buttonStyle(.plain)
            reuseButton
        } else {
            // Locked (closed, or used by a shift and not yet reopened) → the two safe
            // ways forward: unlock to edit, or reuse as a brand-new draft.
            reopenButton
            reuseButton
        }
    }

    // REUSE — always available. Copies this lineup into a fresh draft (no stock is
    // pulled until that draft is started), then opens it.
    private var reuseButton: some View {
        VStack(spacing: 4) {
            Button {
                Haptics.tap(); Task { await duplicate() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "doc.on.doc")
                    Text(duplicating ? "Copying…" : "Reuse as new plan")
                }
                .font(.ui(15, .bold)).foregroundStyle(Mise.navy)
                .frame(maxWidth: .infinity).padding(.vertical, 13)
                .background(RoundedRectangle(cornerRadius: 14).fill(Mise.navy.opacity(0.10)))
            }.buttonStyle(.plain).disabled(duplicating)
            Text("Starts a fresh draft with the same items — no ingredients are pulled until you start it.")
                .font(.ui(10)).foregroundStyle(Mise.ink5).frame(maxWidth: .infinity, alignment: .center)
        }
    }

    // REOPEN — only on a locked plan. A shift-used plan first shows the risk warning.
    private var reopenButton: some View {
        VStack(spacing: 4) {
            Button {
                Haptics.tap()
                if consumedByShift { confirmReopen = true } else { Task { await reopen() } }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "lock.open")
                    Text(reopening ? "Reopening…" : "Reopen to edit")
                }
                .font(.ui(15, .heavy)).foregroundStyle(.white)
                .frame(maxWidth: .infinity).padding(.vertical, 14)
                .background(RoundedRectangle(cornerRadius: 14).fill(Mise.navy))
            }.buttonStyle(Pressable()).disabled(reopening)
            Text(consumedByShift
                 ? "Unlocks this plan to edit again. It stays linked to its market shift — its numbers feed that shift's record."
                 : "Unlocks this closed plan to edit again. No stock is pulled by reopening.")
                .font(.ui(10)).foregroundStyle(Mise.ink5).frame(maxWidth: .infinity, alignment: .center)
        }
    }
}

// ============================================================================
//  PACKAGING · BY SKU — expandable per-recipe breakdown of the same demand the
//  packaging rollup sums ("swole rolls: 5" hinged ×50 · sticker sheets ~4 · …").
//  Shared by the plan editor's packaging card and the Week totals packaging
//  card. Sheets-first per line (multi-piece materials read in purchase units).
//  DISPLAY ONLY — the aggregate lines above it stay the buy-list truth.
// ============================================================================
// TIME roll-up card — make (components) + cook (recipe equipment) + print
// (printed packaging), broken out with a total. Display only; nothing is
// scheduled or deducted. Renders nothing when no piece has time data. Shared
// by the single-plan editor and the Week totals view.
struct TimeCard: View {
    let time: MarketPlanModel.TimeRollup

    private var parts: [(String, Bool)] {
        var p: [(String, Bool)] = []
        if time.make > 0, let t = fmtDuration(time.make)   { p.append(("make ≈\(t)", false)) }
        if time.cook > 0, let t = fmtDuration(time.cook)   { p.append(("cook ≈\(t)", false)) }
        if time.print > 0, let t = fmtDuration(time.print) { p.append(("print ≈\(t)", false)) }
        if let t = fmtDuration(time.total) { p.append(("total ≈\(t)", true)) }
        return p
    }

    var body: some View {
        if time.hasAny {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text("TIME").font(.ui(11, .bold)).tracking(0.4).foregroundStyle(Mise.ink4)
                    Text("EST").font(.ui(9, .heavy)).tracking(0.6).foregroundStyle(AutoAccent.ink)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(AutoAccent.bg))
                        .overlay(Capsule().strokeBorder(AutoAccent.line.opacity(0.45), lineWidth: 1))
                    Spacer()
                }
                Text("Rough wall-clock from the equipment rates we have. Display only — nothing is scheduled.")
                    .font(.ui(10)).foregroundStyle(Mise.ink5)
                HStack(spacing: 6) {
                    ForEach(Array(parts.enumerated()), id: \.offset) { i, part in
                        if i > 0 { Text("·").font(.ui(13)).foregroundStyle(Mise.ink5.opacity(0.5)) }
                        Text(part.0).font(.ui(13, part.1 ? .bold : .semibold))
                            .foregroundStyle(part.1 ? Mise.navy : Mise.ink)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14).background(RoundedRectangle(cornerRadius: 14).fill(Mise.surface))
        }
    }
}

struct PkgBySkuSection: View {
    let bySku: [MarketPlanModel.PkgSku]
    @State private var open = false

    var body: some View {
        if !bySku.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Button {
                    Haptics.tap()
                    withAnimation(.easeInOut(duration: 0.15)) { open.toggle() }
                } label: {
                    HStack(spacing: 5) {
                        Text("BY SKU").font(.ui(10, .bold)).tracking(0.5).foregroundStyle(Mise.navy)
                        Image(systemName: open ? "chevron.up" : "chevron.down")
                            .font(.system(size: 9, weight: .bold)).foregroundStyle(Mise.navy)
                        Spacer(minLength: 0)
                    }
                }.buttonStyle(.plain)
                if open {
                    ForEach(bySku) { sku in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(sku.name).font(.ui(12, .bold)).foregroundStyle(Mise.ink).lineLimit(1)
                            ForEach(sku.lines) { l in
                                HStack(spacing: 6) {
                                    Text(l.name + (l.pieceName == "pc" ? "" : " · \(l.pieceName)s"))
                                        .font(.ui(11)).foregroundStyle(Mise.ink3).lineLimit(1)
                                    Spacer(minLength: 4)
                                    Text(l.display).font(.ui(11, .semibold)).foregroundStyle(Mise.ink2).monospacedDigit()
                                    if l.multiPiece {
                                        Text("(\(Int(l.neededPieces.rounded(.up))) \(l.pieceName)s)")
                                            .font(.ui(9)).foregroundStyle(Mise.ink5)
                                    }
                                }
                            }
                        }
                        .padding(.vertical, 5)
                        .overlay(alignment: .bottom) {
                            if sku.id != bySku.last?.id { Rectangle().fill(Mise.ink5.opacity(0.08)).frame(height: 1) }
                        }
                    }
                }
            }
            .padding(.top, 6)
        }
    }
}

// MARK: - Week totals (roll several plans into one shopping list)

extension MarketPlanModel {
    // The {recipeId: units} map a plan drives its ingredient pull from.
    static func planItems(_ p: FSDoc) -> [String: Int] {
        var m: [String: Int] = [:]
        for (k, v) in (p.map("items") ?? [:]) { if let n = FS.int(v), n > 0 { m[k] = n } }
        return m
    }

    // The saved {recipeId: {size: count}} hand-set pack mix on a plan doc
    // (shared 1:1 with HQ2 — same field, same shape). ZERO counts are kept:
    // an explicit 0 records "the owner touched this item's mix and chose none
    // of this size" — the key's presence is what blocks the sales-history
    // suggestion in effectiveMix. (HQ2 reads the same field and simply filters
    // out zero counts, so the marker is invisible there.)
    static func planPackMix(_ p: FSDoc) -> [String: [Int: Int]] {
        var out: [String: [Int: Int]] = [:]
        for (rid, sizes) in (p.map("packMix") ?? [:]) {
            guard let inner = FS.map(sizes) else { continue }
            var m: [Int: Int] = [:]
            for (sz, c) in inner { if let s = Int(sz), let n = FS.int(c), n >= 0 { m[s] = n } }
            if !m.isEmpty { out[rid] = m }
        }
        return out
    }

    // Combine several plans into one ingredient list. The COMBINED rollup merges
    // every plan's units per recipe and explodes once — so a recipe used on two
    // days adds up, and on-hand is compared against the WHOLE week at once (the
    // honest "do I have enough for everything" view). Each plan also gets its own
    // rollup for the per-day drill-down. packMix is irrelevant here: ingredient
    // needs come from total units, not how they're packed.
    func combinedRollup(planIds: Set<String>) -> (combined: Rollup, perPlan: [(plan: FSDoc, roll: Rollup)]) {
        var merged: [String: Int] = [:]
        var per: [(plan: FSDoc, roll: Rollup)] = []
        // Keep the plan order stable (newest-first, as listPlans returns them).
        for p in plans where planIds.contains(p.id) {
            let items = Self.planItems(p)
            guard !items.isEmpty else { continue }
            for (k, v) in items { merged[k, default: 0] += v }
            per.append((plan: p, roll: rollup(items: items)))
        }
        return (rollup(items: merged), per)
    }

    // One combined PACKAGING list across several plans: run the packaging rollup
    // for EACH plan with its own saved pack mix (merged over the sales-history
    // suggestions, exactly as the editor computes), then merge the lines by
    // packaging id — needs ADD UP across the week, on-hand is counted ONCE (it's
    // the same shelf of boxes no matter how many days draw from it). Per-plan
    // first because the legacy per-batch charge rounds up per plan, matching what
    // each plan's own page shows. Read-only — plans never deduct packaging stock.
    func combinedPackaging(planIds: Set<String>) -> PkgRollup {
        var byKey: [String: PkgLine] = [:]
        var order: [String] = []
        // Per-SKU merge across plans (same recipe on two days adds up).
        var skuByRid: [String: PkgSku] = [:]
        var skuOrder: [String] = []
        for p in plans where planIds.contains(p.id) {
            let items = Self.planItems(p)
            guard !items.isEmpty else { continue }
            let r = packagingRollup(items: items,
                                    packMix: effectiveMix(items: items, manual: Self.planPackMix(p)))
            for l in r.lines {
                if var ex = byKey[l.id] {
                    ex.neededPieces += l.neededPieces
                    byKey[l.id] = ex
                } else {
                    order.append(l.id)
                    byKey[l.id] = l
                }
            }
            for sku in r.bySku {
                if var ex = skuByRid[sku.id] {
                    for line in sku.lines {
                        if let i = ex.lines.firstIndex(where: { $0.id == line.id }) {
                            ex.lines[i].neededPieces += line.neededPieces
                        } else {
                            ex.lines.append(line)
                        }
                    }
                    skuByRid[sku.id] = ex
                } else {
                    skuOrder.append(sku.id)
                    skuByRid[sku.id] = sku
                }
            }
        }
        let lines = order.compactMap { byKey[$0] }.sorted { ($0.neededCost, $0.neededPieces) > ($1.neededCost, $1.neededPieces) }
        let bySku: [PkgSku] = skuOrder.compactMap { rid in
            guard var sku = skuByRid[rid] else { return nil }
            sku.lines.sort { $0.neededPieces > $1.neededPieces }
            return sku
        }
        return PkgRollup(lines: lines,
                         totalCost: lines.reduce(0) { $0 + $1.neededCost },
                         buyCost: lines.reduce(0) { $0 + $1.buyCost },
                         shortCount: lines.filter { $0.isShort }.count,
                         unmatchedCount: lines.filter { !$0.matched }.count,
                         bySku: bySku)
    }
}

// A read-only roll-up across several market plans: pick which plans (days) count,
// see the total ingredients the week needs vs what's on hand, and drill into any
// single day. No deduction happens here — cooking still happens per plan.
struct MarketWeekTotalsView: View {
    let model: MarketPlanModel
    @Environment(\.dismiss) private var dismiss

    @State private var selected: Set<String> = []
    @State private var seeded = false
    @State private var combined: MarketPlanModel.Rollup? = nil
    @State private var perPlan: [(plan: FSDoc, roll: MarketPlanModel.Rollup)] = []
    @State private var weekPkg: MarketPlanModel.PkgRollup? = nil   // packaging across the same plans
    @State private var weekComps: [MarketPlanModel.ComponentRow] = []   // AI component batches across the same plans (shared model.components)
    @State private var weekSkus: [(id: String, name: String, total: Int, split: String, rounds: String?)] = []   // SKU make-counts across the same plans (rounds = per-recipe equipment line)
    @State private var expanded: Set<String> = []
    @AppStorage("miseWeekTotalsSelected") private var savedSelected = ""   // remember the last picks across launches

    // Plans that can be rolled up: open (not closed) and actually carrying items.
    private var selectablePlans: [FSDoc] {
        model.plans.filter {
            ($0.str("status") ?? "draft") != "closed" && !MarketPlanModel.planItems($0).isEmpty
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Pick the plans (days) you're cooking this week and see one combined shopping list — total ingredients needed vs what's on hand. Tap a day to see just its needs. Nothing is deducted here; you still cook each plan on its own page.")
                    .font(.ui(12)).foregroundStyle(Mise.ink4)
                planPicker
                if selected.isEmpty {
                    emptyHint("Select at least one plan above.")
                } else if let c = combined, c.unitsTotal > 0 {
                    totalsCard(c)
                    if !weekSkus.isEmpty { skusCard }
                    ingredientsCard(c)
                    if !weekComps.isEmpty { componentsCard }
                    if let pk = weekPkg, !pk.lines.isEmpty { packagingCard(pk) }
                    TimeCard(time: model.timeRollup(
                        components: weekComps,
                        units: Dictionary(weekSkus.map { ($0.id, $0.total) }, uniquingKeysWith: +),
                        packaging: weekPkg))
                    byDaySection
                } else {
                    emptyHint("The selected plans have nothing to make yet.")
                }
            }
            .padding(18)
        }
        .background(Mise.bg)
        .navigationTitle("Week totals").navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if !seeded {
                // Restore the last saved picks (dropping any plan that no longer
                // exists); fall back to selecting everything only when nothing's saved.
                let ids = Set(selectablePlans.map { $0.id })
                let saved = Set(savedSelected.split(separator: ",").map(String.init)).intersection(ids)
                selected = saved.isEmpty ? ids : saved
                seeded = true; recalc()
            }
        }
        .onChange(of: selected) { _, _ in
            recalc()
            savedSelected = selected.sorted().joined(separator: ",")   // auto-save every change
        }
    }

    private func recalc() {
        // SKU make-counts across the selected days (Omar, Jul 3 2026): every
        // item with its week total + the per-day split, so "what am I baking
        // this week" reads in one card.
        var agg: [String: Int] = [:], order: [String] = [], parts: [String: [String]] = [:]
        for plan in selectablePlans where selected.contains(plan.id) {
            // Prefer the CANONICAL market name picked from the "Which market?"
            // dropdown (marketLabel) — reads cleaner and doesn't truncate
            // mid-word like the manually-typed plan name did (Omar). Fall back
            // to a clipped plan name only when no market was picked.
            let canon = (plan.str("marketLabel") ?? "").trimmingCharacters(in: .whitespaces)
            let short = canon.isEmpty ? String((plan.str("name") ?? "day").prefix(12)) : canon
            for (rid, qty) in MarketPlanModel.planItems(plan) where qty > 0 {
                if agg[rid] == nil { order.append(rid) }
                agg[rid, default: 0] += qty
                parts[rid, default: []].append("\(short) \(qty)")
            }
        }
        weekSkus = order.map { rid in
            let total = agg[rid] ?? 0
            // PER-RECIPE EQUIPMENT: "40 → 3 oven loads of 15" when this SKU's
            // recipe has equipment set in HQ2; nil otherwise.
            let rounds = RecipeEquip.parse(model.product(rid)?.rec).map { $0.label(units: total) }
            return (id: rid,
                    name: model.product(rid)?.name ?? rid,
                    total: total,
                    split: (parts[rid] ?? []).joined(separator: " · "),
                    rounds: rounds)
        }.sorted { $0.total > $1.total }
        let r = model.combinedRollup(planIds: selected)
        combined = r.combined
        perPlan = r.perPlan
        weekPkg = model.combinedPackaging(planIds: selected)
        weekComps = computeWeekComponents()
    }

    // What to MAKE this week — each SKU's combined count with the per-day split.
    private var skusCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("MAKE · WHOLE WEEK").font(.ui(11, .bold)).tracking(0.5).foregroundStyle(Mise.ink3)
            VStack(spacing: 0) {
                ForEach(weekSkus, id: \.id) { s in
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(s.name).font(.ui(13, .semibold)).foregroundStyle(Mise.ink).lineLimit(1)
                            Text(s.split).font(.ui(9.5)).foregroundStyle(Mise.ink5)
                                .lineLimit(2).minimumScaleFactor(0.85)
                            // per-recipe equipment rounds ("40 → 3 oven loads of 15")
                            if let r = s.rounds {
                                Text(r).font(.ui(9.5, .semibold)).foregroundStyle(AutoAccent.ink).lineLimit(1)
                            }
                        }
                        Spacer(minLength: 6)
                        Text("×\(s.total)").font(.ui(14, .heavy)).foregroundStyle(Mise.navy)
                    }
                    .padding(.vertical, 8)
                    .overlay(alignment: .bottom) { if s.id != weekSkus.last?.id { Rectangle().fill(Mise.rule).frame(height: 1) } }
                }
            }
        }
        .padding(13).frame(maxWidth: .infinity, alignment: .leading).surfaceCard(14)
    }

    // ── AI component batches across the selected plans ──────────────────────
    // Delegates to the SHARED model.components (one row per auto-detected shared
    // sub-recipe the week uses); the single-plan editor calls the same helper so
    // the two never diverge. The week passes each selected plan's items map.
    private func computeWeekComponents() -> [MarketPlanModel.ComponentRow] {
        model.components(perPlanItems: perPlan.map { MarketPlanModel.planItems($0.plan) })
    }

    // ── plan multi-select ────────────────────────────────────────────────────
    private var planPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("PLANS IN THIS VIEW").font(.ui(11, .bold)).tracking(0.4).foregroundStyle(Mise.ink4)
                Spacer()
                Button(selected.count == selectablePlans.count ? "None" : "All") {
                    Haptics.tap()
                    selected = selected.count == selectablePlans.count ? [] : Set(selectablePlans.map { $0.id })
                }.font(.ui(11, .bold)).foregroundStyle(Mise.navy)
            }
            if selectablePlans.isEmpty {
                Text("No open plans with items yet. Build a couple of plans first.")
                    .font(.ui(12)).foregroundStyle(Mise.ink4)
            } else {
                ForEach(selectablePlans) { p in planToggleRow(p) }
            }
        }
    }

    private func planToggleRow(_ p: FSDoc) -> some View {
        let items = MarketPlanModel.planItems(p)
        let units = items.values.reduce(0, +)
        let kinds = items.count
        let on = selected.contains(p.id)
        let st = p.str("status") ?? "draft"
        return Button {
            Haptics.tap()
            if on { selected.remove(p.id) } else { selected.insert(p.id) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 18)).foregroundStyle(on ? Mise.navy : Mise.ink5)
                VStack(alignment: .leading, spacing: 2) {
                    Text(p.str("name") ?? "Market plan").font(.ui(14, .semibold)).foregroundStyle(Mise.ink).lineLimit(1)
                    Text("\(kinds) item\(kinds == 1 ? "" : "s") · \(units) made").font(.ui(11)).foregroundStyle(Mise.ink4)
                }
                Spacer(minLength: 6)
                if st == "started" {
                    Text("STARTED").font(.ui(9, .bold)).tracking(0.4).foregroundStyle(Mise.success)
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(Capsule().fill(Mise.success.opacity(0.12)))
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 12).fill(on ? Mise.navy.opacity(0.06) : Mise.surface))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(on ? Mise.navy.opacity(0.25) : .clear, lineWidth: 1))
        }.buttonStyle(.plain)
    }

    // ── combined totals ──────────────────────────────────────────────────────
    private func totalsCard(_ r: MarketPlanModel.Rollup) -> some View {
        let days = perPlan.count
        return HStack(spacing: 0) {
            statCell("\(days)", "day\(days == 1 ? "" : "s")")
            divider
            statCell("\(r.unitsTotal)", "to make")
            divider
            statCell("$\(Int(r.buildCost.rounded()))", "ingredients")
            divider
            // Lead with the shortfall COST (what you must spend to cover what you
            // don't have), with the count as the label — the buy-list total.
            statCell(r.shortCount > 0 ? "$\(Int(r.shortfallCost.rounded()))" : "0",
                     r.shortCount > 0 ? "\(r.shortCount) to buy" : "short",
                     tint: r.shortCount > 0 ? Mise.danger : Mise.success)
        }
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 14).fill(Mise.surface))
    }

    private func statCell(_ value: String, _ label: String, tint: Color = Mise.ink) -> some View {
        VStack(spacing: 3) {
            Text(value).font(.ui(18, .heavy)).foregroundStyle(tint)
            Text(label).font(.ui(10)).foregroundStyle(Mise.ink4)
        }.frame(maxWidth: .infinity)
    }
    private var divider: some View { Rectangle().fill(Mise.ink5.opacity(0.15)).frame(width: 1, height: 30) }

    // ── combined ingredient list ─────────────────────────────────────────────
    private func ingredientsCard(_ r: MarketPlanModel.Rollup) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("INGREDIENTS · WHOLE WEEK").font(.ui(11, .bold)).tracking(0.4).foregroundStyle(Mise.ink4)
                Spacer()
                if r.shortCount > 0 {
                    Text("\(r.shortCount) short · $\(String(format: "%.2f", r.shortfallCost)) to buy")
                        .font(.ui(10, .bold)).foregroundStyle(Mise.danger)
                }
            }.padding(.bottom, 8)
            Text("Needed vs on hand, across every selected day combined.")
                .font(.ui(10)).foregroundStyle(Mise.ink5).padding(.bottom, 10)
            ForEach(r.lines) { line in ingredientRow(line) }
            if r.untrackedCount > 0 || r.reviewCount > 0 {
                Text(footNote(r)).font(.ui(10)).foregroundStyle(Mise.ink5).padding(.top, 8)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Mise.surface))
    }

    private func ingredientRow(_ line: MarketPlanModel.NeedLine) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(line.name).font(.ui(13, .semibold)).foregroundStyle(Mise.ink).lineLimit(1)
                if !line.matched {
                    Text("not in stock catalog").font(.ui(10)).foregroundStyle(Mise.ink5)
                } else if line.isShort {
                    // Lead with what's actually on the shelf so the row self-verifies:
                    // need − have = short, all three visible. Without the "have",
                    // the eye borrows the neighboring row's on-hand and the short
                    // looks like a contradiction (the July 4th/5th casein misread —
                    // butter's "on hand 16.66 lb" sat right under casein's short row).
                    Text("have \(qty(line.onHand)) · short \(qty(line.short)) \(line.stockUnit) · $\(String(format: "%.2f", line.shortfallCost)) to buy")
                        .font(.ui(10, .semibold)).foregroundStyle(Mise.danger)
                } else {
                    Text("on hand \(qty(line.onHand)) \(line.stockUnit)").font(.ui(10)).foregroundStyle(Mise.ink5)
                }
            }
            Spacer(minLength: 6)
            Text("\(qty(line.needed)) \(line.stockUnit)")
                .font(.ui(13, .bold)).foregroundStyle(line.isShort ? Mise.danger : Mise.ink)
        }
        .padding(.vertical, 7)
        .overlay(alignment: .bottom) { Rectangle().fill(Mise.ink5.opacity(0.08)).frame(height: 1) }
    }

    // ── AI component batches (whole week) ────────────────────────────────────
    // The auto-detected shared sub-recipes the selected days build, with how
    // many consolidated batches the week needs (per-plan ceil, summed — see
    // computeWeekComponents) and make-ahead hints. Read-only, nothing deducts.
    private var componentsCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text("COMPONENTS · WHOLE WEEK").font(.ui(11, .bold)).tracking(0.4).foregroundStyle(Mise.ink4)
                Text("AUTO").font(.ui(9, .heavy)).tracking(0.6)
                    .foregroundStyle(AutoAccent.ink)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Capsule().fill(AutoAccent.bg))
                    .overlay(Capsule().strokeBorder(AutoAccent.line.opacity(0.45), lineWidth: 1))
                Spacer()
            }.padding(.bottom, 8)
            Text("Shared sub-recipes the detector found across these days — one consolidated build instead of one per recipe. Batches count per cook day.")
                .font(.ui(10)).foregroundStyle(Mise.ink5).padding(.bottom, 10)
            ForEach(weekComps) { comp in componentRow(comp) }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Mise.surface))
    }

    private func componentRow(_ c: MarketPlanModel.ComponentRow) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(c.name).font(.ui(13, .semibold)).foregroundStyle(Mise.ink).lineLimit(1)
                Text("feeds " + c.memberNames.joined(separator: " + "))
                    .font(.ui(10)).foregroundStyle(Mise.ink5).lineLimit(2)
                // dough weight: per batch + the week's total mass (batches × weight)
                if let w = c.weightG, w > 0 {
                    Text("\(c.weightPrefix)\(fmtGrams(w))/batch · week \(c.weightPrefix)\(fmtQty(w * Double(c.batches), "g"))")
                        .font(.ui(10, .semibold)).foregroundStyle(Mise.ink3)
                    ForEach(c.weighOuts) { wo in
                        Text(wo.line(prefix: c.weightPrefix))
                            .font(.ui(9.5)).foregroundStyle(Mise.ink4)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                // equipment rounds: "18 batches → 5 mixer rounds of 4"
                if let r = c.rounds {
                    Text(r).font(.ui(10, .semibold)).foregroundStyle(Mise.navy)
                }
                if c.prepAhead {
                    Text("make-ahead (D-1)" + ((c.holdDays ?? 0) > 0 ? " · holds \(c.holdDays!)d" : ""))
                        .font(.ui(10, .semibold)).foregroundStyle(AutoAccent.ink)
                }
            }
            Spacer(minLength: 6)
            Text("\(c.batches) batch\(c.batches == 1 ? "" : "es")")
                .font(.ui(13, .bold)).foregroundStyle(Mise.ink)
        }
        .padding(.vertical, 7)
        .overlay(alignment: .bottom) { Rectangle().fill(Mise.ink5.opacity(0.08)).frame(height: 1) }
    }

    // ── combined packaging list ──────────────────────────────────────────────
    // Same idea as the ingredients: every selected plan's packaging needs (each
    // with its own saved pack mix, or the sales-history suggestion when none)
    // added up by packaging id, compared against on-hand counted ONCE. Nothing
    // is deducted — plans never touch packaging stock.
    private func packagingCard(_ r: MarketPlanModel.PkgRollup) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("PACKAGING · WHOLE WEEK").font(.ui(11, .bold)).tracking(0.4).foregroundStyle(Mise.ink4)
                .padding(.bottom, 8)
            Text("Boxes, stickers, containers for every selected day combined. Nothing is deducted here.")
                .font(.ui(10)).foregroundStyle(Mise.ink5).padding(.bottom, 10)
            ForEach(r.lines) { l in packagingRow(l) }
            // per-recipe breakdown across the whole week (Omar's "by SKU" view)
            PkgBySkuSection(bySku: r.bySku)
            Text("≈$\(String(format: "%.2f", r.totalCost)) packaging this week"
                 + (r.shortCount > 0 ? " · \(r.shortCount) short" : "")
                 + (r.unmatchedCount > 0 ? " · \(r.unmatchedCount) not in catalog" : ""))
                .font(.ui(10, .bold)).foregroundStyle(r.shortCount > 0 ? Mise.danger : Mise.ink4)
                .padding(.top, 8)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Mise.surface))
    }

    private func packagingRow(_ l: MarketPlanModel.PkgLine) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(l.name).font(.ui(13, .semibold)).foregroundStyle(Mise.ink).lineLimit(1)
                if !l.matched {
                    Text("not in packaging catalog").font(.ui(10)).foregroundStyle(Mise.ink5)
                } else if l.isShort {
                    Text(l.multiPiece
                         ? "have \(l.unitsLabel(l.onHandUnits)) · buy \(l.unitsLabel(Int(l.buyUnits)))"
                         : "have \(qty(l.onHandPieces)) · short \(qty(l.shortPieces)) \(l.pieceName)")
                        .font(.ui(10, .semibold)).foregroundStyle(Mise.danger)
                } else {
                    Text(l.multiPiece ? "have \(l.unitsLabel(l.onHandUnits))" : "have \(qty(l.onHandPieces)) \(l.pieceName)")
                        .font(.ui(10)).foregroundStyle(Mise.ink5)
                }
                // PRINT TIME: printed sheets (needed SHEETS × per-sheet minutes).
                if l.printMinutes > 0, let t = fmtDuration(l.printMinutes) {
                    Text("≈\(t) to print").font(.ui(9, .semibold)).foregroundStyle(AutoAccent.ink)
                }
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 1) {
                Text(l.multiPiece ? l.unitsLabel(l.neededUnits) : "\(qty(l.neededPieces)) \(l.pieceName)")
                    .font(.ui(13, .bold)).foregroundStyle(l.isShort ? Mise.danger : Mise.ink)
                if l.multiPiece {
                    Text("\(qty(l.neededPieces)) \(l.pieceName)s").font(.ui(9)).foregroundStyle(Mise.ink5)
                }
                if l.matched, l.neededCost > 0 {
                    Text("$\(String(format: "%.2f", l.neededCost))").font(.ui(10)).foregroundStyle(Mise.ink4)
                }
            }
            if l.isShort {
                Text("SHORT").font(.ui(8, .bold)).foregroundStyle(Mise.danger)
                    .padding(.horizontal, 5).padding(.vertical, 2)
                    .background(Capsule().fill(Mise.danger.opacity(0.12)))
            }
        }
        .padding(.vertical, 7)
        .overlay(alignment: .bottom) { Rectangle().fill(Mise.ink5.opacity(0.08)).frame(height: 1) }
    }

    // ── per-day drill-down ───────────────────────────────────────────────────
    // Ingredients the WEEK is short on (from the combined rollup). Shortness is a
    // week-level fact: every selected day draws from the SAME shelf, so comparing
    // one day's need against the full on-hand — as the old per-day rows did —
    // double-allocates the stock and produces fake per-day shorts. (Live repro,
    // Jul 2026: casein need 3.12 lb/day vs 3 lb on hand showed each day "short
    // 0.12 lb · $2.04" while the week was genuinely short 3.23 lb / $56.56 —
    // cook day 1 and day 2's real short is 3.12 lb, not 0.12. The sequential
    // day-by-day shorts sum to exactly the week number; the per-day ones don't.)
    // So day rows show the day's NEEDS only, and flag which of those ingredients
    // the week as a whole is short on — one scheme, week authoritative.
    private var weekShortIds: Set<String> {
        Set((combined?.lines ?? []).filter(\.isShort).map(\.id))
    }
    private var byDaySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("BY DAY").font(.ui(11, .bold)).tracking(0.4).foregroundStyle(Mise.ink4)
            Text("Each day's own needs. Days share the same shelf, so what to BUY is judged across the whole week above — red marks the ingredients the week is short on.")
                .font(.ui(10)).foregroundStyle(Mise.ink5)
            ForEach(Array(perPlan.enumerated()), id: \.offset) { _, entry in dayRow(entry.plan, entry.roll) }
        }
    }

    private func dayRow(_ p: FSDoc, _ r: MarketPlanModel.Rollup) -> some View {
        let open = expanded.contains(p.id)
        // How many of THIS day's ingredients the week is short on (week scope —
        // never this day's need vs the full shelf, see byDaySection).
        let shortHere = r.lines.filter { weekShortIds.contains($0.id) }.count
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                Haptics.tap()
                if open { expanded.remove(p.id) } else { expanded.insert(p.id) }
            } label: {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(p.str("name") ?? "Market plan").font(.ui(14, .semibold)).foregroundStyle(Mise.ink).lineLimit(1)
                        Text("\(r.unitsTotal) made · $\(Int(r.buildCost.rounded())) ingredients\(shortHere > 0 ? " · uses \(shortHere) week-short item\(shortHere == 1 ? "" : "s")" : "")")
                            .font(.ui(11)).foregroundStyle(shortHere > 0 ? Mise.danger : Mise.ink4)
                    }
                    Spacer(minLength: 6)
                    Image(systemName: open ? "chevron.up" : "chevron.down")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(Mise.ink5)
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
            }.buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(r.lines) { line in
                        HStack {
                            Text(line.name).font(.ui(12)).foregroundStyle(Mise.ink3).lineLimit(1)
                            Spacer(minLength: 6)
                            Text("\(qty(line.needed)) \(line.stockUnit)")
                                .font(.ui(12, .semibold)).foregroundStyle(weekShortIds.contains(line.id) ? Mise.danger : Mise.ink3)
                        }.padding(.vertical, 5)
                    }
                }
                .padding(.horizontal, 14).padding(.bottom, 12)
            }
        }
        .background(RoundedRectangle(cornerRadius: 12).fill(Mise.surface))
    }

    // ── helpers ──────────────────────────────────────────────────────────────
    private func emptyHint(_ s: String) -> some View {
        Text(s).font(.ui(12)).foregroundStyle(Mise.ink4)
            .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 24)
    }
    private func footNote(_ r: MarketPlanModel.Rollup) -> String {
        var parts: [String] = []
        if r.untrackedCount > 0 { parts.append("\(r.untrackedCount) ingredient\(r.untrackedCount == 1 ? "" : "s") not in the stock catalog") }
        if r.reviewCount > 0 { parts.append("\(r.reviewCount) need\(r.reviewCount == 1 ? "s" : "") a unit check") }
        return parts.joined(separator: " · ")
    }
    // Compact quantity: whole numbers plain, otherwise up to 2 decimals.
    private func qty(_ d: Double) -> String {
        let r = (d * 100).rounded() / 100
        return r == r.rounded() ? String(Int(r)) : String(format: "%g", r)
    }
}
