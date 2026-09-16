import SwiftUI

// ============================================================================
//  Cook-day sequencer — a back-timed, resource-aware schedule for a SOLO cook.
//  ----------------------------------------------------------------------------
//  Omar's brief (Jul 22): take the day's recipes and produce an ordered,
//  back-timed plan across three overlapping tracks — passive/lead-time, active
//  prep, heat — "so nothing sits idle and everything finishes at the target
//  time." The brief's own warning drives the design: this is NOT a sort.
//
//  The three rules that make it a schedule:
//   1. THE COOK IS A RESOURCE, capacity 1. Hands-on tasks queue for the cook;
//      walk-away tasks (rice cooker, proof, oven) run beside them for free.
//   2. TRACKS OVERLAP. While anything passive runs, the cook is filled with
//      the next ready hands-on task — enforced by the scheduler, not implied
//      by list order.
//   3. THE OVEN IS THE BOTTLENECK. One oven, one temp zone (Omar's kitchen):
//      same-temp loads may share it; a temp change costs a preheat and
//      serializes. Burners: capacity 4. Unattended appliances: no cap (Omar
//      has several; each task tends to own its own machine).
//
//  Algorithm — greedy least-slack list scheduling, per the brief's "ship the
//  simple correct version first":
//   backward pass  latest-start per step from the finish line through each
//                  dish's chain (prep tasks in recipe order → heat),
//   forward pass   walk time forward; among READY steps (deps done) start the
//                  least-slack one whose resources are free; passive steps
//                  skip the cook-capacity check,
//   overlap fill   falls out of the forward pass: the cook is only ever idle
//                  when NO hands-on step is ready.
//
//  Inputs come from what the app already knows: server-parsed prepTasks
//  (hands/walkaway + minutes, ×batches), each dish's heat estimate and oven
//  temp, learned stopwatch timings (they override Claude's minutes), and the
//  editable finish line (readyMin). Wait-window (min/max rest) fields are in
//  the model but unpopulated until recipes carry them — the scheduler honors
//  chains today and windows the day the data exists.
// ============================================================================

// One schedulable unit of work.
struct SeqStep: Identifiable {
    enum Track { case passive, hands, heat }
    enum Res { case none, oven(tempF: Int), burner }
    let id: String
    let dish: String
    let label: String
    let track: Track
    let res: Res
    let durSec: Double
    let depIds: [String]          // all must finish before this starts
    var latestStart: Double = 0   // filled by the backward pass (sec from day start)
}

// One placed block on the timeline.
struct SeqPlaced: Identifiable {
    let id: String
    let dish: String
    let label: String
    let track: SeqStep.Track
    let startSec: Double
    let endSec: Double
    let ovenTemp: Int?
}

struct SeqPlan {
    var placed: [SeqPlaced] = []
    var startMin: Int = 0         // computed day start (minutes after midnight)
    var finishMin: Int = 0
    var cookBusySec: Double = 0
    var makespanSec: Double = 0
    var warnings: [String] = []
    var cookIdlePct: Int {
        makespanSec > 0 ? Int(((makespanSec - cookBusySec) / makespanSec * 100).rounded()) : 0
    }
}

// What the sequencer needs to know about one dish — deliberately NOT CookDish,
// so both the Cook tab (ProductionModel) and the kitchen (KitchenModel) can
// feed it from whatever they already hold.
struct SeqDish {
    let id: String
    let name: String
    let recipeKey: String
    let prepTasks: [PrepTask]
    let batches: Double
    let tempF: Int?
    let passiveMin: Int
    let usesOven: Bool
    // Did the recipe declare any method zones at all? When it did and none say
    // "oven", a mere internal-temp target must NOT force the oven block (a range
    // protein cooked to 165°F belongs on the range). Only when there's no zone
    // signal at all do we fall back to "has a temp → probably baked".
    var hasMethodZones: Bool = false
}

enum CookSequencer {

