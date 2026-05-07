import SwiftUI
import WebKit

struct ConsoleWebView: UIViewRepresentable {
    let url: URL
    let reloadToken: Int

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.keyboardDismissMode = .interactive
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.load(URLRequest(url: url))
        context.coordinator.loadedURL = url
        context.coordinator.reloadToken = reloadToken
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if context.coordinator.loadedURL != url {
            webView.load(URLRequest(url: url))
            context.coordinator.loadedURL = url
        } else if context.coordinator.reloadToken != reloadToken {
            webView.reload()
        }
        context.coordinator.reloadToken = reloadToken
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedURL: URL?
        var reloadToken = 0
    }
}
