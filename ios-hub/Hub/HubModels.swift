import Foundation

/// Mirrors the JSON returned by the zsh-web Hub (the terminal backend on the NAS),
/// which is a different service from cc-monitor used by the usage module.

/// One registered computer (Mac, the Synology itself, …) that runs an Agent.
/// `GET /api/agents` → `{ agents: [...] }`.
struct Machine: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let online: Bool
    let sessions: Int
    let addedAt: Double?
}

struct MachinesResponse: Codable {
    let agents: [Machine]
}

/// One terminal session on a machine. Matches `Session.info()` in sessions.js.
/// `GET /api/agents/:id/sessions` → `{ sessions: [...] }`.
struct TermSession: Codable, Identifiable, Hashable {
    let id: String
    let name: String?
    let createdAt: Double?
    let clients: Int?
    let cols: Int?
    let rows: Int?
    let exited: Bool?
    let exitCode: Int?

    var title: String { name ?? "session-\(id)" }
}

struct SessionsResponse: Codable {
    let sessions: [TermSession]
}

/// `POST /api/agents/:id/sessions` → `{ session: {...} }`.
struct CreateSessionResponse: Codable {
    let session: TermSession
}

/// `POST /api/app/login` → `{ ok, token, user }`. We only need the session token.
struct AppLoginResponse: Codable {
    let ok: Bool
    let token: String
}