    /// Build the day's steps from the dishes. Each dish contributes its parsed
    /// prep tasks as a CHAIN (recipe order is the dependency order — the parse
    /// lists them the way the method does) followed by one heat block.
    static func steps(for dishes: [SeqDish],
                      estimate: (PrepTimingKey, Double) -> Double? = { _, _ in nil }) -> [SeqStep] {
        var out: [SeqStep] = []
        for d in dishes where !d.prepTasks.isEmpty {
            var prev: String? = nil
            for (i, t) in d.prepTasks.enumerated() {
                let key = PrepTimingKey.step(recipeKey: d.recipeKey.isEmpty ? d.name : d.recipeKey,
                                             index: t.stepIdx >= 0 ? t.stepIdx : 100 + i)
                // Learned speed wins over Claude's guess, same as everywhere.
                let sec = estimate(key, max(1, d.batches))
                       ?? Double(t.minutes) * 60 * max(1, d.batches)
                let id = "\(d.id)#p\(i)"
                out.append(SeqStep(id: id, dish: d.name, label: t.label,
                                   track: t.kind == "walkaway" ? .passive : .hands,
                                   res: .none, durSec: sec,
                                   depIds: prev.map { [$0] } ?? []))
                prev = id
            }
            // Heat block: oven when the dish carries a temp, else a burner.
            // Duration: the recipe's passive minutes (hands-off cook time) when
            // real, else a conservative floor — bad estimates should still
            // produce a usable order, just looser clock times.
            let heatSec = Double(max(d.passiveMin > 0 ? d.passiveMin : 25, 10)) * 60
            // Oven only when the METHOD says so. A temp target alone is not oven
            // (range proteins cook to an internal temp too) — fall back to the
            // temp heuristic ONLY when the recipe declared no zones at all.
            let isOven = d.usesOven || (!d.hasMethodZones && d.tempF != nil)
            out.append(SeqStep(id: "\(d.id)#heat", dish: d.name,
                               label: isOven ? "bake / roast" : "cook on the range",
                               track: .heat,
                               res: isOven ? .oven(tempF: d.tempF ?? 350) : .burner,
                               durSec: heatSec,
                               depIds: prev.map { [$0] } ?? []))
        }
        return out
    }

