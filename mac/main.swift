// 随手记笔记本 · macOS 客户端
// 原生 WKWebView 壳：加载 n.139t.cn，补充原生通知、Mac 菜单与外链跳转。
import Cocoa
import WebKit
import UserNotifications

let HOME_URL = URL(string: "https://n.139t.cn/")!
let ALLOWED_HOSTS: Set<String> = ["n.139t.cn", "139t.cn"]
let APP_NAME = "随手记笔记本"

// 可点击的毛玻璃视图（通知横幅用）
final class ClickEffectView: NSVisualEffectView {
    var onClick: (() -> Void)?
    override func mouseDown(with event: NSEvent) { onClick?() }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
                         WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var titleObs: NSKeyValueObservation?
    var zoom: CGFloat = 1.0
    var systemNotifyOK = false          // 系统通知中心是否可用（本地未签名 App 常被拒）
    var banners: [NSPanel] = []

    // MARK: - 注入脚本
    // 网页里 fireNotify() 先试 Service Worker，失败后退回 new Notification()。
    // WKWebView 不支持 Web 通知，这里把两者都接管到原生通知中心。
    static let shimJS = """
    (function(){
      try{
        if(navigator.serviceWorker && navigator.serviceWorker.register){
          navigator.serviceWorker.register = function(){ return Promise.reject(new Error('native-app')); };
        }
      }catch(e){}
      var native = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ivyNotify;
      function IvyNotification(title, opts){
        opts = opts || {};
        this.title = String(title || '');
        this.body = opts.body || '';
        this.tag = opts.tag || '';
        this.onclick = null;
        try{
          if(native) native.postMessage({
            title: this.title,
            body: String(opts.body || ''),
            tag: String(opts.tag || ''),
            noteId: String((opts.data && opts.data.noteId) || '')
          });
        }catch(e){}
      }
      IvyNotification.permission = 'granted';
      IvyNotification.requestPermission = function(){ return Promise.resolve('granted'); };
      IvyNotification.prototype.close = function(){};
      window.Notification = IvyNotification;
      window.__IVY_NATIVE_APP = true;

      // 导出文件：拦下带 download 的 blob 链接，交给原生「存储为…」对话框，可自选文件夹
      function b64FromBlob(blob){
        return new Promise(function(res, rej){
          var fr = new FileReader();
          fr.onload = function(){
            var s = String(fr.result || '');
            res(s.slice(s.indexOf(',') + 1));
          };
          fr.onerror = rej;
          fr.readAsDataURL(blob);
        });
      }
      function sendSave(name, blob){
        b64FromBlob(blob).then(function(b64){
          var msg = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ivySave;
          if(msg) msg.postMessage({ name: name || '导出文件', mime: blob.type || '', base64: b64 });
        }).catch(function(){});
      }
      function isBlobDownload(a){
        var href = a.getAttribute('href') || '';
        return !!a.getAttribute('download') && href.indexOf('blob:') === 0;
      }
      // 场景一：程序里 a.click()（这类 <a> 往往没插进 DOM，冒泡不到 document，只能改原型方法）
      var origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function(){
        try{
          if(isBlobDownload(this)){
            var href = this.getAttribute('href');
            var name = this.getAttribute('download');
            fetch(href).then(function(r){ return r.blob(); }).then(function(b){ sendSave(name, b); });
            return;
          }
        }catch(e){}
        return origClick.apply(this, arguments);
      };
      // 场景二：页面上真实存在的链接被点
      document.addEventListener('click', function(e){
        var a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
        if(!a || !isBlobDownload(a)) return;
        e.preventDefault();
        e.stopPropagation();
        var href = a.getAttribute('href'), name = a.getAttribute('download');
        fetch(href).then(function(r){ return r.blob(); }).then(function(b){ sendSave(name, b); }).catch(function(){});
      }, true);
    })();
    """

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()

        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().getNotificationSettings { s in
            DispatchQueue.main.async { self.systemNotifyOK = (s.authorizationStatus == .authorized) }
        }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, err in
            DispatchQueue.main.async { self.systemNotifyOK = granted }
            if ProcessInfo.processInfo.environment["IVY_SELFTEST"] == "1" {
                let line = "AUTH: granted=\(granted) err=\(err?.localizedDescription ?? "-")\n"
                try? line.write(to: URL(fileURLWithPath: "/tmp/ivy-notify-test.txt"), atomically: true, encoding: .utf8)
            }
        }

        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        if #available(macOS 12.3, *) { cfg.preferences.isElementFullscreenEnabled = true }
        let ucc = WKUserContentController()
        ucc.add(self, name: "ivyNotify")
        ucc.add(self, name: "ivySave")
        ucc.addUserScript(WKUserScript(source: AppDelegate.shimJS,
                                       injectionTime: .atDocumentStart,
                                       forMainFrameOnly: false))
        cfg.userContentController = ucc

        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 840),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = APP_NAME
        window.minSize = NSSize(width: 900, height: 600)
        window.tabbingMode = .disallowed
        window.contentView = web
        window.setFrameAutosaveName("IvyNoteWindow")
        if window.frame.origin == .zero { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        titleObs = web.observe(\.title, options: [.new]) { [weak self] wv, _ in
            guard let self = self else { return }
            let t = (wv.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            self.window.title = t.isEmpty ? APP_NAME : "\(t) — \(APP_NAME)"
        }

        loadHome()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    // MARK: - 加载
    func loadHome() { web.load(URLRequest(url: HOME_URL)) }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if ProcessInfo.processInfo.environment["IVY_SELFTEST"] == "1" { runSelfTest() }
    }

    /// 冒烟自检：把页面关键状态写到 /tmp/ivy-selftest.txt 后退出（仅 IVY_SELFTEST=1 时启用）
    func runSelfTest() {
        let js = """
        JSON.stringify({
          build: (window.IVY_BUILD || {}).id || '',
          notes: (typeof S !== 'undefined' && S.notes) ? S.notes.length : -1,
          nativeFlag: window.__IVY_NATIVE_APP === true,
          notifPerm: (typeof Notification !== 'undefined' && Notification.permission) || '',
          dock: document.querySelectorAll('#dock .dock-item').length,
          helpPanel: typeof openHelpPanel === 'function',
          helpTabs: document.querySelectorAll('[data-htab]').length
        })
        """
        web.evaluateJavaScript(js) { result, error in
            let text: String
            if let s = result as? String { text = "RESULT:" + s }
            else { text = "ERROR:" + (error?.localizedDescription ?? "unknown") }
            try? text.write(to: URL(fileURLWithPath: "/tmp/ivy-selftest.txt"), atomically: true, encoding: .utf8)
            // 读一下 WebKit 给本站的存储配额
            self.web.evaluateJavaScript(
                "try{ navigator.storage.estimate().then(function(e){ window.__QUOTA = e; }); }catch(e){}");
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                self.web.evaluateJavaScript("JSON.stringify(window.__QUOTA || {})") { q, _ in
                    if let s = q as? String {
                        self.appendTest("QUOTA: " + s + "\n")
                    }
                    // 顺便打一条通知 + 走一次导出，验证「网页 → 原生」两条通道
                    self.web.evaluateJavaScript(
                        """
                        try{
                          if(typeof fireNotify==='function'){ fireNotify('自检通知','客户端通知通道测试','n-selftest','t-selftest'); }
                          if(typeof exportBackup==='function'){ exportBackup(); }
                          'ok'
                        }catch(e){ 'err' }
                        """
                    ) { _, _ in
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { NSApp.terminate(nil) }
                    }
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showErrorPage(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // 用户主动取消（比如跳转被拦）不算错误
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        showErrorPage(error)
    }

    func showErrorPage(_ error: Error) {
        let msg = (error as NSError).localizedDescription
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><style>
        :root{color-scheme:light dark}
        body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
             font:15px/1.7 -apple-system,"PingFang SC",sans-serif;background:#faf9f7;color:#333}
        @media (prefers-color-scheme:dark){body{background:#1b1b1d;color:#ddd}}
        .box{text-align:center;max-width:460px;padding:32px}
        h1{font-size:19px;margin:0 0 10px;font-weight:600}
        p{color:#888;margin:0 0 22px;font-size:13.5px}
        a{display:inline-block;padding:9px 22px;border-radius:10px;background:#287a52;color:#fff;
          text-decoration:none;font-size:14px}
        </style></head><body><div class="box">
        <h1>暂时连不上服务器</h1>
        <p>\(msg.replacingOccurrences(of: "<", with: "&lt;"))<br>检查一下网络，或者稍后再试。笔记数据仍然存在本机，不会丢。</p>
        <a href="ivynote://reload">重新加载</a>
        </div></body></html>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    // MARK: - 导航策略：外链走系统浏览器
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
        if url.scheme == "ivynote" {
            if url.host == "reload" { loadHome() }
            return decisionHandler(.cancel)
        }
        if url.scheme == "http" || url.scheme == "https" {
            let host = (url.host ?? "").lowercased()
            if ALLOWED_HOSTS.contains(host) || host.hasSuffix(".139t.cn") {
                return decisionHandler(.allow)
            }
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        NSWorkspace.shared.open(url)   // mailto: / webcal: / tel: 交给系统
        decisionHandler(.cancel)
    }

    // target=_blank
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, navigationAction.targetFrame == nil {
            if let host = url.host?.lowercased(), ALLOWED_HOSTS.contains(host) || host.hasSuffix(".139t.cn") {
                webView.load(navigationAction.request)
            } else {
                NSWorkspace.shared.open(url)
            }
        }
        return nil
    }

    // MARK: - 通知
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any] else { return }
        if message.name == "ivySave" { handleSave(d); return }
        guard message.name == "ivyNotify" else { return }
        let title = (d["title"] as? String) ?? APP_NAME
        let body = (d["body"] as? String) ?? ""
        let noteId = (d["noteId"] as? String) ?? ""
        var tag = (d["tag"] as? String) ?? ""
        if tag.isEmpty { tag = UUID().uuidString }

        if systemNotifyOK {
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            content.userInfo = ["noteId": noteId]
            let req = UNNotificationRequest(identifier: tag, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
        } else {
            // 系统通知中心不可用（本地自签名 App 常见）时，用原生横幅保证能看到
            showBanner(title: title, body: body, noteId: noteId)
        }

        if ProcessInfo.processInfo.environment["IVY_SELFTEST"] == "1" {
            let line = "NOTIFY: title=\(title) body=\(body) noteId=\(noteId) system=\(systemNotifyOK)\n"
            appendTest(line)
        }
    }

    // MARK: - 导出：原生「存储为」对话框
    func handleSave(_ d: [String: Any]) {
        let name = (d["name"] as? String) ?? "导出文件"
        guard let b64 = d["base64"] as? String, let data = Data(base64Encoded: b64) else { return }

        if ProcessInfo.processInfo.environment["IVY_SELFTEST"] == "1" {
            let p = "/tmp/ivy-save-test-" + name
            try? data.write(to: URL(fileURLWithPath: p))
            appendTest("SAVE: name=\(name) bytes=\(data.count) path=\(p)\n")
            return
        }

        let panel = NSSavePanel()
        panel.title = "保存导出文件"
        panel.prompt = "保存"
        panel.nameFieldStringValue = name
        panel.canCreateDirectories = true
        if let last = UserDefaults.standard.string(forKey: "lastSaveDir"),
           FileManager.default.fileExists(atPath: last) {
            panel.directoryURL = URL(fileURLWithPath: last)
        }
        panel.begin { resp in
            guard resp == .OK, let url = panel.url else { return }
            do {
                try data.write(to: url)
                UserDefaults.standard.set(url.deletingLastPathComponent().path, forKey: "lastSaveDir")
                NSWorkspace.shared.activateFileViewerSelecting([url])   // 在访达里高亮刚存的文件
                self.web.evaluateJavaScript(
                    "try{ toast('已保存到「\(url.lastPathComponent)」'); }catch(e){}", completionHandler: nil)
            } catch {
                let a = NSAlert()
                a.messageText = "保存失败"
                a.informativeText = error.localizedDescription
                a.runModal()
            }
        }
    }

    func appendTest(_ line: String) {
        let p = "/tmp/ivy-notify-test.txt"
        if let h = FileHandle(forWritingAtPath: p) {
            h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile()
        } else {
            try? line.write(to: URL(fileURLWithPath: p), atomically: true, encoding: .utf8)
        }
    }

    // MARK: - 兜底横幅（系统通知不可用时）
    func showBanner(title: String, body: String, noteId: String) {
        guard let screen = NSScreen.main else { return }
        let w: CGFloat = 348, h: CGFloat = 82
        let frame = NSRect(x: screen.visibleFrame.maxX - w - 16,
                           y: screen.visibleFrame.maxY - h - 16, width: w, height: h)
        let panel = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered, defer: false)
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let view = ClickEffectView(frame: NSRect(x: 0, y: 0, width: w, height: h))
        view.material = .hudWindow
        view.blendingMode = .behindWindow
        view.state = .active
        view.wantsLayer = true
        view.layer?.cornerRadius = 14
        view.layer?.masksToBounds = true
        view.onClick = { [weak self] in
            guard let self = self else { return }
            NSApp.activate(ignoringOtherApps: true)
            self.window.makeKeyAndOrderFront(nil)
            if !noteId.isEmpty {
                let safe = noteId.replacingOccurrences(of: "'", with: "")
                self.web.evaluateJavaScript(
                    "try{ if(typeof openNote==='function'){ openNote('\(safe)'); } }catch(e){}", completionHandler: nil)
            }
            panel.orderOut(nil)
        }

        let t = NSTextField(labelWithString: title)
        t.font = .boldSystemFont(ofSize: 13.5)
        t.textColor = .labelColor
        t.frame = NSRect(x: 16, y: h - 34, width: w - 64, height: 18)
        t.lineBreakMode = .byTruncatingTail
        let b = NSTextField(labelWithString: body)
        b.font = .systemFont(ofSize: 12)
        b.textColor = .secondaryLabelColor
        b.frame = NSRect(x: 16, y: 14, width: w - 64, height: 32)
        b.maximumNumberOfLines = 2
        b.lineBreakMode = .byTruncatingTail
        let icon = NSImageView(frame: NSRect(x: w - 52, y: h - 50, width: 36, height: 36))
        icon.image = NSApp.applicationIconImage
        view.addSubview(t); view.addSubview(b); view.addSubview(icon)

        panel.contentView = view
        banners.append(panel)
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.22
            panel.animator().alphaValue = 1
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.35
                panel.animator().alphaValue = 0
            }, completionHandler: {
                panel.orderOut(nil)
                self?.banners.removeAll { $0 === panel }
            })
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let noteId = (response.notification.request.content.userInfo["noteId"] as? String) ?? ""
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            self.window.makeKeyAndOrderFront(nil)
            if !noteId.isEmpty {
                let safe = noteId.replacingOccurrences(of: "'", with: "")
                self.web.evaluateJavaScript(
                    "try{ if(typeof openNote==='function'){ openNote('\(safe)'); } }catch(e){}",
                    completionHandler: nil)
            }
        }
        completionHandler()
    }

    // MARK: - 菜单
    @objc func reloadPage(_ s: Any?) { loadHome() }
    @objc func hardReload(_ s: Any?) {
        let store = WKWebsiteDataStore.default()
        store.removeData(ofTypes: [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache],
                         modifiedSince: Date(timeIntervalSince1970: 0)) { [weak self] in
            DispatchQueue.main.async { self?.loadHome() }
        }
    }
    @objc func zoomIn(_ s: Any?) { zoom = min(2.0, zoom + 0.1); web.pageZoom = zoom }
    @objc func zoomOut(_ s: Any?) { zoom = max(0.6, zoom - 0.1); web.pageZoom = zoom }
    @objc func zoomReset(_ s: Any?) { zoom = 1.0; web.pageZoom = 1.0 }
    @objc func openWebVersion(_ s: Any?) { NSWorkspace.shared.open(HOME_URL) }
    @objc func openAdmin(_ s: Any?) { NSWorkspace.shared.open(URL(string: "https://n.139t.cn/admin/")!) }
    @objc func showHelp(_ s: Any?) {
        web.evaluateJavaScript("try{ if(typeof openHelpPanel==='function'){ helpTab='io'; openHelpPanel(); } }catch(e){}",
                               completionHandler: nil)
    }

    func makeMenu(_ title: String, _ items: [(String, Selector?, String)]) -> NSMenuItem {
        let root = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let menu = NSMenu(title: title)
        for (t, sel, key) in items {
            if t == "-" { menu.addItem(.separator()); continue }
            let it = NSMenuItem(title: t, action: sel, keyEquivalent: key)
            it.target = self
            menu.addItem(it)
        }
        root.submenu = menu
        return root
    }

    func buildMenu() {
        let main = NSMenu()

        // 应用菜单
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 \(APP_NAME)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 \(APP_NAME)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = NSMenuItem(title: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(withTitle: "显示全部", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 \(APP_NAME)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // 编辑（WebView 的剪切复制靠标准选择器）
        main.addItem(makeMenu("编辑", [
            ("撤销", Selector(("undo:")), "z"),
            ("重做", Selector(("redo:")), "Z"),
            ("-", nil, ""),
            ("剪切", #selector(NSText.cut(_:)), "x"),
            ("拷贝", #selector(NSText.copy(_:)), "c"),
            ("粘贴", #selector(NSText.paste(_:)), "v"),
            ("全选", #selector(NSText.selectAll(_:)), "a"),
            ("-", nil, ""),
            ("查找", Selector(("performFindPanelAction:")), "f")
        ]))

        // 视图
        main.addItem(makeMenu("视图", [
            ("重新加载", #selector(reloadPage(_:)), "r"),
            ("强制重新加载", #selector(hardReload(_:)), "R"),
            ("-", nil, ""),
            ("放大", #selector(zoomIn(_:)), "+"),
            ("缩小", #selector(zoomOut(_:)), "-"),
            ("实际大小", #selector(zoomReset(_:)), "0"),
            ("-", nil, ""),
            ("进入全屏", #selector(NSWindow.toggleFullScreen(_:)), "f")
        ]))

        // 窗口
        let winRoot = NSMenuItem(title: "窗口", action: nil, keyEquivalent: "")
        let winMenu = NSMenu(title: "窗口")
        winMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        winMenu.addItem(.separator())
        winMenu.addItem(withTitle: "前置全部窗口", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        winRoot.submenu = winMenu
        main.addItem(winRoot)

        // 帮助
        main.addItem(makeMenu("帮助", [
            ("使用说明（导入 / 导出）", #selector(showHelp(_:)), ""),
            ("打开网页版", #selector(openWebVersion(_:)), ""),
            ("打开管理后台", #selector(openAdmin(_:)), "")
        ]))

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
