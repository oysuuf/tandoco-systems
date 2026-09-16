import Foundation

// ============================================================================
//  Mise — Freezer shelf (finished goods carried between markets)
//  ----------------------------------------------------------------------------
//  Freezing never CREATES product and never touches raw-ingredient stock:
//  ingredients were consumed (and deducted) when the units were MADE. The
//  shelf just tracks already-made units so the next market plan can sell them
//  without re-buying/re-deducting their ingredients.
//
//  Accounting (Omar, Jul 16): frozen units keep their original MAKE cost as a
//  basis (stripe-free, same source as plan COGS — makeCostPacks). When they
//  sell, the plan charges that basis to COGS so margins stay honest; only the
//  cash-needed/build-cost side treats them as free.
//
//  One doc per recipe in `finishedGoods/{recipeId}` (staff-only rule, #4505):
//    name, units, basisCents (weighted-avg make cost/unit), oldestFrozenAt,
//    lastFrozenAt, updatedAt.
// ============================================================================

enum Freezer {
    struct Item: Identifiable {
        let id: String            // recipeId
        var name: String
        var units: Int
        var basisCents: Int       // weighted-avg make cost per unit
        var oldestFrozenAt: Date?
        var lastFrozenAt: Date?
        var isStale: Bool {       // gentle 3-week nudge (shows in Stock + plan)
            guard let d = oldestFrozenAt else { return false }
            return Date().timeIntervalSince(d) > 21 * 86_400
        }
        var frozenAgo: String {
            guard let d = oldestFrozenAt else { return "" }
            let days = Int(Date().timeIntervalSince(d) / 86_400)
            if days < 1 { return "frozen today" }
            if days < 14 { return "frozen \(days)d ago" }
            return "frozen \(days / 7)w ago"
        }
    }

    static func decode(_ d: FSDoc) -> Item {
        Item(id: d.id,
             name: d.str("name") ?? d.id,
             units: d.int("units") ?? 0,
             basisCents: d.int("basisCents") ?? 0,
             oldestFrozenAt: d.date("oldestFrozenAt"),
             lastFrozenAt: d.date("lastFrozenAt"))
    }

    static func list(token: String?) async -> [Item] {
        await FS.list("finishedGoods", limit: 200, token: token)
            .map(decode)
            .filter { $0.units > 0 }
            .sorted { $0.name.lowercased() < $1.name.lowercased() }
    }

    // Per-unit MAKE cost for the basis — the same stripe-free number plan COGS
    // uses: makeCostPacks["1"], else loadedCostPerUnit, else ingredient cost.
    static func unitMakeCostCents(recipe r: FSDoc) -> Int {
        if let m = r.map("makeCostPacks"), let single = FS.dbl(m["1"]), single > 0 {
            return Int((single * 100).rounded())
        }
        if let l = r.dbl("loadedCostPerUnit"), l > 0 { return Int((l * 100).rounded()) }
        if let f = r.dbl("ingredientCostPerUnit"), f > 0 { return Int((f * 100).rounded()) }
        return 0
    }

    // FREEZE — add units to the shelf. Fetches the recipe for the make-cost
    // basis and blends it with any units already there (weighted average).
    @discardableResult
    static func add(recipeId: String, name: String, units: Int, token: String?) async -> Bool {
        guard units > 0, !recipeId.isEmpty else { return false }
        let rec = await FS.get("recipes", recipeId, token: token)
        let newBasis = rec.map(unitMakeCostCents) ?? 0
        let existing = await FS.get("finishedGoods", recipeId, token: token)
        let curUnits = existing?.int("units") ?? 0
        let curBasis = existing?.int("basisCents") ?? 0
        let totalUnits = curUnits + units
        var blended = newBasis
        if totalUnits > 0 {
            let curTotal: Double = Double(curUnits) * Double(curBasis)
            let newTotal: Double = Double(units) * Double(newBasis)
            let avg: Double = (curTotal + newTotal) / Double(totalUnits)
            blended = Int(avg.rounded())
        }
        var fields: [String: Any] = [
            "name": name, "units": totalUnits, "basisCents": blended,
            "lastFrozenAt": Date(), "updatedAt": Date(),
        ]
        // The stale-nudge anchors on the OLDEST units still on the shelf.
        if existing?.date("oldestFrozenAt") == nil || curUnits <= 0 { fields["oldestFrozenAt"] = Date() }
        if existing != nil {
            return await FS.patch("finishedGoods", recipeId, fields, token: token)
        }
        fields["oldestFrozenAt"] = Date()
        return await FS.add("finishedGoods", fields, id: recipeId, token: token) != nil
    }

    // CONSUME — a plan pulls units off the shelf (floor 0; basis unchanged).
    @discardableResult
    static func consume(recipeId: String, units: Int, token: String?) async -> Bool {
        guard units > 0 else { return true }
        guard let d = await FS.get("finishedGoods", recipeId, token: token) else { return false }
        let left = max(0, (d.int("units") ?? 0) - units)
        var fields: [String: Any] = ["units": left, "updatedAt": Date()]
        if left == 0 { fields["oldestFrozenAt"] = NSNull() }   // empty shelf resets the age clock
        return await FS.patch("finishedGoods", recipeId, fields, token: token)
    }

    // RESTORE — a deleted/undone plan puts units back (basis untouched).
    @discardableResult
    static func restore(recipeId: String, units: Int, token: String?) async -> Bool {
        guard units > 0 else { return true }
        guard let d = await FS.get("finishedGoods", recipeId, token: token) else { return false }
        var fields: [String: Any] = ["units": (d.int("units") ?? 0) + units, "updatedAt": Date()]
        if d.date("oldestFrozenAt") == nil { fields["oldestFrozenAt"] = Date() }
        return await FS.patch("finishedGoods", recipeId, fields, token: token)
    }

    // WRITE-OFF — spoiled/never-used frozen units. Their cost was NEVER
    // expensed by any market (P&Ls only expense what SOLD), so the loss exits
    // inventory HERE: an expense in the books at basis, dated when tossed —
    // hitting no market's P&L (no market caused it). Omar, Jul 16: "the cost
    // that hits only after the fact" = this write-off.
    @discardableResult
    static func writeOff(item: Item, units: Int, uid: String, token: String?) async -> Bool {
        let n = min(max(0, units), item.units)
        guard n > 0 else { return true }
        let dollars = Double(n * item.basisCents) / 100
        let df = DateFormatter(); df.dateFormat = "yyyy-MM-dd"
        let doc: [String: Any] = [
            "description": "freezer write-off — \(n) × \(item.name)",
            "amount": dollars, "category": "ingredients",
            "vendor": "Freezer write-off", "date": df.string(from: Date()),
            "createdAt": Date(), "createdBy": uid, "source": "mise-native",
        ]
        guard await FS.add("expenses", doc, token: token) != nil else { return false }
        return await consume(recipeId: item.id, units: n, token: token)
    }

    // ADJUST — the Stock tab's manual correction (set an absolute count).
    @discardableResult
    static func set(recipeId: String, units: Int, token: String?) async -> Bool {
        guard let d = await FS.get("finishedGoods", recipeId, token: token) else { return false }
        var fields: [String: Any] = ["units": max(0, units), "updatedAt": Date()]
        if units <= 0 { fields["oldestFrozenAt"] = NSNull() }
        else if d.date("oldestFrozenAt") == nil { fields["oldestFrozenAt"] = Date() }
        return await FS.patch("finishedGoods", recipeId, fields, token: token)
    }
}
