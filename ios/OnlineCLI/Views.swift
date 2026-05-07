import SwiftUI
import UIKit

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
                            NativeTerminalView(client: client)
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
                    ConnectionBadge(text: app.connectionMessage)
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
    @State private var zoom = 1.0
    @State private var panOffset = CGSize.zero
    @State private var panMode = false
    @State private var joystickSensitivity = 1.0
    @State private var keyboardText = ""
    @State private var controlsCollapsed = true
    @State private var controlsOffset = CGSize.zero
    @State private var interfaceIsLandscape = false
    @FocusState private var keyboardFocused: Bool

    var body: some View {
        NavigationStack {
            GeometryReader { proxy in
                let isLandscape = proxy.size.width > proxy.size.height || verticalSizeClass == .compact || interfaceIsLandscape

                ZStack {
                    Color.black.ignoresSafeArea()

                    RemoteStageView(
                        image: client.frameImage,
                        zoom: zoom,
                        panOffset: panOffset,
                        panMode: panMode,
                        remoteCursor: client.remoteCursor,
                        onPointerMove: { client.sendPointerMove($0) },
                        onClick: { point in client.sendClick(at: point) },
                        onPan: { delta in panOffset.width += delta.width; panOffset.height += delta.height }
                    )
                    .ignoresSafeArea(edges: .bottom)

                    VStack(spacing: 0) {
                        HStack {
                            RemoteTopOverlay(
                                state: client.connectionState,
                                status: client.statusText,
                                fps: client.frameFps,
                                latency: client.frameLatencyMs,
                                frameBytes: client.frameBytes,
                                displayInfo: client.displayInfo,
                                mode: $desiredMode,
                                profile: $streamProfile,
                                panMode: $panMode,
                                compact: true,
                                onConnect: connect,
                                onDisconnect: client.disconnect,
                                onModeChange: { mode in
                                    desiredMode = mode
                                    client.setMode(mode)
                                },
                                onProfileChange: { profile in
                                    streamProfile = profile
                                    app.settings.remoteStreamProfile = profile
                                    client.setStreamProfile(profile)
                                }
                            )
                            .frame(maxWidth: min(isLandscape ? 300 : 360, proxy.size.width - 24))
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 12)
                        .padding(.top, 8)

                        Spacer()
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
                        keyboardFocused: $keyboardFocused
                    )
                    .padding(12)

                    TextField("", text: $keyboardText)
                        .focused($keyboardFocused)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .frame(width: 1, height: 1)
                        .opacity(0.01)
                        .onChange(of: keyboardText) { _, newValue in
                            guard !newValue.isEmpty else { return }
                            client.sendText(newValue)
                            keyboardText = ""
                        }
                }
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
                Task {
                    await app.refreshRemoteStatus()
                    await app.refreshRemoteCapabilities()
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIDevice.orientationDidChangeNotification)) { _ in
                updateInterfaceOrientation()
            }
            .onDisappear {
                client.disconnect()
            }
        }
    }

    private func connect() {
        guard let url = app.settings.normalizedBaseURL else {
            client.connectionState = .failed("Set a tailnet URL")
            return
        }
        client.connect(baseURL: url, desiredMode: desiredMode, streamProfile: streamProfile)
    }

    private func updateInterfaceOrientation() {
        interfaceIsLandscape = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.interfaceOrientation }
            .first?
            .isLandscape == true
    }

    private var diagnosticsText: String {
        let queue = client.inputQueueMax.map { "queue \($0)" } ?? "queue --"
        let rate = client.inputRateLimitPerSec.map { "\($0)/s" } ?? "--/s"
        let dropped = client.droppedEvents > 0 ? " • dropped \(client.droppedEvents)" : ""
        return "Input \(rate), \(queue)\(dropped)"
    }
}

struct RemoteStageView: View {
    let image: UIImage?
    let zoom: Double
    let panOffset: CGSize
    let panMode: Bool
    let remoteCursor: CGPoint?
    let onPointerMove: (CGPoint) -> Void
    let onClick: (CGPoint) -> Void
    let onPan: (CGSize) -> Void

