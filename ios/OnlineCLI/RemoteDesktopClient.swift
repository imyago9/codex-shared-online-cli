import Foundation
import AVFoundation
import CoreMedia
import ImageIO
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

struct RemoteFrameRenderUpdate {
    let image: CGImage?
    let pixelSize: CGSize
    let sequence: UInt64
    let decodeMs: Double
    let receivedAt: TimeInterval
}

struct RemoteVideoRenderUpdate {
    let sampleBuffer: CMSampleBuffer?
    let pixelSize: CGSize
    let sequence: UInt64
    let receivedAt: TimeInterval
}

enum RemoteStreamTransport: String {
    case jpeg
    case video
}

struct RemoteRenderDiagnostics: Equatable {
    var decodeMs: Double = 0
    var renderMs: Double = 0
    var droppedFrames = 0
    var receivedFps: Double = 0
    var presentedFps: Double = 0
    var frameBytes = 0
    var captureLatencyMs: Double?
    var inputQueueMax: Int?
    var droppedInputEvents = 0
}

private struct CompressedRemoteFrame {
    let data: Data
    let receivedAt: TimeInterval
}

private struct DecodedRemoteFrame {
    let image: CGImage
    let pixelSize: CGSize
    let decodeMs: Double
    let byteCount: Int
    let receivedAt: TimeInterval
}

@MainActor
@Observable
final class RemoteDesktopClient {
    @ObservationIgnored private(set) var frameImage: CGImage?
    @ObservationIgnored private(set) var remoteCursor: CGPoint?
    @ObservationIgnored private(set) var frameSequence: UInt64 = 0
    @ObservationIgnored private(set) var videoSequence: UInt64 = 0
    @ObservationIgnored private(set) var desktopSize = CGSize(width: 1280, height: 720)
    @ObservationIgnored var frameSink: ((RemoteFrameRenderUpdate) -> Void)?
    @ObservationIgnored var videoSink: ((RemoteVideoRenderUpdate) -> Void)?
    @ObservationIgnored var cursorSink: ((CGPoint?) -> Void)?

    var connectionState: RemoteConnectionState = .disconnected
    var mode: RemoteMode = .view
    var streamProfile: RemoteStreamProfile = .balanced
    var controlAllowed = false
    var frameFps: Double = 0
    var frameLatencyMs: Double?
    var frameBytes = 0
    var displayInfo: RemoteDisplayInfo?
    var monitors: [RemoteMonitorDescriptor] = []
    var lastPointer = CGPoint(x: 0.5, y: 0.5)
    var inputRateLimitPerSec: Int?
    var inputQueueMax: Int?
    var droppedEvents = 0
    var renderDiagnostics = RemoteRenderDiagnostics()
    var gatewayStatus: RemoteGatewayStatus?
    var statusText = "Remote idle"