    /// Schedule against a finish line. `finishMin` = minutes after midnight.
    static func plan(steps input: [SeqStep], finishMin: Int) -> SeqPlan {
        var plan = SeqPlan(); plan.finishMin = finishMin
        guard !input.isEmpty else { return plan }
        var steps = input
        // uniquingKeysWith everywhere in this engine: malformed input must
        // degrade, never trap — this is the screen the cook opens at 6am.
        let byId = Dictionary(steps.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { a, _ in a })

        // ── backward pass: latest start from the finish line ─────────────
        // Children lists once, then propagate latest-finish backwards.
        var children: [String: [String]] = [:]
        for s in steps { for dep in s.depIds { children[dep, default: []].append(s.id) } }
        let finishSec = Double(finishMin) * 60
        // iterate to fixpoint (graphs are tiny — a few dozen nodes)
        for _ in 0..<steps.count {
            for i in steps.indices {
                let kids = children[steps[i].id] ?? []
                let latestFinish = kids.compactMap { byId[$0].map { steps[$0].latestStart } }.min() ?? finishSec
                steps[i].latestStart = latestFinish - steps[i].durSec
            }
        }

        // ── forward pass: greedy least-slack under resources ─────────────
        // Day start: the critical path pulled back from the finish line, with
        // a 5-minute floor so a stacked day still yields a plan (it just
        // reports the overrun as a warning instead of failing).
        let earliest = steps.map(\.latestStart).min() ?? finishSec
        var now = max(earliest, 0)
        if earliest < 0 {
            plan.warnings.append("this day needs \(prepDurationLabel(-earliest)) more than the finish line allows — start earlier or move the line")
            now = 0
        }
        let dayStart = now
        var done: Set<String> = []
        var running: [(step: SeqStep, end: Double, temp: Int?)] = []
        var pending = steps
        var preheatSeq = 0
        let realIds = Set(steps.map(\.id))

        func ovenState() -> (busy: Bool, temp: Int?) {
            for r in running { if case .oven(let t) = r.step.res { return (true, t) } }
            return (false, nil)
        }
        var lastOvenTemp: Int? = nil

        var guardIter = 0
        while done.count < steps.count {
            guardIter += 1
            if guardIter > 5000 {
                plan.warnings.append("plan too complex to finish — showing what was scheduled")
                break
            }
            // retire finished work
            running.removeAll { r in
                if r.end <= now + 0.5 {
                    if realIds.contains(r.step.id) { done.insert(r.step.id) }
                    return true
                }
                return false
            }
            let cookBusy = running.contains { $0.step.track == .hands }
            let burnersBusy = running.filter { if case .burner = $0.step.res { return true }; return false }.count
            let oven = ovenState()

            // ready = all deps done, not yet placed
            var ready = pending.filter { s in !done.contains(s.id) && s.depIds.allSatisfy(done.contains) }
                .filter { s in !running.contains { $0.step.id == s.id } }
            ready.sort { $0.latestStart < $1.latestStart }   // least slack first

            var startedAny = false
            // Resource occupancy must update WITHIN this iteration, not read from
            // the stale start-of-iteration snapshot. The bug this fixes: the
            // single oven was checked against `oven.busy` (fixed for the whole
            // pass), so every ready oven dish claimed it at once and, with temps
            // differing, each inserted a 12-min preheat — thousands of phantom
            // "oven → N°F" steps piled up until the 5000-iteration cap (Omar saw
            // ~4,900 "steps" per dish). Now ONE oven action per tick, and burners
            // count as they fill. Omar, Jul 24.
            var ovenBusyNow = oven.busy
            var burnersNow = burnersBusy
            for s in ready {
                switch s.track {
                case .hands:
                    guard !running.contains(where: { $0.step.track == .hands }) else { continue }
                case .passive: break
                case .heat: break
                }
                switch s.res {
                case .none: break
                case .burner:
                    guard burnersNow < 4 else { continue }
                case .oven(let t):
                    // one temp zone: an occupied oven blocks; a temp CHANGE from
                    // the last load costs a 12-minute preheat, modeled as delay.
                    guard !ovenBusyNow else { continue }
                    if let last = lastOvenTemp, last != t {
                        lastOvenTemp = t
                        ovenBusyNow = true   // the preheat OWNS the oven this tick
                        preheatSeq += 1
                        let phId = s.id + "~preheat\(preheatSeq)"
                        running.append((SeqStep(id: phId, dish: s.dish,
                                                label: "oven to \(t)°F", track: .passive,
                                                // occupies the OVEN: the bake must wait for it
                                                res: .oven(tempF: t), durSec: 12 * 60, depIds: []),
                                        now + 12 * 60, t))
                        plan.placed.append(SeqPlaced(id: phId, dish: s.dish,
                                                     label: "oven → \(t)°F", track: .passive,
                                                     startSec: now, endSec: now + 12 * 60, ovenTemp: t))
                        startedAny = true
                        continue   // the bake itself starts once the preheat "step" clears
                    }
                    lastOvenTemp = t
                    ovenBusyNow = true   // this bake now holds the oven for the tick
                }
                // start it
                var temp: Int? = nil; if case .oven(let t) = s.res { temp = t }
                if case .burner = s.res { burnersNow += 1 }
                running.append((s, now + s.durSec, temp))
                plan.placed.append(SeqPlaced(id: s.id, dish: s.dish, label: s.label,
                                             track: s.track, startSec: now,
                                             endSec: now + s.durSec, ovenTemp: temp))
                if s.track == .hands { plan.cookBusySec += s.durSec }
                startedAny = true
                if s.track == .hands { break }   // cook can start only one; re-eval others next tick
            }

            // advance time: to the next completion, or if nothing is running and
            // nothing could start (shouldn't happen in a DAG), bail with warning
            if let nextEnd = running.map(\.end).min() {
                now = startedAny ? now : nextEnd
                if !startedAny { continue }
                // after starting things, jump to the next event
                now = running.map(\.end).min() ?? now
            } else if !startedAny {
                // Everything done = a clean exit, not a stall — the last retire
                // happens after the loop-top count check.
                if done.count < steps.count {
                    plan.warnings.append("scheduler stalled — a step's dependencies never completed")
                }
                break
            }
        }

        plan.startMin = Int((dayStart / 60).rounded())
        plan.makespanSec = (plan.placed.map(\.endSec).max() ?? dayStart) - dayStart
        return plan
    }
}

