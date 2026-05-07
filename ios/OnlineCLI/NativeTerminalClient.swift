import Foundation
import Observation

enum NativeTerminalConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
    case failed(String)

    var title: String {
        switch self {
        case .disconnected:
            return "Disconnected"
        case .connecting:
            return "Connecting"
        case .connected:
            return "Connected"
        case .failed(let message):
            return message
        }
    }

    var isConnected: Bool {
        if case .connected = self {
            return true
        }
        return false
    }
}

@MainActor
@Observable
final class NativeTerminalBuffer {
    var displayText = ""

    private var lines: [String] = []
    private var currentLine = ""
    private var parseMode: ParseMode = .normal
    private var csiBuffer = ""
    private var pendingCarriageReturn = false
    private let maxLines: Int

    init(maxLines: Int = 8_000) {
        self.maxLines = maxLines
    }

    func reset() {
        lines = []
        currentLine = ""
        parseMode = .normal
        csiBuffer = ""
        pendingCarriageReturn = false
        displayText = ""
    }

    func feed(_ text: String) {
        guard !text.isEmpty else { return }

        for scalar in text.unicodeScalars {
            consume(scalar)
        }
        rebuildDisplayText()
    }

    private func consume(_ scalar: UnicodeScalar) {
        switch parseMode {
        case .normal:
            consumeNormal(scalar)
        case .escape:
            if scalar == "[" {
                csiBuffer = ""
                parseMode = .csi
            } else if scalar == "]" {
                parseMode = .osc
            } else {
                parseMode = .normal
            }
        case .csi:
            if scalar.value >= 0x40 && scalar.value <= 0x7E {
                handleCSI(final: Character(scalar), parameters: csiBuffer)
                csiBuffer = ""
                parseMode = .normal
            } else {
                csiBuffer.append(Character(scalar))
            }
        case .osc:
            if scalar.value == 0x07 {
                parseMode = .normal
            } else if scalar.value == 0x1B {
                parseMode = .oscEscape
            }
        case .oscEscape:
            parseMode = scalar == "\\" ? .normal : .osc
        }
    }

    private func consumeNormal(_ scalar: UnicodeScalar) {
        switch scalar.value {
        case 0x1B:
            parseMode = .escape
        case 0x0D:
            pendingCarriageReturn = true
        case 0x0A:
            commitLine()
            pendingCarriageReturn = false
        case 0x08, 0x7F:
            pendingCarriageReturn = false
            if !currentLine.isEmpty {
                currentLine.removeLast()
            }
        case 0x09:
            applyPendingCarriageReturn()
            currentLine.append("    ")
        case 0x00...0x1F:
            break
        default:
            applyPendingCarriageReturn()
            currentLine.append(Character(scalar))
        }
    }

    private func applyPendingCarriageReturn() {
        if pendingCarriageReturn {
            currentLine = ""
            pendingCarriageReturn = false
        }
    }

    private func handleCSI(final: Character, parameters: String) {
        switch final {
        case "J":
            lines.removeAll(keepingCapacity: true)
            currentLine = ""
            pendingCarriageReturn = false
        case "K":
            pendingCarriageReturn = false
            currentLine = ""
        case "G":
            break
        case "m":
            break
        default:
            _ = parameters
        }
    }

    private func commitLine() {
        lines.append(currentLine)
        currentLine = ""
        trimLinesIfNeeded()
    }

    private func trimLinesIfNeeded() {
        guard lines.count > maxLines else { return }
        lines.removeFirst(lines.count - maxLines)
    }

    private func rebuildDisplayText() {
        trimLinesIfNeeded()
        var visible = lines
        visible.append(currentLine)
        displayText = visible.suffix(maxLines).joined(separator: "\n")
    }

    private enum ParseMode {
        case normal
        case escape
        case csi
        case osc
        case oscEscape
    }
}

@MainActor
@Observable
final class NativeTerminalClient {
    let buffer = NativeTerminalBuffer()

    var connectionState: NativeTerminalConnectionState = .disconnected
    var statusText = "Terminal idle"
    var sessionId: String?
    var terminalProfile: TerminalProfile = .powershell
    var backend = "direct"
    var cols = 120
    var rows = 30
    var bytesReceived = 0
    var lastOutputAt: Date?

    private var baseURL: URL?
    private var webSocketTask: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var socketGeneration = 0
    private var manualDisconnect = false

    func connect(baseURL: URL, session: TerminalSessionSnapshot) {
        disconnect(manual: false)
        self.baseURL = baseURL
        sessionId = session.id
        terminalProfile = session.effectiveProfile
        backend = session.backend ?? backend
        manualDisconnect = false
        socketGeneration += 1
        let generation = socketGeneration

        do {
            let api = OnlineCLIAPI(baseURL: baseURL)
            let url = try api.webSocketURL(
                path: "ws",
                queryItems: [URLQueryItem(name: "sessionId", value: session.id)]
            )
            connectionState = .connecting
            statusText = "Opening \(session.profileLabel)"
            buffer.reset()

            let task = URLSession.shared.webSocketTask(with: url)
            webSocketTask = task
            task.resume()
            receiveTask = Task { [weak self] in
                await self?.receiveLoop(generation: generation)
            }
            sendResize(cols: cols, rows: rows)
        } catch {
            connectionState = .failed(error.localizedDescription)
            statusText = error.localizedDescription
        }
    }

    func disconnect(manual: Bool = true) {
        manualDisconnect = manual
        socketGeneration += 1
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        if manual || connectionState.isConnected || connectionState == .connecting {
            connectionState = .disconnected
            statusText = "Terminal disconnected"
        }
    }