    private var webSocketTask: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private let feedback = UIImpactFeedbackGenerator(style: .light)
    private var currentURL: URL?
    private let pointerSendInterval: TimeInterval = 1.0 / 180.0
    private var lastPointerSendAt: TimeInterval = 0
    private var pendingPointer: CGPoint?
    private var pointerFlushTask: Task<Void, Never>?
    @ObservationIgnored private var frameDecodeTask: Task<Void, Never>?
    @ObservationIgnored private var pendingFrameData: CompressedRemoteFrame?
    @ObservationIgnored private var pendingDecodedFrame: DecodedRemoteFrame?
    @ObservationIgnored private var framePresentationTask: Task<Void, Never>?
    @ObservationIgnored private var lastFramePresentationAt: TimeInterval = 0
    @ObservationIgnored private var diagnosticsDraft = RemoteRenderDiagnostics()
    @ObservationIgnored private var lastDiagnosticsPublishAt: TimeInterval = 0
    @ObservationIgnored private var receivedFrameCount = 0
    @ObservationIgnored private var receivedFpsWindowStartedAt: TimeInterval = 0
    @ObservationIgnored private var presentedFrameCount = 0
    @ObservationIgnored private var presentedFpsWindowStartedAt: TimeInterval = 0
    @ObservationIgnored private var adaptiveCooldownUntil: TimeInterval = 0
    @ObservationIgnored private var adaptiveGoodSince: TimeInterval?
    @ObservationIgnored private var adaptiveDroppedFrameBaseline = 0
    @ObservationIgnored private var adaptiveDroppedInputBaseline = 0
    @ObservationIgnored private var streamTransport: RemoteStreamTransport = .video
    @ObservationIgnored private var videoUsesAccessUnitFraming = false
    @ObservationIgnored private var h264Decoder = RemoteH264AnnexBDecoder()
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
                URLQueryItem(name: "transport", value: "video"),
                URLQueryItem(name: "fps", value: "\(streamProfile.videoFps)"),
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
        frameDecodeTask?.cancel()
        frameDecodeTask = nil
        framePresentationTask?.cancel()
        framePresentationTask = nil
        monitorLayoutFlushTask?.cancel()
        monitorLayoutFlushTask = nil
        pendingPointer = nil
        pendingFrameData = nil
        pendingDecodedFrame = nil
        pendingMonitorLayoutOffsets = nil
        h264Decoder.reset()
        streamTransport = .video
        videoUsesAccessUnitFraming = false
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        frameImage = nil
        remoteCursor = nil
        diagnosticsDraft = RemoteRenderDiagnostics()
        renderDiagnostics = diagnosticsDraft
        frameSequence &+= 1
        frameSink?(RemoteFrameRenderUpdate(
            image: nil,
            pixelSize: desktopSize,
            sequence: frameSequence,
            decodeMs: 0,
            receivedAt: ProcessInfo.processInfo.systemUptime
        ))
        videoSequence &+= 1
        videoSink?(RemoteVideoRenderUpdate(
            sampleBuffer: nil,
            pixelSize: desktopSize,
            sequence: videoSequence,
            receivedAt: ProcessInfo.processInfo.systemUptime
        ))
        cursorSink?(nil)
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
        setStreamProfile(nextProfile, adaptive: false)
    }

    private func setStreamProfile(_ nextProfile: RemoteStreamProfile, adaptive: Bool) {
        guard nextProfile != streamProfile else { return }
        streamProfile = nextProfile
        sendEnvelope([
            "type": "set-stream",
            "fps": nextProfile.fps,
            "videoFps": nextProfile.videoFps,
            "quality": nextProfile.jpegQuality
        ])
        if adaptive {
            setStatusText("Stream adapted to \(nextProfile.title)")
        }
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
        publishPredictedCursor(normalized)
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
            if Self.isJPEGData(data) || streamTransport == .jpeg {
                enqueueFrameData(data)
            } else {
                handleVideoData(data)
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
            updateDisplayInfo(decodeObject(RemoteDisplayInfo.self, from: payload["display"]))
            updateMonitors(decodeObject([RemoteMonitorDescriptor].self, from: payload["monitors"]))
            updateGatewayStatus(decodeObject(RemoteGatewayStatus.self, from: payload["gateway"]))
            if let stream = payload["stream"] as? [String: Any] {
                frameFps = doubleValue(stream["fps"]) ?? frameFps
                if let transport = streamTransportValue(stream["transport"]) {
                    streamTransport = transport
                }
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
            if let transport = streamTransportValue(payload["transport"]) {
                if transport != streamTransport {
                    h264Decoder.reset()
                }
                streamTransport = transport
            }
            let nextFraming = videoFramingValue(payload) == "access-unit"
            if nextFraming != videoUsesAccessUnitFraming {
                h264Decoder.reset()
                videoUsesAccessUnitFraming = nextFraming
            }
            updateDisplayInfo(decodeObject(RemoteDisplayInfo.self, from: payload["display"]))
            updateMonitors(decodeObject([RemoteMonitorDescriptor].self, from: payload["monitors"]))
            setStatusText(streamTransport == .video ? "Live video stream active" : "JPEG fallback stream active")
        case "remote-monitor-config":
            updateMonitors(decodeObject([RemoteMonitorDescriptor].self, from: payload["monitors"]))
            setStatusText("Monitor view updated")
        case "remote-monitor-layout":
            setStatusText("Monitor view updated")
        case "remote-stats":
            frameFps = doubleValue(payload["fps"]) ?? frameFps
            frameBytes = intValue(payload["frameBytes"]) ?? frameBytes
            frameLatencyMs = doubleValue(payload["captureLatencyMs"])
            diagnosticsDraft.frameBytes = frameBytes
            diagnosticsDraft.captureLatencyMs = frameLatencyMs
            diagnosticsDraft.inputQueueMax = inputQueueMax
            diagnosticsDraft.droppedInputEvents = droppedEvents
            publishDiagnosticsIfNeeded()
            updateDisplayInfo(decodeObject(RemoteDisplayInfo.self, from: payload["display"]))
            updateMonitors(decodeObject([RemoteMonitorDescriptor].self, from: payload["monitors"]))
            considerAdaptiveStream()
        case "remote-cursor":
            if let x = doubleValue(payload["x"]), let y = doubleValue(payload["y"]) {
                let point = CGPoint(x: x, y: y)
                if remoteCursor != point {
                    remoteCursor = point
                    cursorSink?(point)
                }
            }
        case "remote-input-throttled":
            setStatusText("Input throttled")
        case "remote-input-backpressure":
            droppedEvents = intValue(payload["droppedEvents"]) ?? droppedEvents
            diagnosticsDraft.droppedInputEvents = droppedEvents
            diagnosticsDraft.inputQueueMax = inputQueueMax
            publishDiagnosticsIfNeeded(force: true)
            setStatusText("Input queue is saturated")
        case "remote-input-error":
            setStatusText(payload["message"] as? String ?? "Input error")
        case "remote-input-connected":
            setStatusText("Input connected")
        case "remote-input-disconnected":
            setStatusText("Input disconnected")
        case "remote-stream-error":
            connectionState = .failed(payload["message"] as? String ?? "Stream error")
        case "remote-stream-restarting":
            setStatusText("Restarting live video")
        case "remote-stream-disconnected":
            connectionState = .failed("Remote stream disconnected")
        default:
            break
        }
    }

    private func handleVideoData(_ data: Data) {
        let receivedAt = ProcessInfo.processInfo.systemUptime
        recordReceivedFrame(byteCount: data.count, at: receivedAt)
        let samples = videoUsesAccessUnitFraming
            ? h264Decoder.appendAccessUnit(data, receivedAt: receivedAt)
            : h264Decoder.append(data, receivedAt: receivedAt)
        for sample in samples {
            publishVideoFrame(sample)
        }
    }

    private func publishVideoFrame(_ sample: RemoteVideoSample) {
        videoSequence &+= 1
        desktopSize = sample.pixelSize
        diagnosticsDraft.decodeMs = sample.packetizeMs
        diagnosticsDraft.frameBytes = sample.byteCount
        publishDiagnosticsIfNeeded()
        videoSink?(RemoteVideoRenderUpdate(
            sampleBuffer: sample.sampleBuffer,
            pixelSize: sample.pixelSize,
            sequence: videoSequence,
            receivedAt: sample.receivedAt
        ))
        if connectionState != .connected {
            connectionState = .connected
        }
    }

    private func enqueueFrameData(_ data: Data) {
        let now = ProcessInfo.processInfo.systemUptime
        if pendingFrameData != nil {
            diagnosticsDraft.droppedFrames += 1
        }
        pendingFrameData = CompressedRemoteFrame(data: data, receivedAt: now)
        recordReceivedFrame(byteCount: data.count, at: now)
        guard frameDecodeTask == nil else { return }
        frameDecodeTask = Task { [weak self] in
            await self?.decodePendingFrames()
        }
    }

    private func decodePendingFrames() async {
        while !Task.isCancelled {
            guard let compressedFrame = pendingFrameData else {
                frameDecodeTask = nil
                return
            }

            pendingFrameData = nil
            guard let decodedFrame = await Self.decodeFrameImage(from: compressedFrame), !Task.isCancelled else {
                continue
            }
            enqueueDecodedFrame(decodedFrame)
        }
    }

    private func enqueueDecodedFrame(_ frame: DecodedRemoteFrame) {
        let now = ProcessInfo.processInfo.systemUptime
        let interval = targetPresentationInterval
        let elapsed = now - lastFramePresentationAt

        if lastFramePresentationAt == 0 || elapsed >= interval {
            framePresentationTask?.cancel()
            framePresentationTask = nil
            pendingDecodedFrame = nil
            publishFrame(frame)
            return
        }

        if pendingDecodedFrame != nil {
            diagnosticsDraft.droppedFrames += 1
        }
        pendingDecodedFrame = frame
        scheduleFramePresentation(after: interval - elapsed)
    }

    private func scheduleFramePresentation(after delay: TimeInterval) {
        guard framePresentationTask == nil else { return }
        let nanoseconds = UInt64(max(0, delay) * 1_000_000_000)
        framePresentationTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: nanoseconds)
            self?.flushPendingDecodedFrame()
        }
    }

    private func flushPendingDecodedFrame() {
        framePresentationTask = nil
        guard let frame = pendingDecodedFrame else { return }
        pendingDecodedFrame = nil
        publishFrame(frame)
    }

    private func publishFrame(_ frame: DecodedRemoteFrame) {
        frameSequence &+= 1
        frameImage = frame.image
        desktopSize = frame.pixelSize
        lastFramePresentationAt = ProcessInfo.processInfo.systemUptime
        diagnosticsDraft.decodeMs = frame.decodeMs
        diagnosticsDraft.frameBytes = frame.byteCount
        publishDiagnosticsIfNeeded()
        frameSink?(RemoteFrameRenderUpdate(
            image: frame.image,
            pixelSize: frame.pixelSize,
            sequence: frameSequence,
            decodeMs: frame.decodeMs,
            receivedAt: frame.receivedAt
        ))
        if connectionState != .connected {
            connectionState = .connected
        }
        considerAdaptiveStream()
    }

    private nonisolated static func decodeFrameImage(from frame: CompressedRemoteFrame) async -> DecodedRemoteFrame? {
        await Task.detached(priority: .userInitiated) {
            let startedAt = ProcessInfo.processInfo.systemUptime
            let options: [CFString: Any] = [
                kCGImageSourceShouldCache: true,
                kCGImageSourceShouldCacheImmediately: true
            ]
            guard
                let source = CGImageSourceCreateWithData(frame.data as CFData, options as CFDictionary),
                let cgImage = CGImageSourceCreateImageAtIndex(source, 0, options as CFDictionary)
            else {
                return nil
            }
            let decodeMs = (ProcessInfo.processInfo.systemUptime - startedAt) * 1_000
            return DecodedRemoteFrame(
                image: cgImage,
                pixelSize: CGSize(width: cgImage.width, height: cgImage.height),
                decodeMs: decodeMs,
                byteCount: frame.data.count,
                receivedAt: frame.receivedAt
            )
        }.value
    }

    func recordFramePresented(renderMs: Double) {
        let now = ProcessInfo.processInfo.systemUptime
        diagnosticsDraft.renderMs = renderMs
        if presentedFpsWindowStartedAt == 0 {
            presentedFpsWindowStartedAt = now
        }
        presentedFrameCount += 1
        let elapsed = now - presentedFpsWindowStartedAt
        if elapsed >= 1 {
            diagnosticsDraft.presentedFps = Double(presentedFrameCount) / elapsed
            presentedFrameCount = 0
            presentedFpsWindowStartedAt = now
        }
        publishDiagnosticsIfNeeded()
    }

    private var targetPresentationInterval: TimeInterval {
        let fps = max(1, min(30, streamProfile.fps))
        return 1.0 / Double(fps)
    }

    private func recordReceivedFrame(byteCount: Int, at now: TimeInterval) {
        frameBytes = byteCount
        diagnosticsDraft.frameBytes = byteCount
        diagnosticsDraft.inputQueueMax = inputQueueMax
        diagnosticsDraft.droppedInputEvents = droppedEvents
        if receivedFpsWindowStartedAt == 0 {
            receivedFpsWindowStartedAt = now
        }
        receivedFrameCount += 1
        let elapsed = now - receivedFpsWindowStartedAt
        if elapsed >= 1 {
            diagnosticsDraft.receivedFps = Double(receivedFrameCount) / elapsed
            receivedFrameCount = 0
            receivedFpsWindowStartedAt = now
        }
        publishDiagnosticsIfNeeded()
    }

    private func publishDiagnosticsIfNeeded(force: Bool = false) {
        let now = ProcessInfo.processInfo.systemUptime
        guard force || now - lastDiagnosticsPublishAt >= 0.33 else { return }
        lastDiagnosticsPublishAt = now
        diagnosticsDraft.captureLatencyMs = frameLatencyMs
        diagnosticsDraft.inputQueueMax = inputQueueMax
        diagnosticsDraft.droppedInputEvents = droppedEvents
        if renderDiagnostics != diagnosticsDraft {
            renderDiagnostics = diagnosticsDraft
        }
    }

    private func considerAdaptiveStream() {
        let now = ProcessInfo.processInfo.systemUptime
        guard now >= adaptiveCooldownUntil else { return }

        let latency = frameLatencyMs ?? diagnosticsDraft.captureLatencyMs ?? 0
        let pressureIsHigh = latency > 220
            || diagnosticsDraft.decodeMs > 24
            || diagnosticsDraft.droppedFrames > adaptiveDroppedFrameBaseline
            || droppedEvents > adaptiveDroppedInputBaseline

        if pressureIsHigh {
            adaptiveGoodSince = nil
            adaptiveDroppedFrameBaseline = diagnosticsDraft.droppedFrames
            adaptiveDroppedInputBaseline = droppedEvents
            guard let lower = streamProfile.nextLowerPressureProfile else {
                adaptiveCooldownUntil = now + 3
                return
            }
            setStreamProfile(lower, adaptive: true)
            adaptiveCooldownUntil = now + 4
            return
        }

        let pressureIsLow = latency > 0
            && latency < 90
            && diagnosticsDraft.decodeMs > 0
            && diagnosticsDraft.decodeMs < 8
            && diagnosticsDraft.droppedFrames == adaptiveDroppedFrameBaseline
            && droppedEvents == adaptiveDroppedInputBaseline

        if pressureIsLow {
            adaptiveGoodSince = adaptiveGoodSince ?? now
            if now - (adaptiveGoodSince ?? now) >= 8, let higher = streamProfile.nextHigherQualityProfile {
                setStreamProfile(higher, adaptive: true)
                adaptiveGoodSince = nil
                adaptiveCooldownUntil = now + 10
            }
        } else {
            adaptiveGoodSince = nil
            adaptiveDroppedFrameBaseline = diagnosticsDraft.droppedFrames
            adaptiveDroppedInputBaseline = droppedEvents
        }
    }

    private func updateDisplayInfo(_ next: RemoteDisplayInfo?) {
        guard let next, next != displayInfo else { return }
        displayInfo = next
    }

    private func updateMonitors(_ next: [RemoteMonitorDescriptor]?) {
        guard let next, next != monitors else { return }
        monitors = next
    }

    private func updateGatewayStatus(_ next: RemoteGatewayStatus?) {
        guard let next, next != gatewayStatus else { return }
        gatewayStatus = next
    }

    private func sendInput(_ event: [String: Any], reportBlocked: Bool = true) {
        guard canSendInput(reportBlocked: reportBlocked) else { return }
        sendEnvelope(["type": "input", "event": event])
    }

    private func sendMouseButton(button: String, action: String, at point: CGPoint?) {
        let target = point.map(normalizedPoint) ?? lastPointer
        lastPointer = target
        publishPredictedCursor(target)
        cancelPendingPointerMove()
        sendInput([
            "type": "mouse_button",
            "button": button,
            "action": action,
            "x": target.x,
            "y": target.y
        ])
    }

    private func publishPredictedCursor(_ point: CGPoint) {
        guard mode == .control else { return }
        if remoteCursor != point {
            remoteCursor = point
            cursorSink?(point)
        }
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

    private nonisolated static func isJPEGData(_ data: Data) -> Bool {
        guard data.count >= 2 else { return false }
        return data[data.startIndex] == 0xFF && data[data.index(after: data.startIndex)] == 0xD8
    }

    private func streamTransportValue(_ value: Any?) -> RemoteStreamTransport? {
        guard let rawValue = value as? String else { return nil }
        switch rawValue.lowercased() {
        case "video", "h264":
            return .video
        case "jpeg", "jpg", "image":
            return .jpeg
        default:
            return nil
        }
    }

    private func videoFramingValue(_ payload: [String: Any]) -> String? {
        if let framing = payload["framing"] as? String {
            return framing.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }
        if let video = payload["video"] as? [String: Any], let framing = video["framing"] as? String {
            return framing.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }
        return nil
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

private struct RemoteVideoSample {
    let sampleBuffer: CMSampleBuffer
    let pixelSize: CGSize
    let sequence: UInt64
    let packetizeMs: Double
    let byteCount: Int
    let receivedAt: TimeInterval
}

private final class RemoteH264AnnexBDecoder {
    private var buffer = Data()
    private var currentAccessUnit: [Data] = []
    private var sps: Data?
    private var pps: Data?
    private var formatDescription: CMVideoFormatDescription?
    private var sampleSequence: UInt64 = 0

    func reset() {
        buffer.removeAll(keepingCapacity: true)
        currentAccessUnit.removeAll(keepingCapacity: true)
        sps = nil
        pps = nil
        formatDescription = nil
        sampleSequence = 0
    }

    func append(_ data: Data, receivedAt: TimeInterval) -> [RemoteVideoSample] {
        guard !data.isEmpty else { return [] }
        buffer.append(data)
        let units = drainCompleteNALUnits()
        guard !units.isEmpty else { return [] }

        return processNALUnits(units, receivedAt: receivedAt, flushAtEnd: false)
    }

    func appendAccessUnit(_ data: Data, receivedAt: TimeInterval) -> [RemoteVideoSample] {
        guard !data.isEmpty else { return [] }
        let units = nalUnits(in: data)
        guard !units.isEmpty else { return [] }

        return processNALUnits(units, receivedAt: receivedAt, flushAtEnd: true)
    }

    private func processNALUnits(
        _ units: [Data],
        receivedAt: TimeInterval,
        flushAtEnd: Bool
    ) -> [RemoteVideoSample] {
        var samples: [RemoteVideoSample] = []
        for unit in units {
            if let sample = processNALUnit(unit, receivedAt: receivedAt) {
                samples.append(sample)
            }
        }
        if flushAtEnd, let sample = flushAccessUnit(receivedAt: receivedAt) {
            samples.append(sample)
        }
        return samples
    }

    private func nalUnits(in data: Data) -> [Data] {
        guard data.count >= 5 else { return [] }
        let bytes = [UInt8](data)
        var starts: [(index: Int, length: Int)] = []
        var index = 0

        while index + 3 < bytes.count {
            if bytes[index] == 0, bytes[index + 1] == 0 {
                if bytes[index + 2] == 1 {
                    starts.append((index, 3))
                    index += 3
                    continue
                }
                if bytes[index + 2] == 0, bytes[index + 3] == 1 {
                    starts.append((index, 4))
                    index += 4
                    continue
                }
            }
            index += 1
        }

        guard !starts.isEmpty else { return [data] }
        return starts.enumerated().compactMap { offset, startCode in
            let start = startCode.index + startCode.length
            let end = offset + 1 < starts.count ? starts[offset + 1].index : data.count
            guard end > start else { return nil }
            return data.subdata(in: start..<end)
        }
    }

    private func drainCompleteNALUnits() -> [Data] {
        guard buffer.count >= 5 else { return [] }
        let bytes = [UInt8](buffer)
        var starts: [(index: Int, length: Int)] = []
        var index = 0

        while index + 3 < bytes.count {
            if bytes[index] == 0, bytes[index + 1] == 0 {
                if bytes[index + 2] == 1 {
                    starts.append((index, 3))
                    index += 3
                    continue
                }
                if index + 3 < bytes.count, bytes[index + 2] == 0, bytes[index + 3] == 1 {
                    starts.append((index, 4))
                    index += 4
                    continue
                }
            }
            index += 1
        }

        guard starts.count >= 2 else {
            if let first = starts.first, first.index > 0 {
                buffer.removeSubrange(0..<first.index)
            } else if starts.isEmpty, buffer.count > 2_000_000 {
                buffer.removeAll(keepingCapacity: true)
            }
            return []
        }

        var units: [Data] = []
        for unitIndex in 0..<(starts.count - 1) {
            let start = starts[unitIndex].index + starts[unitIndex].length
            let end = starts[unitIndex + 1].index
            if end > start {
                units.append(buffer.subdata(in: start..<end))
            }
        }

        buffer.removeSubrange(0..<starts[starts.count - 1].index)
        return units
    }

    private func processNALUnit(_ unit: Data, receivedAt: TimeInterval) -> RemoteVideoSample? {
        guard let firstByte = unit.first else { return nil }
        let type = firstByte & 0x1F

        if type == 9 {
            return flushAccessUnit(receivedAt: receivedAt)
        }

        if type == 7 {
            sps = unit
            rebuildFormatDescription()
        } else if type == 8 {
            pps = unit
            rebuildFormatDescription()
        }

        if shouldKeepInAccessUnit(type: type) {
            currentAccessUnit.append(unit)
        }
        return nil
    }

    private func shouldKeepInAccessUnit(type: UInt8) -> Bool {
        switch type {
        case 1, 5, 6, 7, 8:
            return true
        default:
            return !currentAccessUnit.isEmpty
        }
    }

    private func rebuildFormatDescription() {
        guard let sps, let pps else { return }
        sps.withUnsafeBytes { spsBuffer in
            pps.withUnsafeBytes { ppsBuffer in
                guard
                    let spsPointer = spsBuffer.bindMemory(to: UInt8.self).baseAddress,
                    let ppsPointer = ppsBuffer.bindMemory(to: UInt8.self).baseAddress
                else {
                    return
                }
                let pointers: [UnsafePointer<UInt8>] = [spsPointer, ppsPointer]
                let sizes = [sps.count, pps.count]
                var nextDescription: CMFormatDescription?
                let status = pointers.withUnsafeBufferPointer { pointerBuffer in
                    sizes.withUnsafeBufferPointer { sizeBuffer in
                        CMVideoFormatDescriptionCreateFromH264ParameterSets(
                            allocator: kCFAllocatorDefault,
                            parameterSetCount: 2,
                            parameterSetPointers: pointerBuffer.baseAddress!,
                            parameterSetSizes: sizeBuffer.baseAddress!,
                            nalUnitHeaderLength: 4,
                            formatDescriptionOut: &nextDescription
                        )
                    }
                }
                if status == noErr {
                    formatDescription = nextDescription
                }
            }
        }
    }

    private func flushAccessUnit(receivedAt: TimeInterval) -> RemoteVideoSample? {
        let accessUnit = currentAccessUnit
        currentAccessUnit.removeAll(keepingCapacity: true)
        guard
            accessUnit.contains(where: { (($0.first ?? 0) & 0x1F) == 1 || (($0.first ?? 0) & 0x1F) == 5 }),
            let formatDescription
        else {
            return nil
        }

        let startedAt = ProcessInfo.processInfo.systemUptime
        var blockData = Data()
        blockData.reserveCapacity(accessUnit.reduce(0) { $0 + $1.count + 4 })
        for nal in accessUnit {
            var length = UInt32(nal.count).bigEndian
            withUnsafeBytes(of: &length) { blockData.append(contentsOf: $0) }
            blockData.append(nal)
        }

        var blockBuffer: CMBlockBuffer?
        let blockStatus = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault,
            memoryBlock: nil,
            blockLength: blockData.count,
            blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: blockData.count,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard blockStatus == noErr, let blockBuffer else { return nil }

        let replaceStatus = blockData.withUnsafeBytes { bytes in
            CMBlockBufferReplaceDataBytes(
                with: bytes.baseAddress!,
                blockBuffer: blockBuffer,
                offsetIntoDestination: 0,
                dataLength: blockData.count
            )
        }
        guard replaceStatus == noErr else { return nil }

        sampleSequence &+= 1
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 60),
            presentationTimeStamp: CMTime(value: CMTimeValue(sampleSequence), timescale: 60),
            decodeTimeStamp: .invalid
        )
        var sampleSize = blockData.count
        var sampleBuffer: CMSampleBuffer?
        let sampleStatus = CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault,
            dataBuffer: blockBuffer,
            formatDescription: formatDescription,
            sampleCount: 1,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleSizeEntryCount: 1,
            sampleSizeArray: &sampleSize,
            sampleBufferOut: &sampleBuffer
        )
        guard sampleStatus == noErr, let sampleBuffer else { return nil }
        markSampleBufferForImmediateDisplay(sampleBuffer)

        let dimensions = CMVideoFormatDescriptionGetDimensions(formatDescription)
        return RemoteVideoSample(
            sampleBuffer: sampleBuffer,
            pixelSize: CGSize(width: CGFloat(dimensions.width), height: CGFloat(dimensions.height)),
            sequence: sampleSequence,
            packetizeMs: (ProcessInfo.processInfo.systemUptime - startedAt) * 1_000,
            byteCount: blockData.count,
            receivedAt: receivedAt
        )
    }

    private func markSampleBufferForImmediateDisplay(_ sampleBuffer: CMSampleBuffer) {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: true) else {
            return
        }
        let rawDictionary = CFArrayGetValueAtIndex(attachments, 0)
        let dictionary = unsafeBitCast(rawDictionary, to: CFMutableDictionary.self)
        CFDictionarySetValue(
            dictionary,
            Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
            Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
        )
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
