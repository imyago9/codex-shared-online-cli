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

    private var history: [String] = []
    private var screen: [[Character]] = []
    private var cursorX = 0
    private var cursorY = 0
    private var savedCursorX = 0
    private var savedCursorY = 0
    private var cols = 80
    private var rows = 24
    private var parseMode: ParseMode = .normal
    private var csiBuffer = ""
    private let maxLines: Int

    init(maxLines: Int = 8_000) {
        self.maxLines = maxLines
        screen = Self.makeBlankScreen(cols: cols, rows: rows)
    }

    func reset() {
        history = []
        screen = Self.makeBlankScreen(cols: cols, rows: rows)
        cursorX = 0
        cursorY = 0
        savedCursorX = 0
        savedCursorY = 0
        parseMode = .normal
        csiBuffer = ""
        displayText = ""
    }

    func resize(cols: Int, rows: Int) {
        let nextCols = max(20, cols)
        let nextRows = max(6, rows)
        guard nextCols != self.cols || nextRows != self.rows else { return }

        let oldScreen = screen
        let oldCols = self.cols
        self.cols = nextCols
        self.rows = nextRows
        screen = oldScreen.prefix(self.rows).map { oldLine in
            var line = Array(oldLine.prefix(self.cols))
            if line.count < self.cols {
                line.append(contentsOf: Array(repeating: " ", count: self.cols - line.count))
            }
            return line
        }
        while screen.count < self.rows {
            screen.append(blankLine())
        }
        cursorX = min(cursorX, max(0, min(oldCols, self.cols) - 1))
        cursorY = min(cursorY, self.rows - 1)
        rebuildDisplayText()
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
            cursorX = 0
        case 0x0A:
            lineFeed()
        case 0x08, 0x7F:
            cursorX = max(0, cursorX - 1)
        case 0x09:
            let spaces = 4 - (cursorX % 4)
            for _ in 0..<spaces {
                put(Character(" "))
            }
        case 0x00...0x1F:
            break
        default:
            put(Character(scalar))
        }
    }

    private func handleCSI(final: Character, parameters: String) {
        let params = parsedParameters(parameters)
        switch final {
        case "J":
            eraseInDisplay(mode: params.first ?? 0)
        case "K":
            eraseInLine(mode: params.first ?? 0)
        case "H", "f":
            let row = max(1, params.first ?? 1) - 1
            let col = max(1, params.dropFirst().first ?? 1) - 1
            cursorY = min(rows - 1, row)
            cursorX = min(cols - 1, col)
        case "A":
            cursorY = max(0, cursorY - max(1, params.first ?? 1))
        case "B":
            cursorY = min(rows - 1, cursorY + max(1, params.first ?? 1))
        case "G":
            cursorX = max(0, min(cols - 1, max(1, params.first ?? 1) - 1))
        case "C":
            cursorX = max(0, min(cols - 1, cursorX + max(1, params.first ?? 1)))
        case "D":
            cursorX = max(0, cursorX - max(1, params.first ?? 1))
        case "E":
            cursorY = min(rows - 1, cursorY + max(1, params.first ?? 1))
            cursorX = 0
        case "F":
            cursorY = max(0, cursorY - max(1, params.first ?? 1))
            cursorX = 0
        case "S":
            scrollUp(max(1, params.first ?? 1), recordHistory: true)
        case "T":
            scrollDown(max(1, params.first ?? 1))
        case "X":
            eraseCharacters(max(1, params.first ?? 1))
        case "s":
            savedCursorX = cursorX
            savedCursorY = cursorY
        case "u":
            cursorX = min(cols - 1, max(0, savedCursorX))
            cursorY = min(rows - 1, max(0, savedCursorY))
        case "m", "h", "l", "r":
            break
        default:
            _ = parameters
        }
    }

    private func put(_ character: Character) {
        if cursorX >= cols {
            cursorX = 0
            lineFeed()
        }
        screen[cursorY][cursorX] = character
        cursorX += 1
    }

    private func lineFeed() {
        if cursorY >= rows - 1 {
            scrollUp(1, recordHistory: true)
        } else {
            cursorY += 1
        }
    }

    private func scrollUp(_ count: Int, recordHistory: Bool) {
        guard count > 0 else { return }
        for _ in 0..<min(count, rows) {
            if recordHistory {
                history.append(lineString(screen[0]))
            }
            screen.removeFirst()
            screen.append(blankLine())
        }
        trimLinesIfNeeded()
    }

    private func scrollDown(_ count: Int) {
        guard count > 0 else { return }
        for _ in 0..<min(count, rows) {
            screen.removeLast()
            screen.insert(blankLine(), at: 0)
        }
    }

    private func eraseInDisplay(mode: Int) {
        switch mode {
        case 1:
            for row in 0...cursorY {
                let end = row == cursorY ? cursorX : cols - 1
                guard end >= 0 else { continue }
                for col in 0...min(end, cols - 1) {
                    screen[row][col] = " "
                }
            }
        case 2, 3:
            screen = Self.makeBlankScreen(cols: cols, rows: rows)
            if mode == 3 {
                history.removeAll(keepingCapacity: true)
            }
        default:
            for row in cursorY..<rows {
                let start = row == cursorY ? cursorX : 0
                guard start < cols else { continue }
                for col in start..<cols {
                    screen[row][col] = " "
                }
            }
        }
    }

    private func eraseInLine(mode: Int) {
        switch mode {
        case 1:
            for col in 0...min(cursorX, cols - 1) {
                screen[cursorY][col] = " "
            }
        case 2:
            screen[cursorY] = blankLine()
        default:
            guard cursorX < cols else { return }
            for col in cursorX..<cols {
                screen[cursorY][col] = " "
            }
        }
    }

    private func eraseCharacters(_ count: Int) {
        guard cursorX < cols else { return }
        for col in cursorX..<min(cols, cursorX + count) {
            screen[cursorY][col] = " "
        }
    }

    private func parsedParameters(_ parameters: String) -> [Int] {
        parameters
            .replacingOccurrences(of: "?", with: "")
            .split(separator: ";")
            .map { Int($0) ?? 0 }
    }

    private func trimLinesIfNeeded() {
        guard history.count > maxLines else { return }
        history.removeFirst(history.count - maxLines)
    }

    private func rebuildDisplayText() {
        trimLinesIfNeeded()
        let lastVisibleRow = max(cursorY, screen.lastIndex(where: { !$0.allSatisfy { $0 == " " } }) ?? 0)
        let visibleScreen = screen.prefix(lastVisibleRow + 1).map(lineString)
        let visible = history + visibleScreen
        displayText = visible.suffix(maxLines).joined(separator: "\n")
    }

    private func blankLine() -> [Character] {
        Array(repeating: " ", count: cols)
    }

    private func lineString(_ line: [Character]) -> String {
        String(line).trimmingTrailingSpaces()
    }

    private static func makeBlankScreen(cols: Int, rows: Int) -> [[Character]] {
        Array(repeating: Array(repeating: " ", count: max(1, cols)), count: max(1, rows))
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
        buffer.resize(cols: nextCols, rows: nextRows)
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
            if let rawProfile = payload["terminalProfile"] as? String, !rawProfile.isEmpty {
                terminalProfile = .powershell
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

private extension String {
    func trimmingTrailingSpaces() -> String {
        var value = self
        while value.last == " " {
            value.removeLast()
        }
        return value
    }
}
