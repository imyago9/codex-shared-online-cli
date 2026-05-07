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

            SessionsView()
                .tabItem { Label("Sessions", systemImage: "rectangle.stack") }

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
    @State private var reloadToken = 0

    var body: some View {
        NavigationStack {
            Group {
                if let url = app.settings.normalizedBaseURL {
                    ConsoleWebView(url: url, reloadToken: reloadToken)
                        .ignoresSafeArea(.keyboard, edges: .bottom)
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
                        reloadToken += 1
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Reload terminal")
                }
            }
        }
    }
}

struct RemoteDesktopView: View {
    @Environment(AppModel.self) private var app
    @State private var client = RemoteDesktopClient()
    @State private var desiredMode: RemoteMode = .view
    @State private var streamProfile: RemoteStreamProfile = .balanced
    @State private var zoom = 1.0
    @State private var panOffset = CGSize.zero
    @State private var panMode = false
    @State private var keyboardText = ""
    @FocusState private var keyboardFocused: Bool

    var body: some View {
        NavigationStack {
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
                    .padding(.horizontal, 12)
                    .padding(.top, 8)

                    Spacer()

                    RemoteControlDeck(
                        client: client,
                        zoom: $zoom,
                        panOffset: $panOffset,
                        diagnosticsText: diagnosticsText,
                        actions: app.remoteCapabilities?.actions ?? [],
                        keyboardFocused: $keyboardFocused
                    )
                    .padding(.horizontal, 12)
                    .padding(.bottom, 10)
                }

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
                Task {
                    await app.refreshRemoteStatus()
                    await app.refreshRemoteCapabilities()
                }
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
    let onConnect: () -> Void
    let onDisconnect: () -> Void
    let onModeChange: (RemoteMode) -> Void
    let onProfileChange: (RemoteStreamProfile) -> Void

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(state.title)
                        .font(.headline)
                    Text(statusLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

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

            HStack(spacing: 10) {
                Picker("Mode", selection: $mode) {
                    ForEach(RemoteMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .onChange(of: mode) { _, newMode in
                    onModeChange(newMode)
                }

                Picker("Stream", selection: $profile) {
                    ForEach(RemoteStreamProfile.allCases) { profile in
                        Label(profile.title, systemImage: profile.systemImage).tag(profile)
                    }
                }
                .pickerStyle(.menu)
                .onChange(of: profile) { _, newProfile in
                    onProfileChange(newProfile)
                }

                Toggle(isOn: $panMode) {
                    Image(systemName: "hand.draw")
                }
                .toggleStyle(.button)
                .labelStyle(.iconOnly)
            }
        }
        .padding(12)
        .nativeGlass(cornerRadius: 24)
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
}

struct RemoteControlDeck: View {
    let client: RemoteDesktopClient
    @Binding var zoom: Double
    @Binding var panOffset: CGSize
    let diagnosticsText: String
    let actions: [RemoteActionDescriptor]
    var keyboardFocused: FocusState<Bool>.Binding

    var body: some View {
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
                    client.nudgePointer(dx: dx, dy: dy)
                }

                VStack(spacing: 8) {
                    HStack(spacing: 8) {
                        Button("Left") { client.sendClick(button: "left") }
                        Button("Right") { client.sendClick(button: "right") }
                    }
                    .buttonStyle(.borderedProminent)

                    HStack(spacing: 8) {
                        RemoteIconButton("arrow.up") { client.sendKey("ArrowUp", code: "ArrowUp") }
                        RemoteIconButton("arrow.down") { client.sendKey("ArrowDown", code: "ArrowDown") }
                        RemoteIconButton("arrow.up.arrow.down") { client.sendWheel(deltaY: -360) }
                        RemoteIconButton("arrow.down.arrow.up") { client.sendWheel(deltaY: 360) }
                    }

                    HStack(spacing: 8) {
                        Button("Tab") { client.sendKey("Tab", code: "Tab") }
                        Button("Enter") { client.sendKey("Enter", code: "Enter") }
                        Button("Space") { client.sendKey(" ", code: "Space") }
                    }
                    .buttonStyle(.bordered)
                    .font(.caption.weight(.semibold))
                }
            }
        }
        .padding(12)
        .nativeGlass(cornerRadius: 26)
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
    let onNudge: (CGFloat, CGFloat) -> Void
    @State private var knobOffset = CGSize.zero

    var body: some View {
        ZStack {
            Circle()
                .fill(.secondary.opacity(0.18))
                .frame(width: 108, height: 108)
            Circle()
                .fill(.primary.opacity(0.20))
                .frame(width: 42, height: 42)
                .offset(knobOffset)
        }
        .contentShape(Circle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    let radius: CGFloat = 42
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

struct SessionsView: View {
    @Environment(AppModel.self) private var app
    @State private var command = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(app.sessions) { session in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(session.displayName)
                                        .font(.headline)
                                    Text(session.cwd ?? "No working directory")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                Spacer()
                                if session.id == app.defaultSessionId {
                                    Text("Default")
                                        .font(.caption2.weight(.bold))
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 4)
                                        .nativeGlass(cornerRadius: 10)
                                }
                            }

                            HStack {
                                Button("Restart") { Task { await app.restartSession(session) } }
                                Button("Delete", role: .destructive) { Task { await app.deleteSession(session) } }
                            }
                            .buttonStyle(.bordered)
                        }
                        .padding(.vertical, 4)
                    }
                }

                Section("Send Command") {
                    Picker("Session", selection: .constant(app.defaultSessionId ?? "")) {
                        ForEach(app.sessions) { session in
                            Text(session.displayName).tag(session.id)
                        }
                    }
                    TextField("Command", text: $command)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Send to Default Session") {
                        guard let session = app.sessions.first(where: { $0.id == app.defaultSessionId }) else { return }
                        let value = command
                        command = ""
                        Task { await app.sendCommand(value, to: session) }
                    }
                    .disabled(command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .navigationTitle("Sessions")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task { await app.createSession() }
                    } label: {
                        Label("New", systemImage: "plus")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await app.refreshSessions() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
        }
    }
}

struct MetricsView: View {
    @Environment(AppModel.self) private var app

    var totalTokens: Int {
        app.codexSessions.reduce(0) { partial, session in
            partial + (session.metrics?.totalTokenUsage?.totalTokens ?? 0)
        }
    }

    var totalTools: Int {
        app.codexSessions.reduce(0) { partial, session in
            partial + (session.metrics?.toolCalls ?? 0)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    MetricRow(title: "Codex Sessions", value: "\(app.codexSessions.count)", systemImage: "rectangle.stack")
                    MetricRow(title: "Tokens", value: totalTokens.formatted(), systemImage: "number")
                    MetricRow(title: "Tool Calls", value: totalTools.formatted(), systemImage: "wrench.and.screwdriver")
                }

                Section("Recent Codex Sessions") {
                    ForEach(app.codexSessions) { session in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(session.title)
                                .font(.headline)
                            Text(session.model ?? "Unknown model")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            HStack {
                                Text(session.resumeStatus ?? (session.isResumable == true ? "resumable" : "unknown"))
                                Spacer()
                                Button("Resume") {
                                    Task {
                                        await app.resumeCodexSession(session, into: app.defaultSessionId)
                                    }
                                }
                                .disabled(session.isResumable == false)
                            }
                            .font(.caption)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .navigationTitle("Metrics")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await app.refreshCodexSessions() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
        }
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
