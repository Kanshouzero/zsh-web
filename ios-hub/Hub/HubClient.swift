import Foundation

/// REST client for the zsh-web Hub. Authenticates once with the shared token via
/// `POST /api/app/login`, caches the returned session token, and sends it as
/// `Authorization: Bearer` on every call. The same session token is handed to the
/// terminal WebSocket as `?access_token=` (see TerminalSocket).
actor HubClient {
    let base: URL
    private let appToken: String          // the shared AUTH_TOKEN (the credential)
    private var session: String?          // the issued session token (Bearer)

    private static let urlSession: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 20
        c.waitsForConnectivity = false   // fail fast so login errors surface instead of hanging
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    init?(serverURL: String, token: String) {
        let trimmed = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let u = URL(string: trimmed), u.scheme != nil, u.host != nil else { return nil }
        self.base = u
        self.appToken = token
    }

    /// The session token, exposed so the WebSocket layer can authenticate.
    func sessionToken() async throws -> String {
        if let session { return session }
        return try await login()
    }

    @discardableResult
    func login() async throws -> String {
        let data = try await send(req("/api/app/login", method: "POST", json: ["token": appToken]),
                                  authed: false)
        let tok = try JSONDecoder().decode(AppLoginResponse.self, from: data).token
        session = tok
        return tok
    }

    func machines() async throws -> [Machine] {
        let data = try await sendAuthed(req("/api/agents"))
        return try JSONDecoder().decode(MachinesResponse.self, from: data).agents
    }

    func sessions(machine id: String) async throws -> [TermSession] {
        let data = try await sendAuthed(req("/api/agents/\(id)/sessions"))
        return try JSONDecoder().decode(SessionsResponse.self, from: data).sessions
    }

    func createSession(machine id: String, name: String?) async throws -> TermSession {
        var body: [String: Any] = [:]
        if let name, !name.isEmpty { body["name"] = name }
        let data = try await sendAuthed(req("/api/agents/\(id)/sessions", method: "POST", json: body))
        return try JSONDecoder().decode(CreateSessionResponse.self, from: data).session
    }

    func killSession(machine id: String, sid: String) async throws {
        _ = try await sendAuthed(req("/api/agents/\(id)/sessions/\(sid)", method: "DELETE"))
    }

    // MARK: - Claude usage (proxied by the Hub to its usage service)

    /// Cached usage for every account (fast).
    func usageAccounts() async throws -> [Account] {
        let data = try await sendAuthed(req("/api/usage"))
        return try JSONDecoder().decode(AccountsResponse.self, from: data).accounts
    }

    /// Force the server to re-pull one account from upstream.
    func refreshUsageAccount(_ id: String) async throws {
        _ = try await sendAuthed(req("/api/usage/accounts/\(id)/refresh", method: "POST"))
    }

    // MARK: - plumbing

    private func req(_ path: String, method: String = "GET", json: [String: Any]? = nil) -> URLRequest {
        var r = URLRequest(url: base.appendingPathComponent(path))
        r.httpMethod = method
        if let json {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        return r
    }

    /// Send with the Bearer token, logging in (or re-logging-in on 401) as needed.
    private func sendAuthed(_ request: URLRequest) async throws -> Data {
        if session == nil { _ = try await login() }
        do {
            return try await send(request, authed: true)
        } catch HubError.http(401, _) {
            session = nil
            _ = try await login()
            return try await send(request, authed: true)
        }
    }

    private func send(_ request: URLRequest, authed: Bool) async throws -> Data {
        var req = request
        if authed, let session {
            req.setValue("Bearer \(session)", forHTTPHeaderField: "Authorization")
        }
        let data: Data, resp: URLResponse
        do {
            (data, resp) = try await Self.urlSession.data(for: req)
        } catch {
            throw HubError.message(error.localizedDescription)
        }
        guard let http = resp as? HTTPURLResponse else { throw HubError.message("无响应") }
        guard (200..<300).contains(http.statusCode) else {
            var msg = ""
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let e = obj["error"] as? String { msg = e }
            throw HubError.http(http.statusCode, msg)
        }
        return data
    }
}

enum HubError: LocalizedError {
    case http(Int, String)
    case message(String)

    var errorDescription: String? {
        switch self {
        case let .http(code, body):
            if code == 401 { return "令牌无效或已过期(检查 AUTH_TOKEN)" }
            if code == 503 { return body.isEmpty ? "机器离线" : body }
            return "HTTP \(code)\(body.isEmpty ? "" : "：\(body)")"
        case let .message(m): return m
        }
    }
}
