import Foundation

struct ServerSettings: Codable, Equatable {
    var baseURLString = ""
    var companionToken = ""
    var defaultTerminalProfile: TerminalProfile = .powershell
    var defaultRemoteMode: RemoteMode = .view
    var remoteStreamProfile: RemoteStreamProfile = .balanced
    var preferNativeRemote = true

    enum CodingKeys: String, CodingKey {
        case baseURLString
        case companionToken
        case defaultTerminalProfile
        case defaultRemoteMode
        case remoteStreamProfile
        case preferNativeRemote
    }

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        baseURLString = try container.decodeIfPresent(String.self, forKey: .baseURLString) ?? baseURLString
        companionToken = try container.decodeIfPresent(String.self, forKey: .companionToken) ?? companionToken
        defaultTerminalProfile = try container.decodeIfPresent(TerminalProfile.self, forKey: .defaultTerminalProfile) ?? defaultTerminalProfile
        defaultRemoteMode = try container.decodeIfPresent(RemoteMode.self, forKey: .defaultRemoteMode) ?? defaultRemoteMode
        remoteStreamProfile = try container.decodeIfPresent(RemoteStreamProfile.self, forKey: .remoteStreamProfile) ?? remoteStreamProfile
        preferNativeRemote = try container.decodeIfPresent(Bool.self, forKey: .preferNativeRemote) ?? preferNativeRemote
    }

    var normalizedBaseURL: URL? {
        let trimmed = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard var components = URLComponents(string: withScheme) else {
            return nil
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url
    }

    var trimmedCompanionToken: String {
        companionToken.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum TerminalProfile: String, Codable, CaseIterable, Identifiable {
    case powershell

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = (try? container.decode(String.self))?.lowercased()
        self = rawValue == "powershell" ? .powershell : .powershell
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    var title: String {
        "PowerShell"
    }

    var subtitle: String {
        "Native Windows shell"
    }

    var systemImage: String {
        "terminal"
    }
}

enum RemoteStreamProfile: String, Codable, CaseIterable, Identifiable {
    case economy
    case balanced
    case fluid
    case sharp

    var id: String { rawValue }

    var title: String {
        switch self {
        case .economy:
            return "Economy"
        case .balanced:
            return "Balanced"
        case .fluid:
            return "Fluid"
        case .sharp:
            return "Sharp"
        }
    }

    var systemImage: String {
        switch self {
        case .economy:
            return "leaf"
        case .balanced:
            return "dial.medium"
        case .fluid:
            return "speedometer"
        case .sharp:
            return "text.viewfinder"
        }
    }

    var fps: Int {
        switch self {
        case .economy:
            return 5
        case .balanced:
            return 10
        case .fluid:
            return 20
        case .sharp:
            return 12
        }
    }

    var videoFps: Int {
        switch self {
        case .economy:
            return 15
        case .balanced:
            return 30
        case .fluid, .sharp:
            return 60
        }
    }

    var jpegQuality: Int {
        switch self {
        case .economy:
            return 46
        case .balanced:
            return 62
        case .fluid:
            return 64
        case .sharp:
            return 86
        }
    }

    var nextLowerPressureProfile: RemoteStreamProfile? {
        switch self {
        case .economy:
            return nil
        case .balanced:
            return .economy
        case .fluid:
            return .balanced
        case .sharp:
            return .balanced
        }
    }

    var nextHigherQualityProfile: RemoteStreamProfile? {
        switch self {
        case .economy:
            return .balanced
        case .balanced:
            return .fluid
        case .fluid:
            return .sharp
        case .sharp:
            return nil
        }
    }
}

enum RemoteMode: String, Codable, CaseIterable, Identifiable {
    case view
    case control

    var id: String { rawValue }

    var title: String {
        switch self {
        case .view:
            return "View"
        case .control:
            return "Control"
        }
    }
}

enum RemoteGestureMode: String, Codable, CaseIterable, Identifiable {
    case direct
    case trackpad
    case viewport

    var id: String { rawValue }

    var title: String {
        switch self {
        case .direct:
            return "Direct"
        case .trackpad:
            return "Trackpad"
        case .viewport:
            return "Viewport"
        }
    }

    var systemImage: String {
        switch self {
        case .direct:
            return "hand.tap"
        case .trackpad:
            return "rectangle.and.hand.point.up.left"
        case .viewport:
            return "move.3d"
        }
    }
}

struct HealthResponse: Codable {
    let ok: Bool
    let timestamp: String
    let totalSessions: Int
    let defaultSessionId: String?
    let singleConsoleMode: Bool
    let defaultTerminalProfile: TerminalProfile?
    let terminalProfiles: [TerminalProfile]?
}

struct CompanionStatus: Codable, Equatable {
    let ok: Bool
    let companionVersion: String?
    let serverRunning: Bool
    let remoteAgentRunning: Bool
    let runOnStartup: Bool
    let autoStartServer: Bool
    let appUrl: String?
    let tailnetUrl: String?
    let repoRoot: String?
    let serverPort: Int?
    let remotePort: Int?
    let launcherPort: Int?
    let message: String?
}

struct CompanionActionResponse: Codable, Equatable {
    let ok: Bool
    let message: String?
    let status: CompanionStatus?
}

struct SessionsResponse: Codable {
    let sessions: [TerminalSessionSnapshot]
    let defaultSessionId: String?
    let singleConsoleMode: Bool
    let defaultTerminalProfile: TerminalProfile?
    let terminalProfiles: [TerminalProfile]?
}

struct SessionMutationResponse: Codable {
    let session: TerminalSessionSnapshot
    let defaultSessionId: String?
}

struct TerminalSessionSnapshot: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let status: String?
    let terminalProfile: TerminalProfile?
    let shellType: TerminalProfile?
    let backend: String?
    let shell: String?
    let cwd: String?
    let cols: Int?
    let rows: Int?
    let createdAt: String?
    let lastActivityAt: String?
    let clientCount: Int?

    var displayName: String {
        name.isEmpty ? String(id.prefix(8)) : name
    }

    var effectiveProfile: TerminalProfile {
        terminalProfile ?? shellType ?? .powershell
    }

    var profileLabel: String {
        effectiveProfile.title
    }

    var backendLabel: String {
        backend == "direct" ? "native PTY" : effectiveProfile.subtitle
    }
}

struct RemoteStatus: Codable {
    let enabled: Bool
    let defaultMode: RemoteMode
    let streamFps: Int
    let jpegQuality: Int
    let inputRateLimitPerSec: Int
    let inputMaxQueue: Int?
    let streamPresets: [RemoteStreamPresetDescriptor]?
    let actions: [RemoteActionDescriptor]?
    let gateway: RemoteGatewayStatus?
    let sidecar: RemoteSidecarStatus
}

struct RemoteCapabilities: Codable {
    let enabled: Bool
    let defaultMode: RemoteMode
    let sidecarReachable: Bool
    let controlAvailable: Bool
    let streamFps: Int
    let jpegQuality: Int
    let inputRateLimitPerSec: Int
    let inputMaxQueue: Int?
    let streamPresets: [RemoteStreamPresetDescriptor]
    let actions: [RemoteActionDescriptor]
    let display: RemoteDisplayInfo?
    let monitors: [RemoteMonitorDescriptor]?
    let gateway: RemoteGatewayStatus?
}

struct RemoteMonitorDescriptor: Codable, Identifiable, Hashable {
    let rawId: String?
    let name: String?
    let primary: Bool?
    let left: Int
    let top: Int
    let width: Int
    let height: Int

    enum CodingKeys: String, CodingKey {
        case rawId = "id"
        case name
        case primary
        case left
        case top
        case width
        case height
    }

    var id: String {
        if let rawId, !rawId.isEmpty {
            return rawId
        }
        return "\(left):\(top):\(width):\(height)"
    }

    var displayName: String {
        if let name, !name.isEmpty {
            return name
        }
        return primary == true ? "Primary" : "Monitor"
    }

    var resolutionText: String {
        "\(width)x\(height)"
    }

    var positionText: String {
        "x \(left), y \(top)"
    }
}

struct RemoteStreamPresetDescriptor: Codable, Identifiable, Hashable {
    let id: String
    let label: String
    let fps: Int
    let jpegQuality: Int
    let intent: String?
}

struct RemoteActionDescriptor: Codable, Identifiable {
    let id: String
    let label: String
    let key: String
    let code: String
    let modifiers: [String: Bool]?
}

struct RemoteGatewayStatus: Codable, Hashable {
    let activeConnections: Int?
    let viewConnections: Int?
    let controlConnections: Int?
    let totalConnections: Int?
    let droppedEvents: Int?
    let lastConnectedAt: String?
    let lastDisconnectedAt: String?
    let lastFrameStats: RemoteFrameStats?
    let lastInputError: String?
    let updatedAt: String?
}

struct RemoteFrameStats: Codable, Hashable {
    let fps: Double?
    let frameBytes: Int?
    let captureTs: Double?
    let captureLatencyMs: Double?
    let receivedAt: String?
}

struct RemoteSidecarStatus: Codable {
    let url: String
    let reachable: Bool
    let ok: Bool
    let inputAvailable: Bool
    let reason: String?
    let health: RemoteSidecarHealth?
}

struct RemoteSidecarHealth: Codable {
    let stream: RemoteSidecarStreamHealth?
    let input: RemoteSidecarInputHealth?
    let cursor: RemoteSidecarCursorHealth?
    let display: RemoteDisplayInfo?
    let displays: [RemoteMonitorDescriptor]?
    let platform: String?
}

struct RemoteSidecarStreamHealth: Codable {
    let fps: Double?
    let targetFps: Int?
    let jpegQuality: Int?
    let clients: Int?
    let lastFrameBytes: Int?
    let lastCaptureTs: Double?
    let lastCaptureLatencyMs: Double?
    let lastError: String?
}

struct RemoteSidecarInputHealth: Codable {
    let available: Bool?
    let reason: String?
}

struct RemoteSidecarCursorHealth: Codable {
    let available: Bool?
    let reason: String?
}

struct RemoteDisplayInfo: Codable, Hashable {
    let left: Int?
    let top: Int?
    let width: Int?
    let height: Int?
    let virtualLeft: Int?
    let virtualTop: Int?
    let virtualWidth: Int?
    let virtualHeight: Int?
    let scaleX: Double?
    let scaleY: Double?
    let source: String?
    let captureWidth: Int?
    let captureHeight: Int?
    let captureDisplayId: String?
    let captureDisplayName: String?
}
