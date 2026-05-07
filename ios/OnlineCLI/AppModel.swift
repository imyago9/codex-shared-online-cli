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
    var codexSessions: [CodexSessionSummary] = []
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
        await refreshSessions()
        await refreshCodexSessions()
        await refreshRemoteStatus()
        await refreshRemoteCapabilities()
    }

    func refreshHealth() async {
        guard let api else {
            connectionMessage = "Enter a tailnet URL"
            return
        }

        isLoading = true
        defer { isLoading = false }

        do {
            health = try await api.health()
            connectionMessage = "Connected"
        } catch {
            connectionMessage = error.localizedDescription
        }
    }

    func refreshSessions() async {
        guard let api else { return }
        do {
            let response = try await api.sessions()
            sessions = response.sessions
            defaultSessionId = response.defaultSessionId
        } catch {
            connectionMessage = error.localizedDescription
        }
    }

    func createSession() async {
        guard let api else { return }
        do {
            let response = try await api.createSession()
            defaultSessionId = response.defaultSessionId
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

    func refreshCodexSessions() async {
        guard let api else { return }
        do {
            codexSessions = try await api.codexSessions(limit: 80).sessions
        } catch {
            connectionMessage = error.localizedDescription
        }
    }

    func resumeCodexSession(_ codexSession: CodexSessionSummary, into terminalSessionId: String?) async {
        guard let api else { return }
        do {
            try await api.resumeCodexSession(codexSession.id, terminalSessionId: terminalSessionId)
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
