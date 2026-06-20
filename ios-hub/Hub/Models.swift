import Foundation

/// Mirrors the JSON returned by the self-hosted cc-monitor backend
/// (`GET /api/accounts`). Field names match the server's `publicView`.
struct AccountsResponse: Codable {
    let accounts: [Account]
}

struct Account: Codable, Identifiable {
    let id: String
    let name: String
    let subscriptionType: String?
    let usage: Usage?
    let lastFetchedAt: Double?
    let lastError: String?
}

struct Usage: Codable {
    let fiveHour: UsageWindow?
    let sevenDay: UsageWindow?
    let sevenDaySonnet: UsageWindow?
    let overallStatus: String?
}

/// One rate-limit window (5h / 7d). Named to avoid clashing with SwiftUI.Window.
struct UsageWindow: Codable {
    let usedPercent: Double?
    let resetsAt: String?
    let status: String?
}

extension UsageWindow {
    /// Parses the ISO-8601 reset timestamp (e.g. "2026-06-18T07:10:00.000Z").
    var resetDate: Date? {
        guard let s = resetsAt else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    /// Human "重置于 X" string for display.
    var resetLabel: String? {
        guard let d = resetDate else { return nil }
        let secs = d.timeIntervalSinceNow
        if secs <= 0 { return "即将重置" }
        let h = Int(secs) / 3600
        let m = (Int(secs) % 3600) / 60
        if h >= 1 { return m > 0 ? "\(h) 小时 \(m) 分后重置" : "\(h) 小时后重置" }
        return "\(m) 分钟后重置"
    }
}
