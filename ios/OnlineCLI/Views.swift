import SwiftUI
import AVFoundation
import UIKit

private enum RemoteViewportSettings {
    static let minimumZoom = 1.0
    static let maximumZoom = 24.0
    static let zoomStep = 0.5
    static let doubleTapZoom = 2.75
}

private enum RemoteChromeSpacing {
    static let edgeInset: CGFloat = 2
    static let portraitTabInset: CGFloat = 84
    static let monitorPanelDockGap: CGFloat = 54
}

struct RemoteTelemetrySnapshot: Equatable {
    var state: RemoteConnectionState = .disconnected
    var status = "Remote idle"
    var fps = 0.0
    var latency: Double?
    var frameBytes = 0
    var displaySizeText: String?
    var decodeMs = 0.0
    var renderMs = 0.0
    var droppedFrames = 0
    var receivedFps = 0.0
    var presentedFps = 0.0
    var inputQueueMax: Int?
    var droppedInputEvents = 0

    @MainActor
    init(client: RemoteDesktopClient) {
        let diagnostics = client.renderDiagnostics
        state = client.connectionState
        status = client.statusText
        fps = client.frameFps
        latency = client.frameLatencyMs
        frameBytes = client.frameBytes
        decodeMs = diagnostics.decodeMs
        renderMs = diagnostics.renderMs
        droppedFrames = diagnostics.droppedFrames
        receivedFps = diagnostics.receivedFps
        presentedFps = diagnostics.presentedFps
        inputQueueMax = client.inputQueueMax ?? diagnostics.inputQueueMax
        droppedInputEvents = client.droppedEvents
        if let display = client.displayInfo, let width = display.width, let height = display.height {
            displaySizeText = "\(width)x\(height)"
        }
    }

    init() {}
}

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        TabView {
            ConsoleTabView()
                .tabItem { Label("Console", systemImage: "terminal") }

            RemoteDesktopView()
                .tabItem { Label("Remote", systemImage: "desktopcomputer") }

            ThreadsView()
                .tabItem { Label("Threads", systemImage: "bubble.left.and.text.bubble.right") }

            MetricsView()
                .tabItem { Label("Metrics", systemImage: "chart.bar.xaxis") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .task {
            await app.refreshAll()
        }
    }
}

struct ConsoleTabView: View {
    @Environment(AppModel.self) private var app
    @State private var client = NativeTerminalClient()
    @State private var fullScreen = false
    @State private var terminalFocusToken = 0
    @State private var terminalDismissKeyboardToken = 0
    @State private var terminalKeyboardVisible = false

    var body: some View {
        NavigationStack {
            Group {
                if app.settings.normalizedBaseURL != nil {
                    VStack(spacing: 0) {
                        if !fullScreen {
                            TerminalSessionController(
                                onReconnect: connectActiveTerminal
                            )
                        }

                        if app.activeTerminalSession != nil {
                            NativeTerminalView(
                                client: client,
                                focusToken: $terminalFocusToken,
                                dismissKeyboardToken: $terminalDismissKeyboardToken,
                                keyboardVisible: $terminalKeyboardVisible
                            )
                        } else {
                            ContentUnavailableView(
                                "Create a terminal",
                                systemImage: "terminal",
                                description: Text("No active terminal is selected.")
                            )
                        }
                    }
                } else {
                    ContentUnavailableView("Set a tailnet URL", systemImage: "network.slash")
                }
            }
            .navigationTitle("Console")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ConsoleMoreMenu(
                        connectionText: app.connectionMessage,
                        serverURL: app.settings.baseURLString,
                        terminalConnected: client.connectionState.isConnected,
                        keyboardVisible: terminalKeyboardVisible,
                        onRefresh: {
                            Task {
                                await app.refreshAll()
                                connectActiveTerminal()
                            }
                        },
                        onReconnect: connectActiveTerminal,
                        onToggleConnection: {
                            if client.connectionState.isConnected {
                                client.disconnect()
                            } else {
                                connectActiveTerminal()
                            }
                        },
                        onNewPowerShell: {
                            Task {
                                await app.createSession(profile: .powershell)
                                connectActiveTerminal()
                            }
                        },
                        onHideKeyboard: {
                            terminalDismissKeyboardToken += 1
                        }
                    )
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if terminalKeyboardVisible {
                        Button {
                            terminalDismissKeyboardToken += 1
                        } label: {
                            Image(systemName: "keyboard.chevron.compact.down")
                        }
                        .accessibilityLabel("Hide terminal keyboard")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        fullScreen.toggle()
                    } label: {
                        Image(systemName: fullScreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                    }
                    .accessibilityLabel(fullScreen ? "Exit terminal fullscreen" : "Enter terminal fullscreen")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        if client.connectionState.isConnected {
                            client.disconnect()
                        } else {
                            connectActiveTerminal()
                        }
                    } label: {
                        Image(systemName: client.connectionState.isConnected ? "stop.fill" : "play.fill")
                    }
                    .accessibilityLabel(client.connectionState.isConnected ? "Disconnect terminal" : "Connect terminal")
                }
            }
            .task {
                await app.refreshSessions()
                connectActiveTerminal()
            }
            .onChange(of: app.activeTerminalSessionId) { _, _ in
                connectActiveTerminal()
            }
            .onChange(of: app.settings.baseURLString) { _, _ in
                Task { await app.refreshSessions() }
                connectActiveTerminal()
            }
        }
    }

    private func connectActiveTerminal() {
        guard let url = app.settings.normalizedBaseURL, let session = app.activeTerminalSession else {
            client.disconnect()
            return
        }
        client.connect(baseURL: url, session: session)
    }
}

struct ConsoleMoreMenu: View {
    let connectionText: String
    let serverURL: String
    let terminalConnected: Bool
    let keyboardVisible: Bool
    let onRefresh: () -> Void
    let onReconnect: () -> Void
    let onToggleConnection: () -> Void
    let onNewPowerShell: () -> Void
    let onHideKeyboard: () -> Void

    var body: some View {
        Menu {
            Button {} label: {
                Label(connectionText, systemImage: connectionIcon)
            }
            .disabled(true)

            Button {
                onRefresh()
            } label: {
                Label("Refresh Server", systemImage: "arrow.clockwise")
            }

            Button {
                onReconnect()
            } label: {
                Label("Reconnect Console", systemImage: "terminal")
            }

            Button {
                onToggleConnection()
            } label: {
                Label(terminalConnected ? "Disconnect Console" : "Connect Console", systemImage: terminalConnected ? "stop.fill" : "play.fill")
            }

            Button {
                onNewPowerShell()
            } label: {
                Label("New PowerShell", systemImage: "plus")
            }

            if keyboardVisible {
                Button {
                    onHideKeyboard()
                } label: {
                    Label("Hide Keyboard", systemImage: "keyboard.chevron.compact.down")
                }
            }

            Button {
                UIPasteboard.general.string = serverURL
            } label: {
                Label("Copy Server URL", systemImage: "doc.on.doc")
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 16, weight: .bold))
                .frame(width: 44, height: 44)
                .contentShape(Circle())
                .nativeGlass(cornerRadius: 22, interactive: true)
        }
        .accessibilityLabel("Console options")
    }

    private var connectionIcon: String {
        connectionText == "Connected" ? "checkmark.circle.fill" : "exclamationmark.triangle"
    }
}

struct TerminalSessionController: View {
    @Environment(AppModel.self) private var app
    let onReconnect: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Menu {
                ForEach(app.sessions) { session in
                    Button {
                        app.selectTerminalSession(session.id)
                        onReconnect()
                    } label: {
                        Label(session.displayName, systemImage: "terminal")
                    }
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "terminal")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(app.activeTerminalSession?.displayName ?? "No terminal")
                            .font(.subheadline.weight(.semibold))
                        Text(activeTerminalDetail)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .nativeGlass(cornerRadius: 8, interactive: true)
            }