// ── VIEW: clock-timed checklist + a three-track peek ──────────────────────
struct SequencerView: View {
    let plan: SeqPlan
    @Binding var finishMin: Int
    @State private var showTracks = false
    @State private var expandedDishes: Set<String> = []   // which dishes are expanded to steps

    private func clock(_ sec: Double) -> String {
        let m = Int((sec / 60).rounded())
        let h24 = (m / 60) % 24, mm = m % 60
        let h12 = h24 % 12 == 0 ? 12 : h24 % 12
        return String(format: "%d:%02d%@", h12, mm, h24 >= 12 ? "p" : "a")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // finish-line picker — the whole plan back-times from this
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("FINISH BY").font(.ui(10, .bold)).tracking(0.8).foregroundStyle(Mise.ink4)
                    Text(clock(Double(finishMin) * 60)).font(.brand(22, .semibold)).foregroundStyle(Mise.ink)
                }
                Spacer()
                Stepper("", value: $finishMin, in: 300...1380, step: 15).labelsHidden()
                Button { Haptics.selection(); showTracks.toggle() } label: {
                    Text(showTracks ? "checklist" : "tracks").font(.ui(11, .bold)).foregroundStyle(Mise.navy)
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(Capsule().fill(Mise.surface2))
                }.buttonStyle(.plain)
            }
            if !plan.placed.isEmpty {
                HStack(spacing: 10) {
                    Text("start ≈\(clock(Double(plan.startMin) * 60))").font(.ui(12, .bold)).foregroundStyle(Mise.goldDeep)
                    Text("·").foregroundStyle(Mise.ink5)
                    Text("hands busy \(100 - plan.cookIdlePct)% of the day").font(.ui(12)).foregroundStyle(Mise.ink3)
                }
            }
            ForEach(plan.warnings, id: \.self) { w in
                Text("⚠ \(w)").font(.ui(11.5, .semibold)).foregroundStyle(Mise.danger)
                    .padding(.horizontal, 11).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Mise.dangerBg))
            }

            if plan.placed.isEmpty {
                Text("No parsed tasks yet — recipes gain their task list overnight, or on save.")
                    .font(.ui(12)).foregroundStyle(Mise.ink4).padding(.vertical, 16)
            } else if showTracks {
                trackView
            } else {
                checklist
            }
        }
    }

    // The cook plan, ONE LINE PER DISH — its start time + step count; tap to
    // expand the steps. The flat every-step list (100+ rows with times) was
    // overwhelming and slow (Omar, Jul 24: "it lists out every single step…
    // very long, very slow"). Collapsed by default; LazyVStack keeps even a
    // big day cheap to render.
    private var checklist: some View {
        let byDish = Dictionary(grouping: plan.placed) { $0.dish }
        let dishes = byDish
            .map { (dish: $0.key, steps: $0.value.sorted { $0.startSec < $1.startSec }) }
            .sorted { ($0.steps.first?.startSec ?? 0) < ($1.steps.first?.startSec ?? 0) }
        return LazyVStack(spacing: 6) {
            ForEach(dishes, id: \.dish) { d in
                let open = expandedDishes.contains(d.dish)
                let start = d.steps.first?.startSec ?? 0
                VStack(spacing: 0) {
                    Button {
                        Haptics.selection()
                        if open { expandedDishes.remove(d.dish) } else { expandedDishes.insert(d.dish) }
                    } label: {
                        HStack(spacing: 10) {
                            Text(clock(start)).font(.ui(12, .heavy)).monospacedDigit()
                                .foregroundStyle(Mise.goldDeep).frame(width: 52, alignment: .trailing)
                            Text(d.dish.lowercased()).font(.ui(14, .bold)).foregroundStyle(Mise.ink).lineLimit(1)
                            Spacer(minLength: 4)
                            Text("\(d.steps.count) step\(d.steps.count == 1 ? "" : "s")")
                                .font(.ui(10.5)).foregroundStyle(Mise.ink4)
                            Image(systemName: open ? "chevron.up" : "chevron.down")
                                .font(.system(size: 10, weight: .bold)).foregroundStyle(Mise.ink4)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 11)
                    }.buttonStyle(.plain)
                    if open {
                        VStack(spacing: 6) { ForEach(d.steps) { stepRow($0) } }
                            .padding(.horizontal, 10).padding(.bottom, 10)
                    }
                }
                .background(RoundedRectangle(cornerRadius: 11).fill(Mise.surface))
                .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(Mise.rule, lineWidth: 1))
            }
        }
    }
    // One scheduled step — the row shown when a dish is expanded.
    private func stepRow(_ p: SeqPlaced) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(clock(p.startSec)).font(.ui(12, .heavy)).monospacedDigit()
                .foregroundStyle(Mise.ink2).frame(width: 52, alignment: .trailing)
            ZStack {
                Circle().fill(color(p.track).opacity(0.15))
                Image(systemName: icon(p.track)).font(.system(size: 9, weight: .bold))
                    .foregroundStyle(color(p.track))
            }.frame(width: 20, height: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(p.label).font(.ui(13.5, p.track == .hands ? .bold : .semibold))
                    .foregroundStyle(Mise.ink)
                Text(prepDurationLabel(p.endSec - p.startSec) + (p.track != .hands ? " · hands free" : ""))
                    .font(.ui(10.5)).foregroundStyle(Mise.ink4)
            }
            Spacer(minLength: 4)
            if let t = p.ovenTemp { Text("\(t)°F").font(.ui(10, .heavy)).foregroundStyle(Mise.goldDeep) }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 9).fill(Mise.surface2))
    }

    // The peek: passive / hands / heat as stacked lanes on one time axis.
    private var trackView: some View {
        let t0 = plan.placed.map(\.startSec).min() ?? 0
        let t1 = plan.placed.map(\.endSec).max() ?? 1
        let span = max(t1 - t0, 60)
        return VStack(alignment: .leading, spacing: 8) {
            ForEach([SeqStep.Track.passive, .hands, .heat], id: \.self) { track in
                VStack(alignment: .leading, spacing: 3) {
                    Text(track == .passive ? "RUNNING ON ITS OWN" : track == .hands ? "YOUR HANDS" : "HEAT")
                        .font(.ui(9, .heavy)).tracking(0.7).foregroundStyle(Mise.ink4)
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 6).fill(Mise.surface2)
                            ForEach(plan.placed.filter { $0.track == track }) { p in
                                let x = (p.startSec - t0) / span * geo.size.width
                                let w = max((p.endSec - p.startSec) / span * geo.size.width, 8)
                                RoundedRectangle(cornerRadius: 5)
                                    .fill(color(track).opacity(0.8))
                                    .frame(width: w, height: 22)
                                    .offset(x: x)
                            }
                        }
                    }.frame(height: 24)
                }
            }
            HStack {
                Text(clock(t0)).font(.ui(10)).foregroundStyle(Mise.ink4)
                Spacer()
                Text(clock(t1)).font(.ui(10)).foregroundStyle(Mise.ink4)
            }
        }
    }

    private func color(_ t: SeqStep.Track) -> Color {
        switch t { case .passive: return Mise.info; case .hands: return Mise.navy; case .heat: return Mise.goldDeep }
    }
    private func icon(_ t: SeqStep.Track) -> String {
        switch t { case .passive: return "clock"; case .hands: return "hand.raised.fill"; case .heat: return "flame.fill" }
    }
}

extension SeqStep.Track: Hashable {}
