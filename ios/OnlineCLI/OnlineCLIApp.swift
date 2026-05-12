import SwiftUI

@main
struct OnlineCLIApp: App {
    @State private var appModel = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appModel)
                .onOpenURL { url in
                    guard let serverURL = ServerSettings.importedConnectionURLString(from: url) else {
                        return
                    }
                    appModel.settings.baseURLString = serverURL
                    Task {
                        await appModel.refreshAll()
                    }
                }
        }
    }
}
