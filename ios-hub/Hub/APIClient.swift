import Foundation

enum APIError: LocalizedError {
    case badURL
    case http(Int, String)
    case message(String)

    var errorDescription: String? {
        switch self {
        case .badURL: return "服务器地址无效"
        case let .http(code, body): return "HTTP \(code)\(body.isEmpty ? "" : "：\(body)")"
        case let .message(m): return m
        }
    }
}

/// Thin client for the cc-monitor backend. Relies on URLSession's shared cookie
/// storage so the session cookie set by `/api/login` is reused automatically.
struct APIClient {
    let base: URL

    private static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.httpCookieStorage = .shared
        c.httpShouldSetCookies = true
        c.httpCookieAcceptPolicy = .always
        c.timeoutIntervalForRequest = 20
        c.waitsForConnectivity = true
        return URLSession(configuration: c)
    }()

    init?(serverURL: String) {
        let trimmed = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let u = URL(string: trimmed), u.scheme != nil, u.host != nil else { return nil }
        self.base = u
    }

    private func request(_ path: String, method: String = "GET", json: [String: Any]? = nil) -> URLRequest {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = method
        if let json {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        return req
    }

    @discardableResult
    private func send(_ req: URLRequest) async throws -> Data {
        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await Self.session.data(for: req)
        } catch {
            throw APIError.message(error.localizedDescription)
        }
        guard let http = resp as? HTTPURLResponse else { throw APIError.message("无响应") }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            // Surface the server's {"error": "..."} message when present.
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let msg = obj["error"] as? String {
                throw APIError.http(http.statusCode, msg)
            }
            throw APIError.http(http.statusCode, String(body.prefix(120)))
        }
        return data
    }

    func login(password: String) async throws {
        try await send(request("/api/login", method: "POST", json: ["password": password]))
    }

    func accounts() async throws -> [Account] {
        let data = try await send(request("/api/accounts"))
        return try JSONDecoder().decode(AccountsResponse.self, from: data).accounts
    }

    func refresh(id: String) async throws {
        try await send(request("/api/accounts/\(id)/refresh", method: "POST"))
    }
}
