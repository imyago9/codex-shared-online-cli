import SwiftUI
import UIKit

struct NativeTerminalView: View {
    let client: NativeTerminalClient
    @State private var focusToken = 0
    @State private var dismissKeyboardToken = 0
    @State private var autoScroll = true

    var body: some View {
        TerminalSurface(
            text: client.buffer.displayText,
            statusText: client.statusText,
            focusToken: $focusToken,
            dismissKeyboardToken: $dismissKeyboardToken,
            autoScroll: $autoScroll,
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
                    onInput: onInput
                )
                    .frame(width: 1, height: 1)
                    .opacity(0.01)
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
            .onAppear {
                resize(for: proxy.size)
                focusToken += 1
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

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.isEditable = false
        textView.backgroundColor = UIColor(red: 0.03, green: 0.04, blue: 0.06, alpha: 1)
        textView.textColor = UIColor(red: 0.86, green: 0.89, blue: 0.93, alpha: 1)
        textView.font = font
        textView.isSelectable = false
        textView.textContainerInset = UIEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
        textView.textContainer.lineFragmentPadding = 0
        textView.alwaysBounceVertical = true
        textView.keyboardDismissMode = .interactive
        textView.autocorrectionType = .no
        textView.autocapitalizationType = .none
        textView.smartDashesType = .no
        textView.smartQuotesType = .no
        textView.spellCheckingType = .no

        let recognizer = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleTap))
        recognizer.cancelsTouchesInView = false
        textView.addGestureRecognizer(recognizer)
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        context.coordinator.onTap = onTap
        textView.font = font
        if textView.text != text {
            textView.text = text
            if autoScroll {
                let maxOffset = max(0, textView.contentSize.height - textView.bounds.height + textView.adjustedContentInset.bottom)
                textView.setContentOffset(CGPoint(x: 0, y: maxOffset), animated: false)
            }
        }
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
}

struct TerminalInputCapture: UIViewRepresentable {
    @Binding var focusToken: Int
    @Binding var dismissKeyboardToken: Int
    let onInput: (String) -> Void

    func makeUIView(context: Context) -> InputView {
        let view = InputView()
        view.onInput = onInput
        return view
    }

    func updateUIView(_ uiView: InputView, context: Context) {
        uiView.onInput = onInput
        if uiView.lastFocusToken != focusToken {
            uiView.lastFocusToken = focusToken
            DispatchQueue.main.async {
                uiView.becomeFirstResponder()
            }
        }
        if uiView.lastDismissKeyboardToken != dismissKeyboardToken {
            uiView.lastDismissKeyboardToken = dismissKeyboardToken
            DispatchQueue.main.async {
                uiView.resignFirstResponder()
            }
        }
    }

    final class InputView: UIView, UIKeyInput {
        var onInput: ((String) -> Void)?
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
            accessoryToolbar
        }

        private lazy var accessoryToolbar: UIToolbar = {
            let toolbar = UIToolbar()
            toolbar.sizeToFit()
            toolbar.items = [
                UIBarButtonItem(title: "Paste", style: .plain, target: self, action: #selector(sendPaste)),
                UIBarButtonItem(title: "Esc", style: .plain, target: self, action: #selector(sendEscape)),
                UIBarButtonItem(title: "Tab", style: .plain, target: self, action: #selector(sendTab)),
                UIBarButtonItem(title: "Ctrl-C", style: .plain, target: self, action: #selector(sendControlC)),
                UIBarButtonItem(systemItem: .flexibleSpace),
                UIBarButtonItem(title: "Done", style: .done, target: self, action: #selector(dismissKeyboard))
            ]
            return toolbar
        }()

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
        @objc private func sendEscape() { onInput?(TerminalKey.escape.sequence) }
        @objc private func sendTab() { onInput?(TerminalKey.tab.sequence) }
        @objc private func sendControlC() { onInput?(TerminalKey.controlC.sequence) }
        @objc private func sendPaste() {
            guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
            onInput?(text.replacingOccurrences(of: "\n", with: "\r"))
        }
        @objc private func dismissKeyboard() { resignFirstResponder() }
    }
}
