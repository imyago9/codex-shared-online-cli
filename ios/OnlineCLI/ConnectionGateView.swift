import SwiftUI

struct ConnectionGateView: View {
    @Environment(AppModel.self) private var app
    @State private var draftURL = ""
    @State private var localMessage = ""
    @State private var didAttemptDefaultConnection = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 22) {
                    header
                    connectionForm
                }
                .padding(.horizontal, 22)
                .padding(.vertical, 34)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Connect")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                draftURL = app.settings.baseURLString
                if draftURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                   let defaultURL = ServerSettings.defaultConnectionCandidate {
                    draftURL = defaultURL
                    await connect(using: defaultURL, defaultAttempt: true)
                } else {
                    await app.refreshAll()
                }
            }
        }
    }

    private var header: some View {
        VStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(LinearGradient(colors: [.cyan, .green], startPoint: .topLeading, endPoint: .bottomTrailing))
                Image(systemName: "terminal.fill")
                    .font(.system(size: 38, weight: .bold))
                    .foregroundStyle(.black.opacity(0.82))
            }
            .frame(width: 86, height: 86)
            .shadow(color: .black.opacity(0.18), radius: 18, y: 8)

            VStack(spacing: 6) {
                Text("Online CLI")
                    .font(.largeTitle.weight(.bold))
                Text(localMessage.isEmpty ? app.connectionMessage : localMessage)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var connectionForm: some View {
        VStack(spacing: 14) {
            TextField("Tailnet URL", text: $draftURL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.URL)
                .padding(14)
                .background(.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            Button {
                connect()
            } label: {
                Label("Connect", systemImage: "network")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(app.isLoading || draftURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            if let defaultURL = ServerSettings.defaultConnectionCandidate,
               ServerSettings.normalizedURLString(draftURL) != defaultURL {
                Button {
                    draftURL = defaultURL
                    connect()
                } label: {
                    Label("Use Tailscale Default", systemImage: "sparkle.magnifyingglass")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(app.isLoading)
            }
        }
        .padding(16)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func connect() {
        Task {
            await connect(using: draftURL, defaultAttempt: false)
        }
    }

    private func connect(using urlString: String, defaultAttempt: Bool) async {
        if defaultAttempt {
            guard !didAttemptDefaultConnection else { return }
            didAttemptDefaultConnection = true
            localMessage = "Finding Online CLI on Tailscale"
        } else {
            localMessage = "Checking connection"
        }
        app.settings.baseURLString = ServerSettings.normalizedURLString(urlString)
        await app.refreshAll()
        draftURL = app.settings.baseURLString
        localMessage = app.isServerConnected ? "Connected" : app.connectionMessage
    }
}
