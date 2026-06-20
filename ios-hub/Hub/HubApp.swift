import SwiftUI

@main
struct HubApp: App {
    @State private var model = AppModel()
    @State private var hub = HubModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(hub)
                .preferredColorScheme(.dark)
        }
    }
}
