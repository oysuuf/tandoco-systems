import Foundation
import Capacitor
import StripeTerminal
import CoreLocation
import CoreBluetooth

// ─────────────────────────────────────────────────────────────────────
// CapacitorTandocoTerminalPlugin
//
// Thin Swift bridge over the official Stripe Terminal iOS SDK. Surfaces
// just the methods the market mode till in scripts/hq2.js calls:
//   initialize, discoverReaders, connectReader, disconnectReader,
//   retrievePaymentIntent, collectPaymentMethod, processPayment,
//   cancelCollectPaymentMethod, checkTapToPaySupport
//
// Replaces the community `capacitor-stripe-terminal` plugin (v2.x of
// which doesn't support Swift Package Manager — required by Capacitor 7
// + Xcode 26). See docs/MARKET_TERMINAL_SDK.md for full rationale.
//
// Two discovery paths supported:
//   discoveryMethod: 'bluetoothProximity' → Stripe Reader M2 over BLE
//   discoveryMethod: 'localMobile'        → Tap-to-Pay on iPhone (TTPI),
//                                           uses the phone's own NFC.
//                                           Requires Apple's
//                                           com.apple.developer.proximity-reader.payment.acceptance
//                                           entitlement (see
//                                           docs/MARKET_TERMINAL_ENTITLEMENT.md).
//
// JS calls this plugin as `window.Capacitor.Plugins.StripeTerminal`
// (registered name preserved so the existing scripts/hq2.js code
// shipped in PR #2812 doesn't need to change).
// ─────────────────────────────────────────────────────────────────────

// SDK 5 split the old MobileReaderDelegate roles into:
//   - TapToPayReaderDelegate (TTPI / phone-as-reader path · new in SDK 5)
//   - MobileReaderDelegate    (Bluetooth M2 path · same name as SDK 4)
// We conform to both so a single plugin instance can serve either flow.
// Method-name prefix tells the SDK which path fired the event:
// `tapToPayReader(_:...)` from TTPI, `reader(_:...)` from M2 / Bluetooth.
@objc(CapacitorTandocoTerminalPlugin)
public class CapacitorTandocoTerminalPlugin: CAPPlugin, CAPBridgedPlugin, ConnectionTokenProvider, DiscoveryDelegate, MobileReaderDelegate, TapToPayReaderDelegate {

