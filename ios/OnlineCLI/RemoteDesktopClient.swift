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

    var isConnected: Bool {
        if case .connected = connectionState {
            return true
        }
        return false
    }

    func connect(baseURL: URL, desiredMode: RemoteMode, streamProfile: RemoteStreamProfile) {
        disconnect()

        do {
            let api = OnlineCLIAPI(baseURL: baseURL)
            let url = try api.webSocketURL(
                path: "ws/remote",
                queryItems: [
                    URLQueryItem(name: "mode", value: desiredMode.rawValue),
                    URLQueryItem(name: "fps", value: "\(streamProfile.fps)"),
                    URLQueryItem(name: "quality", value: "\(streamProfile.jpegQuality)")
                ]
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
        receiveTask?.cancel()
        receiveTask = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        if isConnected || connectionState == .connecting {
            connectionState = .disconnected
        }
    }

    func setMode(_ nextMode: RemoteMode) {
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

    func sendPointerMove(_ point: CGPoint) {
        let normalized = normalizedPoint(point)
        lastPointer = normalized
        sendInput([
            "type": "mouse_move",
            "x": normalized.x,
            "y": normalized.y
        ])
    }

    func sendClick(button: String = "left", at point: CGPoint? = nil) {
        let target = point.map(normalizedPoint) ?? lastPointer
        lastPointer = target
        feedback.impactOccurred()
        sendInput([
            "type": "mouse_button",
            "button": button,
            "action": "click",
            "x": target.x,
            "y": target.y
        ])
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
            gatewayStatus = decodeObject(RemoteGatewayStatus.self, from: payload["gateway"]) ?? gatewayStatus
            if let stream = payload["stream"] as? [String: Any] {
                frameFps = doubleValue(stream["fps"]) ?? frameFps
            }
            if let rawMode = payload["mode"] as? String, let nextMode = RemoteMode(rawValue: rawMode) {
                mode = nextMode
            }
            connectionState = .connected
            statusText = controlAllowed ? "Control available" : "View only"
        case "remote-stream-connected":
            connectionState = .connected
            statusText = "Stream connected"
        case "remote-stream-config":
            statusText = "Stream tuned to \(streamProfile.title)"
        case "remote-stats":
            frameFps = doubleValue(payload["fps"]) ?? frameFps
            frameBytes = intValue(payload["frameBytes"]) ?? frameBytes
            frameLatencyMs = doubleValue(payload["captureLatencyMs"])
        case "remote-cursor":
            if let x = doubleValue(payload["x"]), let y = doubleValue(payload["y"]) {
                remoteCursor = CGPoint(x: x, y: y)
            }
        case "remote-input-throttled":
            statusText = "Input throttled"
        case "remote-input-backpressure":
            droppedEvents = intValue(payload["droppedEvents"]) ?? droppedEvents
            statusText = "Input queue is saturated"
        case "remote-input-error":
            statusText = payload["message"] as? String ?? "Input error"
        case "remote-input-connected":
            statusText = "Input connected"
        case "remote-input-disconnected":
            statusText = "Input disconnected"
        case "remote-stream-error":
            connectionState = .failed(payload["message"] as? String ?? "Stream error")
        case "remote-stream-disconnected":
            connectionState = .failed("Remote stream disconnected")
        default:
            break
        }
    }

    private func sendInput(_ event: [String: Any]) {
        guard mode == .control, controlAllowed else {
            statusText = "Enable control first"
            return
        }
        sendEnvelope(["type": "input", "event": event])
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
