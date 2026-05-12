import SwiftUI
import UIKit

struct ConnectionGateView: View {
    @Environment(AppModel.self) private var app
    @State private var draftURL = ""
    @State private var localMessage = ""

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
                await app.refreshAll()
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
            TextField("Tailscale link", text: $draftURL)
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

            Button {
                viewInTailscale()
            } label: {
                Label("View in Tailscale", systemImage: "network")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)

            VStack(alignment: .leading, spacing: 8) {
                Text("1. Run Windows Manager.")
                Text("2. Open Tailscale on IPhone.")
                Text("3. Copy target machine address.")
                Text("4. Paste here in app and connect.")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
        }
        .padding(16)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func connect() {
        Task {
            await connect(using: draftURL)
        }
    }

    private func connect(using urlString: String) async {
        localMessage = "Checking connection"
        app.settings.baseURLString = ServerSettings.normalizedURLString(urlString)
        await app.refreshAll()
        draftURL = app.settings.baseURLString
        localMessage = app.isServerConnected ? "Connected" : app.connectionMessage
    }

    private func viewInTailscale() {
        guard
            let appStoreURL = URL(string: "itms-apps://apps.apple.com/app/tailscale/id1470499037"),
            let webURL = URL(string: "https://login.tailscale.com/admin/machines")
        else {
            localMessage = "Unable to open Tailscale"
            return
        }

        UIApplication.shared.open(appStoreURL) { didOpen in
            if !didOpen {
                UIApplication.shared.open(webURL) { didOpen in
                    if !didOpen {
                        localMessage = "Unable to open Tailscale"
                    }
                }
            }
        }
    }
}
