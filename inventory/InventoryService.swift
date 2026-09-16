import Foundation

// MARK: - Purchase units + cost/gram (1:1 with HQ2 ING_UNIT_OPTIONS + GRAMS_PER_UNIT)

enum IngUnit {
    // Purchase-unit dropdown. Weight units convert to grams directly; volume
    // units convert via the item's density ("grams per cup"); each-style has no
    // gram conversion. (Weight set is 1:1 with HQ2's ING_UNIT_OPTIONS.)
    static let options: [(value: String, label: String)] = [
        ("g",  "gram (g)"),
        ("kg", "kilogram (kg)"),
        ("lb", "pound (lb)"),
        ("oz", "ounce (oz)"),
        ("ml", "milliliter (mL)"),
        ("l",  "liter (L)"),
        ("tsp", "teaspoon (tsp)"),
        ("tbsp", "tablespoon (tbsp)"),
        ("floz", "fluid ounce (fl oz)"),
        ("cup", "cup"),
        ("qt", "quart (qt)"),
        ("gal", "gallon (gal)"),
        ("ea", "each (ea)"),
    ]
    // Grouped for the picker menu.
    static let weightUnits = ["g", "kg", "lb", "oz"]
    static let volumeUnits = ["ml", "l", "tsp", "tbsp", "floz", "cup", "qt", "gal"]
    static let countUnits  = ["ea"]
    static func label(_ v: String) -> String { options.first { $0.value == v }?.label ?? v }

    // grams in 1 purchase unit (weight family); nil for each-style.
    private static let gramsPer: [String: Double] = [
        "g": 1, "gram": 1, "grams": 1,
        "kg": 1000, "kilo": 1000, "kilogram": 1000,
        "lb": 453.592, "lbs": 453.592, "pound": 453.592,
        "oz": 28.3495, "ounce": 28.3495,
    ]
    // milliliters in 1 purchase unit (volume family).
    private static let mlPer: [String: Double] = [
        "ml": 1, "milliliter": 1, "milliliters": 1,
        "l": 1000, "liter": 1000, "litre": 1000, "liters": 1000,
        "tsp": 4.92892, "teaspoon": 4.92892, "tbsp": 14.7868, "tablespoon": 14.7868,
        "floz": 29.5735, "fl oz": 29.5735, "cup": 236.588, "c": 236.588,
        "pt": 473.176, "pint": 473.176, "qt": 946.353, "quart": 946.353,
        "gal": 3785.41, "gallon": 3785.41,
    ]
    static let cupML = 236.588

    static func isVolume(_ unit: String) -> Bool {
        mlPer[unit.lowercased().trimmingCharacters(in: .whitespaces)] != nil
    }
    // grams in 1 purchase unit. Volume units need a density (gramsPerCup) to
    // bridge to weight; without one they return nil (cost/gram is unknown).
    static func grams(_ unit: String, gramsPerCup: Double = 0) -> Double? {
        let u = unit.lowercased().trimmingCharacters(in: .whitespaces)
        if let g = gramsPer[u] { return g }
        if gramsPerCup > 0, let ml = mlPer[u] { return ml * gramsPerCup / cupML }
        return nil
    }
    // costPerGram = costPerUnit / gramsPerUnit — HQ2 _computeCostPerGram parity.
    static func costPerGram(costPerUnit: Double, unit: String, gramsPerCup: Double = 0) -> Double? {
        guard costPerUnit > 0, let g = grams(unit, gramsPerCup: gramsPerCup), g > 0 else { return nil }
        return costPerUnit / g
    }
}

// MARK: - Density defaults (1:1 with HQ2 CATALOG_DENSITY_DEFAULTS)
// Pre-fills gramsPerCup / gramsPerPiece on the add form when the typed name
// matches, so the Cost Lab can convert cooking-units (tsp/cup/piece) → grams.

enum CatalogDensity {
    struct D { let cup: Double?; let piece: Double? }
    private static func cup(_ g: Double) -> D { D(cup: g, piece: nil) }
    private static func piece(_ g: Double) -> D { D(cup: nil, piece: g) }

    static let defaults: [String: D] = [
        // Liquids
        "water": cup(240), "whole milk": cup(240), "2 milk": cup(240), "skim milk": cup(240),
        "almond milk": cup(240), "oat milk": cup(240), "heavy cream": cup(232),
        "half and half": cup(242), "buttermilk": cup(240), "sour cream": cup(240),
        "yogurt": cup(245), "greek yogurt": cup(285), "vegetable oil": cup(218),
        "olive oil": cup(220), "canola oil": cup(218), "coconut oil": cup(218),
        "honey": cup(340), "maple syrup": cup(316), "molasses": cup(333),
        "soy sauce": cup(240), "vinegar": cup(239), "lemon juice": cup(244),
        "vanilla extract": cup(208),
        // Dry baking staples
        "all purpose flour": cup(120), "bread flour": cup(130), "cake flour": cup(114),
        "whole wheat flour": cup(113), "almond flour": cup(96), "granulated sugar": cup(200),
        "brown sugar": cup(213), "powdered sugar": cup(120), "cornstarch": cup(128),
        "cocoa powder": cup(85), "oats": cup(90),
        // Leaveners & seasonings
        "baking powder": cup(192), "baking soda": cup(220), "active dry yeast": cup(144),
        "instant yeast": cup(144), "salt": cup(288), "kosher salt": cup(230),
        "sea salt": cup(280), "cinnamon": cup(125), "nutmeg": cup(110), "black pepper": cup(120),
        // Fats
        "butter": cup(227), "unsalted butter": cup(227), "salted butter": cup(227),
        "cream cheese": cup(230),
        // Proteins / produce
        "casein": cup(90), "whey protein": cup(110), "peanut butter": cup(258),
        "cocoa nibs": cup(120), "chocolate chips": cup(175), "raisin": cup(165),
        "shredded cheese": cup(113), "parmesan": cup(100),
        // Each-style (per-piece weights)
        "egg": piece(50), "large egg": piece(50), "garlic clove": piece(4),
        "lemon": piece(65), "lime": piece(25), "orange": piece(90),
    ]

