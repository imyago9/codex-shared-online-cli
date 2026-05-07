import Foundation

struct ServerSettings: Codable, Equatable {
    var baseURLString = "https://desktop-cguakc2.tailbca5e0.ts.net"
    var defaultRemoteMode: RemoteMode = .view
    var remoteStreamProfile: RemoteStreamProfile = .balanced
    var preferNativeRemote = true

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
            return 4
        case .balanced:
            return 8
        case .fluid:
            return 14
        case .sharp:
            return 8
        }
    }

    var jpegQuality: Int {
        switch self {
        case .economy:
            return 42
        case .balanced:
            return 58
        case .fluid:
            return 58
        case .sharp:
            return 78
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

struct HealthResponse: Codable {
    let ok: Bool
    let timestamp: String
    let totalSessions: Int
    let defaultSessionId: String?
    let singleConsoleMode: Bool
}

struct SessionsResponse: Codable {
    let sessions: [TerminalSessionSnapshot]
    let defaultSessionId: String?
    let singleConsoleMode: Bool
}

struct SessionMutationResponse: Codable {
    let session: TerminalSessionSnapshot
    let defaultSessionId: String?
}

struct TerminalSessionSnapshot: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let shell: String?
    let cwd: String?
    let cols: Int?
    let rows: Int?
    let createdAt: String?
    let lastActivityAt: String?
    let localAttachCommand: String?
    let clientCount: Int?

    var displayName: String {
        name.isEmpty ? String(id.prefix(8)) : name
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
    let gateway: RemoteGatewayStatus?
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

struct RemoteDisplayInfo: Codable {
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
}

struct CodexSessionsResponse: Codable {
    let sessions: [CodexSessionSummary]
    let summary: CodexSummary?
}

struct CodexSummary: Codable {
    let totalSessions: Int?
    let totalTokens: Int?
    let totalToolCalls: Int?
}

struct CodexSessionSummary: Codable, Identifiable, Hashable {
    let id: String
    let cwd: String?
    let model: String?
    let startedAt: String?
    let lastPromptAt: String?
    let isResumable: Bool?
    let resumeStatus: String?
    let resumeCommand: String?
    let metrics: CodexMetrics?

    var title: String {
        guard let cwd, !cwd.isEmpty else {
            return String(id.prefix(8))
        }

        let normalizedPath = cwd.replacingOccurrences(of: "\\", with: "/")
        return normalizedPath.split(separator: "/").last.map(String.init) ?? cwd
    }
}

struct CodexMetrics: Codable, Hashable {
    let toolCalls: Int?
    let totalTokenUsage: TokenUsage?
}

struct TokenUsage: Codable, Hashable {
    let totalTokens: Int?
}
