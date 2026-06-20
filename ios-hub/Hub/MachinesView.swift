import SwiftUI

/// Terminal module entry: the list of registered machines (Mac, the NAS, …).
/// Tap a machine to see its sessions, tap a session to open the live terminal.
struct MachinesView: View {
    @Environment(HubModel.self) private var hub
    @Binding var showSettings: Bool

    var body: some View {
        NavigationStack {
            Group {
                if !hub.isConfigured {
                    ContentUnavailableView {
                        Label("未配置终端 Hub", systemImage: "server.rack")
                    } description: {
                        Text("到设置里填 Hub 地址和 AUTH_TOKEN")
                    } actions: {
                        Button("打开设置") { showSettings = true }
                            .buttonStyle(.borderedProminent)
                    }
                } else if hub.machines.isEmpty && !hub.loading {
                    ContentUnavailableView {
                        Label(hub.errorText == nil ? "暂无机器" : "连接失败",
                              systemImage: hub.errorText == nil ? "desktopcomputer" : "exclamationmark.triangle")
                    } description: {
                        Text(hub.errorText ?? "还没有电脑注册到 Hub。在电脑上跑 agent 配对后会出现在这里。")
                    } actions: {
                        Button("重试") { Task { await hub.reload() } }
                    }
                } else {
                    machineList
                }
            }
            .navigationTitle("终端")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                }
            }
            .task { if hub.isConfigured && hub.machines.isEmpty { await hub.reload() } }
        }
    }

    private var machineList: some View {
        List {
            ForEach(hub.machines) { m in
                if m.online, let client = hub.client() {
                    NavigationLink {
                        SessionListView(client: client, machine: m)
                    } label: {
                        MachineRow(machine: m)
                    }
                } else {
                    MachineRow(machine: m)   // offline: not tappable
                }
            }
        }
        .refreshable { await hub.reload() }
    }
}

private struct MachineRow: View {
    let machine: Machine

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(machine.online ? .green : .secondary)
                .frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 2) {
                Text(machine.name).font(.body)
                Text(machine.online ? "\(machine.sessions) 个会话" : "离线")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, 2)
        .opacity(machine.online ? 1 : 0.55)
    }
}

/// Sessions on one machine: list, create, kill, open.
struct SessionListView: View {
    let client: HubClient
    let machine: Machine

    @State private var sessions: [TermSession] = []
    @State private var loading = false
    @State private var errorText: String?
    @State private var showCreate = false
    @State private var newName = ""
    @State private var busy = false

    var body: some View {
        Group {
            if sessions.isEmpty && !loading {
                ContentUnavailableView {
                    Label(errorText == nil ? "暂无会话" : "无法加载",
                          systemImage: errorText == nil ? "terminal" : "exclamationmark.triangle")
                } description: {
                    Text(errorText ?? "点右上角 + 新建一个会话。")
                } actions: {
                    if errorText == nil {
                        Button("新建会话") { showCreate = true }.buttonStyle(.borderedProminent)
                    } else {
                        Button("重试") { Task { await load() } }
                    }
                }
            } else {
                List {
                    ForEach(sessions) { s in
                        NavigationLink {
                            TerminalScreen(client: client, machine: machine, session: s)
                        } label: {
                            SessionRow(session: s)
                        }
                        .swipeActions {
                            Button(role: .destructive) {
                                Task { await kill(s) }
                            } label: { Label("结束", systemImage: "trash") }
                        }
                    }
                }
                .refreshable { await load() }
            }
        }
        .navigationTitle(machine.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showCreate = true } label: { Image(systemName: "plus") }
                    .disabled(busy)
            }
        }
        .alert("新建会话", isPresented: $showCreate) {
            TextField("名称(可选)", text: $newName)
            Button("取消", role: .cancel) { newName = "" }
            Button("创建") { Task { await create() } }
        } message: {
            Text("在「\(machine.name)」上开一个新终端")
        }
        .task { await load() }
    }

    private func load() async {
        loading = true; errorText = nil
        defer { loading = false }
        do { sessions = try await client.sessions(machine: machine.id) }
        catch { errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }
    }

    private func create() async {
        busy = true; defer { busy = false }
        do {
            _ = try await client.createSession(machine: machine.id, name: newName.trimmingCharacters(in: .whitespaces))
            newName = ""
            await load()
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func kill(_ s: TermSession) async {
        do { try await client.killSession(machine: machine.id, sid: s.id); await load() }
        catch { errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }
    }
}

private struct SessionRow: View {
    let session: TermSession

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "terminal")
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title).font(.body)
                HStack(spacing: 8) {
                    if let c = session.cols, let r = session.rows {
                        Text("\(c)×\(r)")
                    }
                    if let clients = session.clients, clients > 0 {
                        Label("\(clients)", systemImage: "person.fill")
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, 2)
    }
}
