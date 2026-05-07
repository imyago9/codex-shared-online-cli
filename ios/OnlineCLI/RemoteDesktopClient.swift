import Foundation
import Observation
import UIKit

enum RemoteConnectionState: Equatable {
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
}

@MainActor
@Observable
final class RemoteDesktopClient {
    var frameImage: UIImage?
    var connectionState: RemoteConnectionState = .disconnected
    var mode: RemoteMode = .view
    var streamProfile: RemoteStreamProfile = .balanced
    var controlAllowed = false
    var frameFps: Double = 0
    var frameLatencyMs: Double?
    var frameBytes = 0
    var desktopSize = CGSize(width: 1280, height: 720)
    var displayInfo: RemoteDisplayInfo?
    var monitors: [RemoteMonitorDescriptor] = []
    var remoteCursor: CGPoint?
    var lastPointer = CGPoint(x: 0.5, y: 0.5)
    var inputRateLimitPerSec: Int?
    var inputQueueMax: Int?
    var droppedEvents = 0
    var gatewayStatus: RemoteGatewayStatus?
    var statusText = "Remote idle"

    private var webSocketTask: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private let feedback = UIImpactFeedbackGenerator(style: .light)
    private var currentURL: URL?
    private let pointerSendInterval: TimeInterval = 1.0 / 120.0
    private var lastPointerSendAt: TimeInterval = 0
    private var pendingPointer: CGPoint?
    private var pointerFlushTask: Task<Void, Never>?
    private var lastControlPromptAt: TimeInterval = 0
    private let monitorLayoutSendInterval: TimeInterval = 1.0 / 30.0
    private var lastMonitorLayoutSendAt: TimeInterval = 0
    private var pendingMonitorLayoutOffsets: [String: CGSize]?
    private var monitorLayoutFlushTask: Task<Void, Never>?

    var isConnected: Bool {
        if case .connected = connectionState {
            return true
        }
        return false
    }

    func connect(
        baseURL: URL,
        desiredMode: RemoteMode,
        streamProfile: RemoteStreamProfile,
        visibleMonitorIds: Set<String> = [],
        monitorLayoutOffsets: [String: CGSize] = [:]
    ) {
        disconnect()

        do {
            let api = OnlineCLIAPI(baseURL: baseURL)
            var queryItems = [
                URLQueryItem(name: "mode", value: desiredMode.rawValue),
                URLQueryItem(name: "fps", value: "\(streamProfile.fps)"),
                URLQueryItem(name: "quality", value: "\(streamProfile.jpegQuality)")
            ]
            if !visibleMonitorIds.isEmpty {
                queryItems.append(URLQueryItem(name: "monitors", value: visibleMonitorIds.sorted().joined(separator: ",")))
            }
            if let layout = monitorLayoutQueryValue(monitorLayoutOffsets) {
                queryItems.append(URLQueryItem(name: "layout", value: layout))
            }
            let url = try api.webSocketURL(
                path: "ws/remote",
                queryItems: queryItems
            )
            currentURL = url
            mode = desiredMode
            self.streamProfile = streamProfile
            connectionState = .connecting
            statusText = "Opening remote stream"

            let task = URLSession.shared.webSocketTask(with: url)
            webSocketTask = task
            task.resume()
            receiveTask = Task { [weak self] in
                await self?.receiveLoop()
            }
        } catch {
            connectionState = .failed(error.localizedDescription)
        }
    }

    func disconnect() {
        releaseRemoteInputState()
        receiveTask?.cancel()
        receiveTask = nil
        pointerFlushTask?.cancel()
        pointerFlushTask = nil
        monitorLayoutFlushTask?.cancel()
        monitorLayoutFlushTask = nil
        pendingPointer = nil
        pendingMonitorLayoutOffsets = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        if isConnected || connectionState == .connecting {
            connectionState = .disconnected
        }
    }

    func setMode(_ nextMode: RemoteMode) {
        if mode == .control && nextMode != .control {
            releaseRemoteInputState()
        }
        mode = nextMode
        sendEnvelope(["type": "set-mode", "mode": nextMode.rawValue])
    }