    // Tolerant of plurals + punctuation, like HQ2's _lookupIngredientDensity.
    static func lookup(_ name: String) -> D? {
        let key = name.lowercased()
            .replacingOccurrences(of: "[^a-z0-9 ]", with: " ", options: .regularExpression)
            .replacingOccurrences(of: " +", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        if let d = defaults[key] { return d }
        if key.hasSuffix("s"), let d = defaults[String(key.dropLast())] { return d }
        return nil
    }
}

// MARK: - Receipt line parsing
// Scanned receipt lines usually carry the pack size right in the name
// ("flour ap 50lb", "chkn thigh 40 oz", "tomato 6 ct"). This pulls that out so
// adding the item to the catalog can pre-fill package size + unit, and takes a
// rough guess at the category from keywords — so there's far less to type.
enum ReceiptParse {
    // Receipt unit token → the app's purchase unit (g/kg/lb/oz/ea). Volume units
    // (gal/L) aren't in the picker, so they're intentionally left out → no size
    // prefill rather than a wrong one.
    // Each receipt unit maps to a stock unit PLUS a multiplier — the general
    // mechanism for units that mean "N of the thing" (a dozen is 12, a gross
    // is 144). Add future collective units HERE, never as one-off hacks
    // downstream (Omar, Jul 27).
    private static let unitMap: [String: (unit: String, mult: Double)] = [
        "lb": ("lb", 1), "lbs": ("lb", 1), "pound": ("lb", 1), "pounds": ("lb", 1),
        "oz": ("oz", 1), "ounce": ("oz", 1), "ounces": ("oz", 1),
        "g": ("g", 1), "gr": ("g", 1), "gram": ("g", 1), "grams": ("g", 1),
        "kg": ("kg", 1), "kgs": ("kg", 1), "kilo": ("kg", 1), "kilogram": ("kg", 1), "kilograms": ("kg", 1),
        "ct": ("ea", 1), "count": ("ea", 1), "ea": ("ea", 1), "each": ("ea", 1),
        "pk": ("ea", 1), "pack": ("ea", 1), "pc": ("ea", 1), "pcs": ("ea", 1), "piece": ("ea", 1), "pieces": ("ea", 1),
        "dz": ("ea", 12), "doz": ("ea", 12), "dozen": ("ea", 12),
        "gross": ("ea", 144),
    ]
    private static let packWords: Set<String> = ["bag", "bags", "case", "cases", "box", "boxes",
        "jar", "jars", "bottle", "bottles", "can", "cans", "pkg", "ctn", "carton", "cartons"]

