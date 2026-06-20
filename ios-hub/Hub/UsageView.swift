import SwiftUI

struct UsageView: View {
    @Environment(AppModel.self) private var model
    @Binding var showSettings: Bool

    var body: some View {
        NavigationStack {
            Group {
                if !model.isConfigured {
                    ContentUnavailableView {
                        Label("未连接服务器", systemImage: "server.rack")
                    } description: {
                        Text("先在设置里配置 Hub 地址和令牌")
                    } actions: {
                        Button("打开设置") { showSettings = true }
                            .buttonStyle(.borderedProminent)
                    }
                } else if model.accounts.isEmpty {
                    if model.loading {
                        ProgressView("加载中…")
                    } else {
                        ContentUnavailableView {
                            Label("暂无账号", systemImage: "person.crop.circle.badge.questionmark")
                        } description: {
                            Text(model.errorText ?? "在网页面板里导入 Claude Code 账号后这里就会显示")
                        } actions: {
                            Button("重试") { Task { await model.connect() } }
                        }
                    }
                } else {
                    ScrollView {
                        GlassEffectContainer(spacing: 16) {
                            LazyVStack(spacing: 16) {
                                ForEach(model.accounts) { account in
                                    AccountCard(account: account) {
                                        await model.refresh(account.id)
                                    }
                                    .padding(16)
                                    .glassEffect(.regular, in: .rect(cornerRadius: 22))
                                }
                            }
                        }
                        .padding()
                    }
                }
            }
            .navigationTitle("Claude 用量")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
            .refreshable { await model.reload() }
        }
    }
}

struct AccountCard: View {
    let account: Account
    let onRefresh: () async -> Void
    @State private var refreshing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(account.name).font(.headline)
                if let plan = account.subscriptionType {
                    Text(plan.uppercased())
                        .font(.caption2).fontWeight(.semibold)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(.secondary.opacity(0.15), in: Capsule())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    Task { refreshing = true; await onRefresh(); refreshing = false }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .rotationEffect(.degrees(refreshing ? 360 : 0))
                        .animation(refreshing ? .linear(duration: 0.8).repeatForever(autoreverses: false) : .default, value: refreshing)
                }
                .buttonStyle(.borderless)
            }

            if let u = account.usage {
                MeterRow(label: "5 小时窗口", window: u.fiveHour)
                MeterRow(label: "每周窗口", window: u.sevenDay)
                if let sonnet = u.sevenDaySonnet {
                    MeterRow(label: "每周 · Sonnet", window: sonnet)
                }
            } else {
                Text(account.lastError ?? "暂无数据，正在获取…")
                    .font(.footnote).foregroundStyle(.secondary)
            }

            if let err = account.lastError, account.usage != nil {
                Text("⚠ \(err)").font(.caption2).foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct MeterRow: View {
    let label: String
    let window: UsageWindow?

    private var pct: Double { window?.usedPercent ?? 0 }
    private var color: Color {
        if pct >= 85 { return .red }
        if pct >= 60 { return .orange }
        return .green
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(label).font(.subheadline)
                Spacer()
                Text(window?.usedPercent != nil ? String(format: "%.0f%%", pct) : "—")
                    .font(.subheadline).monospacedDigit()
                    .foregroundStyle(color)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.secondary.opacity(0.18))
                    Capsule().fill(color)
                        .frame(width: max(0, min(1, pct / 100)) * geo.size.width)
                }
            }
            .frame(height: 8)
            if let reset = window?.resetLabel {
                Text(reset).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}