    func setStreamProfile(_ nextProfile: RemoteStreamProfile) {
        streamProfile = nextProfile
        sendEnvelope([
            "type": "set-stream",
            "fps": nextProfile.fps,
            "quality": nextProfile.jpegQuality
        ])
    }

    func setVisibleMonitors(_ monitorIds: Set<String>) {
        sendEnvelope([
            "type": "set-monitors",
            "monitors": monitorIds.sorted()
        ])
    }

    func setMonitorLayoutOffsets(_ offsets: [String: CGSize]) {
        let normalizedOffsets = normalizedMonitorLayoutOffsets(offsets)
        if normalizedOffsets.isEmpty {
            monitorLayoutFlushTask?.cancel()
            monitorLayoutFlushTask = nil
            pendingMonitorLayoutOffsets = nil
            lastMonitorLayoutSendAt = ProcessInfo.processInfo.systemUptime
            sendMonitorLayoutEnvelope(normalizedOffsets)
            return
        }

        let now = ProcessInfo.processInfo.systemUptime
        if now - lastMonitorLayoutSendAt >= monitorLayoutSendInterval {
            lastMonitorLayoutSendAt = now
            sendMonitorLayoutEnvelope(normalizedOffsets)
        } else {
            pendingMonitorLayoutOffsets = normalizedOffsets
            scheduleMonitorLayoutFlush(after: monitorLayoutSendInterval - (now - lastMonitorLayoutSendAt))
        }
    }

    func sendPointerMove(_ point: CGPoint) {
        let normalized = normalizedPoint(point)
        lastPointer = normalized
        guard canSendInput(reportBlocked: false) else { return }

        let now = ProcessInfo.processInfo.systemUptime
        if now - lastPointerSendAt >= pointerSendInterval {
            lastPointerSendAt = now
            sendPointerMoveEnvelope(normalized)
        } else {
            pendingPointer = normalized
            schedulePointerFlush(after: pointerSendInterval - (now - lastPointerSendAt))
        }
    }

    func sendClick(button: String = "left", at point: CGPoint? = nil) {
        feedback.impactOccurred()
        sendMouseButton(button: button, action: "click", at: point)
    }

    func beginDrag(at point: CGPoint) {
        feedback.impactOccurred()
        sendMouseButton(button: "left", action: "down", at: point)
    }

    func updateDrag(to point: CGPoint) {
        sendPointerMove(point)
    }

    func endDrag(at point: CGPoint) {
        sendMouseButton(button: "left", action: "up", at: point)
    }

