import Foundation
import Observation

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
            resetConnectionState(message: "Enter a tailnet URL")
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
        resetConnectionState(message: "Enter a tailnet URL")
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
