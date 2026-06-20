import Foundation

// Template for the gitignored Hub/Secrets.swift. Copy this file to
// Hub/Secrets.swift and fill in your own values. (This template lives outside the
// Hub/ folder on purpose, so Xcode's folder-sync does NOT compile it.)
enum Secrets {
    static let defaultHubURL = "http://YOUR-NAS-IP:7654"
    static let defaultHubToken = "PUT-YOUR-AUTH_TOKEN-HERE"   // must match the Hub's AUTH_TOKEN
    static let defaultUsageURL = "http://YOUR-NAS-IP:8790"
}