    func sendDoubleClick(at point: CGPoint? = nil) {
        sendClick(button: "left", at: point)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 70_000_000)
            await MainActor.run {
                self?.sendClick(button: "left", at: point)
            }
        }
    }

    func sendWheel(deltaY: Int) {
        sendInput([
            "type": "mouse_wheel",
            "deltaX": 0,
            "deltaY": deltaY,
            "x": lastPointer.x,
            "y": lastPointer.y
        ])
    }

    func nudgePointer(dx: CGFloat, dy: CGFloat) {
        let next = CGPoint(
            x: min(1, max(0, lastPointer.x + dx)),
            y: min(1, max(0, lastPointer.y + dy))
        )
        sendPointerMove(next)
    }

    func sendKey(_ key: String, code: String = "", modifiers: [String: Bool] = [:]) {
        sendInput([
            "type": "key",
            "action": "press",
            "key": key,
            "code": code,
            "modifiers": modifiers
        ])
    }

    func sendShortcut(_ shortcut: RemoteShortcut) {
        sendKey(shortcut.key, code: shortcut.code, modifiers: shortcut.modifiers)
    }

    func sendAction(_ action: RemoteActionDescriptor) {
        sendKey(action.key, code: action.code, modifiers: action.modifiers ?? [:])
    }

    func releaseRemoteInputState() {
        sendEnvelope([
            "type": "input",
            "event": [
                "type": "release_all"
            ]
        ])
    }

    func sendText(_ text: String) {
        guard !text.isEmpty else { return }
        let chunks = text.chunked(maxLength: 60)
        for chunk in chunks {
            sendInput(["type": "text", "text": chunk])
        }
    }

    private func receiveLoop() async {
        while !Task.isCancelled {
            guard let webSocketTask else { return }
            do {
                let message = try await webSocketTask.receive()
                await handle(message)
            } catch {
                if !Task.isCancelled {
                    connectionState = .failed(error.localizedDescription)
                    statusText = error.localizedDescription
                }
                return
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) async {
        switch message {
        case .data(let data):
            if let image = UIImage(data: data) {
                frameImage = image
                desktopSize = image.size
                if connectionState != .connected {
                    connectionState = .connected
                }
            }
        case .string(let text):
            handleControlText(text)
        @unknown default:
            break
        }
    }

    private func handleControlText(_ text: String) {
        guard
            let data = text.data(using: .utf8),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            payload["__onlineCliControl"] as? Bool == true,
            payload["channel"] as? String == "remote",
            let type = payload["type"] as? String
        else {
            return
        }

        switch type {
        case "remote-ready", "remote-mode":
            controlAllowed = payload["controlAllowed"] as? Bool ?? false
            inputRateLimitPerSec = intValue(payload["inputRateLimitPerSec"]) ?? inputRateLimitPerSec
            inputQueueMax = intValue(payload["inputQueueMax"]) ?? inputQueueMax
            displayInfo = decodeObject(RemoteDisplayInfo.self, from: payload["display"]) ?? displayInfo
            monitors = decodeObject([RemoteMonitorDescriptor].self, from: payload["monitors"]) ?? monitors
            gatewayStatus = decodeObject(RemoteGatewayStatus.self, from: payload["gateway"]) ?? gatewayStatus
            if let stream = payload["stream"] as? [String: Any] {
                frameFps = doubleValue(stream["fps"]) ?? frameFps
            }
            if let rawMode = payload["mode"] as? String, let nextMode = RemoteMode(rawValue: rawMode) {
                mode = nextMode
            }
            connectionState = .connected
            setStatusText(controlAllowed ? "Control available" : "View only")
        case "remote-stream-connected":
            connectionState = .connected
            setStatusText("Stream connected")
        case "remote-stream-config":
            monitors = decodeObject([RemoteMonitorDescriptor].self, from: payload["monitors"]) ?? monitors
            setStatusText("Stream tuned to \(streamProfile.title)")
        case "remote-monitor-config":
            monitors = decodeObject([RemoteMonitorDescriptor].self, from: payload["monitors"]) ?? monitors
            setStatusText("Monitor view updated")
        case "remote-stats":
            frameFps = doubleValue(payload["fps"]) ?? frameFps
            frameBytes = intValue(payload["frameBytes"]) ?? frameBytes
            frameLatencyMs = doubleValue(payload["captureLatencyMs"])
            displayInfo = decodeObject(RemoteDisplayInfo.self, from: payload["display"]) ?? displayInfo
            monitors = decodeObject([RemoteMonitorDescriptor].self, from: payload["monitors"]) ?? monitors
        case "remote-cursor":
            if let x = doubleValue(payload["x"]), let y = doubleValue(payload["y"]) {
                remoteCursor = CGPoint(x: x, y: y)
            }
        case "remote-input-throttled":
            setStatusText("Input throttled")
        case "remote-input-backpressure":
            droppedEvents = intValue(payload["droppedEvents"]) ?? droppedEvents
            setStatusText("Input queue is saturated")
        case "remote-input-error":
            setStatusText(payload["message"] as? String ?? "Input error")
        case "remote-input-connected":
            setStatusText("Input connected")
        case "remote-input-disconnected":
            setStatusText("Input disconnected")
        case "remote-stream-error":
            connectionState = .failed(payload["message"] as? String ?? "Stream error")
        case "remote-stream-disconnected":
            connectionState = .failed("Remote stream disconnected")
        default:
            break
        }
    }

    private func sendInput(_ event: [String: Any], reportBlocked: Bool = true) {
        guard canSendInput(reportBlocked: reportBlocked) else { return }
        sendEnvelope(["type": "input", "event": event])
    }

    private func sendMouseButton(button: String, action: String, at point: CGPoint?) {
        let target = point.map(normalizedPoint) ?? lastPointer
        lastPointer = target
        cancelPendingPointerMove()
        sendInput([
            "type": "mouse_button",
            "button": button,
            "action": action,
            "x": target.x,
            "y": target.y
        ])
    }

    private func canSendInput(reportBlocked: Bool = true) -> Bool {
        guard mode == .control, controlAllowed else {
            if reportBlocked {
                noteControlRequired()
            }
            return false
        }
        return true
    }

    private func sendPointerMoveEnvelope(_ point: CGPoint) {
        sendInput([
            "type": "mouse_move",
            "x": point.x,
            "y": point.y
        ], reportBlocked: false)
    }

    private func schedulePointerFlush(after delay: TimeInterval) {
        guard pointerFlushTask == nil else { return }
        let nanoseconds = UInt64(max(0, delay) * 1_000_000_000)
        pointerFlushTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: nanoseconds)
            self?.flushPendingPointerMove()
        }
    }

    private func cancelPendingPointerMove() {
        pointerFlushTask?.cancel()
        pointerFlushTask = nil
        pendingPointer = nil
    }

    private func flushPendingPointerMove() {
        pointerFlushTask = nil
        guard let point = pendingPointer else { return }
        pendingPointer = nil
        lastPointerSendAt = ProcessInfo.processInfo.systemUptime
        sendPointerMoveEnvelope(point)
    }

    private func noteControlRequired() {
        let now = ProcessInfo.processInfo.systemUptime
        guard statusText != "Enable control first" || now - lastControlPromptAt > 0.75 else { return }
        lastControlPromptAt = now
        setStatusText("Enable control first")
    }

    private func setStatusText(_ text: String) {
        guard statusText != text else { return }
        statusText = text
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

    private func sendMonitorLayoutEnvelope(_ offsets: [String: CGSize]) {
        sendEnvelope([
            "type": "set-monitor-layout",
            "layout": monitorLayoutPayload(offsets)
        ])
    }

    private func scheduleMonitorLayoutFlush(after delay: TimeInterval) {
        guard monitorLayoutFlushTask == nil else { return }
        let nanoseconds = UInt64(max(0, delay) * 1_000_000_000)
        monitorLayoutFlushTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: nanoseconds)
            self?.flushPendingMonitorLayout()
        }
    }

    private func flushPendingMonitorLayout() {
        monitorLayoutFlushTask = nil
        guard let offsets = pendingMonitorLayoutOffsets else { return }
        pendingMonitorLayoutOffsets = nil
        lastMonitorLayoutSendAt = ProcessInfo.processInfo.systemUptime
        sendMonitorLayoutEnvelope(offsets)
    }

    private func monitorLayoutQueryValue(_ offsets: [String: CGSize]) -> String? {
        let payload = monitorLayoutPayload(normalizedMonitorLayoutOffsets(offsets))
        guard !payload.isEmpty, JSONSerialization.isValidJSONObject(payload) else { return nil }
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func monitorLayoutPayload(_ offsets: [String: CGSize]) -> [[String: Any]] {
        offsets.compactMap { id, offset -> [String: Any]? in
            let dx = Int(offset.width.rounded())
            let dy = Int(offset.height.rounded())
            guard !id.isEmpty, dx != 0 || dy != 0 else { return nil }
            return [
                "id": id,
                "dx": dx,
                "dy": dy
            ]
        }
    }

    private func normalizedMonitorLayoutOffsets(_ offsets: [String: CGSize]) -> [String: CGSize] {
        offsets.reduce(into: [String: CGSize]()) { result, entry in
            let id = entry.key.trimmingCharacters(in: .whitespacesAndNewlines)
            let dx = Int(entry.value.width.rounded())
            let dy = Int(entry.value.height.rounded())
            guard !id.isEmpty, dx != 0 || dy != 0 else { return }
            result[id] = CGSize(width: dx, height: dy)
        }
    }

    private func normalizedPoint(_ point: CGPoint) -> CGPoint {
        CGPoint(
            x: min(1, max(0, point.x)),
            y: min(1, max(0, point.y))
        )
    }

    private func intValue(_ value: Any?) -> Int? {
        if let value = value as? Int {
            return value
        }
        if let value = value as? Double {
            return Int(value)
        }
        if let value = value as? NSNumber {
            return value.intValue
        }
        return nil
    }

    private func doubleValue(_ value: Any?) -> Double? {
        if let value = value as? Double {
            return value
        }
        if let value = value as? Int {
            return Double(value)
        }
        if let value = value as? NSNumber {
            return value.doubleValue
        }
        return nil
    }

    private func decodeObject<T: Decodable>(_ type: T.Type, from value: Any?) -> T? {
        guard let value, JSONSerialization.isValidJSONObject(value) else {
            return nil
        }
        guard let data = try? JSONSerialization.data(withJSONObject: value) else {
            return nil
        }
        return try? JSONDecoder().decode(type, from: data)
    }
}

