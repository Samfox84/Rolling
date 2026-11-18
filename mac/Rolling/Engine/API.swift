import Foundation

/// A problem talking to the studio, in plain words.
struct StudioError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Talks to a Rolling studio's web API — the one running inside this app, or one on a server.
/// Signed in as the studio's owner (admin password), or with one show's host link (just that show).
final class StudioAPI: @unchecked Sendable {
    let base: URL
    /// With a host link: that show's key (added to every request). Empty when signed in as the owner.
    let hostKey: String
    private let session: URLSession
    private let decoder = JSONDecoder()

    init(base: URL, hostKey: String = "") {
        self.base = base
        self.hostKey = hostKey
        let cfg = URLSessionConfiguration.ephemeral
        cfg.httpCookieStorage = HTTPCookieStorage()        // this studio's sign-in, kept apart from everything else
        cfg.httpCookieAcceptPolicy = .always
        cfg.timeoutIntervalForRequest = 60
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: cfg)
    }

    // MARK: - plumbing

    func url(_ path: String, key: String? = nil) -> URL {
        var s = base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path
        let k = key ?? hostKey
        if !k.isEmpty { s += (path.contains("?") ? "&" : "?") + "k=" + (k.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? k) }
        return URL(string: s) ?? base
    }

    @discardableResult
    func data(_ method: String, _ path: String, json: Any? = nil, body: Data? = nil, headers: [String: String] = [:],
              key: String? = nil, timeout: TimeInterval = 60) async throws -> Data {
        var req = URLRequest(url: url(path, key: key))
        req.httpMethod = method
        req.timeoutInterval = timeout
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        if let json {
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else if let body {
            req.httpBody = body
            req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        }
        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await session.data(for: req) }
        catch { throw StudioError(message: "The studio didn't answer (\(error.localizedDescription))") }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw StudioError(message: msg ?? (String(data: data, encoding: .utf8).flatMap { $0.count < 200 && !$0.isEmpty ? $0 : nil } ?? "The studio said \(code)"))
        }
        return data
    }

    func get<T: Decodable>(_ type: T.Type, _ path: String, key: String? = nil) async throws -> T {
        let d = try await data("GET", path, key: key)
        do { return try decoder.decode(T.self, from: d) }
        catch { throw StudioError(message: "The studio sent something this app doesn't understand (\(error.localizedDescription))") }
    }

    func send<T: Decodable>(_ type: T.Type, _ method: String, _ path: String, json: Any? = nil, key: String? = nil) async throws -> T {
        let d = try await data(method, path, json: json, key: key)
        return try decoder.decode(T.self, from: d)
    }

    func call(_ method: String, _ path: String, json: Any? = nil, key: String? = nil) async throws {
        try await data(method, path, json: json, key: key)
    }

    // MARK: - the studio

    func info() async throws -> StudioInfo { try await get(StudioInfo.self, "/api/info") }

    func login(password: String) async throws {
        try await call("POST", "/api/login", json: ["password": password])
    }

    func rooms() async throws -> RoomsReply { try await get(RoomsReply.self, "/api/rooms") }

    func room(_ id: String, key: String? = nil) async throws -> Room { try await get(Room.self, "/api/rooms/\(id)", key: key) }

    func makeRoom(name: String) async throws -> Room { try await send(Room.self, "POST", "/api/rooms", json: ["name": name]) }

    func deleteRoom(_ id: String) async throws { try await call("DELETE", "/api/rooms/\(id)") }

    func roomSettings(_ r: Room, _ changes: [String: Any]) async throws -> Room {
        try await send(Room.self, "POST", "/api/rooms/\(r.id)/settings", json: changes, key: r.hostKey)
    }

    func settings() async throws -> StudioSettings { try await get(StudioSettings.self, "/api/settings") }

    func saveSettings(_ changes: [String: Any]) async throws { try await call("POST", "/api/settings", json: changes) }

    /// Upload a file (intro / outro, soundboard pad); the studio converts it.
    func upload(_ path: String, file: URL, key: String) async throws -> Data {
        let body = try Data(contentsOf: file)
        let name = file.lastPathComponent.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "file"
        return try await data("POST", path, body: body, headers: ["X-Filename": name], key: key, timeout: 600)
    }

    /// Download to a file (a take's files, its zip).
    func download(_ path: String, to dest: URL, key: String) async throws {
        var req = URLRequest(url: url(path, key: key))
        req.timeoutInterval = 24 * 3600
        let (tmp, resp) = try await session.download(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw StudioError(message: "The studio said \(code)") }
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: tmp, to: dest)
    }

    /// Fetch part of a file (the live copy of a take, while it records).
    func range(_ path: String, from: Int, to: Int, key: String) async throws -> (Data, Int) {
        var req = URLRequest(url: url(path, key: key))
        req.setValue("bytes=\(from)-\(to)", forHTTPHeaderField: "Range")
        req.timeoutInterval = 60
        let (d, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 403 { throw StudioError(message: "The studio refused this host link (it may have been changed)") }
        return (d, code)
    }

    /// A plain web address for something (to show or open in a browser).
    func link(_ path: String, key: String) -> URL { url(path, key: key) }
}