    @State private var dragStart = CGPoint.zero
    @State private var lastPanTranslation = CGSize.zero

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .interpolation(.medium)
                        .aspectRatio(contentMode: .fit)
                        .scaleEffect(zoom)
                        .offset(panOffset)
                    if let remoteCursor, let cursorPoint = denormalize(remoteCursor, in: proxy.size, image: image) {
                        Image(systemName: "cursorarrow")
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundStyle(.white)
                            .shadow(color: .black.opacity(0.8), radius: 2, x: 0, y: 1)
                            .position(cursorPoint)
                    }
                } else {
                    VStack(spacing: 14) {
                        Image(systemName: "display.trianglebadge.exclamationmark")
                            .font(.system(size: 42))
                        Text("Connect to start the remote desktop stream")
                            .font(.headline)
                    }
                    .foregroundStyle(.white.opacity(0.72))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        if panMode {
                            let delta = CGSize(
                                width: value.translation.width - lastPanTranslation.width,
                                height: value.translation.height - lastPanTranslation.height
                            )
                            lastPanTranslation = value.translation
                            onPan(delta)
                        } else {
                            dragStart = value.startLocation
                            if let normalized = normalize(value.location, in: proxy.size, image: image) {
                                onPointerMove(normalized)
                            }
                        }
                    }
                    .onEnded { value in
                        defer { lastPanTranslation = .zero }
                        guard !panMode else { return }
                        let distance = hypot(value.location.x - dragStart.x, value.location.y - dragStart.y)
                        if distance < 10, let normalized = normalize(value.location, in: proxy.size, image: image) {
                            onClick(normalized)
                        }
                    }
            )
        }
    }

    private func normalize(_ location: CGPoint, in container: CGSize, image: UIImage?) -> CGPoint? {
        guard let image else { return nil }
        let imageSize = image.size
        let scale = min(container.width / imageSize.width, container.height / imageSize.height) * zoom
        let displaySize = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
        let origin = CGPoint(
            x: (container.width - displaySize.width) / 2 + panOffset.width,
            y: (container.height - displaySize.height) / 2 + panOffset.height
        )
        let x = (location.x - origin.x) / displaySize.width
        let y = (location.y - origin.y) / displaySize.height
        guard x.isFinite, y.isFinite else { return nil }
        return CGPoint(x: min(1, max(0, x)), y: min(1, max(0, y)))
    }

    private func denormalize(_ point: CGPoint, in container: CGSize, image: UIImage?) -> CGPoint? {
        guard let image else { return nil }
        let imageSize = image.size
        let scale = min(container.width / imageSize.width, container.height / imageSize.height) * zoom
        let displaySize = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
        let origin = CGPoint(
            x: (container.width - displaySize.width) / 2 + panOffset.width,
            y: (container.height - displaySize.height) / 2 + panOffset.height
        )
        return CGPoint(
            x: origin.x + displaySize.width * min(1, max(0, point.x)),
            y: origin.y + displaySize.height * min(1, max(0, point.y))
        )
    }
}

struct RemoteTopOverlay: View {
    let state: RemoteConnectionState
    let status: String
    let fps: Double
    let latency: Double?
    let frameBytes: Int
    let displayInfo: RemoteDisplayInfo?
    @Binding var mode: RemoteMode
    @Binding var profile: RemoteStreamProfile
    @Binding var panMode: Bool
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
        .nativeGlass(cornerRadius: compact ? 18 : 24)
    }

    private var regularBody: some View {
        VStack(spacing: 10) {
            headerRow

            HStack(spacing: 10) {
                modePicker
                    .pickerStyle(.segmented)

                streamPicker
                    .pickerStyle(.menu)

                panToggle
            }
        }
    }

    private var compactBody: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(state.title)
                    .font(.caption.weight(.semibold))
                Text(compactStatusLine)
                    .font(.caption2)
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
                Text(state.title)
                    .font(.headline)
                Text(statusLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()
            connectButton
        }
    }

    private var connectButton: some View {
        Button {
            if case .connected = state {
                onDisconnect()
            } else {
                onConnect()
            }
        } label: {
            Image(systemName: isConnected ? "stop.fill" : "play.fill")
                .frame(width: 34, height: 34)
        }
        .nativeGlass(cornerRadius: 17, interactive: true)
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

    private var panToggle: some View {
        Toggle(isOn: $panMode) {
            Image(systemName: "hand.draw")
        }
        .toggleStyle(.button)
        .labelStyle(.iconOnly)
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

            Button {
                panMode.toggle()
            } label: {
                Label(panMode ? "Disable Pan" : "Enable Pan", systemImage: "hand.draw")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .frame(width: 34, height: 34)
        }
        .buttonStyle(.plain)
        .nativeGlass(cornerRadius: 17, interactive: true)
    }

    private var isConnected: Bool {
        if case .connected = state {
            return true
        }
        return false
    }

    private var statusLine: String {
        let latencyText = latency.map { " • \(Int($0)) ms" } ?? ""
        let sizeText = displayInfo.flatMap { display -> String? in
            guard let width = display.width, let height = display.height else { return nil }
            return " • \(width)x\(height)"
        } ?? ""
        let bytesText = frameBytes > 0 ? " • \(ByteCountFormatter.string(fromByteCount: Int64(frameBytes), countStyle: .file))" : ""
        return "\(status) • \(String(format: "%.1f", fps)) fps\(latencyText)\(sizeText)\(bytesText)"
    }

    private var compactStatusLine: String {
        let latencyText = latency.map { " • \(Int($0)) ms" } ?? ""
        return "\(String(format: "%.1f", fps)) fps\(latencyText)"
    }
}

