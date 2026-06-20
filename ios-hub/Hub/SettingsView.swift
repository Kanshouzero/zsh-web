import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(HubModel.self) private var hub
    @Environment(\.dismiss) private var dismiss

    // 终端 Hub(用量也走它)
    @State private var hubURL = ""
    @State private var hubToken = ""
    @State private var hubTesting = false
    @State private var hubResult: String?
    @State private var hubOK = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("地址,如 http://192.168.1.10:7654", text: $hubURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("AUTH_TOKEN", text: $hubToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Button {
                        Task { await testHub() }
                    } label: {
                        HStack {
                            Text("连接测试")
                            if hubTesting { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(hubTesting || hubURL.trimmingCharacters(in: .whitespaces).isEmpty)

                    if let r = hubResult {
                        Text(r).font(.footnote).foregroundStyle(hubOK ? .green : .red)
                    }
                } header: {
                    Text("Hub(zsh-web)")
                } footer: {
                    Text("终端会话 + Claude 用量的统一服务。地址是 Hub 端口(默认 7654);AUTH_TOKEN 是 Hub 部署时设的共享令牌。用量也走这个登录,不再单独配置。")
                }

                Section {} footer: {
                    Text("局域网填内网地址;在外面访问填 Lucky 反代的公网域名(https)。令牌只存在本机。")
                }
            }
            .navigationTitle("设置")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                }
            }
            .onAppear {
                hubURL = hub.serverURL
                hubToken = hub.token
            }
        }
    }

    private func testHub() async {
        hubTesting = true; hubResult = nil
        defer { hubTesting = false }
        guard let client = HubClient(serverURL: hubURL, token: hubToken) else {
            hubOK = false; hubResult = "地址格式无效"; return
        }
        do {
            let machines = try await client.machines()
            let online = machines.filter(\.online).count
            hubOK = true
            hubResult = "连接成功 · \(machines.count) 台机器(\(online) 在线)"
        } catch {
            hubOK = false
            hubResult = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func save() {
        hub.serverURL = hubURL.trimmingCharacters(in: .whitespaces)
        hub.token = hubToken.trimmingCharacters(in: .whitespaces)
        if hub.isConfigured {
            Task { await hub.reload() }
            Task { await model.reload() }   // usage rides the same Hub login
        }
        dismiss()
    }
}
