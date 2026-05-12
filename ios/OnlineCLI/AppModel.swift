import Foundation
import Observation
import Security

@MainActor
@Observable
final class AppModel {
    var settings: ServerSettings {
        didSet {
            SettingsStore.save(settings)
        }
    }

    var health: HealthResponse?
    var sessions: [TerminalSessionSnapshot] = []
    var defaultSessionId: String?
    var activeTerminalSessionId: String?
    var availableTerminalProfiles: [TerminalProfile] = [.powershell]
    var remoteStatus: RemoteStatus?
    var remoteCapabilities: RemoteCapabilities?
    var tailscaleDevices: [TailscaleDevice] = []
    var tailscaleMessage = "Sign in with Tailscale OAuth"
    var isTailscaleLoading = false
    var connectionMessage = "Not checked"
    var isLoading = false

    init() {
        self.settings = SettingsStore.load()
    }

    var api: OnlineCLIAPI? {
        guard let baseURL = settings.normalizedBaseURL else {
            return nil
        }
        return OnlineCLIAPI(baseURL: baseURL)
    }

    var isTailscaleSignedIn: Bool {
        settings.hasTailscaleOAuthClientID && TailscaleSecretStore.hasClientSecret()
    }

    var hasSelectedTailscaleDevice: Bool {
        settings.selectedTailscaleDeviceID != nil && settings.normalizedBaseURL != nil
    }

    func refreshStartup() async {
        if isTailscaleSignedIn {
            await refreshTailscaleDevices()
        }
        await refreshAll()
    }

    func refreshAll() async {
        await refreshHealth()
        if isServerConnected {
            await refreshSessions()
            await refreshRemoteStatus()
            await refreshRemoteCapabilities()
        } else {
            sessions = []
            defaultSessionId = nil
            activeTerminalSessionId = nil
            remoteStatus = nil
            remoteCapabilities = nil
        }
    }

    func refreshHealth() async {
        guard let api else {
            resetConnectionState(message: isTailscaleSignedIn ? "Choose a Tailscale device" : "Sign in with Tailscale OAuth")
            return
        }

        isLoading = true
        defer { isLoading = false }

        do {
            health = try await api.health()
            settings.defaultTerminalProfile = .powershell
            if let profiles = health?.terminalProfiles, !profiles.isEmpty {
                let supportedProfiles = profiles.filter { $0 == .powershell }
                availableTerminalProfiles = supportedProfiles.isEmpty ? [.powershell] : supportedProfiles
            }
            connectionMessage = "Connected"
        } catch {
            health = nil
            connectionMessage = error.localizedDescription
        }
    }

    func disconnectFromServer() {
        settings.baseURLString = ""
        settings.selectedTailscaleDeviceID = nil
        settings.selectedTailscaleDeviceName = nil
        resetConnectionState(message: "Choose a Tailscale device")
    }

    func signInToTailscale(tailnet: String, clientID: String, clientSecret: String) async {
        let normalizedTailnet = ServerSettings.normalizedTailnetName(tailnet)
        let normalizedClientID = ServerSettings.normalizedOAuthClientID(clientID)
        let normalizedSecret = clientSecret.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !normalizedClientID.isEmpty, !normalizedSecret.isEmpty else {
            tailscaleMessage = "Enter OAuth client credentials"
            return
        }

        isTailscaleLoading = true
        tailscaleMessage = "Signing in"
        defer { isTailscaleLoading = false }

        do {
            let devices = try await TailscaleAPI().fetchDevices(
                tailnet: normalizedTailnet,
                clientID: normalizedClientID,
                clientSecret: normalizedSecret
            )
            try TailscaleSecretStore.saveClientSecret(normalizedSecret)
            settings.tailscaleTailnetName = normalizedTailnet
            settings.tailscaleClientID = normalizedClientID
            tailscaleDevices = devices
            tailscaleMessage = devices.isEmpty ? "Signed in - no devices found" : "Signed in"
            if let selectedID = settings.selectedTailscaleDeviceID,
               let selectedDevice = devices.first(where: { $0.id == selectedID }) {
                applySelectedDevice(selectedDevice)
                await refreshAll()
            } else {
                clearSelectedDevice(message: "Choose a Tailscale device")
            }
        } catch {
            tailscaleMessage = error.localizedDescription
            TailscaleSecretStore.deleteClientSecret()
        }
    }

    func refreshTailscaleDevices() async {
        guard isTailscaleSignedIn, let clientSecret = TailscaleSecretStore.loadClientSecret() else {
            tailscaleDevices = []
            tailscaleMessage = "Sign in with Tailscale OAuth"
            return
        }

        isTailscaleLoading = true
        tailscaleMessage = "Loading devices"
        defer { isTailscaleLoading = false }

        do {
            let devices = try await TailscaleAPI().fetchDevices(
                tailnet: settings.tailscaleTailnetName,
                clientID: settings.tailscaleClientID,
                clientSecret: clientSecret
            )
            tailscaleDevices = devices
            tailscaleMessage = devices.isEmpty ? "No devices found" : "Devices loaded"
            if let selectedID = settings.selectedTailscaleDeviceID,
               let selectedDevice = devices.first(where: { $0.id == selectedID }) {
                applySelectedDevice(selectedDevice)
            } else if settings.selectedTailscaleDeviceID != nil {
                clearSelectedDevice(message: "Choose a Tailscale device")
            }
        } catch {
            tailscaleDevices = []
            tailscaleMessage = error.localizedDescription
        }
    }

