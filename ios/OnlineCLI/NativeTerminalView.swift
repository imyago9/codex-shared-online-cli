import SwiftUI
import UIKit

struct NativeTerminalView: View {
    let client: NativeTerminalClient
    @Binding var focusToken: Int
    @Binding var dismissKeyboardToken: Int
    @Binding var keyboardVisible: Bool
    @State private var autoScroll = true

    var body: some View {
        TerminalSurface(
            text: client.buffer.displayText,
            statusText: client.statusText,
            focusToken: $focusToken,
            dismissKeyboardToken: $dismissKeyboardToken,
            autoScroll: $autoScroll,
            keyboardVisible: $keyboardVisible,
            onInput: client.sendInput,
            onResize: client.sendResize(cols:rows:)
        )
        .background(Color(red: 0.03, green: 0.04, blue: 0.06))
    }
}

private struct TerminalSurface: View {
    let text: String
    let statusText: String
    @Binding var focusToken: Int
    @Binding var dismissKeyboardToken: Int
    @Binding var autoScroll: Bool
    @Binding var keyboardVisible: Bool
    let onInput: (String) -> Void
    let onResize: (Int, Int) -> Void

    private let font = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .topLeading) {
                TerminalTextSurface(
                    text: renderedText,
                    font: font,
                    autoScroll: autoScroll,
                    onTap: { focusToken += 1 }
                )

                TerminalInputCapture(
                    focusToken: $focusToken,
                    dismissKeyboardToken: $dismissKeyboardToken,
                    keyboardVisible: $keyboardVisible,
                    onInput: onInput
                )
                    .frame(width: 1, height: 1)
                    .opacity(0.01)
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
            .onAppear {
                resize(for: proxy.size)
            }
            .onChange(of: proxy.size) { _, size in
                resize(for: size)
            }
        }
    }

    private var renderedText: String {
        text.isEmpty ? "\(statusText)\n" : text
    }

    private func resize(for size: CGSize) {
        let characterWidth = max(6, "W".size(withAttributes: [.font: font]).width)
        let lineHeight = max(12, font.lineHeight)
        let cols = max(24, Int((size.width - 20) / characterWidth))
        let rows = max(8, Int((size.height - 20) / lineHeight))
        onResize(cols, rows)
    }
}

private struct TerminalTextSurface: UIViewRepresentable {
    let text: String
    let font: UIFont
    let autoScroll: Bool
    let onTap: () -> Void

    func makeUIView(context: Context) -> TerminalScrollView {
        let scrollView = TerminalScrollView()
        let recognizer = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleTap))
        recognizer.cancelsTouchesInView = false
        scrollView.addGestureRecognizer(recognizer)
        return scrollView
    }

    func updateUIView(_ scrollView: TerminalScrollView, context: Context) {
        context.coordinator.onTap = onTap
        scrollView.update(text: text, font: font, autoScroll: autoScroll)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onTap: onTap)
    }

    final class Coordinator: NSObject {
        var onTap: () -> Void

        init(onTap: @escaping () -> Void) {
            self.onTap = onTap
        }

        @objc func handleTap() {
            onTap()
        }
    }

    final class TerminalScrollView: UIScrollView {
        private let terminalContentView = TerminalContentView()

        override init(frame: CGRect) {
            super.init(frame: frame)
            backgroundColor = UIColor(red: 0.03, green: 0.04, blue: 0.06, alpha: 1)
            indicatorStyle = .white
            alwaysBounceVertical = true
            alwaysBounceHorizontal = false
            showsHorizontalScrollIndicator = false
            keyboardDismissMode = .interactive
            delaysContentTouches = false
            addSubview(terminalContentView)
        }

        required init?(coder: NSCoder) {
            return nil
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            updateContentFrame(autoScroll: false)
        }

        func update(text: String, font: UIFont, autoScroll: Bool) {
            let wasPinnedToBottom = contentOffset.y >= max(0, contentSize.height - bounds.height - 24)
            terminalContentView.configure(text: text, font: font)
            updateContentFrame(autoScroll: autoScroll || wasPinnedToBottom)
        }

        private func updateContentFrame(autoScroll: Bool) {
            let size = terminalContentView.preferredSize(minimumSize: bounds.size)
            if terminalContentView.frame.size != size {
                terminalContentView.frame = CGRect(origin: .zero, size: size)
                contentSize = size
            }
            if autoScroll {
                let maxOffsetY = max(0, contentSize.height - bounds.height + adjustedContentInset.bottom)
                setContentOffset(CGPoint(x: 0, y: maxOffsetY), animated: false)
            }
        }
    }

    final class TerminalContentView: UIView {
        private var lines: [String] = [""]
        private var attributes: [NSAttributedString.Key: Any] = [:]
        private var font = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        private let inset = UIEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
        private let textColor = UIColor(red: 0.86, green: 0.89, blue: 0.93, alpha: 1)
        private let background = UIColor(red: 0.03, green: 0.04, blue: 0.06, alpha: 1)

        private var lineHeight: CGFloat {
            ceil(font.lineHeight)
        }

        private var characterWidth: CGFloat {
            max(6, "W".size(withAttributes: [.font: font]).width)
        }

        override init(frame: CGRect) {
            super.init(frame: frame)
            isOpaque = true
            backgroundColor = background
            configure(text: "", font: font)
        }

        required init?(coder: NSCoder) {
            return nil
        }

        func configure(text: String, font: UIFont) {
            let nextLines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            self.lines = nextLines.isEmpty ? [""] : nextLines
            self.font = font
            self.attributes = [
                .font: font,
                .foregroundColor: textColor
            ]
            setNeedsDisplay()
        }

        func preferredSize(minimumSize: CGSize) -> CGSize {
            let longestLine = lines.reduce(0) { max($0, $1.count) }
            let contentWidth = CGFloat(longestLine) * characterWidth + inset.left + inset.right
            let contentHeight = CGFloat(lines.count) * lineHeight + inset.top + inset.bottom
            return CGSize(
                width: max(minimumSize.width, ceil(contentWidth)),
                height: max(minimumSize.height + 1, ceil(contentHeight))
            )
        }

        override func draw(_ rect: CGRect) {
            background.setFill()
            UIRectFill(rect)
            guard !lines.isEmpty else { return }

            let firstLine = max(0, Int(floor((rect.minY - inset.top) / lineHeight)))
            let lastLine = min(lines.count - 1, Int(ceil((rect.maxY - inset.top) / lineHeight)))
            guard firstLine <= lastLine else { return }

            for index in firstLine...lastLine {
                let origin = CGPoint(x: inset.left, y: inset.top + CGFloat(index) * lineHeight)
                (lines[index] as NSString).draw(at: origin, withAttributes: attributes)
            }
        }
    }
}