            HStack(spacing: 8) {
                Button {
                    Task {
                        await app.createSession(profile: .powershell)
                        onReconnect()
                    }
                } label: {
                    Label("New PowerShell", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .disabled(app.api == nil)

                Button {
                    guard let session = app.activeTerminalSession else { return }
                    Task {
                        await app.restartSession(session)
                        onReconnect()
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Restart terminal")
                .disabled(app.activeTerminalSession == nil)

                Button(role: .destructive) {
                    guard let session = app.activeTerminalSession else { return }
                    Task {
                        await app.deleteSession(session)
                        onReconnect()
                    }
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("End terminal")
                .disabled(app.sessions.count <= 1)

                Spacer()

                Text("\(app.sessions.count) terminals")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var activeTerminalDetail: String {
        guard let session = app.activeTerminalSession else {
            return "PowerShell default"
        }
        let cwd = session.cwd ?? "home"
        return "\(session.profileLabel) • \(session.backendLabel) • \(cwd)"
    }
}

struct RemoteDesktopView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var client = RemoteDesktopClient()
    @State private var desiredMode: RemoteMode = .view
    @State private var streamProfile: RemoteStreamProfile = .balanced
    @State private var gestureMode: RemoteGestureMode = .direct
    @State private var zoom = 1.0
    @State private var panOffset = CGSize.zero
    @State private var joystickSensitivity = 1.0
    @State private var controlsCollapsed = true
    @State private var controlsOffset = CGSize.zero
    @State private var interfaceIsLandscape = false
    @State private var keyboardHeight: CGFloat = 0
    @State private var telemetry = RemoteTelemetrySnapshot()
    @State private var monitorPanelPresented = false
    @State private var monitorDragMode = false
    @State private var monitorLayoutOffsets: [String: CGSize] = [:]
    @State private var selectedMonitorIds: Set<String> = []
    @State private var remoteKeyboardVisible = false
    @State private var remoteKeyboardFocusToken = 0
    @State private var remoteKeyboardDismissToken = 0
    private let telemetryTicker = Timer.publish(every: 0.33, on: .main, in: .common).autoconnect()

    var body: some View {
        NavigationStack {
            GeometryReader { proxy in
                let isLandscape = proxy.size.width > proxy.size.height || verticalSizeClass == .compact || interfaceIsLandscape
                let useLandscapeEdgeOutsets = isLandscape && keyboardHeight <= 0
                let leadingChromeOutset = useLandscapeEdgeOutsets ? edgeOutset(proxy.safeAreaInsets.leading) : 0
                let trailingChromeOutset = useLandscapeEdgeOutsets ? edgeOutset(proxy.safeAreaInsets.trailing) : 0
                let bottomChromeOutset = isLandscape && keyboardHeight <= 0 ? edgeOutset(proxy.safeAreaInsets.bottom) : 0
                ZStack {
                    Color.black.ignoresSafeArea()

                    RemoteKeyboardBridge(
                        client: client,
                        focusToken: $remoteKeyboardFocusToken,
                        dismissToken: $remoteKeyboardDismissToken,
                        keyboardVisible: $remoteKeyboardVisible
                    )
                    .frame(width: max(44, proxy.size.width), height: max(44, proxy.size.height))
                    .accessibilityHidden(true)

                    RemoteStageHost(
                        client: client,
                        zoom: $zoom,
                        panOffset: $panOffset,
                        controlMode: desiredMode == .control,
                        gestureMode: gestureMode,
                        interactionEnabled: !(monitorPanelPresented && monitorDragMode),
                        displayInfo: client.displayInfo,
                        monitors: availableMonitors,
                        selectedMonitorIds: effectiveSelectedMonitorIds,
                        monitorLayoutOffsets: monitorLayoutOffsets
                    )
                    .allowsHitTesting(!(monitorPanelPresented && monitorDragMode))
                    .ignoresSafeArea(edges: .bottom)

                    VStack {
                        Spacer()
                        RemoteDiagnosticsOverlay(telemetry: telemetry)
                            .padding(.bottom, quickDockBottomInset(isLandscape: isLandscape) + 58)
                    }
                    .allowsHitTesting(false)
                    .zIndex(10)

                    VStack(spacing: 0) {
                        HStack {
                            RemoteTopOverlay(
                                telemetry: telemetry,
                                mode: $desiredMode,
                                profile: $streamProfile,
                                gestureMode: $gestureMode,
                                compact: true,
                                onConnect: connect,
                                onDisconnect: disconnect,
                                onModeChange: setRemoteMode,
                                onProfileChange: { profile in
                                    streamProfile = profile
                                    app.settings.remoteStreamProfile = profile
                                    client.setStreamProfile(profile)
                                    refreshTelemetry()
                                }
                            )
                            .frame(maxWidth: min(isLandscape ? 300 : 360, proxy.size.width - (RemoteChromeSpacing.edgeInset * 2)))
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, RemoteChromeSpacing.edgeInset)
                        .padding(.top, RemoteChromeSpacing.edgeInset)

                        Spacer()
                    }

                    if monitorPanelPresented {
                        VStack {
                            Spacer()
                            HStack {
                                Spacer(minLength: 0)
                                RemoteMonitorPanel(
                                    monitors: availableMonitors,
                                    selectedMonitorIds: $selectedMonitorIds,
                                    dragMode: $monitorDragMode,
                                    layoutOffsets: $monitorLayoutOffsets,
                                    onSelectionChange: applyMonitorSelection,
                                    onLayoutChange: applyMonitorLayout,
                                    onResetViews: resetMonitorViews
                                )
                                .frame(width: min(isLandscape ? 310 : 340, proxy.size.width - (RemoteChromeSpacing.edgeInset * 2)))
                                .padding(.trailing, RemoteChromeSpacing.edgeInset)
                                .padding(.bottom, quickDockBottomInset(isLandscape: isLandscape) + RemoteChromeSpacing.monitorPanelDockGap)
                                .offset(x: trailingChromeOutset, y: bottomChromeOutset)
                            }
                        }
                        .transition(.opacity)
                        .zIndex(40)
                    }

                    FloatingRemoteControls(
                        client: client,
                        zoom: $zoom,
                        panOffset: $panOffset,
                        joystickSensitivity: $joystickSensitivity,
                        isCollapsed: $controlsCollapsed,
                        offset: $controlsOffset,
                        containerSize: proxy.size,
                        compact: isLandscape,
                        diagnosticsText: diagnosticsText,
                        actions: app.remoteCapabilities?.actions ?? [],
                        keyboardVisible: remoteKeyboardVisible,
                        onKeyboardFocus: focusRemoteKeyboard,
                        anchor: .leading
                    )
                    .padding(RemoteChromeSpacing.edgeInset)
                    .offset(x: -leadingChromeOutset, y: bottomChromeOutset)

                    VStack {
                        Spacer()
                        HStack {
                            Spacer(minLength: 0)
                            RemoteQuickDock(
                                mode: desiredMode,
                                monitorActive: monitorPanelPresented,
                                monitorCount: availableMonitors.count,
                                keyboardFocused: remoteKeyboardVisible,
                                onControlToggle: toggleControlMode,
                                onMonitorToggle: toggleMonitorPanel,
                                onKeyboardToggle: toggleRemoteKeyboard
                            )
                        }
                        .padding(.trailing, RemoteChromeSpacing.edgeInset)
                        .padding(.bottom, quickDockBottomInset(isLandscape: isLandscape))
                        .offset(x: trailingChromeOutset, y: bottomChromeOutset)
                    }

                }
                .ignoresSafeArea(.keyboard, edges: .bottom)
                .toolbar(isLandscape ? .hidden : .visible, for: .navigationBar)
                .toolbar(isLandscape ? .hidden : .visible, for: .tabBar)
            }
            .navigationTitle("Remote")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task {
                            await app.refreshRemoteStatus()
                            await app.refreshRemoteCapabilities()
                        }
                    } label: {
                        Image(systemName: "bolt.horizontal.circle")
                    }
                    .accessibilityLabel("Refresh remote status")
                }
            }
            .onAppear {
                desiredMode = app.settings.defaultRemoteMode
                streamProfile = app.settings.remoteStreamProfile
                updateInterfaceOrientation()
                refreshTelemetry()
                Task {
                    await app.refreshRemoteStatus()
                    await app.refreshRemoteCapabilities()
                    reconcileMonitorSelection(availableMonitors)
                }
            }
            .onChange(of: client.monitors) { _, monitors in
                reconcileMonitorSelection(monitors)
            }
            .onReceive(NotificationCenter.default.publisher(for: UIDevice.orientationDidChangeNotification)) { _ in
                updateInterfaceOrientation()
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { notification in
                updateKeyboardHeight(notification)
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { notification in
                updateKeyboardHeight(notification)
            }
            .onReceive(telemetryTicker) { _ in
                refreshTelemetry()
            }
            .onDisappear {
                disconnect()
            }
        }
    }

    private func connect() {
        guard let url = app.settings.normalizedBaseURL else {
            client.connectionState = .failed("Set a tailnet URL")
            return
        }
        client.connect(
            baseURL: url,
            desiredMode: desiredMode,
            streamProfile: streamProfile,
            visibleMonitorIds: effectiveSelectedMonitorIds,
            monitorLayoutOffsets: monitorLayoutOffsets
        )
        refreshTelemetry()
    }

    private func disconnect() {
        client.disconnect()
        dismissRemoteKeyboard()
        refreshTelemetry()
    }

    private func setRemoteMode(_ mode: RemoteMode) {
        desiredMode = mode
        if mode != .control {
            dismissRemoteKeyboard()
        }
        client.setMode(mode)
        refreshTelemetry()
    }

    private func toggleControlMode() {
        setRemoteMode(desiredMode == .control ? .view : .control)
    }

    private func toggleMonitorPanel() {
        monitorPanelPresented.toggle()
        if monitorPanelPresented {
            reconcileMonitorSelection(availableMonitors)
            if availableMonitors.isEmpty {
                Task {
                    await app.refreshRemoteStatus()
                    await app.refreshRemoteCapabilities()
                    reconcileMonitorSelection(availableMonitors)
                }
            }
        }
    }

    private func applyMonitorSelection(_ monitorIds: Set<String>) {
        let availableIds = Set(availableMonitors.map(\.id))
        let nextIds = monitorIds.intersection(availableIds)
        selectedMonitorIds = nextIds.isEmpty ? availableIds : nextIds
        client.setVisibleMonitors(selectedMonitorIds)
    }

    private func resetMonitorViews() {
        monitorLayoutOffsets = [:]
        client.setMonitorLayoutOffsets([:])
    }

    private func applyMonitorLayout(_ offsets: [String: CGSize]) {
        monitorLayoutOffsets = offsets.filter { _, offset in
            abs(offset.width) >= 0.5 || abs(offset.height) >= 0.5
        }
        client.setMonitorLayoutOffsets(monitorLayoutOffsets)
    }

    private func reconcileMonitorSelection(_ monitors: [RemoteMonitorDescriptor]) {
        let availableIds = Set(monitors.map(\.id))
        guard !availableIds.isEmpty else { return }
        let current = selectedMonitorIds.intersection(availableIds)
        if current.isEmpty || current.count != selectedMonitorIds.count {
            selectedMonitorIds = current.isEmpty ? availableIds : current
        }
    }

    private func focusRemoteKeyboard() {
        if desiredMode != .control {
            setRemoteMode(.control)
        }
        remoteKeyboardFocusToken += 1
    }

    private func toggleRemoteKeyboard() {
        if remoteKeyboardVisible {
            dismissRemoteKeyboard()
        } else {
            focusRemoteKeyboard()
        }
    }

    private func dismissRemoteKeyboard() {
        remoteKeyboardVisible = false
        remoteKeyboardDismissToken += 1
    }

    private func refreshTelemetry() {
        let next = RemoteTelemetrySnapshot(client: client)
        if telemetry != next {
            telemetry = next
        }
        if client.isConnected, streamProfile != client.streamProfile {
            streamProfile = client.streamProfile
        }
    }

    private func updateInterfaceOrientation() {
        interfaceIsLandscape = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.interfaceOrientation }
            .first?
            .isLandscape == true
    }

    private func quickDockBottomInset(isLandscape: Bool) -> CGFloat {
        if keyboardHeight > 0 {
            return keyboardHeight + RemoteChromeSpacing.edgeInset
        }
        return isLandscape ? RemoteChromeSpacing.edgeInset : RemoteChromeSpacing.portraitTabInset
    }

    private func edgeOutset(_ safeInset: CGFloat) -> CGFloat {
        max(0, safeInset - RemoteChromeSpacing.edgeInset)
    }

    private func updateKeyboardHeight(_ notification: Notification) {
        guard let endFrame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else {
            keyboardHeight = 0
            return
        }

        let screenHeight = UIScreen.main.bounds.height
        let nextHeight = max(0, screenHeight - endFrame.minY)
        let duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        withAnimation(.easeOut(duration: duration)) {
            keyboardHeight = nextHeight > 12 ? nextHeight : 0
        }
    }

    private var diagnosticsText: String {
        let queue = telemetry.inputQueueMax.map { "q \($0)" } ?? "q --"
        let rate = client.inputRateLimitPerSec.map { "\($0)/s" } ?? "--/s"
        return String(
            format: "rx %.1f • draw %.1f • dec %.1fms • render %.1fms • drop %d • input %@ %@/%d",
            telemetry.receivedFps,
            telemetry.presentedFps,
            telemetry.decodeMs,
            telemetry.renderMs,
            telemetry.droppedFrames,
            queue,
            rate,
            telemetry.droppedInputEvents
        )
    }

    private var availableMonitors: [RemoteMonitorDescriptor] {
        if !client.monitors.isEmpty {
            return client.monitors
        }
        if let monitors = app.remoteCapabilities?.monitors, !monitors.isEmpty {
            return monitors
        }
        if let displays = app.remoteStatus?.sidecar.health?.displays, !displays.isEmpty {
            return displays
        }
        return []
    }

    private var effectiveSelectedMonitorIds: Set<String> {
        let availableIds = Set(availableMonitors.map(\.id))
        guard !availableIds.isEmpty else { return [] }
        let current = selectedMonitorIds.intersection(availableIds)
        return current.isEmpty ? availableIds : current
    }
}

struct RemoteStageHost: View {
    let client: RemoteDesktopClient
    @Binding var zoom: Double
    @Binding var panOffset: CGSize
    let controlMode: Bool
    let gestureMode: RemoteGestureMode
    let interactionEnabled: Bool
    let displayInfo: RemoteDisplayInfo?
    let monitors: [RemoteMonitorDescriptor]
    let selectedMonitorIds: Set<String>
    let monitorLayoutOffsets: [String: CGSize]

    var body: some View {
        RemoteStageSurface(
            client: client,
            zoom: $zoom,
            panOffset: $panOffset,
            controlMode: controlMode,
            gestureMode: gestureMode,
            interactionEnabled: interactionEnabled,
            displayInfo: displayInfo,
            monitors: monitors,
            selectedMonitorIds: selectedMonitorIds,
            monitorLayoutOffsets: monitorLayoutOffsets,
            onClick: { point in client.sendClick(at: point) },
            onRightClick: { point in client.sendClick(button: "right", at: point) },
            onPointerMove: { point in client.sendPointerMove(point) },
            onDragStart: { point in client.beginDrag(at: point) },
            onDragMove: { point in client.updateDrag(to: point) },
            onDragEnd: { point in client.endDrag(at: point) }
        )
    }
}

private struct RemoteStageSurface: UIViewRepresentable {
    let client: RemoteDesktopClient
    @Binding var zoom: Double
    @Binding var panOffset: CGSize
    let controlMode: Bool
    let gestureMode: RemoteGestureMode
    let interactionEnabled: Bool
    let displayInfo: RemoteDisplayInfo?
    let monitors: [RemoteMonitorDescriptor]
    let selectedMonitorIds: Set<String>
    let monitorLayoutOffsets: [String: CGSize]
    let onClick: (CGPoint) -> Void
    let onRightClick: (CGPoint) -> Void
    let onPointerMove: (CGPoint) -> Void
    let onDragStart: (CGPoint) -> Void
    let onDragMove: (CGPoint) -> Void
    let onDragEnd: (CGPoint) -> Void

    func makeUIView(context: Context) -> RemoteStageSurfaceView {
        let view = RemoteStageSurfaceView()
        attachSinks(to: view)
        return view
    }

    func updateUIView(_ uiView: RemoteStageSurfaceView, context: Context) {
        let zoomBinding = $zoom
        let panOffsetBinding = $panOffset

        attachSinks(to: uiView)
        uiView.configure(
            zoom: zoom,
            panOffset: panOffset,
            controlMode: controlMode,
            gestureMode: gestureMode,
            interactionEnabled: interactionEnabled,
            displayInfo: displayInfo,
            monitors: monitors,
            selectedMonitorIds: selectedMonitorIds,
            monitorLayoutOffsets: monitorLayoutOffsets,
            onZoomChange: { zoomBinding.wrappedValue = $0 },
            onPanOffsetChange: { panOffsetBinding.wrappedValue = $0 },
            onClick: onClick,
            onRightClick: onRightClick,
            onPointerMove: onPointerMove,
            onDragStart: onDragStart,
            onDragMove: onDragMove,
            onDragEnd: onDragEnd,
            onFramePresented: { client.recordFramePresented(renderMs: $0) }
        )
        uiView.setFrame(RemoteFrameRenderUpdate(
            image: client.frameImage,
            pixelSize: client.desktopSize,
            sequence: client.frameSequence,
            decodeMs: client.renderDiagnostics.decodeMs,
            receivedAt: ProcessInfo.processInfo.systemUptime
        ))
        uiView.setRemoteCursor(client.remoteCursor)
    }

    private func attachSinks(to view: RemoteStageSurfaceView) {
        client.frameSink = { [weak view] update in
            view?.setFrame(update)
        }
        client.videoSink = { [weak view] update in
            view?.setVideoFrame(update)
        }
        client.cursorSink = { [weak view] point in
            view?.setRemoteCursor(point)
        }
    }
}

private final class RemoteStageSurfaceView: UIView, UIGestureRecognizerDelegate {
    private final class MonitorLayers {
        let imageLayer = CALayer()
        let videoContainerLayer = CALayer()
        let videoLayer = AVSampleBufferDisplayLayer()
        let strokeLayer = CAShapeLayer()
        let labelBackgroundLayer = CAShapeLayer()
        let textLayer = CATextLayer()

        init(contentParent: CALayer, overlayParent: CALayer, contentsScale: CGFloat) {
            imageLayer.contentsGravity = .resize
            imageLayer.magnificationFilter = .linear
            imageLayer.minificationFilter = .linear
            imageLayer.contentsScale = contentsScale
            videoContainerLayer.masksToBounds = true
            videoContainerLayer.contentsScale = contentsScale
            videoContainerLayer.isHidden = true
            videoLayer.videoGravity = .resize
            videoLayer.backgroundColor = UIColor.black.cgColor
            videoLayer.contentsScale = contentsScale
            textLayer.contentsScale = contentsScale
            textLayer.alignmentMode = .center
            textLayer.truncationMode = .end
            textLayer.isWrapped = false
            contentParent.addSublayer(imageLayer)
            contentParent.addSublayer(videoContainerLayer)
            videoContainerLayer.addSublayer(videoLayer)
            overlayParent.addSublayer(strokeLayer)
            overlayParent.addSublayer(labelBackgroundLayer)
            overlayParent.addSublayer(textLayer)
        }

        func removeFromSuperlayer() {
            imageLayer.removeFromSuperlayer()
            videoContainerLayer.removeFromSuperlayer()
            strokeLayer.removeFromSuperlayer()
            labelBackgroundLayer.removeFromSuperlayer()
            textLayer.removeFromSuperlayer()
        }
    }

    private struct StageGeometry {
        let sourceBounds: CGRect
        let visualBounds: CGRect
        let visualFrame: CGRect
        let monitorFrames: [RemoteMonitorStageFrame]
        let usesMonitorLayers: Bool
    }

    private let imageView = UIView()
    private let videoLayer = AVSampleBufferDisplayLayer()
    private let placeholderView = UIStackView()
    private let placeholderIcon = UIImageView(image: UIImage(systemName: "display.trianglebadge.exclamationmark"))
    private let placeholderLabel = UILabel()
    private let monitorContentLayer = CALayer()
    private let monitorOverlayLayer = CALayer()
    private let cursorView = UIImageView(image: UIImage(systemName: "cursorarrow"))

    private var renderedSequence: UInt64?
    private var renderedVideoSequence: UInt64?
    private var presentedSequence: UInt64?
    private var presentedVideoSequence: UInt64?
    private var latestImage: CGImage?
    private var videoActive = false
    private var desktopSize = CGSize(width: 1280, height: 720)
    private var remoteCursor: CGPoint?
    private var zoomValue = RemoteViewportSettings.minimumZoom
    private var panOffsetValue = CGSize.zero
    private var controlMode = false
    private var gestureMode = RemoteGestureMode.direct
    private var displayInfo: RemoteDisplayInfo?
    private var monitors: [RemoteMonitorDescriptor] = []
    private var selectedMonitorIds: Set<String> = []
    private var monitorLayoutOffsets: [String: CGSize] = [:]
    private var monitorLayers: [String: MonitorLayers] = [:]

    private var onZoomChange: ((Double) -> Void)?
    private var onPanOffsetChange: ((CGSize) -> Void)?
    private var onClick: ((CGPoint) -> Void)?
    private var onRightClick: ((CGPoint) -> Void)?
    private var onPointerMove: ((CGPoint) -> Void)?
    private var onDragStart: ((CGPoint) -> Void)?
    private var onDragMove: ((CGPoint) -> Void)?
    private var onDragEnd: ((CGPoint) -> Void)?
    private var onFramePresented: ((Double) -> Void)?

    private weak var twoFingerPanRecognizer: UIPanGestureRecognizer?
    private weak var pinchRecognizer: UIPinchGestureRecognizer?
    private weak var longPressRecognizer: UILongPressGestureRecognizer?
    private weak var trackedTouch: UITouch?
    private var touchStartLocation = CGPoint.zero
    private var touchStartUptime: TimeInterval = 0
    private var touchStartPoint: CGPoint?
    private var touchLastPoint: CGPoint?
    private var trackpadStartCursor: CGPoint?
    private var longPressConsumed = false
    private var touchMovedBeyondLongPress = false
    private var singleFingerViewportPanActive = false
    private var remoteDragActive = false
    private var initialPanOffset = CGSize.zero
    private var initialZoom = RemoteViewportSettings.minimumZoom
    private var initialPinchLocation = CGPoint.zero
    private let dragActivationDistance: CGFloat = 4
    private let longPressMinimumDuration: TimeInterval = 0.60
    private let longPressMovementLimit: CGFloat = 6
    private var hasRenderableFrame: Bool {
        latestImage != nil || videoActive
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        commonInit()
    }

    required init?(coder: NSCoder) {
        nil
    }

    func configure(
        zoom: Double,
        panOffset: CGSize,
        controlMode: Bool,
        gestureMode: RemoteGestureMode,
        interactionEnabled: Bool,
        displayInfo: RemoteDisplayInfo?,
        monitors: [RemoteMonitorDescriptor],
        selectedMonitorIds: Set<String>,
        monitorLayoutOffsets: [String: CGSize],
        onZoomChange: @escaping (Double) -> Void,
        onPanOffsetChange: @escaping (CGSize) -> Void,
        onClick: @escaping (CGPoint) -> Void,
        onRightClick: @escaping (CGPoint) -> Void,
        onPointerMove: @escaping (CGPoint) -> Void,
        onDragStart: @escaping (CGPoint) -> Void,
        onDragMove: @escaping (CGPoint) -> Void,
        onDragEnd: @escaping (CGPoint) -> Void,
        onFramePresented: @escaping (Double) -> Void
    ) {
        var needsLayout = false
        let nextZoom = clampedZoom(zoom)
        if abs(nextZoom - zoomValue) > 0.0001 {
            zoomValue = nextZoom
            needsLayout = true
        }

        let nextPanOffset = clampedPanOffset(panOffset)
        if nextPanOffset != panOffsetValue {
            panOffsetValue = nextPanOffset
            needsLayout = true
        }

        if self.controlMode != controlMode {
            self.controlMode = controlMode
        }
        if self.gestureMode != gestureMode {
            self.gestureMode = gestureMode
            cancelTrackedTouch()
        }

        if isUserInteractionEnabled != interactionEnabled {
            isUserInteractionEnabled = interactionEnabled
            if !interactionEnabled {
                cancelTrackedTouch()
            }
        }

        if self.displayInfo != displayInfo {
            self.displayInfo = displayInfo
            needsLayout = true
        }
        if self.monitors != monitors {
            self.monitors = monitors
            needsLayout = true
        }
        if self.selectedMonitorIds != selectedMonitorIds {
            self.selectedMonitorIds = selectedMonitorIds
            needsLayout = true
        }
        if self.monitorLayoutOffsets != monitorLayoutOffsets {
            self.monitorLayoutOffsets = monitorLayoutOffsets
            needsLayout = true
        }

        self.onZoomChange = onZoomChange
        self.onPanOffsetChange = onPanOffsetChange
        self.onClick = onClick
        self.onRightClick = onRightClick
        self.onPointerMove = onPointerMove
        self.onDragStart = onDragStart
        self.onDragMove = onDragMove
        self.onDragEnd = onDragEnd
        self.onFramePresented = onFramePresented

        if needsLayout {
            setNeedsLayout()
        }
    }

    func setFrame(_ update: RemoteFrameRenderUpdate) {
        guard renderedSequence != update.sequence else { return }
        renderedSequence = update.sequence
        if update.image != nil, videoActive {
            videoActive = false
            flushVideoLayer(removeImage: true)
            videoLayer.isHidden = true
            hideMonitorVideoLayers()
        }
        latestImage = update.image
        desktopSize = update.pixelSize
        imageView.layer.contents = update.image
        if update.image == nil, !videoActive {
            flushVideoLayer(removeImage: true)
            videoLayer.isHidden = true
        }
        placeholderView.isHidden = hasRenderableFrame
        cursorView.isHidden = !hasRenderableFrame || remoteCursor == nil
        setNeedsLayout()
    }

    func setVideoFrame(_ update: RemoteVideoRenderUpdate) {
        guard renderedVideoSequence != update.sequence else { return }
        let renderStartedAt = CACurrentMediaTime()
        renderedVideoSequence = update.sequence
        guard let sampleBuffer = update.sampleBuffer else {
            videoActive = false
            flushVideoLayer(removeImage: true)
            videoLayer.isHidden = true
            placeholderView.isHidden = latestImage != nil
            cursorView.isHidden = latestImage == nil || remoteCursor == nil
            setNeedsLayout()
            return
        }

        let wasVideoActive = videoActive
        let previousDesktopSize = desktopSize
        latestImage = nil
        imageView.layer.contents = nil
        videoActive = true
        desktopSize = update.pixelSize
        placeholderView.isHidden = true
        cursorView.isHidden = remoteCursor == nil

        let geometryChanged = !wasVideoActive
            || previousDesktopSize != update.pixelSize
            || videoLayer.isHidden
            || placeholderView.frame != bounds
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let geometry = stageGeometry(panOffset: panOffsetValue, zoom: zoomValue), geometry.usesMonitorLayers {
            videoLayer.isHidden = true
            monitorContentLayer.isHidden = false
            updateMonitorVideoLayers(geometry: geometry, sampleBuffer: sampleBuffer)
            updateMonitorOverlay(frames: geometry.monitorFrames)
        } else {
            hideMonitorVideoLayers()
            monitorContentLayer.isHidden = true
            enqueue(sampleBuffer, on: videoLayer)
        }
        CATransaction.commit()
        if geometryChanged {
            setNeedsLayout()
        }
        if renderedVideoSequence != presentedVideoSequence {
            presentedVideoSequence = renderedVideoSequence
            onFramePresented?((CACurrentMediaTime() - renderStartedAt) * 1_000)
        }
    }

    func setRemoteCursor(_ point: CGPoint?) {
        guard remoteCursor != point else { return }
        remoteCursor = point
        cursorView.isHidden = !hasRenderableFrame || point == nil
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let renderStartedAt = CACurrentMediaTime()
        CATransaction.begin()
        CATransaction.setDisableActions(true)

        placeholderView.frame = bounds
        monitorContentLayer.frame = bounds
        monitorOverlayLayer.frame = bounds

        if let geometry = stageGeometry(panOffset: panOffsetValue, zoom: zoomValue), hasRenderableFrame {
            if videoActive {
                imageView.isHidden = true
                hideMonitorImageLayers()
                if geometry.usesMonitorLayers {
                    videoLayer.isHidden = true
                    monitorContentLayer.isHidden = false
                    updateMonitorVideoLayers(geometry: geometry)
                } else {
                    monitorContentLayer.isHidden = true
                    hideMonitorVideoLayers()
                    videoLayer.isHidden = false
                    videoLayer.frame = pixelAligned(geometry.visualFrame)
                    videoLayer.contentsRect = CGRect(x: 0, y: 0, width: 1, height: 1)
                }
                updateMonitorOverlay(frames: geometry.monitorFrames)
            } else if let image = latestImage {
                videoLayer.isHidden = true
                hideMonitorVideoLayers()
                imageView.isHidden = geometry.usesMonitorLayers
                monitorContentLayer.isHidden = !geometry.usesMonitorLayers
                if geometry.usesMonitorLayers {
                    updateMonitorLayers(geometry: geometry, image: image)
                } else {
                    hideMonitorImageLayers()
                    imageView.layer.contents = image
                    imageView.frame = pixelAligned(geometry.visualFrame)
                    updateMonitorOverlay(frames: geometry.monitorFrames)
                }
            }
            updateCursor(geometry: geometry)
        } else {
            imageView.isHidden = true
            imageView.layer.contents = nil
            videoLayer.isHidden = true
            hideMonitorImageLayers()
            monitorContentLayer.isHidden = true
            monitorOverlayLayer.isHidden = true
            cursorView.isHidden = true
        }

        CATransaction.commit()

        if latestImage != nil, renderedSequence != presentedSequence {
            presentedSequence = renderedSequence
            onFramePresented?((CACurrentMediaTime() - renderStartedAt) * 1_000)
        } else if videoActive, renderedVideoSequence != presentedVideoSequence {
            presentedVideoSequence = renderedVideoSequence
            onFramePresented?((CACurrentMediaTime() - renderStartedAt) * 1_000)
        }
    }

    @objc private func handleSingleTap(_ recognizer: UITapGestureRecognizer) {
        guard isUserInteractionEnabled, recognizer.state == .ended, controlMode, gestureMode == .trackpad else { return }
        guard let normalized = normalizedPoint(for: recognizer.location(in: self)) else { return }
        onClick?(normalized)
    }

    @objc private func handleDoubleTap(_ recognizer: UITapGestureRecognizer) {
        guard isUserInteractionEnabled, recognizer.state == .ended, hasRenderableFrame, gestureMode == .viewport else { return }
        if zoomValue > 1.01 {
            setViewport(zoom: RemoteViewportSettings.minimumZoom, panOffset: .zero, notify: true)
            return
        }

        let targetZoom = clampedZoom(RemoteViewportSettings.doubleTapZoom)
        let pan = anchoredPanOffset(
            from: panOffsetValue,
            oldZoom: zoomValue,
            newZoom: targetZoom,
            anchor: recognizer.location(in: self)
        )
        setViewport(zoom: targetZoom, panOffset: pan, notify: true)
    }

    @objc private func handleLongPress(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began else { return }
        guard isUserInteractionEnabled, controlMode, gestureMode != .viewport, hasRenderableFrame else { return }
        guard let trackedTouch else { return }
        guard !touchMovedBeyondLongPress, !singleFingerViewportPanActive, !remoteDragActive else { return }

        let location = trackedTouch.location(in: self)
        guard distance(from: touchStartLocation, to: location) <= longPressMovementLimit else { return }
        guard ProcessInfo.processInfo.systemUptime - touchStartUptime >= longPressMinimumDuration - 0.03 else { return }

        let target = gestureMode == .trackpad
            ? (remoteCursor ?? touchLastPoint ?? trackpadStartCursor ?? normalizedPoint(for: location))
            : (normalizedPoint(for: location) ?? touchLastPoint ?? touchStartPoint)
        guard let target else { return }

        longPressConsumed = true
        onRightClick?(target)
    }

    @objc private func handleTwoFingerPan(_ recognizer: UIPanGestureRecognizer) {
        guard isUserInteractionEnabled, hasRenderableFrame else { return }

        switch recognizer.state {
        case .began:
            initialPanOffset = panOffsetValue
        case .changed:
            let translation = recognizer.translation(in: self)
            setViewport(
                zoom: zoomValue,
                panOffset: CGSize(
                    width: initialPanOffset.width + translation.x,
                    height: initialPanOffset.height + translation.y
                ),
                notify: true
            )
        case .ended, .cancelled, .failed:
            initialPanOffset = panOffsetValue
        default:
            break
        }
    }

    @objc private func handlePinch(_ recognizer: UIPinchGestureRecognizer) {
        guard isUserInteractionEnabled, hasRenderableFrame else { return }

        switch recognizer.state {
        case .began:
            initialZoom = zoomValue
            initialPanOffset = panOffsetValue
            initialPinchLocation = recognizer.location(in: self)
        case .changed:
            let nextZoom = clampedZoom(initialZoom * recognizer.scale)
            let nextPan = anchoredPanOffset(
                from: initialPanOffset,
                oldZoom: initialZoom,
                newZoom: nextZoom,
                anchor: initialPinchLocation
            )
            setViewport(zoom: nextZoom, panOffset: nextPan, notify: true)
        case .ended, .cancelled, .failed:
            setViewport(zoom: zoomValue, panOffset: panOffsetValue, notify: true)
        default:
            break
        }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesBegan(touches, with: event)
        guard isUserInteractionEnabled, hasRenderableFrame, trackedTouch == nil else { return }
        guard activeTouchCount(in: event) == 1, let touch = touches.first else { return }

        trackedTouch = touch
        touchStartLocation = touch.location(in: self)
        touchStartUptime = ProcessInfo.processInfo.systemUptime
        touchStartPoint = normalizedPoint(for: touchStartLocation)
        touchLastPoint = touchStartPoint
        trackpadStartCursor = remoteCursor ?? touchStartPoint ?? CGPoint(x: 0.5, y: 0.5)
        if controlMode, gestureMode == .direct, let touchStartPoint {
            onPointerMove?(touchStartPoint)
        }
        initialPanOffset = panOffsetValue
        longPressConsumed = false
        touchMovedBeyondLongPress = false
        singleFingerViewportPanActive = false
        remoteDragActive = false
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesMoved(touches, with: event)
        guard isUserInteractionEnabled else {
            cancelTrackedTouch()
            return
        }
        guard let trackedTouch, touches.contains(trackedTouch) else { return }
        guard activeTouchCount(in: event) == 1 else {
            cancelTrackedTouch()
            return
        }
        let location = trackedTouch.location(in: self)
        if distance(from: touchStartLocation, to: location) > longPressMovementLimit {
            touchMovedBeyondLongPress = true
        }

        guard controlMode else {
            handleOneFingerViewportPan(to: location)
            return
        }

        guard gestureMode != .viewport else {
            cancelTrackedTouch()
            return
        }
        guard !longPressConsumed else { return }
        guard let normalized = pointForActiveGesture(location: location) else { return }
        touchLastPoint = normalized

        if gestureMode == .trackpad {
            onPointerMove?(normalized)
            return
        }

        if !remoteDragActive, distance(from: touchStartLocation, to: location) >= dragActivationDistance, let startPoint = touchStartPoint {
            remoteDragActive = true
            onDragStart?(startPoint)
        }

        if remoteDragActive {
            onDragMove?(normalized)
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesEnded(touches, with: event)
        guard let trackedTouch, touches.contains(trackedTouch) else { return }
        if longPressConsumed || singleFingerViewportPanActive {
            if remoteDragActive, let point = touchLastPoint ?? touchStartPoint {
                onDragEnd?(point)
            }
        } else if remoteDragActive {
            let normalized = normalizedPoint(for: trackedTouch.location(in: self)) ?? touchLastPoint ?? touchStartPoint
            if let normalized {
                onDragEnd?(normalized)
            }
        } else if controlMode, gestureMode != .viewport, distance(from: touchStartLocation, to: trackedTouch.location(in: self)) < dragActivationDistance {
            let clickTarget = gestureMode == .trackpad
                ? (remoteCursor ?? touchLastPoint ?? trackpadStartCursor)
                : (normalizedPoint(for: trackedTouch.location(in: self)) ?? touchLastPoint ?? touchStartPoint)
            if let clickTarget {
                onClick?(clickTarget)
            }
        }
        clearTrackedTouch()
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesCancelled(touches, with: event)
        guard let trackedTouch, touches.contains(trackedTouch) else { return }
        cancelTrackedTouch()
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        let pair = [gestureRecognizer, otherGestureRecognizer]
        return pair.contains { $0 === twoFingerPanRecognizer } && pair.contains { $0 === pinchRecognizer }
    }

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard isUserInteractionEnabled else { return false }
        if let tap = gestureRecognizer as? UITapGestureRecognizer {
            if tap.numberOfTapsRequired == 1 {
                return gestureMode == .trackpad
            }
            if tap.numberOfTapsRequired == 2 {
                return gestureMode == .viewport
            }
        }
        if gestureRecognizer === longPressRecognizer {
            return controlMode
                && gestureMode != .viewport
                && hasRenderableFrame
                && trackedTouch != nil
                && !touchMovedBeyondLongPress
        }
        return true
    }

    private func commonInit() {
        backgroundColor = .black
        isOpaque = true
        clipsToBounds = true
        isMultipleTouchEnabled = true

        imageView.backgroundColor = .black
        imageView.isOpaque = true
        imageView.layer.contentsGravity = .resize
        imageView.layer.magnificationFilter = .linear
        imageView.layer.minificationFilter = .linear
        imageView.layer.contentsScale = UIScreen.main.scale
        addSubview(imageView)

        videoLayer.videoGravity = .resize
        videoLayer.backgroundColor = UIColor.black.cgColor
        videoLayer.isHidden = true
        layer.addSublayer(videoLayer)

        monitorContentLayer.masksToBounds = false
        layer.addSublayer(monitorContentLayer)

        monitorOverlayLayer.masksToBounds = false
        layer.addSublayer(monitorOverlayLayer)

        placeholderIcon.tintColor = UIColor.white.withAlphaComponent(0.72)
        placeholderIcon.contentMode = .scaleAspectFit
        placeholderIcon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 42, weight: .regular)

        placeholderLabel.text = "Connect to start the remote desktop stream"
        placeholderLabel.textColor = UIColor.white.withAlphaComponent(0.72)
        placeholderLabel.font = .preferredFont(forTextStyle: .headline)
        placeholderLabel.textAlignment = .center
        placeholderLabel.numberOfLines = 2

        placeholderView.axis = .vertical
        placeholderView.alignment = .center
        placeholderView.distribution = .fill
        placeholderView.spacing = 14
        placeholderView.isUserInteractionEnabled = false
        placeholderView.addArrangedSubview(placeholderIcon)
        placeholderView.addArrangedSubview(placeholderLabel)
        addSubview(placeholderView)

        cursorView.tintColor = .white
        cursorView.contentMode = .scaleAspectFit
        cursorView.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 22, weight: .semibold)
        cursorView.layer.shadowColor = UIColor.black.cgColor
        cursorView.layer.shadowOpacity = 0.85
        cursorView.layer.shadowRadius = 2
        cursorView.layer.shadowOffset = CGSize(width: 0, height: 1)
        cursorView.isHidden = true
        addSubview(cursorView)

        let twoFingerPan = UIPanGestureRecognizer(target: self, action: #selector(handleTwoFingerPan(_:)))
        twoFingerPan.minimumNumberOfTouches = 2
        twoFingerPan.maximumNumberOfTouches = 2
        twoFingerPan.cancelsTouchesInView = true
        twoFingerPan.delegate = self
        addGestureRecognizer(twoFingerPan)
        twoFingerPanRecognizer = twoFingerPan

        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handlePinch(_:)))
        pinch.cancelsTouchesInView = true
        pinch.delegate = self
        addGestureRecognizer(pinch)
        pinchRecognizer = pinch

        let singleTap = UITapGestureRecognizer(target: self, action: #selector(handleSingleTap(_:)))
        singleTap.numberOfTapsRequired = 1
        singleTap.delegate = self

        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        doubleTap.delegate = self

        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
        longPress.minimumPressDuration = longPressMinimumDuration
        longPress.allowableMovement = longPressMovementLimit
        longPress.cancelsTouchesInView = true
        longPress.delegate = self

        addGestureRecognizer(singleTap)
        addGestureRecognizer(doubleTap)
        addGestureRecognizer(longPress)
        longPressRecognizer = longPress
    }

    private func setViewport(zoom: Double, panOffset: CGSize, notify: Bool) {
        let nextZoom = clampedZoom(zoom)
        zoomValue = nextZoom
        let nextPanOffset = clampedPanOffset(panOffset)
        panOffsetValue = nextPanOffset
        setNeedsLayout()

        if notify {
            onZoomChange?(nextZoom)
            onPanOffsetChange?(nextPanOffset)
        }
    }

    private func flushVideoLayer(removeImage: Bool) {
        if removeImage {
            videoLayer.sampleBufferRenderer.flush(removingDisplayedImage: true) {}
        } else {
            videoLayer.sampleBufferRenderer.flush()
        }
    }

    private func anchoredPanOffset(from panOffset: CGSize, oldZoom: Double, newZoom: Double, anchor: CGPoint) -> CGSize {
        guard oldZoom > 0 else { return panOffset }
        let ratio = CGFloat(newZoom / oldZoom)
        let anchorFromCenter = CGPoint(x: anchor.x - bounds.midX, y: anchor.y - bounds.midY)
        return CGSize(
            width: anchorFromCenter.x - (anchorFromCenter.x - panOffset.width) * ratio,
            height: anchorFromCenter.y - (anchorFromCenter.y - panOffset.height) * ratio
        )
    }

    private func updateCursor(geometry: StageGeometry) {
        guard hasRenderableFrame, let remoteCursor else {
            cursorView.isHidden = true
            return
        }

        let cursorBounds = geometry.usesMonitorLayers ? geometry.visualBounds : geometry.sourceBounds
        let desktopX = cursorBounds.minX + cursorBounds.width * min(1, max(0, remoteCursor.x))
        let desktopY = cursorBounds.minY + cursorBounds.height * min(1, max(0, remoteCursor.y))
        guard geometry.visualBounds.contains(CGPoint(x: desktopX, y: desktopY)) else {
            cursorView.isHidden = true
            return
        }

        let x = geometry.visualFrame.minX + ((desktopX - geometry.visualBounds.minX) / geometry.visualBounds.width) * geometry.visualFrame.width
        let y = geometry.visualFrame.minY + ((desktopY - geometry.visualBounds.minY) / geometry.visualBounds.height) * geometry.visualFrame.height
        cursorView.isHidden = false
        cursorView.frame = pixelAligned(CGRect(x: x, y: y, width: 24, height: 24))
    }

    private func updateMonitorLayers(geometry: StageGeometry, image: CGImage) {
        monitorOverlayLayer.isHidden = geometry.monitorFrames.count <= 1
        let activeIds = Set(geometry.monitorFrames.map(\.id))
        removeInactiveMonitorLayers(activeIds: activeIds)

        for frame in geometry.monitorFrames {
            let layers = monitorLayers[frame.id] ?? makeMonitorLayers(for: frame.id)
            layers.imageLayer.isHidden = false
            layers.imageLayer.contents = image
            layers.imageLayer.contentsRect = contentsRect(for: frame.sourceRect, sourceBounds: geometry.sourceBounds)
            layers.imageLayer.frame = pixelAligned(frame.rect)
            layers.videoContainerLayer.isHidden = true
        }

        updateMonitorOverlay(frames: geometry.monitorFrames)
    }

    private func updateMonitorVideoLayers(geometry: StageGeometry, sampleBuffer: CMSampleBuffer? = nil) {
        monitorContentLayer.isHidden = false
        let activeIds = Set(geometry.monitorFrames.map(\.id))
        removeInactiveMonitorLayers(activeIds: activeIds)

        for frame in geometry.monitorFrames {
            let layers = monitorLayers[frame.id] ?? makeMonitorLayers(for: frame.id)
            layers.imageLayer.isHidden = true
            layers.imageLayer.contents = nil
            layers.videoContainerLayer.isHidden = false
            layers.videoContainerLayer.frame = pixelAligned(frame.rect)
            layers.videoLayer.frame = videoLayerFrame(for: frame, sourceBounds: geometry.sourceBounds)
            if let sampleBuffer {
                enqueue(copySampleBuffer(sampleBuffer), on: layers.videoLayer)
            }
        }
    }

    private func enqueue(_ sampleBuffer: CMSampleBuffer, on layer: AVSampleBufferDisplayLayer) {
        let renderer = layer.sampleBufferRenderer
        if renderer.status == .failed || renderer.requiresFlushToResumeDecoding {
            renderer.flush()
        }
        if !renderer.isReadyForMoreMediaData {
            renderer.flush()
        }
        renderer.enqueue(sampleBuffer)
    }

    private func copySampleBuffer(_ sampleBuffer: CMSampleBuffer) -> CMSampleBuffer {
        var copiedSampleBuffer: CMSampleBuffer?
        let status = CMSampleBufferCreateCopy(
            allocator: kCFAllocatorDefault,
            sampleBuffer: sampleBuffer,
            sampleBufferOut: &copiedSampleBuffer
        )
        return status == noErr ? (copiedSampleBuffer ?? sampleBuffer) : sampleBuffer
    }

    private func updateMonitorOverlay(frames: [RemoteMonitorStageFrame]) {
        guard frames.count > 1 else {
            monitorOverlayLayer.isHidden = true
            return
        }

        monitorOverlayLayer.isHidden = false
        let activeIds = Set(frames.map(\.id))
        removeInactiveMonitorLayers(activeIds: activeIds)

        for frame in frames {
            let layers = monitorLayers[frame.id] ?? makeMonitorLayers(for: frame.id)
            let rect = pixelAligned(frame.rect)
            let path = UIBezierPath(roundedRect: rect, cornerRadius: 5).cgPath
            layers.strokeLayer.path = path
            layers.strokeLayer.fillColor = UIColor.clear.cgColor
            layers.strokeLayer.strokeColor = tintColor.cgColor
            layers.strokeLayer.lineWidth = 2
            layers.strokeLayer.isHidden = false

            let labelRect = monitorLabelRect(for: frame.monitor.displayName, in: rect)
            layers.labelBackgroundLayer.path = UIBezierPath(
                roundedRect: labelRect,
                cornerRadius: labelRect.height / 2
            ).cgPath
            layers.labelBackgroundLayer.fillColor = UIColor.black.withAlphaComponent(0.72).cgColor
            layers.labelBackgroundLayer.isHidden = false
            layers.textLayer.string = frame.monitor.displayName
            layers.textLayer.font = UIFont.boldSystemFont(ofSize: 11)
            layers.textLayer.fontSize = 11
            layers.textLayer.foregroundColor = UIColor.white.cgColor
            layers.textLayer.frame = labelRect.insetBy(dx: 5, dy: 3)
            layers.textLayer.isHidden = false
        }
    }

    private func makeMonitorLayers(for id: String) -> MonitorLayers {
        let layers = MonitorLayers(
            contentParent: monitorContentLayer,
            overlayParent: monitorOverlayLayer,
            contentsScale: window?.screen.scale ?? UIScreen.main.scale
        )
        monitorLayers[id] = layers
        return layers
    }

    private func removeInactiveMonitorLayers(activeIds: Set<String>) {
        for id in monitorLayers.keys.filter({ !activeIds.contains($0) }) {
            monitorLayers[id]?.removeFromSuperlayer()
            monitorLayers[id] = nil
        }
    }

    private func hideMonitorImageLayers() {
        for layers in monitorLayers.values {
            layers.imageLayer.isHidden = true
            layers.imageLayer.contents = nil
        }
    }

    private func hideMonitorVideoLayers() {
        for layers in monitorLayers.values {
            layers.videoContainerLayer.isHidden = true
            layers.videoLayer.sampleBufferRenderer.flush()
        }
    }

    private func videoLayerFrame(for frame: RemoteMonitorStageFrame, sourceBounds: CGRect) -> CGRect {
        let scaleX = frame.rect.width / max(1, frame.sourceRect.width)
        let scaleY = frame.rect.height / max(1, frame.sourceRect.height)
        return pixelAligned(CGRect(
            x: -(frame.sourceRect.minX - sourceBounds.minX) * scaleX,
            y: -(frame.sourceRect.minY - sourceBounds.minY) * scaleY,
            width: sourceBounds.width * scaleX,
            height: sourceBounds.height * scaleY
        ))
    }

    private func monitorLabelRect(for label: String, in rect: CGRect) -> CGRect {
        let font = UIFont.boldSystemFont(ofSize: 11)
        let size = (label as NSString).size(withAttributes: [.font: font])
        let maxWidth = max(36, rect.width - 12)
        let width = min(maxWidth, max(36, ceil(size.width) + 14))
        let height: CGFloat = 20
        return pixelAligned(CGRect(
            x: rect.minX + 6,
            y: rect.minY + 6,
            width: width,
            height: height
        ))
    }

    private func stageGeometry(panOffset: CGSize, zoom: Double) -> StageGeometry? {
        let sourceBounds = streamSourceBounds()
        guard sourceBounds.width > 0, sourceBounds.height > 0 else { return nil }

        let selectedMonitors = stageMonitors()
        let selectedMonitorIds = Set(selectedMonitors.map(\.id))
        let hasLayoutOffsets = !monitorLayoutOffsets.isEmpty
        let usesMonitorLayers = monitors.count > 1
            && !selectedMonitors.isEmpty
            && (selectedMonitorIds.count < Set(monitors.map(\.id)).count || hasLayoutOffsets)

        let visualBounds = usesMonitorLayers ? monitorUnion(for: selectedMonitors) : sourceBounds
        guard visualBounds.width > 0, visualBounds.height > 0 else { return nil }

        let frame = pixelAligned(contentFrame(for: visualBounds.size, panOffset: panOffset, zoom: zoom))
        return StageGeometry(
            sourceBounds: sourceBounds,
            visualBounds: visualBounds,
            visualFrame: frame,
            monitorFrames: monitorFrames(in: frame, visualBounds: visualBounds, monitors: usesMonitorLayers ? selectedMonitors : monitors),
            usesMonitorLayers: usesMonitorLayers
        )
    }

    private func monitorFrames(
        in visualFrame: CGRect,
        visualBounds: CGRect,
        monitors: [RemoteMonitorDescriptor]
    ) -> [RemoteMonitorStageFrame] {
        guard !monitors.isEmpty else { return [] }
        let layout = RemoteMonitorLayoutGeometry(monitors: monitors, offsets: monitorLayoutOffsets)

        return monitors.compactMap { monitor in
            let rawRect = layout.rect(for: monitor)
            let intersection = rawRect.intersection(visualBounds)
            guard !intersection.isNull, intersection.width > 1, intersection.height > 1 else {
                return nil
            }

            let sourceRect = CGRect(
                x: CGFloat(monitor.left) + (intersection.minX - rawRect.minX),
                y: CGFloat(monitor.top) + (intersection.minY - rawRect.minY),
                width: intersection.width,
                height: intersection.height
            )
            let x = visualFrame.minX + ((intersection.minX - visualBounds.minX) / visualBounds.width) * visualFrame.width
            let y = visualFrame.minY + ((intersection.minY - visualBounds.minY) / visualBounds.height) * visualFrame.height
            let width = (intersection.width / visualBounds.width) * visualFrame.width
            let height = (intersection.height / visualBounds.height) * visualFrame.height
            return RemoteMonitorStageFrame(
                id: monitor.id,
                monitor: monitor,
                rect: CGRect(x: x, y: y, width: width, height: height),
                desktopRect: intersection,
                sourceRect: sourceRect
            )
        }
    }

    private func streamSourceBounds() -> CGRect {
        if let displayInfo {
            let left = displayInfo.left ?? displayInfo.virtualLeft
            let top = displayInfo.top ?? displayInfo.virtualTop
            let width = displayInfo.width ?? displayInfo.virtualWidth
            let height = displayInfo.height ?? displayInfo.virtualHeight

            if let left, let top, let width, let height, width > 0, height > 0 {
                return CGRect(x: CGFloat(left), y: CGFloat(top), width: CGFloat(width), height: CGFloat(height))
            }
        }

        let layoutBounds = RemoteMonitorLayoutGeometry(monitors: monitors, offsets: [:]).union
        if !monitors.isEmpty, layoutBounds.width > 0, layoutBounds.height > 0 {
            return layoutBounds
        }

        if desktopSize.width > 0, desktopSize.height > 0 {
            return CGRect(origin: .zero, size: desktopSize)
        }

        return layoutBounds
    }

    private func stageMonitors() -> [RemoteMonitorDescriptor] {
        guard !monitors.isEmpty else { return [] }
        guard !selectedMonitorIds.isEmpty else { return monitors }
        let selected = monitors.filter { selectedMonitorIds.contains($0.id) }
        return selected.isEmpty ? monitors : selected
    }

    private func monitorUnion(for monitors: [RemoteMonitorDescriptor]) -> CGRect {
        RemoteMonitorLayoutGeometry(monitors: monitors, offsets: monitorLayoutOffsets).union
    }

    private func normalizedPoint(for location: CGPoint) -> CGPoint? {
        guard hasRenderableFrame else { return nil }
        guard let geometry = stageGeometry(panOffset: panOffsetValue, zoom: zoomValue) else { return nil }
        guard geometry.visualFrame.width > 0, geometry.visualFrame.height > 0 else { return nil }
        let x = (location.x - geometry.visualFrame.minX) / geometry.visualFrame.width
        let y = (location.y - geometry.visualFrame.minY) / geometry.visualFrame.height
        guard x.isFinite, y.isFinite else { return nil }
        return CGPoint(x: min(1, max(0, x)), y: min(1, max(0, y)))
    }

    private func pointForActiveGesture(location: CGPoint) -> CGPoint? {
        guard gestureMode == .trackpad else {
            return normalizedPoint(for: location)
        }
        guard hasRenderableFrame else { return nil }
        guard let geometry = stageGeometry(panOffset: panOffsetValue, zoom: zoomValue) else { return nil }
        guard geometry.visualFrame.width > 0, geometry.visualFrame.height > 0 else { return nil }
        let start = trackpadStartCursor ?? remoteCursor ?? CGPoint(x: 0.5, y: 0.5)
        let sensitivity: CGFloat = 1.25
        let dx = ((location.x - touchStartLocation.x) / geometry.visualFrame.width) * sensitivity
        let dy = ((location.y - touchStartLocation.y) / geometry.visualFrame.height) * sensitivity
        return CGPoint(
            x: min(1, max(0, start.x + dx)),
            y: min(1, max(0, start.y + dy))
        )
    }

    private func handleOneFingerViewportPan(to location: CGPoint) {
        guard hasRenderableFrame else { return }
        let translation = CGSize(
            width: location.x - touchStartLocation.x,
            height: location.y - touchStartLocation.y
        )
        guard singleFingerViewportPanActive || hypot(translation.width, translation.height) >= dragActivationDistance else {
            return
        }

        singleFingerViewportPanActive = true
        setViewport(
            zoom: zoomValue,
            panOffset: CGSize(
                width: initialPanOffset.width + translation.width,
                height: initialPanOffset.height + translation.height
            ),
            notify: true
        )
    }

    private func contentFrame(for contentSize: CGSize, panOffset: CGSize, zoom: Double) -> CGRect {
        guard contentSize.width > 0, contentSize.height > 0, bounds.width > 0, bounds.height > 0 else {
            return bounds
        }

        let scale = min(bounds.width / contentSize.width, bounds.height / contentSize.height) * CGFloat(zoom)
        let displaySize = CGSize(width: contentSize.width * scale, height: contentSize.height * scale)
        return CGRect(
            x: (bounds.width - displaySize.width) / 2 + panOffset.width,
            y: (bounds.height - displaySize.height) / 2 + panOffset.height,
            width: displaySize.width,
            height: displaySize.height
        )
    }

    private func clampedZoom(_ value: Double) -> Double {
        min(RemoteViewportSettings.maximumZoom, max(RemoteViewportSettings.minimumZoom, value))
    }

    private func clampedPanOffset(_ offset: CGSize) -> CGSize {
        guard hasRenderableFrame, let geometry = stageGeometry(panOffset: .zero, zoom: zoomValue), zoomValue > 1.01 else {
            return .zero
        }

        let horizontalLimit = max(0, (geometry.visualFrame.width - bounds.width) / 2 + 44)
        let verticalLimit = max(0, (geometry.visualFrame.height - bounds.height) / 2 + 44)
        return CGSize(
            width: min(horizontalLimit, max(-horizontalLimit, offset.width)),
            height: min(verticalLimit, max(-verticalLimit, offset.height))
        )
    }

    private func contentsRect(for desktopRect: CGRect, sourceBounds: CGRect) -> CGRect {
        guard sourceBounds.width > 0, sourceBounds.height > 0 else {
            return CGRect(x: 0, y: 0, width: 1, height: 1)
        }

        let x = (desktopRect.minX - sourceBounds.minX) / sourceBounds.width
        let y = (desktopRect.minY - sourceBounds.minY) / sourceBounds.height
        let width = desktopRect.width / sourceBounds.width
        let height = desktopRect.height / sourceBounds.height
        return CGRect(
            x: min(1, max(0, x)),
            y: min(1, max(0, y)),
            width: min(1, max(0, width)),
            height: min(1, max(0, height))
        )
    }

    private func pixelAligned(_ rect: CGRect) -> CGRect {
        let scale = window?.screen.scale ?? UIScreen.main.scale
        guard scale > 0 else { return rect }
        return CGRect(
            x: (rect.origin.x * scale).rounded() / scale,
            y: (rect.origin.y * scale).rounded() / scale,
            width: (rect.size.width * scale).rounded() / scale,
            height: (rect.size.height * scale).rounded() / scale
        )
    }

    private func activeTouchCount(in event: UIEvent?) -> Int {
        event?.allTouches?.filter { $0.phase != .ended && $0.phase != .cancelled }.count ?? 0
    }

    private func cancelTrackedTouch() {
        if remoteDragActive, let point = touchLastPoint ?? touchStartPoint {
            onDragEnd?(point)
        }
        clearTrackedTouch()
    }

    private func clearTrackedTouch() {
        trackedTouch = nil
        touchStartPoint = nil
        touchLastPoint = nil
        touchStartUptime = 0
        trackpadStartCursor = nil
        longPressConsumed = false
        touchMovedBeyondLongPress = false
        singleFingerViewportPanActive = false
        remoteDragActive = false
    }

    private func distance(from start: CGPoint, to end: CGPoint) -> CGFloat {
        hypot(end.x - start.x, end.y - start.y)
    }
}

struct RemoteKeyboardBridge: View {
    let client: RemoteDesktopClient
    @Binding var focusToken: Int
    @Binding var dismissToken: Int
    @Binding var keyboardVisible: Bool

