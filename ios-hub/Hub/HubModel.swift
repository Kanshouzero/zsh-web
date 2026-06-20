import Foundation
import Observation

/// State for the terminal module: connection settings to the zsh-web Hub plus the
/// list of machines. Sessions and the live terminal are loaded on demand by the
/// views, which reach back here for a configured `HubClient`.
@Observable
final class HubModel {
    var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: "hubURL") }
    }
    var token: String {
        didSet { UserDefaults.standard.set(token, forKey: "hubToken") }
    }

    var machines: [Machine] = []
    var loading = false
    var errorText: String?

    var isConfigured: Bool {
        !serverURL.trimmingCharacters(in: .whitespaces).isEmpty &&
        !token.trimmingCharacters(in: .whitespaces).isEmpty
    }

    init() {
        // Fall back to the baked-in defaults (Secrets.swift) on first launch, so
        // the app is pre-configured. Once the user saves Settings these persist.
        serverURL = UserDefaults.standard.string(forKey: "hubURL") ?? Secrets.defaultHubURL
        token = UserDefaults.standard.string(forKey: "hubToken") ?? Secrets.defaultHubToken
    }

    // Cache one client per (url, token) so the issued session token is reused
    // across navigations instead of re-logging-in on every screen.
    @ObservationIgnored private var cached: HubClient?
    @ObservationIgnored private var cachedKey = ""

    /// A client for the current settings (nil if the URL is malformed).
    func client() -> HubClient? {
        let key = "\(serverURL)\u{0}\(token)"
        if let cached, cachedKey == key { return cached }
        guard let c = HubClient(serverURL: serverURL, token: token) else { return nil }
        cached = c
        cachedKey = key
        return c
    }

    /// Load (or reload) the machine list.
    func reload() async {
        guard let client = client() else { errorText = "Hub 地址无效"; return }
        loading = true
        errorText = nil
        defer { loading = false }
        do {
            machines = try await client.machines()
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
