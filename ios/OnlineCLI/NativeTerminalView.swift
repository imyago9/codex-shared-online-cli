import SwiftUI
import UIKit

struct NativeTerminalView: View {
    let client: NativeTerminalClient
    @State private var focusToken = 0
    @State private var historyDrag = 0.0
    @State private var autoScroll = true

    var body: some View {
        VStack(spacing: 0) {
            TerminalSurface(
                text: client.buffer.displayText,
                statusText: client.statusText,
                focusToken: $focusToken,
                autoScroll: $autoScroll,
                onInput: client.sendInput,
                onResize: client.sendResize(cols:rows:)
            )
            .overlay(alignment: .topTrailing) {
                TerminalLiveBadge(client: client)
                    .padding(10)
            }

            TerminalControlBar(
                historyDrag: $historyDrag,
                autoScroll: $autoScroll,
                onFocus: { focusToken += 1 },
                onPaste: pasteClipboard,
                onCopy: copyTerminalOutput,
                onKey: client.sendKey(_:),
                onHistoryScroll: { lines in
                    Task { await client.scrollServerHistory(lines: lines) }
                }
            )
        }
        .background(Color(red: 0.03, green: 0.04, blue: 0.06))
    }

    private func pasteClipboard() {
        guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
        client.sendInput(text.replacingOccurrences(of: "\n", with: "\r"))
    }

    private func copyTerminalOutput() {
        UIPasteboard.general.string = client.buffer.displayText
    }
}

private struct TerminalSurface: View {
    let text: String
    let statusText: String
    @Binding var focusToken: Int
    @Binding var autoScroll: Bool
    let onInput: (String) -> Void
    let onResize: (Int, Int) -> Void

    private let fontSize: CGFloat = 13
    private let lineHeight: CGFloat = 18

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .topLeading) {
                ScrollViewReader { scrollProxy in
                    ScrollView {
                        Text(renderedText)
                            .font(.system(size: fontSize, design: .monospaced))
                            .foregroundStyle(Color(red: 0.86, green: 0.89, blue: 0.93))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                            .padding(.horizontal, 12)
                            .padding(.top, 44)
                            .padding(.bottom, 18)
                        Color.clear
                            .frame(width: 1, height: 1)
                            .id("terminal-bottom")
                    }
                    .scrollIndicators(.visible)
                    .onChange(of: text) { _, _ in
                        guard autoScroll else { return }
                        withAnimation(.easeOut(duration: 0.12)) {
                            scrollProxy.scrollTo("terminal-bottom", anchor: .bottom)
                        }
                    }
                    .onTapGesture {
                        focusToken += 1
                    }
                }

                TerminalInputCapture(focusToken: $focusToken, onInput: onInput)
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
        let cols = max(20, Int(size.width / (fontSize * 0.62)))
        let rows = max(8, Int(size.height / lineHeight))
        onResize(cols, rows)
    }
}

private struct TerminalControlBar: View {
    @Binding var historyDrag: Double
    @Binding var autoScroll: Bool
    let onFocus: () -> Void
    let onPaste: () -> Void
    let onCopy: () -> Void
    let onKey: (TerminalKey) -> Void
    let onHistoryScroll: (Int) -> Void

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: "text.line.first.and.arrowtriangle.forward")
                    .foregroundStyle(.secondary)
                Slider(
                    value: $historyDrag,
                    in: -1...1,
                    onEditingChanged: { editing in
                        if !editing {
                            historyDrag = 0
                        }
                    }
                )
                    .onChange(of: historyDrag) { _, value in
                        guard abs(value) > 0.08 else { return }
                        let lines = Int((value * 90).rounded())
                        onHistoryScroll(lines)
                    }
                Toggle(isOn: $autoScroll) {
                    Image(systemName: "arrow.down.to.line.compact")
                }
                .toggleStyle(.button)
                .labelStyle(.iconOnly)
                .accessibilityLabel("Auto scroll")
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    TerminalIconButton(systemImage: "keyboard", action: onFocus)
                    TerminalIconButton(systemImage: "doc.on.clipboard", action: onPaste)
                    TerminalIconButton(systemImage: "doc.on.doc", action: onCopy)
                    Divider().frame(height: 28)
                    TerminalKeyButton(key: .escape, onKey: onKey)
                    TerminalKeyButton(key: .tab, onKey: onKey)
                    TerminalKeyButton(key: .controlC, onKey: onKey)
                    TerminalKeyButton(key: .controlD, onKey: onKey)
                    TerminalKeyButton(key: .controlL, onKey: onKey)
                    TerminalKeyButton(key: .arrowLeft, onKey: onKey)
                    TerminalKeyButton(key: .arrowRight, onKey: onKey)
                    TerminalKeyButton(key: .arrowUp, onKey: onKey)
                    TerminalKeyButton(key: .arrowDown, onKey: onKey)
                    TerminalKeyButton(key: .pageUp, onKey: onKey)
                    TerminalKeyButton(key: .pageDown, onKey: onKey)
                    TerminalKeyButton(key: .enter, onKey: onKey)
                }
                .padding(.horizontal, 12)
            }
        }
        .padding(.vertical, 10)
        .background(.bar)
    }
}

private struct TerminalLiveBadge: View {
    let client: NativeTerminalClient

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(client.connectionState.isConnected ? Color.green : Color.orange)
                .frame(width: 7, height: 7)
            Text("\(client.terminalProfile.title) \(client.cols)x\(client.rows)")
                .font(.caption2.monospacedDigit().weight(.semibold))
        }
        .foregroundStyle(.white.opacity(0.86))
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(.black.opacity(0.54), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private struct TerminalIconButton: View {
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .frame(width: 34, height: 34)
        }
        .buttonStyle(.plain)
        .nativeGlass(cornerRadius: 8, interactive: true)
    }
}

private struct TerminalKeyButton: View {
    let key: TerminalKey
    let onKey: (TerminalKey) -> Void

    var body: some View {
        Button {
            onKey(key)
        } label: {
            Text(key.title)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(minWidth: 42, minHeight: 34)
        }
        .buttonStyle(.plain)
        .nativeGlass(cornerRadius: 8, interactive: true)
    }
}

struct TerminalInputCapture: UIViewRepresentable {
    @Binding var focusToken: Int
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
    }

    final class InputView: UIView, UIKeyInput {
        var onInput: ((String) -> Void)?
        var lastFocusToken = 0
        var hasText: Bool { true }
        var keyboardType: UIKeyboardType = .asciiCapable
        var autocapitalizationType: UITextAutocapitalizationType = .none
        var autocorrectionType: UITextAutocorrectionType = .no
        var smartDashesType: UITextSmartDashesType = .no
        var smartQuotesType: UITextSmartQuotesType = .no
        var spellCheckingType: UITextSpellCheckingType = .no

        override var canBecomeFirstResponder: Bool { true }

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