    var body: some View {
        RemoteKeyboardInputCapture(
            focusToken: $focusToken,
            dismissToken: $dismissToken,
            keyboardVisible: $keyboardVisible,
            onText: { client.sendText($0) },
            onEnter: { client.sendKey("Enter", code: "Enter") },
            onBackspace: { client.sendKey("Backspace", code: "Backspace") },
            onEscape: { client.sendKey("Escape", code: "Escape") },
            onTab: { client.sendKey("Tab", code: "Tab") }
        )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityHidden(true)
    }
}

struct RemoteKeyboardInputCapture: UIViewRepresentable {
    @Binding var focusToken: Int
    @Binding var dismissToken: Int
    @Binding var keyboardVisible: Bool
    let onText: (String) -> Void
    let onEnter: () -> Void
    let onBackspace: () -> Void
    let onEscape: () -> Void
    let onTab: () -> Void

    func makeUIView(context: Context) -> InputView {
        let view = InputView()
        view.onText = onText
        view.onEnter = onEnter
        view.onBackspace = onBackspace
        view.onEscape = onEscape
        view.onTab = onTab
        view.onActiveChanged = { [binding = $keyboardVisible] isActive in
            binding.wrappedValue = isActive
        }
        return view
    }

    func updateUIView(_ uiView: InputView, context: Context) {
        uiView.onText = onText
        uiView.onEnter = onEnter
        uiView.onBackspace = onBackspace
        uiView.onEscape = onEscape
        uiView.onTab = onTab
        uiView.onActiveChanged = { [binding = $keyboardVisible] isActive in
            binding.wrappedValue = isActive
        }

        if uiView.lastFocusToken != focusToken {
            uiView.lastFocusToken = focusToken
            DispatchQueue.main.async {
                uiView.requestKeyboardFocus()
            }
        }

        if uiView.lastDismissToken != dismissToken {
            uiView.lastDismissToken = dismissToken
            DispatchQueue.main.async {
                _ = uiView.resignFirstResponder()
            }
        }
    }