    public let identifier = "CapacitorTandocoTerminalPlugin"
    public let jsName = "StripeTerminal"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "initialize",              returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setConnectionToken",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discoverReaders",         returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connectReader",           returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnectReader",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retrievePaymentIntent",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "collectPaymentMethod",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "processPayment",          returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelCollectPaymentMethod", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkTapToPaySupport",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestReaderPermissions", returnType: CAPPluginReturnPromise)
    ]

    // Strong refs so the managers aren't deallocated before iOS finishes
    // showing the permission prompt. Used only by requestReaderPermissions.
    private var _permLocationManager: CLLocationManager?
    private var _permBluetoothManager: CBCentralManager?

    // Last discoveryMethod requested by JS — drives which
    // ConnectionConfiguration builder we use when JS then calls
    // connectReader on one of the discovered readers.
    private var lastDiscoveryMethod: String = "bluetoothProximity"

    // Connection-token plumbing. Stripe Terminal SDK calls fetchConnectionToken()
    // whenever it needs a fresh token. We forward the request out to JS via
    // a notifyListeners event; JS hits our Cloud Function and calls back into
    // setConnectionToken() with the secret.
    private var pendingTokenCompletion: ConnectionTokenCompletionBlock?

    // Discovery state
    private var discoverCancelable: Cancelable?
    private var pendingDiscoverCall: CAPPluginCall?
    private var discoveredReaders: [Reader] = []

    // PaymentIntent state — held across retrievePaymentIntent →
    // collectPaymentMethod → processPayment so JS doesn't have to serialize
    // the whole PI object across the bridge.
    private var currentPaymentIntent: PaymentIntent?

    // Most recent collect-payment-method cancelable, for cancelCollectPaymentMethod.
    private var collectCancelable: Cancelable?

    public override func load() {
        // SDK 5+: setTokenProvider was replaced by initWithTokenProvider, which
        // must be called BEFORE the first access to Terminal.shared. Capacitor
        // calls load() on plugin registration (early in app launch), which is
        // the right moment.
        Terminal.initWithTokenProvider(self)
        // Forward SDK log lines to the iOS console for debugging.
        Terminal.shared.logLevel = .verbose
    }

    // ── ConnectionTokenProvider ──────────────────────────────────────

    public func fetchConnectionToken(_ completion: @escaping ConnectionTokenCompletionBlock) {
        // If there's already a pending request, supersede it rather than
        // rejecting this new one. Critical for the boot-time race: the SDK
        // eagerly tries to fetch a token the moment Terminal.initWithTokenProvider
        // runs (in this plugin's load()) — which is BEFORE the WebView has
        // loaded JS and registered the requestConnectionToken listener. That
        // first request fires our notifyListeners into a void (nobody listening
        // yet) and used to leave pendingTokenCompletion stuck — every subsequent
        // SDK call would then short-circuit with "previous token request still
        // pending" and discoverReaders / collectPaymentMethod would all fail.
        // Now we politely abandon the prior completion (so the SDK doesn't think
        // it leaked) and take ownership of the new one.
        if let prev = pendingTokenCompletion {
            prev(nil, NSError(domain: "CapacitorTandocoTerminalPlugin", code: 1, userInfo: [NSLocalizedDescriptionKey: "superseded by newer token request"]))
        }
        pendingTokenCompletion = completion
        notifyListeners("requestConnectionToken", data: [:])
    }

    @objc func setConnectionToken(_ call: CAPPluginCall) {
        // Called by JS in response to the requestConnectionToken event.
        guard let secret = call.getString("secret") else {
            pendingTokenCompletion?(nil, NSError(domain: "CapacitorTandocoTerminalPlugin", code: 2, userInfo: [NSLocalizedDescriptionKey: "missing secret"]))
            pendingTokenCompletion = nil
            call.reject("missing secret")
            return
        }
        pendingTokenCompletion?(secret, nil)
        pendingTokenCompletion = nil
        call.resolve()
    }

    // ── initialize ───────────────────────────────────────────────────
    @objc func initialize(_ call: CAPPluginCall) {
        // SDK is initialized in load() above. This method exists so the
        // JS code's StripeTerminal.initialize({...}) call doesn't error
        // out — it's a no-op on the native side.
        call.resolve()
    }

    // ── requestReaderPermissions ─────────────────────────────────────
    // Proactively surface the iOS Location + Bluetooth permission prompts
    // so they can be requested during onboarding, before the first charge
    // (Apple Tap-to-Pay App Review requirement). The JS side shows an
    // explainer first, then calls this.
    //   - Location: CLLocationManager.requestWhenInUseAuthorization()
    //   - Bluetooth: instantiating a CBCentralManager triggers the prompt
    // Both Info.plist usage strings are already present. Manager refs are
    // held on self so they survive until iOS resolves the prompt.
    // Idempotent — iOS won't re-prompt once answered.
    @objc func requestReaderPermissions(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let lm = CLLocationManager()
            self._permLocationManager = lm
            lm.requestWhenInUseAuthorization()
            self._permBluetoothManager = CBCentralManager(delegate: nil, queue: nil)
            call.resolve()
        }
    }

    // ── discoverReaders ──────────────────────────────────────────────
    // Two discoveryMethod values supported:
    //   "bluetoothProximity" (default) → Stripe Reader M2 over BLE
    //   "localMobile"                  → Tap-to-Pay on iPhone (phone is the reader)
    @objc func discoverReaders(_ call: CAPPluginCall) {
        let simulated = call.getBool("simulated") ?? false
        let method = call.getString("discoveryMethod") ?? "localMobile"
        lastDiscoveryMethod = method

        let config: DiscoveryConfiguration
        do {
            if method == "localMobile" {
                // TTPI — phone's own NFC as the "reader." JS "localMobile"
                // string preserved for backward-compat with hq2.js + mise-
                // market.html; only the Swift type name changed in SDK 5.
                config = try TapToPayDiscoveryConfigurationBuilder()
                    .setSimulated(simulated)
                    .build()
            } else {
                // Bluetooth M2 path — Stripe Reader M2 over BLE proximity scan.
                // Same builder name as SDK 4; signature unchanged.
                config = try BluetoothScanDiscoveryConfigurationBuilder()
                    .setSimulated(simulated)
                    .setTimeout(20)
                    .build()
            }
        } catch {
            call.reject("discover config error: \(error.localizedDescription)")
            return
        }

        // The SDK runs at most ONE discovery at a time. If one is already in
        // flight (e.g. the till's silent M2 auto-reconnect racing a manual
        // scan), settle the old caller's JS promise NOW and cancel its
        // discovery, then start the new one from the cancel completion.
        // Previously the old call was silently overwritten — its JS `await`
        // hung forever (the frozen "Scanning…" sheet) — and the new discovery
        // failed with SCPErrorBusy because the old scan still held the slot.
        if let prev = pendingDiscoverCall {
            prev.reject("superseded by a newer discoverReaders call")
            pendingDiscoverCall = nil
        }
        let start: () -> Void = { [weak self] in
            guard let self = self else { return }
            self.pendingDiscoverCall = call
            self.discoveredReaders = []
            self.discoverCancelable = Terminal.shared.discoverReaders(config, delegate: self) { [weak self] error in
                guard let self = self else { return }
                // Settle ONLY our own call — a newer discovery may own the
                // pending slot by the time this completion fires.
                guard let pending = self.pendingDiscoverCall, pending === call else { return }
                self.pendingDiscoverCall = nil
                self.discoverCancelable = nil
                if let error = error {
                    pending.reject("discoverReaders failed: \(error.localizedDescription)")
                } else {
                    // Discovery ended without error and without a reader batch
                    // (canceled, or a no-error natural completion) — resolve
                    // with whatever we saw instead of leaving JS pending forever.
                    pending.resolve(["readers": self.discoveredReaders.map { self.readerJson($0) }])
                }
            }
        }
        if let inFlight = discoverCancelable, !inFlight.completed {
            discoverCancelable = nil
            inFlight.cancel { _ in start() }
        } else {
            start()
        }
    }

    public func terminal(_ terminal: Terminal, didUpdateDiscoveredReaders readers: [Reader]) {
        discoveredReaders = readers
        // Return readers to JS as soon as at least one is found. The native
        // SDK keeps scanning in the background; JS sees the first batch.
        if let call = pendingDiscoverCall, !readers.isEmpty {
            call.resolve([
                "readers": readers.map { readerJson($0) }
            ])
            pendingDiscoverCall = nil
            discoverCancelable?.cancel { _ in /* best-effort */ }
            discoverCancelable = nil
        }
    }

    // ── connectReader ────────────────────────────────────────────────
    @objc func connectReader(_ call: CAPPluginCall) {
        guard let serialNumber = call.getString("serialNumber") else {
            call.reject("missing serialNumber")
            return
        }
        guard let reader = discoveredReaders.first(where: { $0.serialNumber == serialNumber }) else {
            call.reject("reader \(serialNumber) not in discovered list — call discoverReaders first")
            return
        }
        // For Bluetooth mobile readers, locationId is optional. The reader
        // self-registers under the Stripe account's default location on
        // first connect. JS can pass an explicit `locationId` later if
        // multi-location support is needed.
        let locationId = call.getString("locationId")
        // Method may also be passed per-call; otherwise reuse whatever
        // the most recent discoverReaders specified.
        let method = call.getString("discoveryMethod") ?? lastDiscoveryMethod

        do {
            // SDK 5+ designated initializer: BOTH connection configuration
            // builders take the reader delegate as the FIRST constructor
            // argument (NOT a chained .setDelegate / .delegate, and NOT a
            // separate parameter on Terminal.shared.connectReader). Headers:
            //   TapToPay:  -initWithDelegate:(id<SCPTapToPayReaderDelegate>)delegate locationId:
            //   Bluetooth: -initWithDelegate:(id<SCPMobileReaderDelegate>)delegate     locationId:
            // The plugin conforms to BOTH delegate protocols, so `self` is a
            // valid argument for either branch.
            let connectionConfig: ConnectionConfiguration
            if method == "localMobile" {
                // TTPI requires a location id — Apple ties each TTPI transaction
                // to a registered Stripe location for dispute/regulatory purposes.
                // Empty string is rejected by the SDK.
                connectionConfig = try TapToPayConnectionConfigurationBuilder(delegate: self, locationId: locationId ?? "")
                    .build()
            } else {
                // Bluetooth M2 — locationId is OPTIONAL; the reader self-registers
                // under the account's default location on first connect. JS can
                // pass an explicit locationId for multi-location markets.
                connectionConfig = try BluetoothConnectionConfigurationBuilder(delegate: self, locationId: locationId ?? "")
                    .build()
            }
            Terminal.shared.connectReader(reader, connectionConfig: connectionConfig) { [weak self] connectedReader, error in
                if let error = error {
                    call.reject("connectReader failed: \(error.localizedDescription)")
                    return
                }
                guard let connectedReader = connectedReader else {
                    call.reject("connectReader returned nil reader")
                    return
                }
                call.resolve([
                    "reader": self?.readerJson(connectedReader) ?? [:]
                ])
            }
        } catch {
            call.reject("connection config error: \(error.localizedDescription)")
        }
    }

    // ── checkTapToPaySupport ─────────────────────────────────────────
    // Lets JS gate the "tap on this phone" cardchoice button without
    // having to attempt a discovery scan that would fail noisily on
    // unsupported devices.
    //
    // Returns:
    //   supported: Bool
    //   reason: String  — empty when supported; short human-readable
    //                     hint when not (no NFC chip, old iOS,
    //                     entitlement missing, etc.). Don't surface
    //                     verbatim to customers; show "your iPhone
    //                     can't take taps right now · use the M2".
    @objc func checkTapToPaySupport(_ call: CAPPluginCall) {
        // Stripe Terminal SDK 5+ exposes a `supportsReaders(of:
        // discoveryMethod: simulated:)` capability check.
        // Returns true only when all of the following are true:
        //   - device hardware supports NFC card reading (iPhone XS+)
        //   - iOS is 16.4+
        //   - the app is signed with the proximity-reader entitlement
        do {
            // SDK 5+: discoveryMethod enum case renamed .localMobile → .tapToPay.
            try Terminal.shared.supportsReaders(
                of: .tapToPay,
                discoveryMethod: .tapToPay,
                simulated: false
            )
            call.resolve([ "supported": true, "reason": "" ])
        } catch {
            // The SDK's error message tells us why — we hand it back
            // verbatim so the till can log it for debugging, but the
            // JS layer should not surface it raw to the operator.
            call.resolve([
                "supported": false,
                "reason": error.localizedDescription
            ])
        }
    }

    // ── disconnectReader ─────────────────────────────────────────────
    @objc func disconnectReader(_ call: CAPPluginCall) {
        Terminal.shared.disconnectReader { error in
            if let error = error {
                call.reject("disconnectReader failed: \(error.localizedDescription)")
                return
            }
            call.resolve()
        }
    }

    // ── retrievePaymentIntent ────────────────────────────────────────
    @objc func retrievePaymentIntent(_ call: CAPPluginCall) {
        guard let secret = call.getString("clientSecret") else {
            call.reject("missing clientSecret")
            return
        }
        Terminal.shared.retrievePaymentIntent(clientSecret: secret) { [weak self] pi, error in
            if let error = error {
                call.reject("retrievePaymentIntent failed: \(error.localizedDescription)")
                return
            }
            self?.currentPaymentIntent = pi
            call.resolve([
                "paymentIntent": self?.paymentIntentJson(pi) ?? [:]
            ])
        }
    }

    // ── collectPaymentMethod ─────────────────────────────────────────
    @objc func collectPaymentMethod(_ call: CAPPluginCall) {
        guard let pi = currentPaymentIntent else {
            call.reject("no payment intent retrieved — call retrievePaymentIntent first")
            return
        }
        collectCancelable = Terminal.shared.collectPaymentMethod(pi) { [weak self] collectedPi, error in
            self?.collectCancelable = nil
            if let error = error {
                call.reject("collectPaymentMethod failed: \(error.localizedDescription)")
                return
            }
            self?.currentPaymentIntent = collectedPi
            call.resolve([
                "paymentIntent": self?.paymentIntentJson(collectedPi) ?? [:]
            ])
        }
    }

    // ── processPayment (aka confirmPaymentIntent in SDK 5+) ──────────
    @objc func processPayment(_ call: CAPPluginCall) {
        guard let pi = currentPaymentIntent else {
            call.reject("no payment intent collected — call collectPaymentMethod first")
            return
        }
        Terminal.shared.confirmPaymentIntent(pi) { [weak self] processedPi, error in
            if let error = error {
                call.reject("processPayment failed: \(error.localizedDescription)")
                return
            }
            self?.currentPaymentIntent = processedPi
            call.resolve([
                "paymentIntent": self?.paymentIntentJson(processedPi) ?? [:]
            ])
        }
    }

    // ── cancelCollectPaymentMethod ───────────────────────────────────
    @objc func cancelCollectPaymentMethod(_ call: CAPPluginCall) {
        guard let cancelable = collectCancelable else {
            call.resolve()  // no-op — nothing to cancel
            return
        }
        cancelable.cancel { error in
            if let error = error {
                call.reject("cancel failed: \(error.localizedDescription)")
                return
            }
            call.resolve()
        }
    }

    // ── TapToPayReaderDelegate (events the SDK pushes during a TTPI charge) ──
    // Method names are tapToPayReader(_:...) in SDK 5 (renamed from
    // reader(_:...) when MobileReaderDelegate was split into TapToPay-
    // and Bluetooth-specific protocols). All five below are REQUIRED by
    // TapToPayReaderDelegate. Same notifyListeners channels as before so
    // the JS side doesn't need to know which delegate fired the event.

    public func tapToPayReader(_ reader: Reader, didStartInstallingUpdate update: ReaderSoftwareUpdate, cancelable: Cancelable?) {
        notifyListeners("readerSoftwareUpdateProgress", data: ["progress": 0.0])
    }

    public func tapToPayReader(_ reader: Reader, didReportReaderSoftwareUpdateProgress progress: Float) {
        notifyListeners("readerSoftwareUpdateProgress", data: ["progress": Double(progress)])
    }

    public func tapToPayReader(_ reader: Reader, didFinishInstallingUpdate update: ReaderSoftwareUpdate?, error: Error?) {
        notifyListeners("readerSoftwareUpdateFinished", data: [
            "ok": error == nil,
            "error": error?.localizedDescription ?? ""
        ])
    }

    public func tapToPayReader(_ reader: Reader, didRequestReaderInput inputOptions: ReaderInputOptions) {
        // SDK is asking the customer to tap. Apple's full-screen Tap to Pay
        // UI takes the iPhone screen at this moment; we just forward the
        // event so the JS-side Card sheet can show a synchronized status.
        notifyListeners("readerRequestedInput", data: [
            "options": String(describing: inputOptions)
        ])
    }

    public func tapToPayReader(_ reader: Reader, didRequestReaderDisplayMessage displayMessage: ReaderDisplayMessage) {
        notifyListeners("readerDisplayMessage", data: [
            "message": String(describing: displayMessage)
        ])
    }

    // ── MobileReaderDelegate (events the SDK pushes for Bluetooth M2) ──
    // In SDK 5 the Bluetooth path KEPT the old `reader(_:...)` method
    // names (under the protocol now Swift-named MobileReaderDelegate).
    // Only TTPI got a brand-new delegate with `tapToPayReader(_:...)`
    // prefixed methods (above).
    //
    // All six below are REQUIRED on MobileReaderDelegate. The four after
    // them are OPTIONAL but useful for the till UI (battery level, low-
    // battery warning, disconnect handling, generic reader events).

    public func reader(_ reader: Reader, didReportAvailableUpdate update: ReaderSoftwareUpdate) {
        notifyListeners("readerSoftwareUpdateAvailable", data: [
            "version": update.deviceSoftwareVersion
        ])
    }

    public func reader(_ reader: Reader, didStartInstallingUpdate update: ReaderSoftwareUpdate, cancelable: Cancelable?) {
        notifyListeners("readerSoftwareUpdateProgress", data: ["progress": 0.0])
    }

    public func reader(_ reader: Reader, didReportReaderSoftwareUpdateProgress progress: Float) {
        notifyListeners("readerSoftwareUpdateProgress", data: ["progress": Double(progress)])
    }

    public func reader(_ reader: Reader, didFinishInstallingUpdate update: ReaderSoftwareUpdate?, error: Error?) {
        notifyListeners("readerSoftwareUpdateFinished", data: [
            "ok": error == nil,
            "error": error?.localizedDescription ?? ""
        ])
    }

    public func reader(_ reader: Reader, didRequestReaderInput inputOptions: ReaderInputOptions) {
        notifyListeners("readerRequestedInput", data: [
            "options": String(describing: inputOptions)
        ])
    }

    public func reader(_ reader: Reader, didRequestReaderDisplayMessage displayMessage: ReaderDisplayMessage) {
        notifyListeners("readerDisplayMessage", data: [
            "message": String(describing: displayMessage)
        ])
    }

    // Optional MobileReaderDelegate events ─────────────────────────────

    public func reader(_ reader: Reader, didReportReaderEvent event: ReaderEvent, info: [AnyHashable : Any]?) {
        notifyListeners("readerEvent", data: [
            "event": String(describing: event),
            "serialNumber": reader.serialNumber
        ])
    }

    public func reader(_ reader: Reader, didReportBatteryLevel batteryLevel: Float, status: BatteryStatus, isCharging: Bool) {
        notifyListeners("batteryLevel", data: [
            "batteryLevel": Double(batteryLevel),
            "isCharging": isCharging
        ])
    }

    public func readerDidReportLowBatteryWarning(_ reader: Reader) {
        notifyListeners("readerLowBattery", data: [:])
    }

    public func reader(_ reader: Reader, didDisconnect reason: DisconnectReason) {
        notifyListeners("readerDisconnected", data: [
            "reason": String(describing: reason),
            "serialNumber": reader.serialNumber
        ])
    }

    // ── JSON helpers ─────────────────────────────────────────────────

    private func readerJson(_ reader: Reader) -> [String: Any] {
        var dict: [String: Any] = [
            "serialNumber": reader.serialNumber,
            "deviceType":   String(describing: reader.deviceType)
        ]
        if let label = reader.label { dict["label"] = label }
        if let battery = reader.batteryLevel?.doubleValue { dict["batteryLevel"] = battery }
        return dict
    }

    private func paymentIntentJson(_ pi: PaymentIntent?) -> [String: Any] {
        guard let pi = pi else { return [:] }
        return [
            "id": pi.stripeId ?? "",
            "status": Self.paymentIntentStatusString(pi.status),
            "amount": pi.amount
        ]
    }

    // Map SCPPaymentIntentStatus → the lowercase snake_case strings the
    // JS side compares against ('succeeded', 'requires_capture', etc.).
    //
    // CRITICAL: the old code used String(describing: pi.status), which
    // produces "SCPPaymentIntentStatus(rawValue: 6)" — NOT "succeeded".
    // The mise-market orchestrator checks `status !== 'succeeded' &&
    // status !== 'requires_capture'` and threw on every real success,
    // showing "Charge failed" + a "Try again" button AFTER the customer's
    // card had already been charged (double-charge + stuck-pending-ticket
    // risk). Mapping to the canonical strings fixes it.
    //
    // Switch matches by case NAME, so declaration order here is
    // irrelevant — but for the record the SDK's rawValue order
    // (verified against SCPPaymentIntentStatus.h, SDK 5.3.0) is:
    //   0 requiresPaymentMethod · 1 requiresConfirmation · 2 requiresAction
    //   3 requiresCapture · 4 processing · 5 canceled · 6 succeeded
    //   7 requiresReauthorization
    // The "rawValue: 6" that surfaced as a fake failure was succeeded.
    private static func paymentIntentStatusString(_ status: PaymentIntentStatus) -> String {
        switch status {
        case .requiresPaymentMethod:    return "requires_payment_method"
        case .requiresConfirmation:     return "requires_confirmation"
        case .requiresAction:           return "requires_action"
        case .requiresCapture:          return "requires_capture"
        case .processing:               return "processing"
        case .canceled:                 return "canceled"
        case .succeeded:                return "succeeded"
        case .requiresReauthorization:  return "requires_reauthorization"
        @unknown default:               return "unknown_\(status.rawValue)"
        }
    }
}