    // "flour ap 50lb" → (50, "lb", "flour ap"). nil if no size or unsupported unit.
    static func sizeUnit(from name: String) -> (qty: Double, unit: String, cleanName: String)? {
        // Receipt shorthand: "50#" means 50 POUNDS ("405 50# FLOUR"). Expand
        // before unit matching or printed sizes on flour/sugar bags are missed.
        let lower = name.lowercased()
            .replacingOccurrences(of: #"(\d)\s*#"#, with: "$1 lb", options: .regularExpression)
        guard let re = try? NSRegularExpression(pattern: #"(\d+(?:\.\d+)?)\s*([a-z]+)"#) else { return nil }
        let ns = lower as NSString
        for m in re.matches(in: lower, range: NSRange(location: 0, length: ns.length)) {
            guard let mapped = unitMap[ns.substring(with: m.range(at: 2))],
                  let rawQty = Double(ns.substring(with: m.range(at: 1))), rawQty > 0 else { continue }
            // Collective units expand here: "5DZ EGGS" is 60 ea, not 5. Before
            // the multiplier existed, an already-answered line went off to be
            // researched (Omar, Jul 27).
            let unit = mapped.unit
            let qty = rawQty * mapped.mult
            var clean = name
            if let r = Range(m.range(at: 0), in: name) { clean.removeSubrange(r) }
            // drop a trailing packaging noun ("… bag" / "… case") and tidy spaces
            var words = clean.split(whereSeparator: { $0 == " " }).map(String.init)
            while let last = words.last, packWords.contains(last.lowercased()) { words.removeLast() }
            clean = words.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            return (qty, unit, clean.isEmpty ? name : clean)
        }
        return nil
    }

    private static let categoryKeywords: [(cat: String, words: [String])] = [
        ("protein",   ["chicken", "beef", "pork", "turkey", "salmon", "fish", "shrimp", "bacon", "sausage", "tofu", "egg"]),
        ("dairy",     ["milk", "cream", "cheese", "butter", "yogurt", "yoghurt"]),
        ("produce",   ["tomato", "onion", "garlic", "lettuce", "spinach", "carrot", "potato", "broccoli", "cucumber", "lemon", "lime", "apple", "banana", "cilantro", "parsley", "ginger", "mushroom", "celery", "kale"]),
        ("dry goods", ["flour", "sugar", "rice", "oat", "pasta", "noodle", "bean", "lentil", "cornstarch", "yeast", "baking"]),
        ("oils & sauces", ["oil", "vinegar", "sauce", "soy", "ketchup", "mustard", "mayo", "syrup", "honey"]),
        ("spices",    ["cumin", "paprika", "cinnamon", "spice", "seasoning", "oregano", "basil", "pepper", "salt"]),
        ("packaging", ["napkin", "fork", "spoon", "to-go", "togo", "tray", "wrap", "lid", "cup", "container"]),
        // Non-food consumables — without this bucket they guessed nil and
        // landed uncategorized among the food on HQ2's ingredients list.
        ("supplies",  ["glove", "towel", "tissue", "toilet", "soap", "sanitizer", "sanitiser", "bleach",
                       "cleaner", "degreaser", "detergent", "sponge", "trash", "garbage", "can liner",
                       "foil", "parchment", "battery", "batteries", "propane", "butane", "tape",
                       "sharpie", "marker", "receipt paper", "tablecloth", "zip tie", "first aid", "filter"]),
    ]
    static func categoryGuess(from name: String) -> String? {
        let n = name.lowercased()
        for (cat, words) in categoryKeywords where words.contains(where: { n.contains($0) }) { return cat }
        return nil
    }
}

// MARK: - REST value → plain Swift (round-trips unknown fields)
// Decodes ANY Firestore REST typed value into a plain Swift value so
// structures we don't fully model can survive an app-side edit untouched —
// e.g. packaging `vendors[]` entries, where HQ2's vendors board owns extra
// keys (chips, moq, material, active…) that must be written back verbatim.
extension FS {
    static func plainValue(_ v: Any?) -> Any? {
        guard let m = v as? [String: Any] else { return nil }
        if let s = m["stringValue"] as? String { return s }
        if let b = m["booleanValue"] as? Bool { return b }
        if let s = m["integerValue"] as? String { return Int(s) ?? 0 }
        if let i = m["integerValue"] as? Int { return i }
        if let d = m["doubleValue"] as? Double { return d }
        if let n = m["doubleValue"] as? NSNumber { return n.doubleValue }
        if let ts = m["timestampValue"] as? String { return ts }   // keep as ISO string
        if let arr = (m["arrayValue"] as? [String: Any])?["values"] as? [[String: Any]] {
            return arr.compactMap { plainValue($0) }
        }
        if let fields = (m["mapValue"] as? [String: Any])?["fields"] as? [String: Any] {
            var out: [String: Any] = [:]
            for (k, vv) in fields { if let p = plainValue(vv) { out[k] = p } }
            return out
        }
        if m.keys.contains("nullValue") { return NSNull() }
        return nil
    }
    /// An array-of-maps field → plain [[String: Any]], every key preserved.
    static func plainMapArray(_ v: Any?) -> [[String: Any]] {
        guard let arr = ((v as? [String: Any])?["arrayValue"] as? [String: Any])?["values"] as? [[String: Any]] else { return [] }
        return arr.compactMap { plainValue($0) as? [String: Any] }
    }
}

// Auto-deduction engine. When a batch is marked cooked (CookSessionStore
// .markRecipe), we subtract the ingredients it used from stock; un-cooking
// restores them. Recipe quantities come in recipe units (g, cup, ea…) and
// stock is tracked in the ingredient's own unit (kg, lb, ea…), so we convert
// before subtracting. Cross-family conversions we don't have (cups → lb needs
// density) are recorded as "review" lines rather than guessed.

// MARK: - Unit conversion

enum Units {
    // grams per 1 unit (mass family)
    private static let mass: [String: Double] = [
        "mg": 0.001, "g": 1, "gram": 1, "grams": 1,
        "kg": 1000, "kilo": 1000, "kilogram": 1000, "kilograms": 1000,
        "oz": 28.3495, "ounce": 28.3495, "ounces": 28.3495,
        "lb": 453.592, "lbs": 453.592, "pound": 453.592, "pounds": 453.592, "#": 453.592,
    ]
    // milliliters per 1 unit (volume family)
    private static let vol: [String: Double] = [
        "ml": 1, "milliliter": 1, "milliliters": 1,
        "l": 1000, "liter": 1000, "liters": 1000, "litre": 1000, "litres": 1000,
        "tsp": 4.92892, "teaspoon": 4.92892, "teaspoons": 4.92892,
        "tbsp": 14.7868, "tablespoon": 14.7868, "tablespoons": 14.7868,
        "floz": 29.5735, "fl oz": 29.5735, "fluid ounce": 29.5735,
        "cup": 236.588, "cups": 236.588, "c": 236.588,
        "pt": 473.176, "pint": 473.176, "qt": 946.353, "quart": 946.353,
        "gal": 3785.41, "gallon": 3785.41, "gallons": 3785.41,
    ]
    // count family — all interchangeable 1:1 (incl. empty unit = "each")
    private static let count: Set<String> = [
        "", "ea", "each", "ct", "count", "pc", "pcs", "piece", "pieces",
        "unit", "units", "clove", "cloves", "egg", "eggs", "can", "cans",
    ]

    private static func norm(_ u: String) -> String {
        u.lowercased().trimmingCharacters(in: .whitespaces)
    }

    /// Convert qty from one unit to another. Returns nil when the units are in
    /// different families (e.g. cups → lb) — we won't guess across families.
    static func convert(_ qty: Double, from: String, to: String) -> Double? {
        let f = norm(from), t = norm(to)
        if f == t { return qty }
        if let gf = mass[f], let gt = mass[t] { return qty * gf / gt }
        if let vf = vol[f], let vt = vol[t] { return qty * vf / vt }
        if count.contains(f) && count.contains(t) { return qty }
        return nil
    }
}

// MARK: - Deduction writer

enum InventoryWriter {
    /// Read a numeric recipe field that may be stored as a number OR a numeric
    /// string ("10"). `FSDoc.dbl` only handles number-typed values, so a
    /// string-valued yield would silently read as nil.
    static func num(_ r: FSDoc, _ key: String) -> Double? {
        if let d = r.dbl(key) { return d }
        if let s = r.str(key), let d = Double(s.trimmingCharacters(in: .whitespaces)) { return d }
        return nil
    }

    /// Convert a recipe-line quantity into the ingredient's STOCK unit. First
    /// tries a same-family conversion (weight↔weight, volume↔volume, count↔count);
    /// if that fails, BRIDGES across families using the ingredient's density
    /// (gramsPerCup / gramsPerPiece) — e.g. "2 cups milk" → oz of milk. This is
    /// the same density trick the cost engine (FrontModel.costOfPull) already
    /// uses, so what we show as "needed" equals what we deduct AND what we cost.
    /// Returns nil only when even density can't reconcile the units (→ review).
    static func stockAmount(_ qty: Double, from unit: String, ing: FSDoc) -> Double? {
        let stockUnit = (ing.str("unit") ?? "").trimmingCharacters(in: .whitespaces)
        if let a = Units.convert(qty, from: unit, to: stockUnit) { return a }   // same family
        let gpc = ing.dbl("gramsPerCup") ?? 0
        let gpp = ing.dbl("gramsPerPiece") ?? 0
        let pieceUnits: Set<String> = ["", "ea", "each", "piece", "pieces", "egg", "eggs", "clove", "cloves", "ct", "count", "unit", "units"]
        // recipe quantity → grams
        var grams: Double? = Units.convert(qty, from: unit, to: "g")
        if grams == nil, gpc > 0, let cups = Units.convert(qty, from: unit, to: "cup") { grams = cups * gpc }
        if grams == nil, gpp > 0, pieceUnits.contains(unit.lowercased().trimmingCharacters(in: .whitespaces)) { grams = qty * gpp }
        guard let g = grams else { return nil }
        // grams → stock unit
        if let a = Units.convert(g, from: "g", to: stockUnit) { return a }      // mass stock
        if pieceUnits.contains(stockUnit.lowercased()), gpp > 0 { return g / gpp }  // each-stocked via piece weight
        return nil   // volume-stocked items are rare → leave for review
    }

    /// Scale a recipe's ingredient list to `qty` finished UNITS. Recipe amounts
    /// are for a whole BATCH; per the HQ2 Cost Lab, one batch yields
    /// (recipeYield × unitsPerYield) sellable units (e.g. a cookie batch makes 24).
    /// So we divide the batch amounts by that, then × qty. Per-serving recipes
    /// (yield 1) are unchanged.
    static func pull(from r: FSDoc?, qty: Int) -> [PullItem] {
        guard let r, qty > 0 else { return [] }
        var ings = r.mapArr("ingredients"); if ings.isEmpty { ings = r.mapArr("linkedIngredients") }
        // recipeYield / unitsPerYield are sometimes stored as STRINGS ("10") by
        // the recipe editor, which `FSDoc.dbl` (number-typed only) reads as nil —
        // that would collapse the divisor to 1 and explode a whole batch per unit
        // (e.g. 72 rolls → 72 batches of milk). Read them string-tolerantly.
        let yieldN = max(1, num(r, "recipeYield") ?? 1)
        let upyN   = max(1, num(r, "unitsPerYield") ?? 1)
        let perUnit = Double(qty) / (yieldN * upyN)   // fraction of a batch per `qty` units
        return ings.compactMap { ri in
            guard let nm = FS.str(ri["name"]) ?? FS.str(ri["ingredient"]) else { return nil }
            let unit = FS.str(ri["unit"]) ?? ""
            let q = (FS.dbl(ri["qty"]) ?? FS.dbl(ri["quantity"]) ?? FS.dbl(ri["amount"]) ?? 0) * perUnit
            // Carry the catalog link so deduction matches by id, not by name.
            // (Recipe lines say "Eggs Large"; the catalog says "Eggs, Large" —
            // a name-only match silently skipped eggs and never deducted them.)
            let iid = FS.str(ri["ingredientId"])
            return PullItem(name: nm, unit: unit, qty: q,
                            ingredientId: (iid?.isEmpty == false) ? iid : nil)
        }
    }

    /// A recipe parked in the "Draft" menu category — a not-yet-real item that
    /// raises NO review flags anywhere. Byte-for-byte match of HQ2's
    /// `_isDraftMenuCategory` (PR #4707): (menuCategory | mealType | category)
    /// lowercased == "draft".
    static func isDraftRecipe(_ r: FSDoc?) -> Bool {
        guard let r else { return false }
        let cat = (r.str("menuCategory") ?? r.str("mealType") ?? r.str("category") ?? "")
            .lowercased().trimmingCharacters(in: .whitespaces)
        return cat == "draft"
    }

    /// Normalize an ingredient name for matching: lowercase, drop punctuation
    /// (so "Eggs, Large" == "Eggs Large"), collapse whitespace.
    /// Exposed (not private) so the Recipe-health checker classifies lines with
    /// the EXACT same normalization deduction uses.
    static func normName(_ s: String) -> String {
        let cleaned = s.lowercased().unicodeScalars.map {
            CharacterSet.alphanumerics.contains($0) ? Character($0) : " "
        }
        return String(cleaned).split(separator: " ").joined(separator: " ")
    }

    /// Index the catalog for lookup by BOTH the doc id and the normalized name.
    /// Exposed for the Recipe-health checker (same index the deduction uses).
    static func indexIngredients(_ ings: [FSDoc]) -> (byId: [String: FSDoc], byName: [String: FSDoc]) {
        var byId: [String: FSDoc] = [:]; var byName: [String: FSDoc] = [:]
        for i in ings {
            byId[i.id] = i
            let n = normName(i.str("name") ?? ""); if !n.isEmpty { byName[n] = i }
        }
        return (byId, byName)
    }

    /// Resolve a pulled recipe line to a catalog doc. The LINK wins: recipe line
    /// names drift from the catalog ("Eggs Large" vs "Eggs, Large"), so a name-only
    /// match silently skipped linked ingredients and never deducted them. Fall back
    /// to the punctuation-tolerant name only when the line carries no id.
    static func resolve(_ p: PullItem, byId: [String: FSDoc], byName: [String: FSDoc]) -> FSDoc? {
        if let id = p.ingredientId, !id.isEmpty, let d = byId[id] { return d }
        return byName[normName(p.name)]
    }

    /// What a recipe line actually takes off the shelf.
    ///
    /// Some things are never stocked in the form a recipe asks for them. You
    /// don't buy lemon zest — you buy lemons and zest one. So an ingredient can
    /// declare where it COMES FROM:
    ///
    ///     derivedFrom: { ingredientId: <lemons>, parentQtyPerUnit: 0.25 }
    ///
    /// meaning one of THIS item's stock units consumes 0.25 of the parent's.
    /// A recipe asking for 1 tbsp of zest then draws a quarter-pound of lemons
    /// out of stock, and the buy list says "lemons" — which is what you'd
    /// actually put in the cart.
    ///
    /// Returns the doc that holds the stock, how much to take in THAT doc's
    /// unit, and the item the recipe named (so the ledger can say where it
    /// came from). One hop only — a parent that is itself derived is ignored
    /// rather than followed, so a mis-set pair can never loop.
    struct StockDraw { let doc: FSDoc; let amount: Double; let via: FSDoc? }
    static func resolveDraw(_ p: PullItem, byId: [String: FSDoc], byName: [String: FSDoc]) -> StockDraw? {
        guard let hit = resolve(p, byId: byId, byName: byName) else { return nil }
        guard let own = stockAmount(p.qty, from: p.unit, ing: hit) else { return nil }
        guard let df = hit.map("derivedFrom"),
              let pid = FS.str(df["ingredientId"]), !pid.isEmpty,
              let parent = byId[pid],
              parent.id != hit.id,
              let per = FS.dbl(df["parentQtyPerUnit"]), per > 0
        else { return StockDraw(doc: hit, amount: own, via: nil) }
        return StockDraw(doc: parent, amount: own * per, via: hit)
    }

    /// Market production: products made for a market shift consume their raw
    /// ingredients HERE, once, at shift-open. Market product does NOT go through
    /// the Cook tab, so this is the only place those ingredients leave stock —
    /// no double-count with the cook flow. Logged as `market-produce` so it's
    /// distinguishable in the inventory ledger. Ingredients are read once and a
    /// working cache carries the running qty, so two products that share an
    /// ingredient both subtract from the same balance.
    static func applyMarketProduction(_ items: [(recipeKey: String, recipeName: String, pull: [PullItem])],
                                      shiftId: String, sourceName: String, actor: String, token: String?) async {
        await applyProduction(items, sourceField: "marketShiftId", sourceId: shiftId,
                              context: "market", sourceName: sourceName, actor: actor, token: token)
    }

    /// Market PLAN production: a saved plan (built ahead of the market in the
    /// Market Plan Builder, shared with HQ2 web) consumes its products' raw
    /// ingredients once, when the operator taps "Start plan / Mark cooked".
    /// Same engine as `applyMarketProduction`; logged with `marketPlanId` so the
    /// ledger shows which plan pulled the stock. Idempotency (don't deduct twice)
    /// is the CALLER's job via the plan's `ingredientsDeducted` flag.
    static func applyPlanProduction(_ items: [(recipeKey: String, recipeName: String, pull: [PullItem])],
                                    planId: String, sourceName: String, actor: String, token: String?) async {
        await applyProduction(items, sourceField: "marketPlanId", sourceId: planId,
                              context: "market plan", sourceName: sourceName, actor: actor, token: token)
    }

    /// Adjust an already-cooked plan's deduction by a per-recipe DELTA in
    /// finished units: a POSITIVE delta means more was made than last recorded
    /// (pull more stock); a NEGATIVE delta means fewer (return stock). Lets the
    /// operator correct "how many I made" after cooking without ever double-
    /// counting — only the difference moves. Tagged `marketPlanId` in the ledger.
    static func adjustPlanProduction(_ changes: [(recipeKey: String, recipeName: String, deltaUnits: Int, recipe: FSDoc?)],
                                     planId: String, planName: String, actor: String, token: String?) async {
        let ings = await FS.list("ingredients", limit: 800, token: token)
        let (byId, byName) = indexIngredients(ings)
        var working: [String: Double] = [:]
        for ch in changes where ch.deltaUnits != 0 {
            let sign: Double = ch.deltaUnits > 0 ? -1 : 1   // more made → subtract; fewer → add back
            let pulls = pull(from: ch.recipe, qty: abs(ch.deltaUnits))
                .filter { $0.qty > 0 && !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }
            for p in pulls {
                guard let doc = resolve(p, byId: byId, byName: byName) else { continue }
                let label = doc.str("name") ?? p.name
                let stockUnit = (doc.str("unit") ?? "").trimmingCharacters(in: .whitespaces)
                let current = working[doc.id] ?? (doc.dbl("currentQty") ?? 0)
                guard let amt = stockAmount(p.qty, from: p.unit, ing: doc) else { continue }
                let delta = sign * amt
                let after = max(0, current + delta)
                working[doc.id] = after
                await FS.patch("ingredients", doc.id, ["currentQty": after, "updatedAt": Date()], token: token)
                _ = await FS.add("inventoryLog", [
                    "ingredientId": doc.id, "ingredientName": label,
                    "action": "market-produce", "delta": delta, "before": current, "after": after, "unit": stockUnit,
                    "note": "plan adjust \(ch.deltaUnits > 0 ? "+" : "")\(ch.deltaUnits) \(ch.recipeName)",
                    "recipeKey": ch.recipeKey, "marketPlanId": planId, "actor": actor, "at": Date(),
                ].merging(planName.isEmpty ? [:] : ["sourceName": planName]) { a, _ in a }, token: token)
            }
        }
    }

    /// Shared body for the two market production paths above. `sourceField` is
    /// the inventoryLog key the source id is written under (`marketShiftId` for a
    /// till shift, `marketPlanId` for a saved plan), so each ledger line points
    /// back at exactly what consumed the stock.
    private static func applyProduction(_ items: [(recipeKey: String, recipeName: String, pull: [PullItem])],
                                        sourceField: String, sourceId: String,
                                        context: String, sourceName: String, actor: String, token: String?) async {
        let ings = await FS.list("ingredients", limit: 800, token: token)
        let (byId, byName) = indexIngredients(ings)
        var working: [String: Double] = [:]   // ingredientId → running currentQty this run
        for item in items {
            let lines = item.pull.filter { $0.qty > 0 && !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }
            for p in lines {
                guard let doc = resolve(p, byId: byId, byName: byName) else {
                    // Smoke detector: no catalog match → leave a review note rather
                    // than skipping silently (the eggs bug hid here for months).
                    _ = await FS.add("inventoryLog", [
                        "ingredientName": p.name, "action": "market-produce", "skipped": true,
                        "note": "no matching ingredient for \"\(p.name)\" — not deducted, review",
                        "recipeKey": item.recipeKey, sourceField: sourceId, "actor": actor, "at": Date(),
                    ].merging(sourceName.isEmpty ? [:] : ["sourceName": sourceName]) { a, _ in a }, token: token)
                    continue
                }
                // "Comes from" hop: a line asking for lemon zest takes LEMONS off
                // the shelf. resolveDraw returns the stocked item and the amount
                // already converted into its unit.
                let draw = resolveDraw(p, byId: byId, byName: byName)
                let stocked = draw?.doc ?? doc
                let key = p.name.lowercased().trimmingCharacters(in: .whitespaces)
                let label = stocked.str("name") ?? key
                let stockUnit = (stocked.str("unit") ?? "").trimmingCharacters(in: .whitespaces)
                let current = working[stocked.id] ?? (stocked.dbl("currentQty") ?? 0)
                guard let amount = draw?.amount else {
                    _ = await FS.add("inventoryLog", [
                        "ingredientId": doc.id, "ingredientName": label,
                        "action": "market-produce", "skipped": true,
                        "note": "unit mismatch: recipe \(p.unit.isEmpty ? "(none)" : p.unit) vs stock \(stockUnit.isEmpty ? "(none)" : stockUnit) — not deducted, review",
                        "recipeKey": item.recipeKey, sourceField: sourceId, "actor": actor, "at": Date(),
                    ].merging(sourceName.isEmpty ? [:] : ["sourceName": sourceName]) { a, _ in a }, token: token)
                    continue
                }
                let after = max(0, current - amount)
                working[stocked.id] = after
                await FS.patch("ingredients", stocked.id, ["currentQty": after, "updatedAt": Date()], token: token)
                // When the draw came through a "comes from" link, say so in the
                // ledger — otherwise lemons quietly disappear with no clue why.
                let viaNote = draw?.via.flatMap { $0.str("name") }.map { " (as \($0))" } ?? ""
                _ = await FS.add("inventoryLog", [
                    "ingredientId": stocked.id, "ingredientName": label,
                    "action": "market-produce",
                    "delta": -amount, "before": current, "after": after, "unit": stockUnit,
                    "note": "made \(item.recipeName.isEmpty ? "product" : item.recipeName) for \(context)" + viaNote,
                    "recipeKey": item.recipeKey, sourceField: sourceId, "actor": actor, "at": Date(),
                ].merging(sourceName.isEmpty ? [:] : ["sourceName": sourceName]) { a, _ in a }, token: token)
            }
        }
    }

    /// Apply one cooked batch to stock. `undo` reverses (adds back) for un-cook.
    /// Reads each ingredient fresh, converts the recipe qty into the stock unit,
    /// patches `currentQty`, and drops an `inventoryLog` line per ingredient.
    static func apply(pull: [PullItem], recipeKey: String, recipeName: String,
                      undo: Bool, actor: String, token: String?) async {
        let lines = pull.filter { $0.qty > 0 && !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }
        guard !lines.isEmpty else { return }

        // Fresh read so we modify the true current value, not a stale cache.
        let ings = await FS.list("ingredients", limit: 800, token: token)
        let (byId, byName) = indexIngredients(ings)

        for p in lines {
            let key = p.name.lowercased().trimmingCharacters(in: .whitespaces)
            guard let doc = resolve(p, byId: byId, byName: byName) else {
                // Smoke detector: no catalog match → leave a review note, don't skip silently.
                _ = await FS.add("inventoryLog", [
                    "ingredientName": p.name, "action": undo ? "cook-undo" : "cook", "skipped": true,
                    "note": "no matching ingredient for \"\(p.name)\" — not deducted, review",
                    "recipeKey": recipeKey, "actor": actor, "at": Date(),
                ], token: token)
                continue
            }
            // "Comes from" hop — lemon zest draws down LEMONS. Only redirect on a
            // real hop (draw.via non-nil); plain lines keep the exact conversion
            // they've always used, so nothing about existing deductions moves.
            let draw = resolveDraw(p, byId: byId, byName: byName)
            let hopped = draw?.via != nil
            let stocked = hopped ? (draw?.doc ?? doc) : doc
            let label = stocked.str("name") ?? key
            let stockUnit = (stocked.str("unit") ?? "").trimmingCharacters(in: .whitespaces)
            let current = stocked.dbl("currentQty") ?? 0

            let converted: Double? = hopped ? draw?.amount
                                            : Units.convert(p.qty, from: p.unit, to: stockUnit)
            guard let amount = converted else {
                // Units don't reconcile — log it for review instead of guessing.
                _ = await FS.add("inventoryLog", [
                    "ingredientId": stocked.id, "ingredientName": label,
                    "action": undo ? "cook-undo" : "cook", "skipped": true,
                    "note": "unit mismatch: recipe \(p.unit.isEmpty ? "(none)" : p.unit) vs stock \(stockUnit.isEmpty ? "(none)" : stockUnit) — not deducted, review",
                    "recipeKey": recipeKey, "actor": actor, "at": Date(),
                ], token: token)
                continue
            }

            let delta = undo ? amount : -amount
            let after = max(0, current + delta)
            let viaNote = draw?.via.flatMap { $0.str("name") }.map { " (as \($0))" } ?? ""
            await FS.patch("ingredients", stocked.id, ["currentQty": after, "updatedAt": Date()], token: token)
            _ = await FS.add("inventoryLog", [
                "ingredientId": stocked.id, "ingredientName": label,
                "action": undo ? "cook-undo" : "cook",
                "delta": delta, "before": current, "after": after, "unit": stockUnit,
                "note": "\(recipeName.isEmpty ? "batch" : recipeName) \(undo ? "un-cooked" : "cooked")" + viaNote,
                "recipeKey": recipeKey, "actor": actor, "at": Date(),
            ], token: token)
        }
    }
}

// MARK: - Recipe health (read-only diagnostics)

/// One flagged recipe line. Mirrors the HQ2 web scan exactly so both
/// surfaces classify the same way.
struct RecipeHealthFinding: Identifiable {
    enum Bucket: Int, Comparable {
        case wontTrack = 0   // 🔴 no match at all — won't cost or deduct
        case unit      = 1   // 🟠 resolves, but the unit can't convert
        case fragile   = 2   // 🟡 works today but the link is brittle
        static func < (a: Bucket, b: Bucket) -> Bool { a.rawValue < b.rawValue }
        var label: String {
            switch self {
            case .wontTrack: return "🔴 Won't track"
            case .unit:      return "🟠 Unit problem"
            case .fragile:   return "🟡 Fragile link"
            }
        }
    }
    let id = UUID()
    let recipeName: String
    let lineName: String
    let unit: String
    let bucket: Bucket
    let reason: String
}

enum RecipeHealth {
    struct Result {
        let findings: [RecipeHealthFinding]
        var recipeCount: Int { Set(findings.map { $0.recipeName }).count }
        var wontTrack: Int { findings.filter { $0.bucket == .wontTrack }.count }
        var unit: Int { findings.filter { $0.bucket == .unit }.count }
        var fragile: Int { findings.filter { $0.bucket == .fragile }.count }
        var clean: Bool { findings.isEmpty }
    }

    /// Scan every recipe's ingredient lines against the catalog, using the
    /// SAME resolution the cook/market deduction uses (id first, then a
    /// punctuation-tolerant name). Read-only: no writes, fixing is on web.
    static func scan(recipes: [FSDoc], ingredients: [FSDoc]) -> Result {
        let (byId, byName) = InventoryWriter.indexIngredients(ingredients)
        var findings: [RecipeHealthFinding] = []

        for r in recipes {
            // Draft parking-lot items raise NO flags — they aren't being worked
            // toward publish, so they shouldn't pollute "needs attention"
            // (matches HQ2's Recipe Doctor early-return, PR #4707).
            if InventoryWriter.isDraftRecipe(r) { continue }
            let recipeName = r.str("name") ?? r.str("title") ?? "(unnamed recipe)"
            // Same extraction as InventoryWriter.pull: ingredients[] then
            // linkedIngredients[]. qty=1 units so the line always scans.
            var lines = r.mapArr("ingredients")
            if lines.isEmpty { lines = r.mapArr("linkedIngredients") }

            for li in lines {
                guard let nm = (FS.str(li["name"]) ?? FS.str(li["ingredient"])),
                      !nm.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
                let unit = FS.str(li["unit"]) ?? ""
                let iid = FS.str(li["ingredientId"])
                let item = PullItem(name: nm, unit: unit, qty: 1,
                                    ingredientId: (iid?.isEmpty == false) ? iid : nil)

                // 1. RESOLVE
                guard let doc = InventoryWriter.resolve(item, byId: byId, byName: byName) else {
                    findings.append(RecipeHealthFinding(
                        recipeName: recipeName, lineName: nm, unit: unit, bucket: .wontTrack,
                        reason: "No matching ingredient in the catalog — this line won't cost or deduct from stock."))
                    continue
                }

                // 2. UNIT — can 1 <unit> convert into the ingredient's stock unit?
                if InventoryWriter.stockAmount(1, from: unit, ing: doc) == nil {
                    findings.append(RecipeHealthFinding(
                        recipeName: recipeName, lineName: nm, unit: unit, bucket: .unit,
                        reason: "The unit \"\(unit.isEmpty ? "(blank)" : unit)\" can't be converted for \"\(doc.str("name") ?? "")\" — usually a missing density on the ingredient."))
                    continue
                }

                // 3. FRAGILE — resolves + converts, but the link is brittle.
                let catName = doc.str("name") ?? ""
                let hasUsableId = (item.ingredientId != nil) && (byId[item.ingredientId!] != nil)
                if !hasUsableId {
                    findings.append(RecipeHealthFinding(
                        recipeName: recipeName, lineName: nm, unit: unit, bucket: .fragile,
                        reason: "Matched by name only (no saved link) — one rename and it stops deducting."))
                } else if InventoryWriter.normName(nm) != InventoryWriter.normName(catName) {
                    findings.append(RecipeHealthFinding(
                        recipeName: recipeName, lineName: nm, unit: unit, bucket: .fragile,
                        reason: "Line name \"\(nm)\" has drifted from the catalog name \"\(catName)\" — the link works, but the mismatch is confusing."))
                }
            }

            // BATCH-YIELD guard for several-to-a-box meals. itemsPerContainer>1
            // means a sold box holds N pieces; the order deduction expands
            // boxes→pieces then divides by the batch's PIECE yield
            // (recipeYield × unitsPerYield). If no batch yield is declared it
            // silently defaults to 1, so a single box would try to deduct
            // several whole batches. This is the landmine on any new boxed meal.
            let ipc = max(1, Int(InventoryWriter.num(r, "itemsPerContainer") ?? 1))
            let hasBatchYield = InventoryWriter.num(r, "unitsPerYield") != nil
                             || InventoryWriter.num(r, "servingsPerBatch") != nil
            if ipc > 1 && !hasBatchYield && !lines.isEmpty {
                findings.append(RecipeHealthFinding(
                    recipeName: recipeName, lineName: "batch yield", unit: "",
                    bucket: .wontTrack,
                    reason: "Sold \(ipc) to a box but no batch yield is set (unitsPerYield) — the order deduction would treat one box as several whole batches. Set how many pieces one batch makes."))
            }

            // CONFLICTING batch-yield fields: a stale `servingsPerBatch` (almost
            // always a duplicate-recipe leftover) that disagrees with the live
            // recipeYield×unitsPerYield. All code uses unitsPerYield, so the math
            // isn't wrong — but two contradicting "makes N" numbers are a data
            // landmine (and a tell the recipe was cloned). Surface it so it gets
            // cleaned up. (Jul 23 — this caught lemon honey chicken 5-vs-14 etc.)
            if let spb = InventoryWriter.num(r, "servingsPerBatch"), spb > 0, !lines.isEmpty {
                let makes = max(1.0, (InventoryWriter.num(r, "recipeYield") ?? 1)
                                   * (InventoryWriter.num(r, "unitsPerYield") ?? 1))
                if abs(spb - makes) > 0.01 {
                    findings.append(RecipeHealthFinding(
                        recipeName: recipeName, lineName: "batch yield", unit: "",
                        bucket: .fragile,
                        reason: "Two disagreeing batch-yield numbers — unitsPerYield says \(Int(makes))/batch, a leftover servingsPerBatch says \(Int(spb)). The system uses \(Int(makes)); clear the stale field in HQ2 so it can't mislead."))
                }
            }
        }

        // Worst-first ordering.
        findings.sort { $0.bucket < $1.bucket }
        return Result(findings: findings)
    }
}