    final class InputView: UITextView {
        var onText: ((String) -> Void)?
        var onEnter: (() -> Void)?
        var onBackspace: (() -> Void)?
        var onEscape: (() -> Void)?
        var onTab: (() -> Void)?
        var onActiveChanged: ((Bool) -> Void)?
        var lastFocusToken = 0
        var lastDismissToken = 0

        init() {
            super.init(frame: .zero, textContainer: nil)
            backgroundColor = .clear
            textColor = .clear
            tintColor = .clear
            isOpaque = false
            isScrollEnabled = false
            isEditable = true
            isSelectable = true
            keyboardType = .asciiCapable
            autocapitalizationType = .none
            autocorrectionType = .no
            smartDashesType = .no
            smartQuotesType = .no
            spellCheckingType = .no
            textContentType = .none
        }

        required init?(coder: NSCoder) {
            nil
        }

        override var canBecomeFirstResponder: Bool { true }
        override var hasText: Bool { true }
        override var inputAccessoryView: UIView? {
            get { nil }
            set {}
        }

        override func becomeFirstResponder() -> Bool {
            let didBecome = super.becomeFirstResponder()
            if didBecome {
                onActiveChanged?(true)
            }
            return didBecome
        }

        override func resignFirstResponder() -> Bool {
            let didResign = super.resignFirstResponder()
            if didResign {
                onActiveChanged?(false)
            }
            return didResign
        }

