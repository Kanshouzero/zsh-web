import Foundation
import Observation

/// Usage state. After the cc-monitor merge, usage no longer has its own server /
/// password — it rides the terminal Hub's login (the same `hubURL` + `hubToken`
/// as HubModel) and reads `GET /api/usage`, which the Hub proxies to its usage
/// service. Keeps the same surface UsageView already uses.
@Observable
final class AppModel {
    var accounts: [Account] = []
    var loggedIn = false
    var loading = false
    var errorText: String?

    /// Configured whenever the Hub is configured (URL + shared token present).
    var isConfigured: Bool {
        !hubURL.trimmingCharacters(in: .whitespaces).isEmpty &&
        !hubToken.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private var hubURL: String {
        UserDefaults.standard.string(forKey: "hubURL") ?? Secrets.defaultHubURL
    }
    private var hubToken: String {
        UserDefaults.standard.string(forKey: "hubToken") ?? Secrets.defaultHubToken
    }

    // Cache one client per (url, token) so the issued session token is reused
    // across reloads instead of re-logging-in every time.
    @ObservationIgnored private var cached: HubClient?
    @ObservationIgnored private var cachedKey = ""

    private func client() -> HubClient? {
        let key = "\(hubURL)\u{0}\(hubToken)"
        if let cached, cachedKey == key { return cached }
        guard let c = HubClient(serverURL: hubURL, token: hubToken) else { return nil }
        cached = c
        cachedKey = key
        return c
    }

    /// Load accounts. Used after editing settings and on launch.
    func connect() async { await reload() }

    /// Reload the account list.
    func reload() async {
        guard let client = client() else { errorText = "Hub 未配置"; return }
        loading = true
        errorText = nil
        defer { loading = false }
        do {
            accounts = try await client.usageAccounts()
            loggedIn = true
        } catch {
            loggedIn = false
            errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Force a server-side usage refresh for one account, then reload.
    func refresh(_ id: String) async {
        guard let client = client() else { return }
        do {
            try await client.refreshUsageAccount(id)
            accounts = try await client.usageAccounts()
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
