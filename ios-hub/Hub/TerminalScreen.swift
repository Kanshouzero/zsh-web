import SwiftUI
import SwiftTerm
import UIKit

enum TerminalStatus: Equatable {
    case connecting
    case connected
    case closed(String)
}

/// Bridges SwiftTerm's UIKit `TerminalView` into SwiftUI and wires it to a Hub
/// session over a WebSocket. The terminal's built-in accessory bar (esc / tab /
/// ctrl / arrows / F-keys) comes for free with `TerminalView`.
struct TerminalContainer: UIViewRepresentable {
    let client: HubClient
    let machine: String
    let sid: String
    @Binding var status: TerminalStatus

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> TerminalView {
        let tv = TerminalView(frame: .zero)
        tv.terminalDelegate = context.coordinator
        tv.backgroundColor = .black
        tv.nativeBackgroundColor = .black
        tv.nativeForegroundColor = UIColor(white: 0.92, alpha: 1)
        if let mono = UIFont(name: "Menlo", size: 11) { tv.font = mono }
        context.coordinator.attach(tv)
        return tv
    }

    func updateUIView(_ uiView: TerminalView, context: Context) {}

    static func dismantleUIView(_ uiView: TerminalView, coordinator: Coordinator) {
        coordinator.disconnect()
    }

    final class Coordinator: NSObject, TerminalViewDelegate, UIGestureRecognizerDelegate {
        private let parent: TerminalContainer
        private let socket = TerminalSocket()
        private weak var terminal: TerminalView?

        // Drag-to-scroll for full-screen TUIs (claude / vim / less). They run in the
        // alternate buffer, which has no scrollback — SwiftTerm's own pan finds nothing
        // to scroll, so you're stuck on the latest screen. Mirror the web client: in the
        // alternate buffer, translate a vertical drag into arrow keys for the program.
        private var panResidualY: CGFloat = 0
        private var panLastY: CGFloat = 0

        init(_ parent: TerminalContainer) { self.parent = parent }

        func attach(_ tv: TerminalView) {
            terminal = tv
            socket.onOpen = { [weak self] in
                guard let self else { return }
                self.setStatus(.connected)
                // The PTY was created at a default size (80×24) before the socket
                // connected, so push the terminal's real grid now — otherwise output
                // wraps to 80 cols and overflows the phone's narrower screen.
                let t = self.terminal?.getTerminal()
                if let t, t.cols > 0 { self.socket.sendResize(cols: t.cols, rows: t.rows) }
            }
            socket.onData = { [weak tv] data in tv?.feed(byteArray: [UInt8](data)[...]) }
            socket.onClose = { [weak self] reason in
                self?.terminal?.feed(text: "\r\n\u{1b}[33m[\(reason)]\u{1b}[0m\r\n")
                self?.setStatus(.closed(reason))
            }
            // Authenticate, then dial the relay.
            Task { @MainActor in
                do {
                    let token = try await parent.client.sessionToken()
                    socket.connect(hubBase: parent.client.base,
                                   machine: parent.machine,
                                   session: parent.sid,
                                   accessToken: token)
                } catch {
                    setStatus(.closed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription))
                }
            }
            // Keep SwiftTerm's full stock accessory bar (esc/ctrl/tab/arrows/F-keys/
            // hide-keyboard) and stack our own extra row on top of it for the things
            // the stock bar lacks: Shift-Tab, one-tap Ctrl-C, and clipboard paste.
            // Set after init so it survives `setup()`'s default bar.
            let width = tv.frame.width > 0 ? tv.frame.width : UIScreen.main.bounds.width
            let bar = TerminalKeyBar(width: width, terminalView: tv)
            bar.onBytes = { [weak self] bytes in self?.socket.send(bytes) }
            bar.onPaste = { [weak self] in
                guard let s = UIPasteboard.general.string, !s.isEmpty else { return }
                self?.socket.send(Array(s.utf8))
            }
            tv.inputAccessoryView = bar

            // Drag-to-scroll inside alternate-buffer TUIs (see panResidualY note above).
            // Runs alongside SwiftTerm's own pan; in the normal buffer it bails out and
            // leaves the stock scrollback panning untouched.
            let pan = UIPanGestureRecognizer(target: self, action: #selector(altBufferPan(_:)))
            pan.delegate = self
            tv.addGestureRecognizer(pan)

            DispatchQueue.main.async { _ = tv.becomeFirstResponder() }
        }

        func disconnect() { socket.disconnect() }

        @objc func altBufferPan(_ g: UIPanGestureRecognizer) {
            guard let tv = terminal, tv.getTerminal().isCurrentBufferAlternate else { return }
            switch g.state {
            case .began:
                panLastY = 0
                panResidualY = 0
            case .changed:
                let y = g.translation(in: tv).y
                panResidualY += y - panLastY
                panLastY = y
                let step: CGFloat = 16   // points of drag per emitted arrow key
                // Drag down (residual > 0) reveals older content → up arrow, and vice versa.
                let up: [UInt8] = [0x1b, 0x5b, 0x41], down: [UInt8] = [0x1b, 0x5b, 0x42]
                while panResidualY >= step { socket.send(up); panResidualY -= step }
                while panResidualY <= -step { socket.send(down); panResidualY += step }
            default:
                panResidualY = 0
            }
        }

        // Coexist with SwiftTerm's built-in scroll/selection pan rather than racing it.
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        private func setStatus(_ s: TerminalStatus) {
            DispatchQueue.main.async { self.parent.status = s }
        }