        override func insertText(_ text: String) {
            var bufferedText = ""
            func flushBufferedText() {
                guard !bufferedText.isEmpty else { return }
                onText?(bufferedText)
                bufferedText = ""
            }

            for scalar in text.unicodeScalars {
                if scalar.value == 10 || scalar.value == 13 {
                    flushBufferedText()
                    onEnter?()
                } else if scalar.value == 9 {
                    flushBufferedText()
                    onTab?()
                } else {
                    bufferedText.append(String(scalar))
                }
            }
            flushBufferedText()
            self.text = ""
        }

        override func deleteBackward() {
            onBackspace?()
            text = ""
        }

        override var keyCommands: [UIKeyCommand]? {
            [
                command(input: "\r", action: #selector(enter)),
                command(input: "\n", action: #selector(enter)),
                command(input: "\t", action: #selector(tab)),
                command(input: "\u{8}", action: #selector(backspace)),
                command(input: "\u{7F}", action: #selector(backspace)),
                command(input: UIKeyCommand.inputEscape, action: #selector(escape))
            ]
        }

        func requestKeyboardFocus(attempt: Int = 0) {
            guard window != nil else {
                guard attempt < 6 else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                    self?.requestKeyboardFocus(attempt: attempt + 1)
                }
                return
            }

            reloadInputViews()
            _ = becomeFirstResponder()

            guard !isFirstResponder, attempt < 2 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                self?.requestKeyboardFocus(attempt: attempt + 1)
            }
        }

        private func command(input: String, action: Selector) -> UIKeyCommand {
            let command = UIKeyCommand(input: input, modifierFlags: [], action: action)
            if #available(iOS 15.0, *) {
                command.wantsPriorityOverSystemBehavior = true
            }
            return command
        }

        @objc private func enter() { onEnter?() }
        @objc private func backspace() { onBackspace?() }
        @objc private func escape() { onEscape?() }
        @objc private func tab() { onTab?() }
    }
}

private struct RemoteMonitorStageFrame: Identifiable {
    let id: String
    let monitor: RemoteMonitorDescriptor
    let rect: CGRect
    var desktopRect: CGRect = .zero
    var sourceRect: CGRect = .zero
}

struct RemoteTopOverlay: View {
    let telemetry: RemoteTelemetrySnapshot
    @Binding var mode: RemoteMode
    @Binding var profile: RemoteStreamProfile
    @Binding var gestureMode: RemoteGestureMode
    let compact: Bool
    let onConnect: () -> Void
    let onDisconnect: () -> Void
    let onModeChange: (RemoteMode) -> Void
    let onProfileChange: (RemoteStreamProfile) -> Void

    var body: some View {
        Group {
            if compact {
                compactBody
            } else {
                regularBody
            }
        }
        .padding(compact ? 10 : 12)
        .frame(minHeight: compact ? 52 : 78)
        .remoteFloatingSurface(cornerRadius: compact ? 20 : 24)
    }

    private var regularBody: some View {
        VStack(spacing: 10) {
            headerRow

            HStack(spacing: 10) {
                modePicker
                    .pickerStyle(.segmented)

                streamPicker
                    .pickerStyle(.menu)

                gesturePicker
                    .pickerStyle(.menu)
            }
        }
    }

    private var compactBody: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(telemetry.state.title)
                    .font(.caption.weight(.semibold))
                Text(compactStatusLine)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            compactOptionsMenu
            connectButton
        }
    }

    private var headerRow: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(telemetry.state.title)
                    .font(.headline)
                Text(statusLine)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            Spacer()
            connectButton
        }
    }

    private var connectButton: some View {
        Button {
            if case .connected = telemetry.state {
                onDisconnect()
            } else {
                onConnect()
            }
        } label: {
            Image(systemName: isConnected ? "stop.fill" : "play.fill")
                .frame(width: 34, height: 34)
        }
        .remoteControlButtonSurface(cornerRadius: 17)
    }

    private var modePicker: some View {
        Picker("Mode", selection: $mode) {
            ForEach(RemoteMode.allCases) { mode in
                Text(mode.title).tag(mode)
            }
        }
        .onChange(of: mode) { _, newMode in
            onModeChange(newMode)
        }
    }

    private var streamPicker: some View {
        Picker("Stream", selection: $profile) {
            ForEach(RemoteStreamProfile.allCases) { profile in
                Label(profile.title, systemImage: profile.systemImage).tag(profile)
            }
        }
        .onChange(of: profile) { _, newProfile in
            onProfileChange(newProfile)
        }
    }

    private var gesturePicker: some View {
        Picker("Gesture", selection: $gestureMode) {
            ForEach(RemoteGestureMode.allCases) { mode in
                Label(mode.title, systemImage: mode.systemImage).tag(mode)
            }
        }
    }

    private var compactOptionsMenu: some View {
        Menu {
            Picker("Mode", selection: $mode) {
                ForEach(RemoteMode.allCases) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .onChange(of: mode) { _, newMode in
                onModeChange(newMode)
            }

            Picker("Stream", selection: $profile) {
                ForEach(RemoteStreamProfile.allCases) { profile in
                    Label(profile.title, systemImage: profile.systemImage).tag(profile)
                }
            }
            .onChange(of: profile) { _, newProfile in
                onProfileChange(newProfile)
            }

            Picker("Gesture", selection: $gestureMode) {
                ForEach(RemoteGestureMode.allCases) { mode in
                    Label(mode.title, systemImage: mode.systemImage).tag(mode)
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .frame(width: 34, height: 34)
        }
        .buttonStyle(.plain)
        .remoteControlButtonSurface(cornerRadius: 17)
    }

    private var isConnected: Bool {
        if case .connected = telemetry.state {
            return true
        }
        return false
    }

    private var statusLine: String {
        let latencyText = telemetry.latency.map { " • \(Int($0)) ms" } ?? ""
        let sizeText = telemetry.displaySizeText.map { " • \($0)" } ?? ""
        let bytesText = telemetry.frameBytes > 0 ? " • \(ByteCountFormatter.string(fromByteCount: Int64(telemetry.frameBytes), countStyle: .file))" : ""
        return "\(telemetry.status) • \(String(format: "%.1f", telemetry.fps)) fps\(latencyText)\(sizeText)\(bytesText)"
    }

    private var compactStatusLine: String {
        let latencyText = telemetry.latency.map { " • \(Int($0)) ms" } ?? ""
        return "\(String(format: "%.1f", telemetry.fps)) fps\(latencyText)"
    }
}

struct RemoteDiagnosticsOverlay: View {
    let telemetry: RemoteTelemetrySnapshot

    var body: some View {
        HStack(spacing: 8) {
            diagnostic("RX", telemetry.receivedFps, suffix: "fps")
            diagnostic("Draw", telemetry.presentedFps, suffix: "fps")
            diagnostic("Dec", telemetry.decodeMs, suffix: "ms")
            diagnostic("Layer", telemetry.renderMs, suffix: "ms")
            Text("Drop \(telemetry.droppedFrames)")
            Text("Input \(telemetry.droppedInputEvents)")
        }
        .font(.caption2.monospacedDigit().weight(.semibold))
        .foregroundStyle(.white.opacity(0.88))
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.black.opacity(0.62), in: Capsule())
    }

    private func diagnostic(_ label: String, _ value: Double, suffix: String) -> Text {
        Text("\(label) \(String(format: "%.1f", value))\(suffix)")
    }
}

struct RemoteQuickDock: View {
    let mode: RemoteMode
    let monitorActive: Bool
    let monitorCount: Int
    let keyboardFocused: Bool
    let onControlToggle: () -> Void
    let onMonitorToggle: () -> Void
    let onKeyboardToggle: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            RemoteQuickDockButton(
                systemName: mode == .control ? "cursorarrow" : "eye",
                isActive: mode == .control,
                accessibilityLabel: mode == .control ? "Switch to view mode" : "Switch to control mode"
            ) {
                onControlToggle()
            }

            RemoteQuickDockButton(
                systemName: "rectangle.on.rectangle",
                isActive: monitorActive,
                accessibilityLabel: monitorCount > 1 ? "Choose visible monitors" : "Show monitor layout"
            ) {
                onMonitorToggle()
            }

            RemoteQuickDockButton(
                systemName: keyboardFocused ? "keyboard.chevron.compact.down" : "keyboard",
                isActive: keyboardFocused,
                accessibilityLabel: keyboardFocused ? "Hide remote keyboard" : "Show remote keyboard"
            ) {
                onKeyboardToggle()
            }
        }
        .padding(6)
        .remoteFloatingSurface(cornerRadius: 26)
    }
}

