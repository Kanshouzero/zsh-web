import Foundation

/// WebSocket transport to the Hub's browser relay (`/ws?agent=&session=&access_token=`).
///
/// Wire protocol (matches hub.js):
///   server → us:  binary frame = raw PTY output;  text frame = JSON control
///                 ({"type":"exit",...} / {"type":"error","message":...})
///   us → server:  binary frame = keystrokes;  text {"type":"resize",cols,rows}
///
/// Connection state is driven by the URLSession delegate so `onOpen` fires only on
/// a real WebSocket handshake (not merely when we kick off the task), and a failed
/// dial reports an error fast instead of hanging forever on "连接中".
final class TerminalSocket: NSObject {
    private var urlSession: URLSession!
    private var task: URLSessionWebSocketTask?
    private var closed = false
    private var opened = false

    /// Raw PTY bytes arrived (delivered on the main queue).
    var onData: ((Data) -> Void)?
    /// The session ended or the machine dropped (main queue). String = reason to show.
    var onClose: ((String) -> Void)?
    /// Socket opened successfully (main queue).
    var onOpen: (() -> Void)?

    override init() {
        super.init()
        let cfg = URLSessionConfiguration.default
        cfg.waitsForConnectivity = false        // fail fast instead of hanging on "连接中"
        cfg.timeoutIntervalForRequest = 15
        urlSession = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }

    func connect(hubBase: URL, machine: String, session sid: String, accessToken: String) {
        guard var comps = URLComponents(url: hubBase, resolvingAgainstBaseURL: false) else {
            fail("Hub 地址无效"); return
        }
        comps.scheme = (comps.scheme == "https") ? "wss" : "ws"
        // appendingPathComponent on an empty base path yields "ws" (no leading
        // slash); URLComponents.url then returns nil whenever a host is present.
        // Force a leading slash so the URL actually builds.
        let joined = (comps.path as NSString).appendingPathComponent("ws")
        comps.path = joined.hasPrefix("/") ? joined : "/" + joined
        comps.queryItems = [
            .init(name: "agent", value: machine),
            .init(name: "session", value: sid),
            .init(name: "access_token", value: accessToken),
        ]
        guard let url = comps.url else { fail("URL 拼接失败"); return }
        let t = urlSession.webSocketTask(with: url)
        task = t
        t.resume()
        receive()
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self, !self.closed else { return }
            switch result {
            case let .success(message):
                switch message {
                case let .data(d):
                    DispatchQueue.main.async { self.onData?(d) }
                case let .string(s):
                    self.handleControl(s)
                @unknown default:
                    break
                }
                self.receive()
            case let .failure(error):
                self.fail(error.localizedDescription)
            }
        }
    }

    private func handleControl(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        let type = obj["type"] as? String
        if type == "exit" {
            let code = obj["code"] as? Int
            fail(code == nil ? "会话已结束" : "会话已结束(退出码 \(code!))")
        } else if type == "error" {
            fail((obj["message"] as? String) ?? "出错了")
        }
    }

    private func fail(_ reason: String) {
        guard !closed else { return }
        closed = true
        DispatchQueue.main.async { [weak self] in self?.onClose?(reason) }
    }

    /// Send keystrokes (raw bytes) to the PTY.
    func send(_ bytes: [UInt8]) {
        guard !closed, !bytes.isEmpty else { return }
        task?.send(.data(Data(bytes))) { _ in }
    }

    /// Tell the PTY the new grid size.
    func sendResize(cols: Int, rows: Int) {
        guard !closed, cols > 0, rows > 0 else { return }
        let json = #"{"type":"resize","cols":\#(cols),"rows":\#(rows)}"#
        task?.send(.string(json)) { _ in }
    }

    func disconnect() {
        closed = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }
}

extension TerminalSocket: URLSessionWebSocketDelegate {
    // Real handshake completed — only now are we actually "在线".
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        opened = true
        DispatchQueue.main.async { [weak self] in self?.onOpen?() }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        fail("连接已断开")
    }

    // Fires on dial failure (can't connect / TLS / DNS) and on normal completion.
    // Our own disconnect() sets `closed` first, so fail() no-ops in that case.
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error {
            fail(error.localizedDescription)
        } else if !opened {
            fail("连接失败")
        }
    }
}
