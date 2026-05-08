import AVFoundation
import SwiftUI
import UIKit

struct ConnectionGateView: View {
    @Environment(AppModel.self) private var app
    @State private var draftURL = ""
    @State private var draftToken = ""
    @State private var showingScanner = false
    @State private var localMessage = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 22) {
                    header
                    connectionForm
                    companionPanel
                }
                .padding(.horizontal, 22)
                .padding(.vertical, 34)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Connect")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                draftURL = app.settings.baseURLString
                draftToken = app.settings.companionToken
                await app.refreshAll()
            }
            .sheet(isPresented: $showingScanner) {
                QRScannerSheet { value in
                    showingScanner = false
                    applyScannedPairing(value)
                }
            }
        }
    }

    private var header: some View {
        VStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(LinearGradient(colors: [.cyan, .green], startPoint: .topLeading, endPoint: .bottomTrailing))
                Image(systemName: "terminal.fill")
                    .font(.system(size: 38, weight: .bold))
                    .foregroundStyle(.black.opacity(0.82))
            }
            .frame(width: 86, height: 86)
                .shadow(color: .black.opacity(0.18), radius: 18, y: 8)

            VStack(spacing: 6) {
                Text("Online CLI")
                    .font(.largeTitle.weight(.bold))
                Text(app.connectionMessage)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var connectionForm: some View {
        VStack(spacing: 14) {
            TextField("Tailnet domain", text: $draftURL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.URL)
                .padding(14)
                .background(.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            SecureField("Companion token", text: $draftToken)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(14)
                .background(.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            HStack(spacing: 12) {
                Button {
                    showingScanner = true
                } label: {
                    Label("Scan QR", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)

                Button {
                    saveAndConnect()
                } label: {
                    Label("Connect", systemImage: "network")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(app.isLoading || draftURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if !localMessage.isEmpty {
                Text(localMessage)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(16)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    @ViewBuilder
    private var companionPanel: some View {
        if app.companionStatus != nil || !app.companionMessage.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Label("Windows Companion", systemImage: "desktopcomputer")
                        .font(.headline)
                    Spacer()
                    ProgressView()
                        .opacity(app.isCompanionLoading ? 1 : 0)
                }

                LabeledContent("Status", value: app.companionMessage)

                if let status = app.companionStatus {
                    LabeledContent("Server", value: status.serverRunning ? "Running" : "Stopped")
                    LabeledContent("Remote", value: status.remoteAgentRunning ? "Ready" : "Stopped")
                    LabeledContent("Startup", value: status.runOnStartup ? "Enabled" : "Disabled")
                }

                HStack(spacing: 12) {
                    Button {
                        Task { await app.startServerFromCompanion() }
                    } label: {
                        Label("Start", systemImage: "play.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(app.isCompanionLoading || draftToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                    Button {
                        Task { await app.refreshCompanionStatus() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .disabled(app.isCompanionLoading)
                }
            }
            .padding(16)
            .background(.background, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
    }

    private func saveAndConnect() {
        let normalized = PairingPayload.normalizedURLString(draftURL)
        app.settings.baseURLString = normalized
        app.settings.companionToken = draftToken.trimmingCharacters(in: .whitespacesAndNewlines)
        localMessage = "Checking connection"
        Task {
            await app.refreshAll()
            localMessage = app.isServerConnected ? "Connected" : app.companionMessage
        }
    }

    private func applyScannedPairing(_ rawValue: String) {
        guard let payload = PairingPayload.parse(rawValue) else {
            localMessage = "The QR code is not an Online CLI pairing code."
            return
        }

        draftURL = payload.url
        draftToken = payload.token ?? draftToken
        saveAndConnect()
    }
}

private struct QRScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var message = "Point the camera at the pairing code."
    let onScan: (String) -> Void

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                QRCodeScannerView(
                    onScan: onScan,
                    onError: { message = $0 }
                )
                .ignoresSafeArea()

                Text(message)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(.black.opacity(0.62), in: Capsule())
                    .padding(.bottom, 28)
            }
            .navigationTitle("Scan Pairing Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

private struct QRCodeScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    let onError: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        QRScannerViewController(onScan: onScan, onError: onError)
    }

    func updateUIViewController(_ uiViewController: QRScannerViewController, context: Context) {}
}

private final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let onScan: (String) -> Void
    private let onError: (String) -> Void
    private var didScan = false

    init(onScan: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
        self.onScan = onScan
        self.onError = onError
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configure()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning {
            session.stopRunning()
        }
    }

    private func configure() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
                DispatchQueue.main.async {
                    allowed ? self?.configureSession() : self?.onError("Camera access is disabled.")
                }
            }
        default:
            onError("Camera access is disabled.")
        }
    }

    private func configureSession() {
        guard let device = AVCaptureDevice.default(for: .video) else {
            onError("Camera is unavailable.")
            return
        }

        do {
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else {
                onError("Camera input is unavailable.")
                return
            }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else {
                onError("QR scanning is unavailable.")
                return
            }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]

            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.insertSublayer(layer, at: 0)
            previewLayer = layer

            DispatchQueue.global(qos: .userInitiated).async { [session] in
                session.startRunning()
            }
        } catch {
            onError(error.localizedDescription)
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard
            !didScan,
            let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
            let value = object.stringValue
        else {
            return
        }

        didScan = true
        session.stopRunning()
        onScan(value)
    }
}

private struct PairingPayload {
    let url: String
    let token: String?

    static func parse(_ rawValue: String) -> PairingPayload? {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let url = URL(string: trimmed),
           url.scheme?.lowercased() == "onlinecli",
           url.host?.lowercased() == "pair",
           let components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            let items = components.queryItems ?? []
            let baseURL = items.first(where: { $0.name == "url" || $0.name == "baseURL" })?.value
            let token = items.first(where: { $0.name == "token" })?.value
            if let baseURL, !baseURL.isEmpty {
                return PairingPayload(url: normalizedURLString(baseURL), token: token)
            }
        }

        if let data = trimmed.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let baseURL = object["url"] as? String ?? object["baseURL"] as? String ?? object["tailnetUrl"] as? String
            let token = object["token"] as? String ?? object["companionToken"] as? String
            if let baseURL, !baseURL.isEmpty {
                return PairingPayload(url: normalizedURLString(baseURL), token: token)
            }
        }

        if URL(string: normalizedURLString(trimmed)) != nil {
            return PairingPayload(url: normalizedURLString(trimmed), token: nil)
        }

        return nil
    }

    static func normalizedURLString(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        return trimmed.contains("://") ? trimmed : "https://\(trimmed)"
    }
}