struct RemoteQuickDockButton: View {
    let systemName: String
    let isActive: Bool
    let accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(isActive ? .white : .primary)
                .frame(width: 38, height: 38)
                .background(
                    Circle()
                        .fill(isActive ? Color.accentColor : Color.white.opacity(0.16))
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}

struct RemoteMonitorPanel: View {
    let monitors: [RemoteMonitorDescriptor]
    @Binding var selectedMonitorIds: Set<String>
    @Binding var dragMode: Bool
    @Binding var layoutOffsets: [String: CGSize]
    let onSelectionChange: (Set<String>) -> Void
    let onLayoutChange: ([String: CGSize]) -> Void
    let onResetViews: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Label("Monitors", systemImage: "rectangle.on.rectangle")
                    .font(.headline)
                Spacer()
                Text(monitors.countText)
                    .font(.caption2.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            if monitors.isEmpty {
                HStack(spacing: 10) {
                    Image(systemName: "display.trianglebadge.exclamationmark")
                    Text("No monitor layout")
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                }
                .foregroundStyle(.secondary)
                .padding(.vertical, 8)
            } else {
                RemoteMonitorLayoutPreview(
                    monitors: monitors,
                    selectedMonitorIds: activeSelection,
                    dragMode: dragMode,
                    layoutOffsets: $layoutOffsets,
                    onToggle: toggleMonitor,
                    onLayoutChange: onLayoutChange
                )
                .frame(height: monitors.count > 2 ? 180 : 148)
            }

            HStack(spacing: 8) {
                dragViewsButton
                resetViewsButton
            }
            .font(.caption.weight(.semibold))
        }
        .padding(12)
        .remoteFloatingSurface(cornerRadius: 22)
    }

    @ViewBuilder
    private var dragViewsButton: some View {
        if dragMode {
            Button {
                dragMode.toggle()
            } label: {
                Label("Drag Views", systemImage: "checkmark.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        } else {
            Button {
                dragMode.toggle()
            } label: {
                Label("Drag Views", systemImage: "arrow.up.left.and.arrow.down.right")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
    }

    private var resetViewsButton: some View {
        Button {
            dragMode = false
            layoutOffsets = [:]
            onResetViews()
        } label: {
            Label("Reset Views", systemImage: "arrow.counterclockwise")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
    }

    private var activeSelection: Set<String> {
        let ids = Set(monitors.map(\.id))
        let selected = selectedMonitorIds.intersection(ids)
        return selected.isEmpty ? ids : selected
    }

    private func toggleMonitor(_ monitor: RemoteMonitorDescriptor) {
        var next = activeSelection
        if next.contains(monitor.id), next.count > 1 {
            next.remove(monitor.id)
        } else {
            next.insert(monitor.id)
        }
        selectedMonitorIds = next
        onSelectionChange(next)
    }
}

struct RemoteMonitorLayoutPreview: View {
    let monitors: [RemoteMonitorDescriptor]
    let selectedMonitorIds: Set<String>
    let dragMode: Bool
    @Binding var layoutOffsets: [String: CGSize]
    let onToggle: (RemoteMonitorDescriptor) -> Void
    let onLayoutChange: ([String: CGSize]) -> Void

    var body: some View {
        GeometryReader { proxy in
            let layout = RemoteMonitorLayoutGeometry(monitors: monitors, offsets: [:])
            let scale = previewScale(for: layout.union, in: proxy.size)

            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 14)
                    .fill(Color.black.opacity(0.28))

                ForEach(monitors) { monitor in
                    let displayRect = scaledRect(layout.rect(for: monitor), layout: layout, scale: scale, in: proxy.size)
                    let monitorOffset = layoutOffsets[monitor.id] ?? .zero
                    RemoteMonitorPreviewTile(
                        monitor: monitor,
                        selected: selectedMonitorIds.isEmpty || selectedMonitorIds.contains(monitor.id),
                        dragMode: dragMode,
                        onToggle: { onToggle(monitor) }
                    )
                    .frame(width: max(54, displayRect.width), height: max(38, displayRect.height))
                    .position(x: displayRect.midX, y: displayRect.midY)
                    .offset(x: monitorOffset.width * scale, y: monitorOffset.height * scale)
                    .transaction { transaction in
                        transaction.animation = nil
                        transaction.disablesAnimations = true
                    }
                }

                if dragMode {
                    RemoteMonitorDragCaptureLayer(
                        monitors: monitors,
                        dragMode: dragMode,
                        layoutOffsets: $layoutOffsets,
                        onLayoutChange: onLayoutChange
                    )
                        .frame(width: proxy.size.width, height: proxy.size.height)
                        .zIndex(10)
                }
            }
            .clipped()
        }
    }

    private func previewScale(for union: CGRect, in size: CGSize) -> CGFloat {
        let availableWidth = max(1, size.width - 24)
        let availableHeight = max(1, size.height - 24)
        return min(availableWidth / max(1, union.width), availableHeight / max(1, union.height))
    }

    private func scaledRect(
        _ rect: CGRect,
        layout: RemoteMonitorLayoutGeometry,
        scale: CGFloat,
        in size: CGSize
    ) -> CGRect {
        let contentSize = CGSize(
            width: layout.union.width * scale,
            height: layout.union.height * scale
        )
        let origin = CGPoint(
            x: (size.width - contentSize.width) / 2,
            y: (size.height - contentSize.height) / 2
        )
        return CGRect(
            x: origin.x + (rect.minX - layout.union.minX) * scale,
            y: origin.y + (rect.minY - layout.union.minY) * scale,
            width: rect.width * scale,
            height: rect.height * scale
        )
    }
}

struct RemoteMonitorPreviewTile: View {
    let monitor: RemoteMonitorDescriptor
    let selected: Bool
    let dragMode: Bool
    let onToggle: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            RoundedRectangle(cornerRadius: 8)
                .fill(selected ? Color.accentColor.opacity(0.36) : Color.white.opacity(0.12))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(selected ? Color.accentColor : Color.white.opacity(0.38), lineWidth: selected ? 2 : 1)
                )

            VStack(spacing: 2) {
                Text(monitor.displayName)
                    .font(.caption2.weight(.bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                Text(monitor.resolutionText)
                    .font(.caption2.monospacedDigit())
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
            }
            .foregroundStyle(.white)
            .padding(6)
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .font(.caption.weight(.bold))
                .foregroundStyle(selected ? Color.accentColor : Color.white.opacity(0.72))
                .padding(5)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            guard !dragMode else { return }
            onToggle()
        }
        .transaction { transaction in
            transaction.animation = nil
            transaction.disablesAnimations = true
        }
    }
}

struct RemoteMonitorDragCaptureLayer: UIViewRepresentable {
    let monitors: [RemoteMonitorDescriptor]
    let dragMode: Bool
    @Binding var layoutOffsets: [String: CGSize]
    let onLayoutChange: ([String: CGSize]) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> UIView {
        let view = CaptureView()
        view.coordinator = context.coordinator
        view.backgroundColor = UIColor.white.withAlphaComponent(0.001)
        view.isOpaque = false
        view.isMultipleTouchEnabled = false
        view.isUserInteractionEnabled = dragMode
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.parent = self
        uiView.isUserInteractionEnabled = dragMode
        if !dragMode {
            context.coordinator.clearDrag()
        }
    }

    final class CaptureView: UIView {
        weak var coordinator: Coordinator?

        override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
            coordinator?.hitMonitorId(at: point, in: bounds.size) != nil
        }

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
            super.touchesBegan(touches, with: event)
            coordinator?.touchesBegan(touches, in: self)
        }

        override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
            super.touchesMoved(touches, with: event)
            coordinator?.touchesMoved(touches, in: self)
        }

        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
            super.touchesEnded(touches, with: event)
            coordinator?.clearDrag()
        }

        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
            super.touchesCancelled(touches, with: event)
            coordinator?.clearDrag()
        }
    }

    final class Coordinator: NSObject {
        var parent: RemoteMonitorDragCaptureLayer
        private weak var trackedTouch: UITouch?
        private var activeMonitorId: String?
        private var dragStartLocation = CGPoint.zero
        private var dragStartOffset = CGSize.zero

        init(parent: RemoteMonitorDragCaptureLayer) {
            self.parent = parent
        }

        func touchesBegan(_ touches: Set<UITouch>, in view: UIView) {
            guard parent.dragMode, trackedTouch == nil, let touch = touches.first else { return }
            let location = touch.location(in: view)
            guard let monitorId = hitMonitorId(at: location, in: view.bounds.size) else { return }
            trackedTouch = touch
            activeMonitorId = monitorId
            dragStartLocation = location
            dragStartOffset = parent.layoutOffsets[monitorId] ?? .zero
        }

        func touchesMoved(_ touches: Set<UITouch>, in view: UIView) {
            guard parent.dragMode, let trackedTouch, touches.contains(trackedTouch), let activeMonitorId else { return }
            let scale = previewScale(in: view.bounds.size)
            let location = trackedTouch.location(in: view)
            publish(
                activeMonitorId,
                offset: CGSize(
                    width: dragStartOffset.width + (location.x - dragStartLocation.x) / max(0.001, scale),
                    height: dragStartOffset.height + (location.y - dragStartLocation.y) / max(0.001, scale)
                )
            )
        }

        func clearDrag() {
            trackedTouch = nil
            activeMonitorId = nil
            dragStartLocation = .zero
            dragStartOffset = .zero
        }

        func hitMonitorId(at point: CGPoint, in size: CGSize) -> String? {
            monitorFrames(in: size)
                .reversed()
                .first { $0.rect.contains(point) }?
                .id
        }

        private func publish(_ id: String, offset: CGSize) {
            var nextOffsets = parent.layoutOffsets
            nextOffsets[id] = offset
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                parent.layoutOffsets = nextOffsets
            }
            parent.onLayoutChange(nextOffsets)
        }

        private func monitorFrames(in size: CGSize) -> [(id: String, rect: CGRect)] {
            let layout = RemoteMonitorLayoutGeometry(monitors: parent.monitors, offsets: [:])
            let scale = previewScale(in: size)
            return parent.monitors.map { monitor in
                let baseRect = scaledRect(layout.rect(for: monitor), layout: layout, scale: scale, in: size)
                let offset = parent.layoutOffsets[monitor.id] ?? .zero
                let tileSize = CGSize(width: max(54, baseRect.width), height: max(38, baseRect.height))
                let center = CGPoint(
                    x: baseRect.midX + offset.width * scale,
                    y: baseRect.midY + offset.height * scale
                )
                return (
                    id: monitor.id,
                    rect: CGRect(
                        x: center.x - tileSize.width / 2,
                        y: center.y - tileSize.height / 2,
                        width: tileSize.width,
                        height: tileSize.height
                    )
                )
            }
        }

        private func previewScale(in size: CGSize) -> CGFloat {
            let union = RemoteMonitorLayoutGeometry(monitors: parent.monitors, offsets: [:]).union
            let availableWidth = max(1, size.width - 24)
            let availableHeight = max(1, size.height - 24)
            return min(availableWidth / max(1, union.width), availableHeight / max(1, union.height))
        }

        private func scaledRect(
            _ rect: CGRect,
            layout: RemoteMonitorLayoutGeometry,
            scale: CGFloat,
            in size: CGSize
        ) -> CGRect {
            let contentSize = CGSize(
                width: layout.union.width * scale,
                height: layout.union.height * scale
            )
            let origin = CGPoint(
                x: (size.width - contentSize.width) / 2,
                y: (size.height - contentSize.height) / 2
            )
            return CGRect(
                x: origin.x + (rect.minX - layout.union.minX) * scale,
                y: origin.y + (rect.minY - layout.union.minY) * scale,
                width: rect.width * scale,
                height: rect.height * scale
            )
        }
    }
}

private struct RemoteMonitorLayoutGeometry {
    let union: CGRect
    private let rects: [String: CGRect]

    init(monitors: [RemoteMonitorDescriptor], offsets: [String: CGSize]) {
        var nextRects: [String: CGRect] = [:]
        var nextUnion: CGRect?

        for monitor in monitors {
            let offset = offsets[monitor.id] ?? .zero
            let rect = CGRect(
                x: CGFloat(monitor.left) + offset.width,
                y: CGFloat(monitor.top) + offset.height,
                width: CGFloat(monitor.width),
                height: CGFloat(monitor.height)
            )
            nextRects[monitor.id] = rect
            nextUnion = nextUnion.map { $0.union(rect) } ?? rect
        }

        rects = nextRects
        union = nextUnion ?? CGRect(x: 0, y: 0, width: 1, height: 1)
    }

    func rect(for monitor: RemoteMonitorDescriptor) -> CGRect {
        rects[monitor.id] ?? CGRect(
            x: CGFloat(monitor.left),
            y: CGFloat(monitor.top),
            width: CGFloat(monitor.width),
            height: CGFloat(monitor.height)
        )
    }
}

private extension Array where Element == RemoteMonitorDescriptor {
    var countText: String {
        "\(count)"
    }
}

struct FloatingRemoteControls: View {
    private struct DragState: Equatable {
        var translation = CGSize.zero
        var isActive = false
    }

    enum Anchor: Equatable {
        case leading
        case trailing

        var alignment: Alignment {
            switch self {
            case .leading:
                return .bottomLeading
            case .trailing:
                return .bottomTrailing
            }
        }
    }

    let client: RemoteDesktopClient
    @Binding var zoom: Double
    @Binding var panOffset: CGSize
    @Binding var joystickSensitivity: Double
    @Binding var isCollapsed: Bool
    @Binding var offset: CGSize
    let containerSize: CGSize
    let compact: Bool
    let diagnosticsText: String
    let actions: [RemoteActionDescriptor]
    let keyboardVisible: Bool
    let onKeyboardFocus: () -> Void
    let anchor: Anchor

    @GestureState private var dragState = DragState()

    var body: some View {
        ZStack(alignment: anchor.alignment) {
            Group {
                if isCollapsed {
                    collapsedButton
                } else {
                    expandedPanel
                }
            }
            .frame(width: panelWidth)
            .offset(x: offset.width + dragState.translation.width, y: offset.height + dragState.translation.height)
            .transaction { transaction in
                transaction.animation = nil
                transaction.disablesAnimations = true
            }
            .fixedSize(horizontal: true, vertical: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: anchor.alignment)
        .animation(nil, value: dragState)
        .animation(nil, value: offset)
    }

    private var expandedPanel: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Capsule()
                    .fill(.secondary.opacity(0.35))
                    .frame(width: 36, height: 5)

                Text("Controls")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)

