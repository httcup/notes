// 网页资源自动更新
//
// 背景：Mac 客户端把 public/ 打进 App，靠本地 127.0.0.1 服务跑起来（localStorage 才能稳定）。
// 以前网页每次发版都要重新打包、重新安装客户端，否则客户端一直停在旧页面。
// 这里在启动时比对线上 version.js，只把静态资源下载到 Application Support 的缓存目录，
// 本地服务优先读缓存、缓存缺失再回落到 App 内置资源 —— 断网时仍能完整使用。

import Foundation

final class IvyWebUpdater {
    static let base = "https://n.139t.cn"
    // 客户端真正会用到的静态资源；dl/ 里的安装包和后台页面不下载
    static let files = [
        "index.html", "s.html", "version.js", "sw.js", "manifest.webmanifest",
        "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png",
        "vendor/mermaid.min.js"
    ]

    private let fm = FileManager.default
    let cacheDir: URL
    var onReady: ((URL) -> Void)?

    init() {
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        cacheDir = base.appendingPathComponent("cn.139t.noteapp/web", isDirectory: true)
    }

    /// 已经有可用缓存就返回缓存目录，否则 nil（用 App 内置网页）
    func cachedRoot() -> URL? {
        let idx = cacheDir.appendingPathComponent("index.html")
        return fm.fileExists(atPath: idx.path) ? cacheDir : nil
    }

    var cachedVersion: String {
        let v = cacheDir.appendingPathComponent("version.txt")
        return (try? String(contentsOf: v, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private static func parseVersion(_ text: String) -> String? {
        guard let r = text.range(of: #"id:\s*'([^']+)'"#, options: .regularExpression) else { return nil }
        let hit = String(text[r])
        guard let q1 = hit.firstIndex(of: "'"), let q2 = hit.lastIndex(of: "'"), q1 < q2 else { return nil }
        return String(hit[hit.index(after: q1)..<q2])
    }

    /// 启动时调用：版本不同就后台下载，下完整体替换缓存目录
    func checkAndUpdate(completion: ((Bool) -> Void)? = nil) {
        guard let url = URL(string: "\(Self.base)/version.js?t=\(Int(Date().timeIntervalSince1970))") else {
            completion?(false); return
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 10
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let self,
                  let data,
                  let text = String(data: data, encoding: .utf8),
                  let id = Self.parseVersion(text) else { completion?(false); return }
            if id == self.cachedVersion { completion?(false); return }
            self.download(version: id, completion: completion)
        }.resume()
    }

    private func download(version: String, completion: ((Bool) -> Void)?) {
        let parent = cacheDir.deletingLastPathComponent()
        try? fm.createDirectory(at: parent, withIntermediateDirectories: true)
        let tmp = fm.temporaryDirectory.appendingPathComponent("ivyweb-\(UUID().uuidString)", isDirectory: true)
        do { try fm.createDirectory(at: tmp, withIntermediateDirectories: true) }
        catch { completion?(false); return }

        let group = DispatchGroup()
        let lock = NSLock()
        var ok = true

        for rel in Self.files {
            group.enter()
            guard let url = URL(string: "\(Self.base)/\(rel)?v=\(version)") else {
                lock.lock(); ok = false; lock.unlock(); group.leave(); continue
            }
            var r = URLRequest(url: url)
            r.timeoutInterval = 30
            r.cachePolicy = .reloadIgnoringLocalCacheData
            URLSession.shared.dataTask(with: r) { data, resp, _ in
                defer { group.leave() }
                guard let data, !data.isEmpty,
                      (resp as? HTTPURLResponse)?.statusCode == 200 else {
                    lock.lock(); ok = false; lock.unlock(); return
                }
                let dest = tmp.appendingPathComponent(rel)
                do {
                    try FileManager.default.createDirectory(at: dest.deletingLastPathComponent(),
                                                            withIntermediateDirectories: true)
                    try data.write(to: dest)
                } catch {
                    lock.lock(); ok = false; lock.unlock()
                }
            }.resume()
        }

        group.notify(queue: .global()) { [weak self] in
            guard let self else { return }
            lock.lock(); let success = ok; lock.unlock()
            guard success else {
                try? self.fm.removeItem(at: tmp)
                completion?(false); return
            }
            try? version.write(to: tmp.appendingPathComponent("version.txt"),
                               atomically: true, encoding: .utf8)
            // 整体换目录：中途失败也不会留下半套资源
            let old = parent.appendingPathComponent("web-old-\(UUID().uuidString)", isDirectory: true)
            do {
                if self.fm.fileExists(atPath: self.cacheDir.path) {
                    try self.fm.moveItem(at: self.cacheDir, to: old)
                }
                try self.fm.moveItem(at: tmp, to: self.cacheDir)
                try? self.fm.removeItem(at: old)
                DispatchQueue.main.async { self.onReady?(self.cacheDir) }
                completion?(true)
            } catch {
                try? self.fm.removeItem(at: tmp)
                completion?(false)
            }
        }
    }
}