private extension String {
    func chunked(maxLength: Int) -> [String] {
        guard count > maxLength else { return [self] }
        var chunks: [String] = []
        var start = startIndex
        while start < endIndex {
            let end = index(start, offsetBy: maxLength, limitedBy: endIndex) ?? endIndex
            chunks.append(String(self[start..<end]))
            start = end
        }
        return chunks
    }
}

enum RemoteShortcut: String, CaseIterable, Identifiable {
    case copy
    case paste
    case selectAll
    case altTab
    case showDesktop
    case taskManager
    case backspace
    case delete
    case pageUp
    case pageDown

    var id: String { rawValue }

    var title: String {
        switch self {
        case .copy:
            return "Copy"
        case .paste:
            return "Paste"
        case .selectAll:
            return "Select All"
        case .altTab:
            return "Alt Tab"
        case .showDesktop:
            return "Show Desktop"
        case .taskManager:
            return "Task Manager"
        case .backspace:
            return "Backspace"
        case .delete:
            return "Delete"
        case .pageUp:
            return "Page Up"
        case .pageDown:
            return "Page Down"
        }
    }

    var systemImage: String {
        switch self {
        case .copy:
            return "doc.on.doc"
        case .paste:
            return "clipboard"
        case .selectAll:
            return "textformat"
        case .altTab:
            return "rectangle.stack"
        case .showDesktop:
            return "desktopcomputer"
        case .taskManager:
            return "speedometer"
        case .backspace:
            return "delete.left"
        case .delete:
            return "delete.right"
        case .pageUp:
            return "arrow.up.to.line"
        case .pageDown:
            return "arrow.down.to.line"
        }
    }