struct FloatingRemoteControls: View {
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
    var keyboardFocused: FocusState<Bool>.Binding

    @GestureState private var dragTranslation = CGSize.zero

    var body: some View {
        VStack {
            Spacer()
            HStack {
                Spacer()

                Group {
                    if isCollapsed {
                        collapsedButton
                    } else {
                        expandedPanel
                    }
                }
                .frame(maxWidth: panelWidth)
                .offset(x: offset.width + dragTranslation.width, y: offset.height + dragTranslation.height)
            }
        }
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
                keyboardFocused: keyboardFocused,
                compact: compact
            )
        }
        .padding(12)
        .nativeGlass(cornerRadius: 22)
    }

    private var collapsedButton: some View {
        Button {
            withAnimation(.spring(response: 0.24, dampingFraction: 0.82)) {
                isCollapsed = false
            }
        } label: {
            Label("Controls", systemImage: "slider.horizontal.3")
                .labelStyle(.iconOnly)
                .frame(width: 48, height: 48)
        }
        .buttonStyle(.plain)
        .nativeGlass(cornerRadius: 24, interactive: true)
        .simultaneousGesture(dragGesture)
        .accessibilityLabel("Show remote controls")
    }

    private var dragGesture: some Gesture {
        DragGesture()
            .updating($dragTranslation) { value, state, _ in
                state = value.translation
            }
            .onEnded { value in
                offset = clamped(
                    CGSize(
                        width: offset.width + value.translation.width,
                        height: offset.height + value.translation.height
                    )
                )
            }
    }

    private var panelWidth: CGFloat {
        if isCollapsed {
            return 56
        }
        return compact ? min(430, containerSize.width * 0.54) : min(620, containerSize.width - 24)
    }

    private func clamped(_ value: CGSize) -> CGSize {
        let horizontalLimit = max(0, (containerSize.width - panelWidth) / 2)
        let verticalLimit = max(0, (containerSize.height - 80) / 2)
        return CGSize(
            width: min(horizontalLimit, max(-horizontalLimit, value.width)),
            height: min(verticalLimit, max(-verticalLimit, value.height))
        )
    }
}

struct RemoteControlDeck: View {
    let client: RemoteDesktopClient
    @Binding var zoom: Double
    @Binding var panOffset: CGSize
    @Binding var joystickSensitivity: Double
    let diagnosticsText: String
    let actions: [RemoteActionDescriptor]
    var keyboardFocused: FocusState<Bool>.Binding
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
                    zoom = max(1, zoom - 0.25)
                }
                RemoteIconButton("plus.magnifyingglass") {
                    zoom = min(3.5, zoom + 0.25)
                }
                RemoteIconButton("scope") {
                    zoom = 1
                    panOffset = .zero
                }
                RemoteIconButton("keyboard") {
                    keyboardFocused.wrappedValue = true
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
                        RemoteIconButton("minus.magnifyingglass") { zoom = max(1, zoom - 0.25) }
                        RemoteIconButton("plus.magnifyingglass") { zoom = min(3.5, zoom + 0.25) }
                        RemoteIconButton("scope") {
                            zoom = 1
                            panOffset = .zero
                        }
                        RemoteIconButton("keyboard") { keyboardFocused.wrappedValue = true }
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
        .nativeGlass(cornerRadius: 17, interactive: true)
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
        .nativeGlass(cornerRadius: 17, interactive: true)
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
