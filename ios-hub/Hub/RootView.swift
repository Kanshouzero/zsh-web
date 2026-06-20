import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var showSettings = false

    var body: some View {
        TabView {
            UsageView(showSettings: $showSettings)
                .tabItem { Label("用量", systemImage: "gauge.with.dots.needle.67percent") }

            MachinesView(showSettings: $showSettings)
                .tabItem { Label("终端", systemImage: "terminal") }

            ComingSoonView(title: "NAS", systemImage: "externaldrive.connected.to.line.below")
                .tabItem { Label("NAS", systemImage: "externaldrive") }

            ComingSoonView(title: "下载", systemImage: "arrow.down.circle")
                .tabItem { Label("下载", systemImage: "arrow.down.circle") }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .task {
            if model.isConfigured {
                await model.connect()
            } else {
                showSettings = true
            }
        }
    }
}

struct ComingSoonView: View {
    let title: String
    let systemImage: String

    var body: some View {
        NavigationStack {
            ContentUnavailableView(
                "\(title) · 即将到来",
                systemImage: systemImage,
                description: Text("这个模块还在规划中")
            )
            .navigationTitle(title)
        }
    }
}