    func selectTailscaleDevice(id: String?) async {
        guard let id else {
            clearSelectedDevice(message: "Choose a Tailscale device")
            return
        }

        guard let device = tailscaleDevices.first(where: { $0.id == id }) else {
            connectionMessage = "Device not found"
            return
        }

        guard !device.serverURLString.isEmpty else {
            connectionMessage = "Device has no Tailscale address"
            return
        }

        applySelectedDevice(device)
        await refreshAll()
    }

    func signOutOfTailscale() {
        TailscaleSecretStore.deleteClientSecret()
        tailscaleDevices = []
        tailscaleMessage = "Sign in with Tailscale OAuth"
        settings.tailscaleClientID = ""
        settings.tailscaleTailnetName = ServerSettings.defaultTailscaleTailnetName
        clearSelectedDevice(message: "Sign in with Tailscale OAuth")
    }

    func refreshSessions() async {
        guard let api else { return }
        do {
            let response = try await api.sessions()
            sessions = response.sessions
            defaultSessionId = response.defaultSessionId
            settings.defaultTerminalProfile = .powershell
            if let profiles = response.terminalProfiles, !profiles.isEmpty {
                let supportedProfiles = profiles.filter { $0 == .powershell }
                availableTerminalProfiles = supportedProfiles.isEmpty ? [.powershell] : supportedProfiles
            }
            reconcileActiveTerminal()
        } catch {
            connectionMessage = error.localizedDescription
        }
    }

    func createSession(profile: TerminalProfile? = nil) async {
        guard let api else { return }
        do {
            let response = try await api.createSession(terminalProfile: .powershell)
            defaultSessionId = response.defaultSessionId
            activeTerminalSessionId = response.session.id
            await refreshSessions()
        } catch {
            connectionMessage = error.localizedDescription
        }
    }

    func restartSession(_ session: TerminalSessionSnapshot) async {
        guard let api else { return }
        do {
            _ = try await api.restartSession(session.id)
            await refreshSessions()
        } catch {
            connectionMessage = error.localizedDescription
        }
    }

    func deleteSession(_ session: TerminalSessionSnapshot) async {
        guard let api else { return }
        do {
            try await api.deleteSession(session.id)
            await refreshSessions()
        } catch {
            connectionMessage = error.localizedDescription
        }
    }

    func sendCommand(_ command: String, to session: TerminalSessionSnapshot) async {
        guard let api else { return }
        do {
            try await api.sendCommand(command, sessionId: session.id)
        } catch {
            connectionMessage = error.localizedDescription
        }
    }

    func refreshRemoteStatus() async {
        guard let api else { return }
        do {
            remoteStatus = try await api.remoteStatus()
        } catch {
            remoteStatus = nil
        }
    }

    func refreshRemoteCapabilities() async {
        guard let api else { return }
        do {
            remoteCapabilities = try await api.remoteCapabilities()
        } catch {
            remoteCapabilities = nil
        }
    }

    func selectTerminalSession(_ id: String?) {
        activeTerminalSessionId = id
        reconcileActiveTerminal()
    }

    var activeTerminalSession: TerminalSessionSnapshot? {
        sessions.first { $0.id == activeTerminalSessionId }
    }

    var isServerConnected: Bool {
        health?.ok == true
    }

    private func reconcileActiveTerminal() {
        if let activeTerminalSessionId, sessions.contains(where: { $0.id == activeTerminalSessionId }) {
            return
        }
        activeTerminalSessionId = defaultSessionId ?? sessions.first?.id
    }

    private func applySelectedDevice(_ device: TailscaleDevice) {
        settings.selectedTailscaleDeviceID = device.id
        settings.selectedTailscaleDeviceName = device.displayName
        settings.baseURLString = ServerSettings.normalizedURLString(device.serverURLString)
    }

    private func clearSelectedDevice(message: String) {
        settings.selectedTailscaleDeviceID = nil
        settings.selectedTailscaleDeviceName = nil
        settings.baseURLString = ""
        resetConnectionState(message: message)
    }

    private func resetConnectionState(message: String) {
        health = nil
        sessions = []
        defaultSessionId = nil
        activeTerminalSessionId = nil
        availableTerminalProfiles = [.powershell]
        remoteStatus = nil
        remoteCapabilities = nil
        connectionMessage = message
        isLoading = false
    }
}

enum TailscaleSecretStore {
    private static let service = "online-cli.tailscale.oauth"
    private static let account = "client-secret"

    static func hasClientSecret() -> Bool {
        loadClientSecret() != nil
    }

    static func loadClientSecret() -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    static func saveClientSecret(_ secret: String) throws {
        let data = Data(secret.utf8)
        var query = baseQuery()
        query[kSecValueData as String] = data

        SecItemDelete(baseQuery() as CFDictionary)
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.unhandledStatus(status)
        }
    }

    static func deleteClientSecret() {
        SecItemDelete(baseQuery() as CFDictionary)
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}

enum KeychainError: LocalizedError {
    case unhandledStatus(OSStatus)

    var errorDescription: String? {
        switch self {
        case .unhandledStatus(let status):
            return "Keychain failed (\(status))"
        }
    }
}

enum SettingsStore {
    private static let key = "online-cli.settings"

    static func load() -> ServerSettings {
        guard
            let data = UserDefaults.standard.data(forKey: key),
            let settings = try? JSONDecoder().decode(ServerSettings.self, from: data)
        else {
            return ServerSettings()
        }
        return settings
    }

    static func save(_ settings: ServerSettings) {
        guard let data = try? JSONEncoder().encode(settings) else {
            return
        }
        UserDefaults.standard.set(data, forKey: key)
    }
}