    func sendInput(_ data: String) {
        guard !data.isEmpty else { return }
        sendEnvelope(["type": "input", "data": data])
    }

    func sendKey(_ key: TerminalKey) {
        sendInput(key.sequence)
    }

    func sendResize(cols: Int, rows: Int) {
        let nextCols = max(20, cols)
        let nextRows = max(6, rows)
        self.cols = nextCols
        self.rows = nextRows
        sendEnvelope(["type": "resize", "cols": nextCols, "rows": nextRows])
    }

    func scrollServerHistory(lines: Int) async {
        guard let baseURL, let sessionId else { return }
        do {
            try await OnlineCLIAPI(baseURL: baseURL).scrollSession(sessionId, lines: lines)
        } catch {
            statusText = error.localizedDescription
        }
    }

    private func receiveLoop(generation: Int) async {
        while !Task.isCancelled {
            guard let webSocketTask, generation == socketGeneration else { return }
            do {
                let message = try await webSocketTask.receive()
                await handle(message, generation: generation)
            } catch {
                guard generation == socketGeneration, !Task.isCancelled else { return }
                connectionState = .failed(error.localizedDescription)
                statusText = "Disconnected; reconnecting"
                scheduleReconnect(generation: generation)
                return
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message, generation: Int) async {
        guard generation == socketGeneration else { return }

        let text: String?
        switch message {
        case .string(let value):
            text = value
        case .data(let data):
            text = String(data: data, encoding: .utf8)
        @unknown default:
            text = nil
        }

        guard let text, !text.isEmpty else { return }
        if handleControlText(text) {
            return
        }

        bytesReceived += text.utf8.count
        lastOutputAt = Date()
        if connectionState != .connected {
            connectionState = .connected
        }
        statusText = "Streaming \(terminalProfile.title)"
        buffer.feed(text)
    }

    private func handleControlText(_ text: String) -> Bool {
        guard
            let data = text.data(using: .utf8),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            payload["__onlineCliControl"] as? Bool == true
        else {
            return false
        }

        if payload["type"] as? String == "session-ready" {
            if let sessionId = payload["sessionId"] as? String {
                self.sessionId = sessionId
            }
            if let rawProfile = payload["terminalProfile"] as? String,
               let profile = TerminalProfile(rawValue: rawProfile) {
                terminalProfile = profile
            }
            if let backend = payload["backend"] as? String {
                self.backend = backend
            }
            if let cols = payload["cols"] as? Int {
                self.cols = cols
            }
            if let rows = payload["rows"] as? Int {
                self.rows = rows
            }
            connectionState = .connected
            statusText = "\(terminalProfile.title) ready"
        }
        return true
    }

    private func sendEnvelope(_ payload: [String: Any]) {
        guard let webSocketTask else { return }
        guard JSONSerialization.isValidJSONObject(payload) else { return }
        guard
            let data = try? JSONSerialization.data(withJSONObject: payload),
            let text = String(data: data, encoding: .utf8)
        else {
            return
        }
        webSocketTask.send(.string(text)) { _ in }
    }

    private func scheduleReconnect(generation: Int) {
        guard !manualDisconnect, reconnectTask == nil else { return }
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            await MainActor.run {
                guard
                    let self,
                    generation == self.socketGeneration,
                    !self.manualDisconnect,
                    let baseURL = self.baseURL,
                    let sessionId = self.sessionId
                else {
                    return
                }
                let placeholder = TerminalSessionSnapshot(
                    id: sessionId,
                    name: "Terminal",
                    status: nil,
                    terminalProfile: self.terminalProfile,
                    shellType: self.terminalProfile,
                    backend: self.backend,
                    shell: nil,
                    cwd: nil,
                    cols: self.cols,
                    rows: self.rows,
                    createdAt: nil,
                    lastActivityAt: nil,
                    localAttachCommand: nil,
                    clientCount: nil
                )
                self.reconnectTask = nil
                self.connect(baseURL: baseURL, session: placeholder)
            }
        }
    }
}

enum TerminalKey: String, CaseIterable, Identifiable {
    case escape
    case tab
    case enter
    case backspace
    case delete
    case arrowUp
    case arrowDown
    case arrowLeft
    case arrowRight
    case pageUp
    case pageDown
    case home
    case end
    case controlC
    case controlD
    case controlL

    var id: String { rawValue }

    var title: String {
        switch self {
        case .escape: return "Esc"
        case .tab: return "Tab"
        case .enter: return "Enter"
        case .backspace: return "Bksp"
        case .delete: return "Del"
        case .arrowUp: return "Up"
        case .arrowDown: return "Down"
        case .arrowLeft: return "Left"
        case .arrowRight: return "Right"
        case .pageUp: return "PgUp"
        case .pageDown: return "PgDn"
        case .home: return "Home"
        case .end: return "End"
        case .controlC: return "Ctrl-C"
        case .controlD: return "Ctrl-D"
        case .controlL: return "Ctrl-L"
        }
    }

    var sequence: String {
        switch self {
        case .escape: return "\u{1B}"
        case .tab: return "\t"
        case .enter: return "\r"
        case .backspace: return "\u{7F}"
        case .delete: return "\u{1B}[3~"
        case .arrowUp: return "\u{1B}[A"
        case .arrowDown: return "\u{1B}[B"
        case .arrowRight: return "\u{1B}[C"
        case .arrowLeft: return "\u{1B}[D"
        case .pageUp: return "\u{1B}[5~"
        case .pageDown: return "\u{1B}[6~"
        case .home: return "\u{1B}[H"
        case .end: return "\u{1B}[F"
        case .controlC: return "\u{03}"
        case .controlD: return "\u{04}"
        case .controlL: return "\u{0C}"
        }
    }
}