struct TerminalInputCapture: UIViewRepresentable {
    @Binding var focusToken: Int
    @Binding var dismissKeyboardToken: Int
    @Binding var keyboardVisible: Bool
    let onInput: (String) -> Void

    func makeUIView(context: Context) -> InputView {
        let view = InputView()
        view.onInput = onInput
        view.onActiveChanged = { [binding = $keyboardVisible] isActive in
            binding.wrappedValue = isActive
        }
        return view
    }

    func updateUIView(_ uiView: InputView, context: Context) {
        uiView.onInput = onInput
        uiView.onActiveChanged = { [binding = $keyboardVisible] isActive in
            binding.wrappedValue = isActive
        }
        if uiView.lastFocusToken != focusToken {
            uiView.lastFocusToken = focusToken
            DispatchQueue.main.async {
                _ = uiView.becomeFirstResponder()
            }
        }
        if uiView.lastDismissKeyboardToken != dismissKeyboardToken {
            uiView.lastDismissKeyboardToken = dismissKeyboardToken
            DispatchQueue.main.async {
                _ = uiView.resignFirstResponder()
            }
        }
    }

    final class InputView: UIView, UIKeyInput {
        var onInput: ((String) -> Void)?
        var onActiveChanged: ((Bool) -> Void)?
        var lastFocusToken = 0
        var lastDismissKeyboardToken = 0
        var hasText: Bool { true }
        var keyboardType: UIKeyboardType = .asciiCapable
        var autocapitalizationType: UITextAutocapitalizationType = .none
        var autocorrectionType: UITextAutocorrectionType = .no
        var smartDashesType: UITextSmartDashesType = .no
        var smartQuotesType: UITextSmartQuotesType = .no
        var spellCheckingType: UITextSpellCheckingType = .no

        override var canBecomeFirstResponder: Bool { true }
        override var inputAccessoryView: UIView? {
            nil
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

        func insertText(_ text: String) {
            let normalized = text.replacingOccurrences(of: "\n", with: "\r")
            onInput?(normalized)
        }

        func deleteBackward() {
            onInput?(TerminalKey.backspace.sequence)
        }

        override var keyCommands: [UIKeyCommand]? {
            [
                command(input: UIKeyCommand.inputUpArrow, action: #selector(up)),
                command(input: UIKeyCommand.inputDownArrow, action: #selector(down)),
                command(input: UIKeyCommand.inputLeftArrow, action: #selector(left)),
                command(input: UIKeyCommand.inputRightArrow, action: #selector(right)),
                command(input: UIKeyCommand.inputEscape, action: #selector(escape)),
                command(input: "\t", action: #selector(tab)),
                command(input: "\r", action: #selector(enter)),
                command(input: "c", modifiers: .control, action: #selector(controlC)),
                command(input: "d", modifiers: .control, action: #selector(controlD)),
                command(input: "l", modifiers: .control, action: #selector(controlL))
            ]
        }

        private func command(
            input: String,
            modifiers: UIKeyModifierFlags = [],
            action: Selector
        ) -> UIKeyCommand {
            let keyCommand = UIKeyCommand(input: input, modifierFlags: modifiers, action: action)
            if #available(iOS 15.0, *) {
                keyCommand.wantsPriorityOverSystemBehavior = true
            }
            return keyCommand
        }

        @objc private func up() { onInput?(TerminalKey.arrowUp.sequence) }
        @objc private func down() { onInput?(TerminalKey.arrowDown.sequence) }
        @objc private func left() { onInput?(TerminalKey.arrowLeft.sequence) }
        @objc private func right() { onInput?(TerminalKey.arrowRight.sequence) }
        @objc private func escape() { onInput?(TerminalKey.escape.sequence) }
        @objc private func tab() { onInput?(TerminalKey.tab.sequence) }
        @objc private func enter() { onInput?(TerminalKey.enter.sequence) }
        @objc private func controlC() { onInput?(TerminalKey.controlC.sequence) }
        @objc private func controlD() { onInput?(TerminalKey.controlD.sequence) }
        @objc private func controlL() { onInput?(TerminalKey.controlL.sequence) }
    }
}