                Spacer()

                Button {
                    withAnimation(.spring(response: 0.24, dampingFraction: 0.82)) {
                        isCollapsed = true
                    }
                } label: {
                    Image(systemName: "chevron.down")
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(.plain)
            }
            .contentShape(Rectangle())
            .gesture(dragGesture)

            RemoteControlDeck(
                client: client,
                zoom: $zoom,
                panOffset: $panOffset,
                joystickSensitivity: $joystickSensitivity,
                diagnosticsText: diagnosticsText,
                actions: actions,
                keyboardVisible: keyboardVisible,
                onKeyboardFocus: onKeyboardFocus,
                compact: compact
            )
        }
        .padding(12)
        .remoteFloatingSurface(cornerRadius: 22, shadow: false)
    }

    private var collapsedButton: some View {
        Image(systemName: "gamecontroller")
            .font(.system(size: 20, weight: .semibold))
            .frame(width: 54, height: 54)
            .contentShape(Rectangle())
            .remoteFloatingSurface(cornerRadius: 27, shadow: false)
            .onTapGesture {
                openPanel()
            }
            .simultaneousGesture(dragGesture)
            .accessibilityLabel("Show joystick controls")
            .accessibilityAddTraits(.isButton)
    }

    private func openPanel() {
        withAnimation(.spring(response: 0.24, dampingFraction: 0.82)) {
            isCollapsed = false
        }
    }

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 8)
            .updating($dragState) { value, state, _ in
                state = DragState(translation: value.translation, isActive: true)
            }
            .onEnded { value in
                withoutDragAnimation {
                    offset = clamped(
                        CGSize(
                            width: offset.width + value.translation.width,
                            height: offset.height + value.translation.height
                        )
                    )
                }
            }
    }

    private var panelWidth: CGFloat {
        if isCollapsed {
            return 56
        }
        return compact ? min(430, containerSize.width * 0.54) : min(620, containerSize.width - 24)
    }

    private func clamped(_ value: CGSize) -> CGSize {
        let horizontalLimit = max(0, containerSize.width - panelWidth - 4)
        let verticalLimit = max(0, containerSize.height - 80)
        let minX = anchor == .leading ? 0 : -horizontalLimit
        let maxX = anchor == .leading ? horizontalLimit : 0
        return CGSize(
            width: min(maxX, max(minX, value.width)),
            height: min(0, max(-verticalLimit, value.height))
        )
    }

    private func withoutDragAnimation(_ updates: () -> Void) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction, updates)
    }
}

struct RemoteControlDeck: View {
    let client: RemoteDesktopClient
    @Binding var zoom: Double
    @Binding var panOffset: CGSize
    @Binding var joystickSensitivity: Double
    let diagnosticsText: String
    let actions: [RemoteActionDescriptor]
    let keyboardVisible: Bool
    let onKeyboardFocus: () -> Void
    let compact: Bool

    var body: some View {
        if compact {
            compactBody
        } else {
            regularBody
        }
    }

    private var regularBody: some View {
        VStack(spacing: 12) {
            HStack {
                Label(diagnosticsText, systemImage: "waveform.path.ecg")
                    .font(.caption2.weight(.semibold))
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
                Spacer()
            }

            HStack(spacing: 10) {
                RemoteIconButton("minus.magnifyingglass") {
                    setZoom(zoom - RemoteViewportSettings.zoomStep)
                }
                RemoteIconButton("plus.magnifyingglass") {
                    setZoom(zoom + RemoteViewportSettings.zoomStep)
                }
                RemoteIconButton("scope") {
                    resetViewport()
                }
                RemoteIconButton("keyboard") {
                    onKeyboardFocus()
                }
                RemoteIconButton("xmark.circle") {
                    client.sendKey("Escape", code: "Escape")
                }
                RemoteShortcutMenu(client: client, actions: actions)
            }

            HStack(alignment: .center, spacing: 14) {
                RemoteJoystick { dx, dy in
                    client.nudgePointer(dx: dx * joystickSensitivity, dy: dy * joystickSensitivity)
                }

                VStack(spacing: 8) {
                    HStack(spacing: 8) {
                        Button("Left") { client.sendClick(button: "left") }
                        Button("Right") { client.sendClick(button: "right") }
                        Button("Double") { client.sendDoubleClick() }
                    }
                    .buttonStyle(.borderedProminent)

                    HStack(spacing: 8) {
                        RemoteIconButton("arrow.up") { client.sendKey("ArrowUp", code: "ArrowUp") }
                        RemoteIconButton("arrow.down") { client.sendKey("ArrowDown", code: "ArrowDown") }
                        RemoteIconButton("arrow.left") { client.sendKey("ArrowLeft", code: "ArrowLeft") }
                        RemoteIconButton("arrow.right") { client.sendKey("ArrowRight", code: "ArrowRight") }
                        RemoteIconButton("arrow.up.arrow.down") { client.sendWheel(deltaY: -360) }
                        RemoteIconButton("arrow.down.arrow.up") { client.sendWheel(deltaY: 360) }
                    }

                    HStack(spacing: 8) {
                        Button("Tab") { client.sendKey("Tab", code: "Tab") }
                        Button("Enter") { client.sendKey("Enter", code: "Enter") }
                        Button("Bksp") { client.sendKey("Backspace", code: "Backspace") }
                        Button("Space") { client.sendKey(" ", code: "Space") }
                    }
                    .buttonStyle(.bordered)
                    .font(.caption.weight(.semibold))

                    HStack(spacing: 8) {
                        Image(systemName: "speedometer")
                            .foregroundStyle(.secondary)
                        Slider(value: $joystickSensitivity, in: 0.45...1.8)
                        Text("\(Int(joystickSensitivity * 100))%")
                            .font(.caption2.monospacedDigit().weight(.semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: 42, alignment: .trailing)
                    }
                }
            }
        }
    }

    private var compactBody: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Label(diagnosticsText, systemImage: "waveform.path.ecg")
                    .font(.caption2.weight(.semibold))
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
                Spacer()
                RemoteShortcutMenu(client: client, actions: actions)
            }

            HStack(alignment: .center, spacing: 12) {
                RemoteJoystick(diameter: 84) { dx, dy in
                    client.nudgePointer(dx: dx * joystickSensitivity, dy: dy * joystickSensitivity)
                }

                VStack(spacing: 8) {
                    HStack(spacing: 8) {
                        RemoteIconButton("minus.magnifyingglass") { setZoom(zoom - RemoteViewportSettings.zoomStep) }
                        RemoteIconButton("plus.magnifyingglass") { setZoom(zoom + RemoteViewportSettings.zoomStep) }
                        RemoteIconButton("scope") {
                            resetViewport()
                        }
                        RemoteIconButton("keyboard") { onKeyboardFocus() }
                        RemoteIconButton("xmark.circle") { client.sendKey("Escape", code: "Escape") }
                    }

                    HStack(spacing: 8) {
                        Button("Left") { client.sendClick(button: "left") }
                        Button("Right") { client.sendClick(button: "right") }
                        Button("Double") { client.sendDoubleClick() }
                    }
                    .buttonStyle(.borderedProminent)
                    .font(.caption2.weight(.semibold))

                    HStack(spacing: 8) {
                        RemoteIconButton("arrow.up") { client.sendKey("ArrowUp", code: "ArrowUp") }
                        RemoteIconButton("arrow.down") { client.sendKey("ArrowDown", code: "ArrowDown") }
                        RemoteIconButton("arrow.left") { client.sendKey("ArrowLeft", code: "ArrowLeft") }
                        RemoteIconButton("arrow.right") { client.sendKey("ArrowRight", code: "ArrowRight") }
                    }

                    HStack(spacing: 8) {
                        Image(systemName: "speedometer")
                            .foregroundStyle(.secondary)
                        Slider(value: $joystickSensitivity, in: 0.45...1.8)
                    }
                }
            }
        }
    }

    private func setZoom(_ value: Double) {
        zoom = min(RemoteViewportSettings.maximumZoom, max(RemoteViewportSettings.minimumZoom, value))
        if zoom <= 1.01 {
            panOffset = .zero
        }
    }

    private func resetViewport() {
        zoom = RemoteViewportSettings.minimumZoom
        panOffset = .zero
    }
}

struct RemoteShortcutMenu: View {
    let client: RemoteDesktopClient
    let actions: [RemoteActionDescriptor]

    var body: some View {
        Menu {
            if actions.isEmpty {
                ForEach(RemoteShortcut.allCases) { shortcut in
                    Button {
                        client.sendShortcut(shortcut)
                    } label: {
                        Label(shortcut.title, systemImage: shortcut.systemImage)
                    }
                }
            } else {
                ForEach(actions) { action in
                    Button {
                        client.sendAction(action)
                    } label: {
                        Label(action.label, systemImage: systemImage(for: action.id))
                    }
                }
            }
        } label: {
            Image(systemName: "command")
                .frame(width: 34, height: 34)
        }
        .buttonStyle(.plain)
        .remoteControlButtonSurface(cornerRadius: 17)
        .accessibilityLabel("Remote shortcuts")
    }

    private func systemImage(for actionId: String) -> String {
        switch actionId {
        case "copy":
            return "doc.on.doc"
        case "paste":
            return "clipboard"
        case "selectAll":
            return "textformat"
        case "altTab", "winTab":
            return "rectangle.stack"
        case "showDesktop":
            return "desktopcomputer"
        case "taskManager":
            return "speedometer"
        case "lock":
            return "lock"
        case "screenshot":
            return "camera.viewfinder"
        default:
            return "command"
        }
    }
}

struct RemoteJoystick: View {
    var diameter: CGFloat = 108
    let onNudge: (CGFloat, CGFloat) -> Void
    @State private var knobOffset = CGSize.zero

    var body: some View {
        ZStack {
            Circle()
                .fill(.secondary.opacity(0.18))
                .frame(width: diameter, height: diameter)
            Circle()
                .fill(.primary.opacity(0.20))
                .frame(width: diameter * 0.39, height: diameter * 0.39)
                .offset(knobOffset)
        }
        .contentShape(Circle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    let radius: CGFloat = diameter * 0.39
                    let dx = min(radius, max(-radius, value.translation.width))
                    let dy = min(radius, max(-radius, value.translation.height))
                    knobOffset = CGSize(width: dx, height: dy)
                    onNudge(dx / radius * 0.026, dy / radius * 0.026)
                }
                .onEnded { _ in
                    withAnimation(.spring(response: 0.22, dampingFraction: 0.72)) {
                        knobOffset = .zero
                    }
                }
        )
        .accessibilityLabel("Pointer joystick")
    }
}

struct RemoteIconButton: View {
    let systemName: String
    let action: () -> Void

    init(_ systemName: String, action: @escaping () -> Void) {
        self.systemName = systemName
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .frame(width: 34, height: 34)
        }
        .buttonStyle(.plain)
        .remoteControlButtonSurface(cornerRadius: 17)
    }
}

private extension View {
    func remoteFloatingSurface(cornerRadius: CGFloat, shadow: Bool = true) -> some View {
        self
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Color(uiColor: .secondarySystemBackground).opacity(0.98))
            )
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(.white.opacity(0.18), lineWidth: 1)
            }
            .shadow(color: shadow ? .black.opacity(0.22) : .clear, radius: shadow ? 18 : 0, x: 0, y: shadow ? 8 : 0)
    }

    func remoteControlButtonSurface(cornerRadius: CGFloat) -> some View {
        self
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Color(uiColor: .tertiarySystemBackground).opacity(0.98))
            )
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(.white.opacity(0.16), lineWidth: 1)
            }
    }
}

struct ThreadsView: View {
    @Environment(AppModel.self) private var app
    @State private var search = ""
    @State private var statusFilter: ThreadStatusFilter = .all

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ThreadSummaryStrip(summary: app.codexSummary, threads: app.codexSessions)

                    VStack(spacing: 10) {
                        TextField("Search threads, cwd, model", text: $search)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textFieldStyle(.roundedBorder)

                        Picker("Resume status", selection: $statusFilter) {
                            ForEach(ThreadStatusFilter.allCases) { filter in
                                Text(filter.title).tag(filter)
                            }
                        }
                        .pickerStyle(.segmented)
                    }

                    if filteredThreads.isEmpty {
                        ContentUnavailableView(
                            "No threads found",
                            systemImage: "bubble.left.and.text.bubble.right",
                            description: Text("The current filters have no matching Codex threads.")
                        )
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                    } else {
                        ForEach(filteredThreads) { thread in
                            CodexThreadCard(thread: thread)
                        }
                    }
                }
                .padding(16)
            }
            .navigationTitle("Threads")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ConnectionBadge(text: app.connectionMessage)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await app.refreshCodexSessions() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh Codex threads")
                }
            }
            .task {
                await app.refreshCodexSessions()
                await app.refreshSessions()
            }
        }
    }

    private var filteredThreads: [CodexSessionSummary] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return app.codexSessions.filter { thread in
            statusFilter.includes(thread)
            && (query.isEmpty || thread.searchText.contains(query))
        }
    }
}

struct ThreadSummaryStrip: View {
    let summary: CodexSummary?
    let threads: [CodexSessionSummary]

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            MetricTile(title: "Threads", value: "\(summary?.sessionCount ?? summary?.totalSessions ?? threads.count)", systemImage: "bubble.left.and.text.bubble.right")
            MetricTile(title: "Tokens", value: (summary?.totalTokens ?? threadTokens).formatted(.number.notation(.compactName)), systemImage: "number")
            MetricTile(title: "Tool Calls", value: (summary?.totalToolCalls ?? threadTools).formatted(.number.notation(.compactName)), systemImage: "wrench.and.screwdriver")
            MetricTile(title: "Resumable", value: "\(summary?.resumableSessionCount ?? threads.filter(\.isThreadResumable).count)", systemImage: "arrow.uturn.backward")
        }
    }

    private var threadTokens: Int {
        threads.reduce(0) { $0 + $1.tokenCount }
    }

    private var threadTools: Int {
        threads.reduce(0) { $0 + $1.toolCallCount }
    }
}

struct CodexThreadCard: View {
    @Environment(AppModel.self) private var app
    let thread: CodexSessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: thread.isThreadResumable ? "checkmark.circle.fill" : "exclamationmark.circle")
                    .foregroundStyle(thread.isThreadResumable ? .green : .orange)
                    .font(.title3)

                VStack(alignment: .leading, spacing: 4) {
                    Text(thread.title)
                        .font(.headline)
                    Text(thread.id)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer()
            }

            HStack(spacing: 6) {
                Chip(text: thread.resumeLabel)
                Chip(text: thread.metricsQualityLabel)
                Chip(text: "\(thread.tokenCount.formatted(.number.notation(.compactName))) tokens")
                Chip(text: "\(thread.toolCallCount.formatted(.number.notation(.compactName))) tools")
            }

            Text(thread.metadataLine)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3)

            HStack {
                Button {
                    Task {
                        await app.resumeCodexSession(thread, into: app.fallbackTerminalSessionId)
                    }
                } label: {
                    Label("Resume in Terminal", systemImage: "arrow.uturn.backward")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!thread.isThreadResumable || app.fallbackTerminalSessionId == nil)

                Button {
                    UIPasteboard.general.string = thread.resumeCommand ?? "codex resume \(thread.id)"
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Copy resume command")
                .disabled(!thread.isThreadResumable)
            }
        }
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