        // MARK: TerminalViewDelegate
        func send(source: TerminalView, data: ArraySlice<UInt8>) { socket.send(Array(data)) }
        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) { socket.sendResize(cols: newCols, rows: newRows) }
        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
        func bell(source: TerminalView) {}
        func clipboardCopy(source: TerminalView, content: Data) {}
        func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}

/// Full-screen terminal for one session, with a connection badge and a reconnect
/// banner when the session ends or the machine drops.
struct TerminalScreen: View {
    let client: HubClient
    let machine: Machine
    let session: TermSession

    @State private var status: TerminalStatus = .connecting
    @State private var instance = UUID()   // bump to rebuild the socket (reconnect)

    var body: some View {
        TerminalContainer(client: client, machine: machine.id, sid: session.id, status: $status)
            .id(instance)
            .background(Color.black)
            .navigationTitle(session.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { badge } }
            .safeAreaInset(edge: .top) { banner }
    }

    @ViewBuilder private var badge: some View {
        switch status {
        case .connecting:
            HStack(spacing: 5) { ProgressView().controlSize(.mini); Text("连接中").font(.caption) }
        case .connected:
            Label("在线", systemImage: "circle.fill")
                .labelStyle(.titleAndIcon).font(.caption).foregroundStyle(.green)
        case .closed:
            Label("已断开", systemImage: "circle.fill")
                .labelStyle(.titleAndIcon).font(.caption).foregroundStyle(.red)
        }
    }

    @ViewBuilder private var banner: some View {
        if case let .closed(msg) = status {
            HStack {
                Image(systemName: "exclamationmark.triangle.fill")
                Text(msg).font(.footnote).lineLimit(1)
                Spacer()
                Button("重连") { status = .connecting; instance = UUID() }
                    .font(.footnote.bold())
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(.red.opacity(0.85))
            .foregroundStyle(.white)
        }
    }
}

/// Keeps SwiftTerm's full stock accessory bar (esc/ctrl/tab/arrows/F-keys/
/// hide-keyboard) and stacks one extra row on top of it for the keys the stock
/// bar lacks: Shift-Tab, one-tap Ctrl-C, and clipboard paste.
final class TerminalKeyBar: UIInputView {
    /// Send raw bytes to the PTY.
    var onBytes: (([UInt8]) -> Void)?
    /// Paste the system clipboard.
    var onPaste: (() -> Void)?

    private let extraRowHeight: CGFloat = 40
    private let stockRowHeight: CGFloat = 36

    init(width: CGFloat, terminalView: TerminalView) {
        super.init(frame: CGRect(x: 0, y: 0, width: width, height: extraRowHeight + stockRowHeight),
                   inputViewStyle: .keyboard)
        allowsSelfSizing = true
        translatesAutoresizingMaskIntoConstraints = true
        autoresizingMask = [.flexibleWidth]
        buildUI(width: width, terminalView: terminalView)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func buildUI(width: CGFloat, terminalView: TerminalView) {
        // --- our extra row (only the keys the stock bar is missing) ---
        let stack = UIStackView()
        stack.axis = .horizontal
        stack.spacing = 6
        stack.alignment = .fill
        stack.layoutMargins = UIEdgeInsets(top: 5, left: 8, bottom: 5, right: 8)
        stack.isLayoutMarginsRelativeArrangement = true
        stack.addArrangedSubview(key("^C")   { [weak self] in self?.send([0x03]) })
        stack.addArrangedSubview(key("⇧Tab") { [weak self] in self?.send([0x1b, 0x5b, 0x5a]) })   // ESC [ Z
        stack.addArrangedSubview(key("粘贴") { [weak self] in self?.onPaste?() })

        let scroll = UIScrollView()
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)

        // --- SwiftTerm's own bar, unchanged, sitting below our row ---
        let stock = TerminalAccessory(frame: CGRect(x: 0, y: 0, width: width, height: stockRowHeight),
                                      inputViewStyle: .keyboard, container: terminalView)
        stock.translatesAutoresizingMaskIntoConstraints = false

        addSubview(scroll)
        addSubview(stock)

        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.heightAnchor.constraint(equalToConstant: extraRowHeight),
            stock.leadingAnchor.constraint(equalTo: leadingAnchor),
            stock.trailingAnchor.constraint(equalTo: trailingAnchor),
            stock.topAnchor.constraint(equalTo: scroll.bottomAnchor),
            stock.bottomAnchor.constraint(equalTo: bottomAnchor),
            stock.heightAnchor.constraint(equalToConstant: stockRowHeight),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            stack.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
        ])
    }

    private func send(_ bytes: [UInt8]) {
        UIDevice.current.playInputClick()
        onBytes?(bytes)
    }

    private func key(_ title: String, _ action: @escaping () -> Void) -> UIButton {
        let b = HandlerButton(type: .system)
        b.setTitle(title, for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: 15, weight: .medium)
        b.setTitleColor(UIColor(white: 0.92, alpha: 1), for: .normal)
        b.backgroundColor = UIColor(white: 0.22, alpha: 1)
        b.layer.cornerRadius = 6
        b.contentEdgeInsets = UIEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
        b.handler = action
        b.addTarget(b, action: #selector(HandlerButton.fire), for: .touchUpInside)
        return b
    }
}

/// A UIButton that carries its own closure, so the key bar can build keys without
/// a selector per key.
private final class HandlerButton: UIButton {
    var handler: (() -> Void)?
    @objc func fire() { handler?() }
}
