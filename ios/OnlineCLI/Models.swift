import Foundation

struct ServerSettings: Codable, Equatable {
    static let defaultTailscaleShortcutName = "OnlineCLI Connect Tailscale"
    static let defaultTailscaleTailnetName = "-"

    var baseURLString = ""
    var tailscaleTailnetName = Self.defaultTailscaleTailnetName
    var tailscaleClientID = ""
    var selectedTailscaleDeviceID: String?
    var selectedTailscaleDeviceName: String?
    var defaultTerminalProfile: TerminalProfile = .powershell
    var defaultRemoteMode: RemoteMode = .view
    var remoteStreamProfile: RemoteStreamProfile = .balanced
    var preferNativeRemote = true
    var tailscaleShortcutName = Self.defaultTailscaleShortcutName

    enum CodingKeys: String, CodingKey {
        case baseURLString
        case tailscaleTailnetName
        case tailscaleClientID
        case selectedTailscaleDeviceID
        case selectedTailscaleDeviceName
        case defaultTerminalProfile
        case defaultRemoteMode
        case remoteStreamProfile
        case preferNativeRemote
        case tailscaleShortcutName
    }

    init() {}

    static func importedConnectionURLString(from url: URL) -> String? {
        guard url.scheme?.lowercased() == "onlinecli" else {
            return nil
        }

        guard
            url.host?.lowercased() == "connect",
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let rawValue = components.queryItems?.first(where: { $0.name == "url" })?.value
        else {
            return nil
        }

        let normalized = normalizedURLString(rawValue)
        return normalized.isEmpty ? nil : normalized
    }

    static func normalizedURLString(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return ""
        }

        let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard var components = URLComponents(string: withScheme) else {
            return withScheme
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url?.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? withScheme
    }

    static func normalizedShortcutName(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? Self.defaultTailscaleShortcutName : trimmed
    }

    static func normalizedTailnetName(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? Self.defaultTailscaleTailnetName : trimmed
    }

    static func normalizedOAuthClientID(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        baseURLString = try container.decodeIfPresent(String.self, forKey: .baseURLString) ?? baseURLString
        tailscaleTailnetName = Self.normalizedTailnetName(
            try container.decodeIfPresent(String.self, forKey: .tailscaleTailnetName) ?? tailscaleTailnetName
        )
        tailscaleClientID = Self.normalizedOAuthClientID(
            try container.decodeIfPresent(String.self, forKey: .tailscaleClientID) ?? tailscaleClientID
        )
        selectedTailscaleDeviceID = try container.decodeIfPresent(String.self, forKey: .selectedTailscaleDeviceID)
        selectedTailscaleDeviceName = try container.decodeIfPresent(String.self, forKey: .selectedTailscaleDeviceName)
        defaultTerminalProfile = try container.decodeIfPresent(TerminalProfile.self, forKey: .defaultTerminalProfile) ?? defaultTerminalProfile
        defaultRemoteMode = try container.decodeIfPresent(RemoteMode.self, forKey: .defaultRemoteMode) ?? defaultRemoteMode
        remoteStreamProfile = try container.decodeIfPresent(RemoteStreamProfile.self, forKey: .remoteStreamProfile) ?? remoteStreamProfile
        preferNativeRemote = try container.decodeIfPresent(Bool.self, forKey: .preferNativeRemote) ?? preferNativeRemote
        tailscaleShortcutName = Self.normalizedShortcutName(
            try container.decodeIfPresent(String.self, forKey: .tailscaleShortcutName) ?? tailscaleShortcutName
        )
    }

    var normalizedBaseURL: URL? {
        let trimmed = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        guard let components = URLComponents(string: Self.normalizedURLString(trimmed)) else {
            return nil
        }
        return components.url
    }

    var hasTailscaleOAuthClientID: Bool {
        !tailscaleClientID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

struct TailscaleDevice: Decodable, Equatable, Identifiable {
    let id: String
    let nodeID: String?
    let name: String
    let hostname: String
    let addresses: [String]
    let os: String?
    let lastSeen: String?
    let authorized: Bool?

    enum CodingKeys: String, CodingKey {
        case id
        case nodeID
        case nodeId
        case name
        case hostname
        case addresses
        case os
        case lastSeen
        case authorized
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let nodeID = try container.decodeIfPresent(String.self, forKey: .nodeID)
            ?? container.decodeIfPresent(String.self, forKey: .nodeId)
        let legacyID = try container.decodeIfPresent(String.self, forKey: .id)
        let name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
        let hostname = try container.decodeIfPresent(String.self, forKey: .hostname) ?? name

        self.id = nodeID ?? legacyID ?? name
        self.nodeID = nodeID
        self.name = name
        self.hostname = hostname
        self.addresses = try container.decodeIfPresent([String].self, forKey: .addresses) ?? []
        self.os = try container.decodeIfPresent(String.self, forKey: .os)
        self.lastSeen = try container.decodeIfPresent(String.self, forKey: .lastSeen)
        self.authorized = try container.decodeIfPresent(Bool.self, forKey: .authorized)
    }

    var displayName: String {
        hostname.isEmpty ? name : hostname
    }

    var secondaryText: String {
        var parts: [String] = []
        if let os, !os.isEmpty {
            parts.append(os)
        }
        if let firstAddress = addresses.first {
            parts.append(firstAddress)
        }
        return parts.joined(separator: " - ")
    }

    var serverURLString: String {
        if !name.isEmpty, name.contains(".") {
            return "https://\(name)"
        }
        if let firstAddress = addresses.first {
            return "https://\(firstAddress)"
        }
        return ""
    }
}

struct TailscaleDevicesResponse: Decodable {
    let devices: [TailscaleDevice]
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
