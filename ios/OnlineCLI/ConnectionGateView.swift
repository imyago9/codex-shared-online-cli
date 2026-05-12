import SwiftUI
import UIKit

struct ConnectionGateView: View {
    @Environment(AppModel.self) private var app
    @State private var draftTailnetName = ServerSettings.defaultTailscaleTailnetName
    @State private var draftClientID = ""
    @State private var draftClientSecret = ""
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
                draftTailnetName = app.settings.tailscaleTailnetName
                draftClientID = app.settings.tailscaleClientID
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
                Text(localMessage.isEmpty ? app.tailscaleMessage : localMessage)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var connectionForm: some View {
        VStack(spacing: 14) {
            TextField("Tailnet", text: $draftTailnetName)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(14)
                .background(.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            TextField("OAuth Client ID", text: $draftClientID)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.username)
                .padding(14)
                .background(.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            SecureField("OAuth Client Secret", text: $draftClientSecret)
                .textContentType(.password)
                .padding(14)
                .background(.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            Button {
                signIn()
            } label: {
                Label("Sign In", systemImage: "person.badge.key")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(app.isTailscaleLoading || !canSignIn)

            Button {
                runTailscaleShortcut()
            } label: {
                Label("Run Tailscale Shortcut", systemImage: "bolt.horizontal")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
        .padding(16)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var canSignIn: Bool {
        !draftClientID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !draftClientSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func signIn() {
        Task {
            localMessage = "Signing in"
            await app.signInToTailscale(
                tailnet: draftTailnetName,
                clientID: draftClientID,
                clientSecret: draftClientSecret
            )
            localMessage = app.tailscaleMessage
            if app.isTailscaleSignedIn {
                draftClientSecret = ""
            }
        }
    }

    private func runTailscaleShortcut() {
        let shortcutName = ServerSettings.normalizedShortcutName(app.settings.tailscaleShortcutName)
        var components = URLComponents()
        components.scheme = "shortcuts"
        components.host = "run-shortcut"
        components.queryItems = [URLQueryItem(name: "name", value: shortcutName)]

        guard let shortcutURL = components.url else {
            localMessage = "Unable to open Shortcuts"
            return
        }

        UIApplication.shared.open(shortcutURL) { didOpen in
            if !didOpen {
                localMessage = "Unable to open Shortcuts"
            }
        }
    }
}
