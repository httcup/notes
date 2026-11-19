// 随手笔记 · Mac 客户端的本地服务
//
// 为什么需要它：
// WKWebView 对 Service Worker 支持不可靠，直接加载 https://n.139t.cn 的话断网就是白屏。
// 这里在 127.0.0.1 的固定端口上把内置网页当静态站跑起来，页面与 localStorage 都留在本地；
// 只有 /api/* 在联网时才转发到线上服务器，断网时接口直接失败，页面自己的重试逻辑会接管。
//
// 固定端口很重要：localStorage 是按 origin（协议 + 主机 + 端口）隔离的，端口一变笔记就"不见"了。

import Foundation
import Network

private struct IvyRequest {
    let method: String
    let target: String              // 路径 + 查询串
    let headers: [String: String]
    let contentLength: Int
}

final class IvyLocalServer {
    let root: URL
    let port: UInt16 = 47821
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "cn.139t.noteapp.localserver", attributes: .concurrent)

    init(root: URL) { self.root = root.standardizedFileURL }

    var homeURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    func start() {
        do {
            let l = try NWListener(using: .tcp, on: NWEndpoint.Port(integerLiteral: port))
            l.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
            l.stateUpdateHandler = { state in
                if case .failed(let err) = state { NSLog("IvyLocalServer failed: \(err)") }
            }
            l.start(queue: queue)
            listener = l
        } catch {
            NSLog("IvyLocalServer start error: \(error)")
        }
    }

    // MARK: - HTTP 请求解析

    private static func splitHeaders(_ data: Data) -> (Data, Data)? {
        let sep = Data([0x0D, 0x0A, 0x0D, 0x0A])
        guard let r = data.range(of: sep) else { return nil }
        return (data.subdata(in: data.startIndex..<r.lowerBound),
                data.subdata(in: r.upperBound..<data.endIndex))
    }

    private static func parse(_ head: Data) -> IvyRequest? {
        guard let text = String(data: head, encoding: .utf8) else { return nil }
        let lines = text.split(separator: "\r\n", omittingEmptySubsequences: false)
        guard let first = lines.first else { return nil }
        let parts = first.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
        guard parts.count >= 2 else { return nil }
        let method = String(parts[0]).uppercased()
        let target = String(parts[1])

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = String(line[..<colon]).trimmingCharacters(in: .whitespaces).lowercased()
            let val = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            headers[key] = val
        }
        return IvyRequest(method: method, target: target, headers: headers,
                          contentLength: Int(headers["content-length"] ?? "") ?? 0)
    }

    private func handle(_ conn: NWConnection) {
        conn.start(queue: queue)
        var buffer = Data()

        func pump() {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, _, error in
                if let d = data, !d.isEmpty { buffer.append(d) }
                if let (head, rest) = Self.splitHeaders(buffer), let req = Self.parse(head) {
                    if rest.count < req.contentLength { pump(); return }
                    self?.route(conn, req: req, body: Data(rest.prefix(req.contentLength)))
                    return
                }
                if error != nil || buffer.count > 4_000_000 { conn.cancel(); return }
                pump()
            }
        }
        pump()
    }

    // MARK: - 路由

    private func route(_ conn: NWConnection, req: IvyRequest, body: Data) {
        if req.target.hasPrefix("/api/") {
            proxy(conn, req: req, body: body)
        } else if req.method == "GET" || req.method == "HEAD" {
            serve(conn, req: req)
        } else {
            send(conn, status: 405, contentType: "text/plain; charset=utf-8",
                 body: Data("Method Not Allowed".utf8))
        }
    }

    private func serve(_ conn: NWConnection, req: IvyRequest) {
        var path = req.target.split(separator: "?", maxSplits: 1).first.map(String.init) ?? "/"
        path = path.removingPercentEncoding ?? path
        if path == "/" { path = "/index.html" }
        let rel = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let file = root.appendingPathComponent(rel, isDirectory: false).standardizedFileURL

        // 防目录穿越：解析后的路径必须仍在 web 目录里
        guard file.path.hasPrefix(root.path + "/"),
              let data = try? Data(contentsOf: file) else {
            send(conn, status: 404, contentType: "text/plain; charset=utf-8",
                 body: Data("404 Not Found".utf8))
            return
        }
        send(conn, status: 200, contentType: Self.mime(file.pathExtension.lowercased()),
             body: req.method == "HEAD" ? Data() : data)
    }

    private func proxy(_ conn: NWConnection, req: IvyRequest, body: Data) {
        // 自检用：模拟断网（页面还是本地资源，只有接口失败）
        if ProcessInfo.processInfo.environment["IVY_TEST_OFFLINE"] == "1" {
            sendJSON(conn, status: 502, object: ["ok": false, "error": "offline (test)"])
            return
        }
        guard let url = URL(string: "https://n.139t.cn" + req.target) else {
            sendJSON(conn, status: 502, object: ["ok": false, "error": "bad api url"])
            return
        }
        var r = URLRequest(url: url)
        r.httpMethod = req.method
        let skip = ["host", "content-length", "connection", "accept-encoding", "origin"]
        for (k, v) in req.headers where !skip.contains(k.lowercased()) {
            r.setValue(v, forHTTPHeaderField: k)
        }
        // 服务端会校验来源，代理出去时冒充网页版本身
        r.setValue("https://n.139t.cn", forHTTPHeaderField: "Origin")
        if !body.isEmpty { r.httpBody = body }

        URLSession.shared.dataTask(with: r) { data, resp, _ in
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 502
            var ct = "application/json; charset=utf-8"
            if let h = (resp as? HTTPURLResponse)?.allHeaderFields {
                for (key, value) in h {
                    if (key as? String)?.lowercased() == "content-type", let s = value as? String {
                        ct = s
                    }
                }
            }
            let payload = data ?? Data("{\"ok\":false,\"error\":\"offline\"}".utf8)
            self.send(conn, status: status, contentType: ct, body: payload)
        }.resume()
    }

    private func sendJSON(_ conn: NWConnection, status: Int, object: [String: Any]) {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: []))
            ?? Data("{\"ok\":false}".utf8)
        send(conn, status: status, contentType: "application/json; charset=utf-8", body: data)
    }

    private func send(_ conn: NWConnection, status: Int, contentType: String, body: Data) {
        let reason = HTTPURLResponse.localizedString(forStatusCode: status)
        let head = "HTTP/1.1 \(status) \(reason)\r\n"
            + "Content-Type: \(contentType)\r\n"
            + "Content-Length: \(body.count)\r\n"
            + "Cache-Control: no-store\r\n"
            + "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(body)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }

    private static func mime(_ ext: String) -> String {
        switch ext {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs":   return "text/javascript; charset=utf-8"
        case "css":         return "text/css; charset=utf-8"
        case "json", "webmanifest": return "application/json; charset=utf-8"
        case "png":         return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif":         return "image/gif"
        case "webp":        return "image/webp"
        case "svg":         return "image/svg+xml"
        case "ico":         return "image/x-icon"
        case "woff":        return "font/woff"
        case "woff2":       return "font/woff2"
        case "ttf":         return "font/ttf"
        case "txt":         return "text/plain; charset=utf-8"
        default:            return "application/octet-stream"
        }
    }
}
