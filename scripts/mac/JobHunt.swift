import AppKit
import WebKit

// Lodestar (the Job Hunt app): a native window around the app at 127.0.0.1:3000, the way Palimpsest wraps its site.
// The server normally runs all the time (launch agent com.jobhunt.app). If it isn't answering, the app
// starts it, shows a short "Starting" page, and loads the app as soon as it responds.
// Like Palimpsest it keeps itself up to date: opening it runs scripts/auto-update.sh in the background (so does the
// com.jobhunt.update launch agent, every minute), and when an update lands the window reloads on the new version.
// The project folder is stored in Info.plist (JobHuntFolder) by scripts/make-mac-app.sh.

let appURL = URL(string: "http://127.0.0.1:3000")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var waitTimer: Timer?
    var waited = 0
    var updateTimer: Timer?
    var installedVersion = ""

    lazy var folder: String = (Bundle.main.object(forInfoDictionaryKey: "JobHuntFolder") as? String) ?? ""
    lazy var nodeDir: String = (Bundle.main.object(forInfoDictionaryKey: "JobHuntNodeDir") as? String) ?? ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()   // keeps the theme choice and other page settings

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.setValue(false, forKey: "drawsBackground")

        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = NSSize(width: min(1440, screen.width * 0.9), height: screen.height * 0.9)
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Lodestar"
        window.isReleasedWhenClosed = false   // closing only hides it, so the Dock icon can bring it back
        window.minSize = NSSize(width: 720, height: 520)
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.backgroundColor = .windowBackgroundColor
        window.contentView = webView
        window.setFrameAutosaveName("JobHuntMainWindow")
        if !window.setFrameUsingName("JobHuntMainWindow") { window.center() }
        window.makeKeyAndOrderFront(nil)

        openApp(path: "/")
        NSApp.activate(ignoringOtherApps: true)

        installedVersion = readInstalledVersion()
        checkForUpdates(tell: false)
        updateTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.reloadIfUpdated() }
    }

    // MARK: Updates

    private func readInstalledVersion() -> String {
        let sha = (try? String(contentsOfFile: folder + "/.installed-sha", encoding: .utf8)) ?? ""
        return sha.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // Runs the updater on its own (nohup, in the background) so it carries on if it has to reopen this app.
    private func checkForUpdates(tell: Bool) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = ["-c", "nohup /bin/bash \"$0/scripts/auto-update.sh\" \(tell ? "--tell" : "") >/dev/null 2>&1 &", folder]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(nodeDir):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        task.environment = env
        try? task.run()
    }

    // The updater writes .installed-sha once the new version is built and the server restarted.
    private func reloadIfUpdated() {
        let now = readInstalledVersion()
        guard !now.isEmpty, now != installedVersion else { return }
        installedVersion = now
        let path = webView.url?.host == appURL.host ? (webView.url?.path ?? "/") : "/"
        openApp(path: path)
    }

    @objc func checkForUpdatesNow(_ sender: Any?) { checkForUpdates(tell: true) }

    @objc func showAbout(_ sender: Any?) {
        // Shows "Version <commit>", the commit of main that's installed.
        if installedVersion.isEmpty { NSApp.orderFrontStandardAboutPanel(nil); return }
        NSApp.orderFrontStandardAboutPanel(options: [.applicationVersion: String(installedVersion.prefix(7)), .version: ""])
    }

    // MARK: Server

    private func serverIsUp(_ done: @escaping (Bool) -> Void) {
        var request = URLRequest(url: appURL)
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { _, response, _ in
            DispatchQueue.main.async { done(response != nil) }
        }.resume()
    }

    private func startServer() {
        let plist = NSHomeDirectory() + "/Library/LaunchAgents/com.jobhunt.app.plist"
        let uid = getuid()
        let script: String
        if FileManager.default.fileExists(atPath: plist) {
            script = "launchctl kickstart gui/\(uid)/com.jobhunt.app || launchctl bootstrap gui/\(uid) '\(plist)'"
        } else {
            script = "cd '\(folder)' && mkdir -p logs && nohup npm start >> logs/app.log 2>&1 &"
        }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = ["-c", script]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(nodeDir):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        task.environment = env
        try? task.run()
    }

    func openApp(path: String) {
        serverIsUp { up in
            if up {
                self.webView.load(URLRequest(url: URL(string: path, relativeTo: appURL)!))
                return
            }
            self.showMessage("Starting Lodestar…", detail: "This takes a few seconds.")
            self.startServer()
            self.waited = 0
            self.waitTimer?.invalidate()
            self.waitTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] timer in
                guard let self = self else { timer.invalidate(); return }
                self.waited += 1
                self.serverIsUp { up in
                    if up {
                        timer.invalidate()
                        self.webView.load(URLRequest(url: URL(string: path, relativeTo: appURL)!))
                    } else if self.waited >= 60 {
                        timer.invalidate()
                        self.showMessage("Lodestar didn't start", detail: "Details are in \(self.folder)/logs/app.log. Choose View → Reload to try again.")
                    }
                }
            }
        }
    }

    private func showMessage(_ title: String, detail: String) {
        let html = """
        <html><head><meta name="color-scheme" content="light dark"><style>
        body { font: 15px -apple-system, sans-serif; display: flex; height: 100vh; margin: 0; align-items: center; justify-content: center;
               background: #f4f2ee; color: #16181d; text-align: center; }
        @media (prefers-color-scheme: dark) { body { background: #121417; color: #ecebe7; } }
        h1 { font-size: 22px; font-weight: 600; margin: 0 0 6px; } p { margin: 0; opacity: 0.7; }
        </style></head><body><div><h1>\(title)</h1><p>\(detail)</p></div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // MARK: Links

    private func isLocal(_ url: URL) -> Bool { url.host == appURL.host && url.port == appURL.port }

    // Job postings and other sites open in the default browser; the app's own pages stay in the window. "Open in
    // Mail" links (message://<Message-ID>) go to Mail and mailto: to the mail app. Nothing else leaves the window:
    // pages show text from job postings and emails, so a file:, smb: or other app link is never handed to macOS.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, let scheme = url.scheme?.lowercased() {
            if scheme == "http" || scheme == "https" {
                if !isLocal(url) {
                    NSWorkspace.shared.open(url)
                    decisionHandler(.cancel)
                    return
                }
            } else if scheme == "message" || scheme == "mailto" {
                if scheme == "message" { openInMail(url) } else { NSWorkspace.shared.open(url) }
                decisionHandler(.cancel)
                return
            } else if !["about", "data", "blob"].contains(scheme) {
                decisionHandler(.cancel)
                return
            }
        }
        decisionHandler(.allow)
    }

    // A message:// link opens that email in Mail. Started cold, Mail can show its last mailbox and drop the link, so
    // it's opened first and handed the link once it's up.
    private func openInMail(_ url: URL) {
        let mailID = "com.apple.mail"
        guard let mail = NSWorkspace.shared.urlForApplication(withBundleIdentifier: mailID) else {
            NSWorkspace.shared.open(url)
            return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        if !NSRunningApplication.runningApplications(withBundleIdentifier: mailID).isEmpty {
            NSWorkspace.shared.open([url], withApplicationAt: mail, configuration: config, completionHandler: nil)
            return
        }
        NSWorkspace.shared.openApplication(at: mail, configuration: config) { _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                NSWorkspace.shared.open([url], withApplicationAt: mail, configuration: config, completionHandler: nil)
            }
        }
    }

    // Resumes, cover letters and screenshots (opened with target="_blank") open in their own apps via the browser.
    // Same rule as above: web links, Mail links and mailto: only.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, let scheme = url.scheme?.lowercased() {
            if scheme == "message" { openInMail(url) } else if ["http", "https", "mailto"].contains(scheme) { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    // Anything the window can't display (a .docx, say) goes to the default browser to download.
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if !response.canShowMIMEType, let url = response.response.url {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // Only "can't reach the server" errors: the server restarted, so wait for it to come back.
        let e = error as NSError
        guard e.domain == NSURLErrorDomain,
              [NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut].contains(e.code) else { return }
        openApp(path: webView.url?.path ?? "/")
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    // The red button closes the window but keeps the app running; clicking the Dock icon reopens it. Cmd-Q quits.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    // MARK: Menu

    @objc func openPage(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        openApp(path: path)
    }
    @objc func reloadPage(_ sender: Any?) {
        if webView.url?.host == appURL.host { webView.reload() } else { openApp(path: "/") }
    }
    @objc func goBack(_ sender: Any?) { webView.goBack() }
    @objc func goForward(_ sender: Any?) { webView.goForward() }
    @objc func openInBrowser(_ sender: Any?) {
        NSWorkspace.shared.open(webView.url?.host == appURL.host ? webView.url! : appURL)
    }
    @objc func revealFolder(_ sender: Any?) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: folder)])
    }

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Lodestar", action: #selector(showAbout(_:)), keyEquivalent: "")
        appMenu.addItem(withTitle: "Check for Updates…", action: #selector(checkForUpdatesNow(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Lodestar", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Lodestar", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        for (title, key, path) in [("Pipeline", "1", "/"), ("Today's Queue", "2", "/queue"), ("Companies", "3", "/companies"), ("Settings", "4", "/settings"), ("Mail", "5", "/mail")] {
            let item = NSMenuItem(title: title, action: #selector(openPage(_:)), keyEquivalent: key)
            item.representedObject = path
            view.addItem(item)
        }
        view.addItem(.separator())
        view.addItem(withTitle: "Back", action: #selector(goBack(_:)), keyEquivalent: "[")
        view.addItem(withTitle: "Forward", action: #selector(goForward(_:)), keyEquivalent: "]")
        view.addItem(withTitle: "Reload", action: #selector(reloadPage(_:)), keyEquivalent: "r")
        view.addItem(.separator())
        view.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser(_:)), keyEquivalent: "")
        view.addItem(withTitle: "Show Lodestar Folder", action: #selector(revealFolder(_:)), keyEquivalent: "")
        view.addItem(.separator())
        let fs = NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.control, .command]
        view.addItem(fs)
        viewItem.submenu = view

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winItem.submenu = win
        NSApp.windowsMenu = win

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