    var key: String {
        switch self {
        case .copy:
            return "c"
        case .paste:
            return "v"
        case .selectAll:
            return "a"
        case .altTab:
            return "Tab"
        case .showDesktop:
            return "d"
        case .taskManager:
            return "Escape"
        case .backspace:
            return "Backspace"
        case .delete:
            return "Delete"
        case .pageUp:
            return "PageUp"
        case .pageDown:
            return "PageDown"
        }
    }

    var code: String {
        switch self {
        case .copy:
            return "KeyC"
        case .paste:
            return "KeyV"
        case .selectAll:
            return "KeyA"
        case .altTab:
            return "Tab"
        case .showDesktop:
            return "KeyD"
        case .taskManager:
            return "Escape"
        case .backspace:
            return "Backspace"
        case .delete:
            return "Delete"
        case .pageUp:
            return "PageUp"
        case .pageDown:
            return "PageDown"
        }
    }

    var modifiers: [String: Bool] {
        switch self {
        case .copy, .paste, .selectAll:
            return ["ctrl": true]
        case .altTab:
            return ["alt": true]
        case .showDesktop:
            return ["meta": true]
        case .taskManager:
            return ["ctrl": true, "shift": true]
        case .backspace, .delete, .pageUp, .pageDown:
            return [:]
        }
    }
}