enum ThreadStatusFilter: String, CaseIterable, Identifiable {
    case all
    case resumable
    case blocked
    case unknown

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all:
            return "All"
        case .resumable:
            return "Resumable"
        case .blocked:
            return "Blocked"
        case .unknown:
            return "Unknown"
        }
    }

    func includes(_ thread: CodexSessionSummary) -> Bool {
        switch self {
        case .all:
            return true
        case .resumable:
            return thread.resumeStatusValue == .resumable
        case .blocked:
            return thread.resumeStatusValue == .blocked
        case .unknown:
            return thread.resumeStatusValue == .unknown
        }
    }
}

struct MetricsView: View {
    @Environment(AppModel.self) private var app
    @State private var search = ""
    @State private var statusFilter: ThreadStatusFilter = .all
    @State private var modelFilter = ""
    @State private var cwdFilter = ""
    @State private var month = Date()
    @State private var selectedDay: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    MetricsFilterPanel(
                        search: $search,
                        statusFilter: $statusFilter,
                        modelFilter: $modelFilter,
                        cwdFilter: $cwdFilter,
                        month: $month,
                        models: modelOptions,
                        cwds: cwdOptions,
                        onClear: clearFilters
                    )

                    MetricsSummaryGrid(threads: filteredThreads)

                    MetricsCalendarView(
                        month: month,
                        threads: filteredBeforeSelectedDay,
                        selectedDay: $selectedDay
                    )

                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Label("Filtered Threads", systemImage: "line.3.horizontal.decrease.circle")
                                .font(.headline)
                            Spacer()
                            Text("\(filteredThreads.count) results")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }

                        ForEach(filteredThreads.prefix(160)) { thread in
                            MetricsThreadRow(thread: thread)
                        }
                    }
                }
                .padding(16)
            }
            .navigationTitle("Metrics")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await app.refreshCodexSessions() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .task {
                await app.refreshCodexSessions()
                if let newest = app.codexSessions.compactMap(\.metricDate).max() {
                    month = newest
                }
            }
        }
    }

    private var filteredBeforeSelectedDay: [CodexSessionSummary] {
        filteredThreads(includeSelectedDay: false)
    }

    private var filteredThreads: [CodexSessionSummary] {
        filteredThreads(includeSelectedDay: true)
    }

    private func filteredThreads(includeSelectedDay: Bool) -> [CodexSessionSummary] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return app.codexSessions.filter { thread in
            guard statusFilter.includes(thread) else { return false }
            if !modelFilter.isEmpty && thread.model != modelFilter { return false }
            if !cwdFilter.isEmpty && thread.cwd != cwdFilter { return false }
            if includeSelectedDay, let selectedDay, thread.metricDayKey != selectedDay { return false }
            if !query.isEmpty && !thread.searchText.contains(query) { return false }
            return true
        }
    }

    private var modelOptions: [String] {
        uniqueSorted(app.codexSessions.compactMap(\.model))
    }

    private var cwdOptions: [String] {
        uniqueSorted(app.codexSessions.compactMap(\.cwd))
    }

    private func uniqueSorted(_ values: [String]) -> [String] {
        Array(Set(values.filter { !$0.isEmpty })).sorted()
    }

    private func clearFilters() {
        search = ""
        statusFilter = .all
        modelFilter = ""
        cwdFilter = ""
        selectedDay = nil
    }
}

struct MetricsFilterPanel: View {
    @Binding var search: String
    @Binding var statusFilter: ThreadStatusFilter
    @Binding var modelFilter: String
    @Binding var cwdFilter: String
    @Binding var month: Date
    let models: [String]
    let cwds: [String]
    let onClear: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            TextField("Search id, cwd, model, store", text: $search)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)

            Picker("Status", selection: $statusFilter) {
                ForEach(ThreadStatusFilter.allCases) { filter in
                    Text(filter.title).tag(filter)
                }
            }
            .pickerStyle(.segmented)

            HStack(spacing: 10) {
                Menu {
                    Button("All models") { modelFilter = "" }
                    ForEach(models, id: \.self) { model in
                        Button(model) { modelFilter = model }
                    }
                } label: {
                    Label(modelFilter.isEmpty ? "All Models" : modelFilter, systemImage: "cpu")
                        .lineLimit(1)
                }
                .buttonStyle(.bordered)

                Menu {
                    Button("All directories") { cwdFilter = "" }
                    ForEach(cwds, id: \.self) { cwd in
                        Button(cwd) { cwdFilter = cwd }
                    }
                } label: {
                    Label(cwdFilter.isEmpty ? "All CWDs" : URL(fileURLWithPath: cwdFilter).lastPathComponent, systemImage: "folder")
                        .lineLimit(1)
                }
                .buttonStyle(.bordered)
            }

            HStack {
                DatePicker("Calendar", selection: $month, displayedComponents: .date)
                    .datePickerStyle(.compact)
                Spacer()
                Button("Clear", action: onClear)
                    .buttonStyle(.bordered)
            }
        }
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

struct MetricsSummaryGrid: View {
    let threads: [CodexSessionSummary]

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            MetricTile(title: "Threads", value: "\(threads.count)", systemImage: "rectangle.stack")
            MetricTile(title: "Tokens", value: totalTokens.formatted(.number.notation(.compactName)), systemImage: "number")
            MetricTile(title: "Tool Calls", value: totalTools.formatted(.number.notation(.compactName)), systemImage: "wrench.and.screwdriver")
            MetricTile(title: "Avg Active", value: formatDuration(averageActiveMs), systemImage: "timer")
        }
    }

    private var totalTokens: Int {
        threads.reduce(0) { $0 + $1.tokenCount }
    }

    private var totalTools: Int {
        threads.reduce(0) { $0 + $1.toolCallCount }
    }

    private var averageActiveMs: Int {
        guard !threads.isEmpty else { return 0 }
        return threads.reduce(0) { $0 + $1.activeMs } / threads.count
    }
}

struct MetricsCalendarView: View {
    let month: Date
    let threads: [CodexSessionSummary]
    @Binding var selectedDay: String?

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 7)
    private let calendar = Calendar.current

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(monthTitle, systemImage: "calendar")
                    .font(.headline)
                Spacer()
                Text(selectedDay ?? "Tap a day")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            LazyVGrid(columns: columns, spacing: 6) {
                ForEach(calendar.shortWeekdaySymbols, id: \.self) { weekday in
                    Text(weekday)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }

                ForEach(leadingBlankDays, id: \.self) { index in
                    Color.clear
                        .frame(height: 46)
                        .accessibilityHidden(true)
                        .id("blank-\(index)")
                }

                ForEach(days, id: \.self) { day in
                    let key = dayKey(day)
                    let stats = dayStats[key] ?? DayStats()
                    Button {
                        guard stats.count > 0 else { return }
                        selectedDay = selectedDay == key ? nil : key
                    } label: {
                        VStack(spacing: 3) {
                            Text("\(day)")
                                .font(.caption.weight(.bold))
                            Text(stats.count > 0 ? "\(stats.count)" : "")
                                .font(.caption2.monospacedDigit())
                        }
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .background(dayBackground(stats: stats, key: key), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(stats.count == 0)
                }
            }
        }
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var monthTitle: String {
        month.formatted(.dateTime.month(.wide).year())
    }

    private var monthStart: Date {
        let components = calendar.dateComponents([.year, .month], from: month)
        return calendar.date(from: components) ?? month
    }

    private var days: [Int] {
        let range = calendar.range(of: .day, in: .month, for: monthStart) ?? 1..<1
        return Array(range)
    }

    private var leadingBlankDays: [Int] {
        let weekday = calendar.component(.weekday, from: monthStart)
        return Array(0..<max(0, weekday - 1))
    }

    private var dayStats: [String: DayStats] {
        threads.reduce(into: [:]) { partial, thread in
            guard let key = thread.metricDayKey, key.hasPrefix(monthStart.monthKey) else { return }
            var stats = partial[key] ?? DayStats()
            stats.count += 1
            stats.tokens += thread.tokenCount
            partial[key] = stats
        }
    }

    private var maxCount: Int {
        dayStats.values.map(\.count).max() ?? 0
    }

    private func dayKey(_ day: Int) -> String {
        "\(monthStart.monthKey)-\(String(format: "%02d", day))"
    }

    private func dayBackground(stats: DayStats, key: String) -> Color {
        guard stats.count > 0, maxCount > 0 else {
            return Color.secondary.opacity(0.08)
        }
        let intensity = Double(stats.count) / Double(maxCount)
        if selectedDay == key {
            return Color.green.opacity(0.55)
        }
        return Color.orange.opacity(0.18 + (intensity * 0.48))
    }
}

struct MetricsThreadRow: View {
    let thread: CodexSessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(thread.id)
                    .font(.caption.monospaced().weight(.semibold))
                    .lineLimit(1)
                Spacer()
                Text(thread.metricDayKey ?? "unknown")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 6) {
                Chip(text: thread.resumeLabel)
                Chip(text: "\(thread.tokenCount.formatted(.number.notation(.compactName))) tok")
                Chip(text: "\(thread.toolCallCount.formatted(.number.notation(.compactName))) tools")
                Chip(text: formatDuration(thread.activeMs))
            }

            Text(thread.metadataLine)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(12)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

struct DayStats: Hashable {
    var count = 0
    var tokens = 0
}

struct MetricTile: View {
    let title: String
    let value: String
    let systemImage: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title3.monospacedDigit().weight(.bold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

struct Chip: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.75)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

struct MetricRow: View {
    let title: String
    let value: String
    let systemImage: String

    var body: some View {
        HStack {
            Label(title, systemImage: systemImage)
            Spacer()
            Text(value)
                .font(.title3.monospacedDigit().weight(.semibold))
        }
    }
}

enum CodexResumeStatus {
    case resumable
    case blocked
    case unknown
}

extension CodexSessionSummary {
    var isThreadResumable: Bool {
        isResumable != false && resumeStatusValue != .blocked
    }

    var resumeStatusValue: CodexResumeStatus {
        if resumeStatus == "unknown" {
            return .unknown
        }
        if resumeStatus == "not_resumable" || isResumable == false {
            return .blocked
        }
        if isResumable == true || resumeStatus == "resumable" {
            return .resumable
        }
        return .unknown
    }

    var resumeLabel: String {
        switch resumeStatusValue {
        case .resumable:
            return "resumable"
        case .blocked:
            return "blocked"
        case .unknown:
            return "unknown"
        }
    }

    var metricsQualityLabel: String {
        switch metricsQuality {
        case "complete":
            return "metrics complete"
        case "partial":
            return "metrics partial"
        case "estimated":
            return "metrics estimated"
        default:
            return metrics == nil ? "metrics estimated" : "metrics partial"
        }
    }

    var tokenCount: Int {
        metrics?.totalTokenUsage?.totalTokens ?? 0
    }

    var toolCallCount: Int {
        metrics?.toolCalls ?? 0
    }

    var activeMs: Int {
        if let activeDurationMs, activeDurationMs > 0 {
            return activeDurationMs
        }
        return elapsedMs
    }

    var elapsedMs: Int {
        if let elapsedDurationMs, elapsedDurationMs > 0 {
            return elapsedDurationMs
        }
        return durationMs ?? 0
    }

    var metricDate: Date? {
        [lastPromptAt, endedAt, startedAt]
            .compactMap { $0 }
            .compactMap(Self.parseDate(_:))
            .first
    }

    var metricDayKey: String? {
        metricDate?.dayKey
    }

    var searchText: String {
        [
            id,
            cwd,
            model,
            cliVersion,
            fileName,
            storeCodexHome,
            resumeStatus,
            resumeReason
        ]
        .compactMap { $0 }
        .joined(separator: " ")
        .lowercased()
    }

    var metadataLine: String {
        var parts = [
            "cwd: \(cwd ?? "Unknown")",
            "model: \(model ?? "Unknown")",
            "time: \(formattedThreadTime)"
        ]
        if let storeCodexHome, !storeCodexHome.isEmpty {
            parts.append("store: \(storeCodexHome)")
        }
        if let resumeReason, !resumeReason.isEmpty {
            parts.append("resume: \(resumeReason)")
        }
        return parts.joined(separator: " | ")
    }

    private var formattedThreadTime: String {
        guard let metricDate else { return "Unknown" }
        return metricDate.formatted(date: .abbreviated, time: .shortened)
    }

    private static func parseDate(_ value: String) -> Date? {
        isoFormatterWithFractions.date(from: value) ?? isoFormatter.date(from: value)
    }

    private static let isoFormatterWithFractions: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoFormatter = ISO8601DateFormatter()
}

extension Date {
    var dayKey: String {
        Self.dayFormatter.string(from: self)
    }

    var monthKey: String {
        Self.monthFormatter.string(from: self)
    }

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static let monthFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM"
        return formatter
    }()
}

func formatDuration(_ milliseconds: Int) -> String {
    guard milliseconds > 0 else { return "0m" }
    let seconds = milliseconds / 1_000
    let hours = seconds / 3_600
    let minutes = (seconds % 3_600) / 60
    let remainingSeconds = seconds % 60
    if hours > 0 {
        return "\(hours)h \(minutes)m"
    }
    if minutes > 0 {
        return "\(minutes)m \(remainingSeconds)s"
    }
    return "\(remainingSeconds)s"
}

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var draftURL = ""
    @State private var draftRemoteMode: RemoteMode = .view
    @State private var draftStreamProfile: RemoteStreamProfile = .balanced
    @State private var preferNativeRemote = true

    var body: some View {
        NavigationStack {
            Form {
                Section("Connection") {
                    TextField("Tailnet URL", text: $draftURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Button("Save and Test") {
                        app.settings.baseURLString = draftURL
                        Task { await app.refreshAll() }
                    }

                    LabeledContent("Status", value: app.connectionMessage)
                }

                Section("Remote") {
                    Picker("Default Mode", selection: $draftRemoteMode) {
                        ForEach(RemoteMode.allCases) { mode in
                            Text(mode.title).tag(mode)
                        }
                    }
                    .onChange(of: draftRemoteMode) { _, newValue in
                        app.settings.defaultRemoteMode = newValue
                    }

                    Picker("Stream Profile", selection: $draftStreamProfile) {
                        ForEach(RemoteStreamProfile.allCases) { profile in
                            Label(profile.title, systemImage: profile.systemImage).tag(profile)
                        }
                    }
                    .onChange(of: draftStreamProfile) { _, newValue in
                        app.settings.remoteStreamProfile = newValue
                    }

                    Toggle("Prefer native remote desktop", isOn: $preferNativeRemote)
                        .onChange(of: preferNativeRemote) { _, newValue in
                            app.settings.preferNativeRemote = newValue
                        }

                    if let status = app.remoteStatus {
                        LabeledContent("Enabled", value: status.enabled ? "Yes" : "No")
                        LabeledContent("Sidecar", value: status.sidecar.reachable ? "Reachable" : "Offline")
                        LabeledContent("Input", value: status.sidecar.inputAvailable ? "Available" : "Unavailable")
                        if let gateway = status.gateway {
                            LabeledContent("Active Clients", value: "\((gateway.activeConnections ?? 0))")
                            LabeledContent("Control Clients", value: "\((gateway.controlConnections ?? 0))")
                        }
                    }

                    if let capabilities = app.remoteCapabilities {
                        LabeledContent("Presets", value: "\(capabilities.streamPresets.count)")
                        LabeledContent("Actions", value: "\(capabilities.actions.count)")
                    }
                }
            }
            .navigationTitle("Settings")
            .onAppear {
                draftURL = app.settings.baseURLString
                draftRemoteMode = app.settings.defaultRemoteMode
                draftStreamProfile = app.settings.remoteStreamProfile
                preferNativeRemote = app.settings.preferNativeRemote
            }
        }
    }
}

struct ConnectionBadge: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .nativeGlass(cornerRadius: 14)
    }
}
