import Darwin
import Security
import Foundation
import Observation

/// "Host it on this Mac": runs a whole Rolling studio inside the app — no server needed.
///
///   the studio      Rolling's own server.js, run by the copy of Node inside the app, on this Mac only (127.0.0.1)
///   the guest link  cloudflared, either
///                     quick — a free https://…trycloudflare.com address, no account, new each time
///                     own   — your own address through a tunnel in your free Cloudflare account (same every time)
///   the tools       ffmpeg and ffprobe make the files after each take
///
/// Recordings, shows and settings live in the studio folder (default ~/Rolling Studio, the same as Rolling Desk).
@MainActor @Observable
final class LocalStudio {
    enum Phase: Equatable { case stopped, starting, running, failed(String) }

    private(set) var phase: Phase = .stopped
    private(set) var localURL: URL?
    private(set) var guestBase: String = ""         // https://… once the guest link works
    private(set) var guestLinkReady = false
    private(set) var guestLinkMessage = "Getting a link for your guests…"
    private(set) var recentLog: [String] = []
    private(set) var password = ""

    private var server: ChildProcess?
    private var tunnel: ChildProcess?
    private var stopping = false
    private var tunnelTries = 0
    private var prefs = Prefs()
    private var logHandle: FileHandle?

    /// Called when the guest link changes after it first worked (people need the new one).
    var onLinkChanged: ((String) -> Void)?
    /// Called if the studio stops by itself.
    var onCrash: ((String) -> Void)?

    static let toolsDir = Bundle.main.resourceURL?.appendingPathComponent("Tools")
    static let studioDir = Bundle.main.resourceURL?.appendingPathComponent("Studio")
    static func tool(_ name: String) -> String? {
        guard let p = toolsDir?.appendingPathComponent(name).path, FileManager.default.isExecutableFile(atPath: p) else { return nil }
        return p
    }

    var isRunning: Bool { phase == .running }

    // MARK: - start / stop

    func start(prefs: Prefs) async throws -> URL {
        stop()
        self.prefs = prefs
        stopping = false
        phase = .starting
        guestBase = ""; guestLinkReady = false; guestLinkMessage = "Getting a link for your guests…"
        do {
            let url = try await startServer()
            localURL = url
            phase = .running
            startTunnel()
            return url
        } catch {
            phase = .failed(error.localizedDescription)
            stop()
            phase = .failed(error.localizedDescription)
            throw error
        }
    }

    func stop() {
        stopping = true
        tunnel?.stop(); tunnel = nil
        server?.stop(); server = nil
        try? FileManager.default.removeItem(at: pidFile)
        if phase == .running || phase == .starting { phase = .stopped }
        localURL = nil
    }

    // MARK: - the studio

    private var secretsFile: URL { Prefs.supportDir.appendingPathComponent("studio-secrets.json") }
    private var pidFile: URL { Prefs.supportDir.appendingPathComponent("tunnel.pid") }

    /// This studio's admin password and signing secret: made once, kept on this Mac (shared with Rolling Desk's format).
    private func secrets() -> (password: String, secret: String) {
        if let d = try? Data(contentsOf: secretsFile), let o = try? JSONSerialization.jsonObject(with: d) as? [String: String],
           let p = o["password"], let s = o["secret"], !p.isEmpty, !s.isEmpty { return (p, s) }
        let p = randomToken(9), s = randomHex(32)
        if let d = try? JSONSerialization.data(withJSONObject: ["password": p, "secret": s]) {
            FileManager.default.createFile(atPath: secretsFile.path, contents: d, attributes: [.posixPermissions: 0o600])
        }
        return (p, s)
    }

    private func startServer() async throws -> URL {
        guard let node = Self.tool("node") else { throw StudioError(message: "This copy of Rolling is missing its studio engine (node). Build it again in Xcode — the build gets it.") }
        guard let studio = Self.studioDir, FileManager.default.fileExists(atPath: studio.appendingPathComponent("server.js").path) else {
            throw StudioError(message: "This copy of Rolling is missing the studio (server.js). Build it again in Xcode — the build copies it in.")
        }
        let folder = prefs.studioFolder
        do { try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true) }
        catch { throw StudioError(message: "Can't use the studio folder \(folder): \(error.localizedDescription)") }
        guard FileManager.default.isWritableFile(atPath: folder) else { throw StudioError(message: "Rolling can't save in \(folder) — choose another studio folder in Settings.") }
        tidyUpOldTunnel()

        let port: Int
        if prefs.guestLink == .own {
            port = prefs.ownPort
            guard Self.portFree(port) else {
                throw StudioError(message: "Port \(port) on this Mac is already in use (is another studio running?). Your Cloudflare tunnel points at this port, so close whatever is using it, or change the port in Settings and in Cloudflare.")
            }
        } else { port = Self.freePort() }

        let (pw, secret) = secrets()
        password = pw
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(port)
        env["BIND"] = "127.0.0.1"
        env["DATA_DIR"] = folder
        env["STUDIO_NAME"] = "Rolling"
        env["ADMIN_PASSWORD"] = pw
        env["SECRET"] = secret
        env["FFMPEG"] = Self.tool("ffmpeg") ?? "ffmpeg"
        env["FFPROBE"] = Self.tool("ffprobe") ?? "ffprobe"
        env["PATH"] = [Self.toolsDir?.path, "/opt/homebrew/bin", "/usr/local/bin", env["PATH"]].compactMap { $0 }.joined(separator: ":")
        if let w = Self.tool("whisper-cli") { env["WHISPER_BIN"] = w; env["WHISPER_MODELS"] = Self.toolsDir?.appendingPathComponent("models").path }
        if prefs.guestLink == .own, let a = Self.cleanAddress(prefs.ownAddress) { env["ROLLING_PUBLIC_URL"] = a }

        openLog()
        writeLog("--- \(ISO8601DateFormatter().string(from: Date())) starting the studio")
        recentLog = []
        server = try ChildProcess(exe: node, args: [studio.appendingPathComponent("server.js").path], env: env, cwd: studio.path, channel: true,
            onLine: { [weak self] line in Task { @MainActor in self?.studioSaid(line) } },
            onExit: { [weak self] code in Task { @MainActor in self?.studioStopped(code) } })
        let url = URL(string: "http://127.0.0.1:\(port)")!
        try await waitUntilUp(url, seconds: 30)
        return url
    }

    private func studioSaid(_ line: String) {
        writeLog(line)
        recentLog = Array((recentLog + [line]).suffix(8))
    }

    private func studioStopped(_ code: Int32) {
        server = nil
        writeLog("--- the studio stopped (\(code))")
        if stopping { return }
        let why = recentLog.last(where: { $0.range(of: "error|cannot|EACCES|ENOSPC|EADDR", options: .regularExpression) != nil }) ?? "code \(code)"
        tunnel?.stop(); tunnel = nil
        phase = .failed("Your studio stopped unexpectedly (\(why)). Recordings already made are safe in \(prefs.studioFolder).")
        onCrash?(why)
    }

    private func waitUntilUp(_ url: URL, seconds: Double) async throws {
        let until = Date().addingTimeInterval(seconds)
        while true {
            if server == nil {
                let why = recentLog.filter { $0.range(of: "error|cannot|EACCES|ENOSPC|EADDR", options: [.regularExpression, .caseInsensitive]) != nil }.suffix(2)
                throw StudioError(message: "The studio couldn't start: \((why.isEmpty ? recentLog.suffix(2) : why).joined(separator: " · "))")
            }
            var req = URLRequest(url: url.appendingPathComponent("api/info"))
            req.timeoutInterval = 2
            if let (_, r) = try? await URLSession.shared.data(for: req), (r as? HTTPURLResponse)?.statusCode == 200 { return }
            if Date() > until { throw StudioError(message: "The studio didn't start within \(Int(seconds)) seconds.") }
            try await Task.sleep(for: .milliseconds(250))
        }
    }

    // MARK: - the guest link

    private func startTunnel() {
        guard let bin = Self.tool("cloudflared"), let local = localURL else {
            guestLinkMessage = "This copy of Rolling has no tunnel program (cloudflared), so guests can't reach you."
            return
        }
        let own = prefs.guestLink == .own
        let token = own ? (Keychain.get("tunnel-token") ?? "") : ""
        if own && token.isEmpty { guestLinkMessage = "Your own guest link needs your Cloudflare tunnel token — add it in Settings."; return }
        // an empty config, so a cloudflared set up for something else on this Mac can't get in the way
        let cfg = Prefs.supportDir.appendingPathComponent("cloudflared-empty.yml")
        try? "# Rolling tunnel — deliberately empty\n{}\n".write(to: cfg, atomically: true, encoding: .utf8)
        let args = own ? ["tunnel", "--no-autoupdate", "--config", cfg.path, "run"]
                       : ["tunnel", "--no-autoupdate", "--config", cfg.path, "--url", local.absoluteString]
        var env = ProcessInfo.processInfo.environment
        if own { env["TUNNEL_TOKEN"] = token }   // in its environment, not on the command line where others could see it
        var found = false
        do {
            let t = try ChildProcess(exe: bin, args: args, env: env,
                onLine: { [weak self] line in
                    Task { @MainActor in
                        guard let self else { return }
                        if line.range(of: "ERR|error", options: .regularExpression) != nil { self.writeLog("[tunnel] " + line.replacingOccurrences(of: token.isEmpty ? "\0" : token, with: "<token>")) }
                        if !found, own, line.range(of: "Registered tunnel connection", options: .caseInsensitive) != nil {
                            found = true; self.tunnelTries = 0; self.setGuestBase(Self.cleanAddress(self.prefs.ownAddress) ?? "")
                        }
                        if !found, !own, let r = line.range(of: #"https://[a-z0-9-]+\.trycloudflare\.com"#, options: .regularExpression) {
                            found = true; self.tunnelTries = 0; self.setGuestBase(String(line[r]))
                        }
                        if own, line.range(of: "Unauthorized|invalid token|token is not valid|failed to unmarshal", options: [.regularExpression, .caseInsensitive]) != nil {
                            self.guestLinkMessage = "Cloudflare didn't accept your tunnel token — copy it again from your Cloudflare tunnel (Install and run a connector) and paste it in Settings."
                        }
                    }
                },
                onExit: { [weak self] code in
                    Task { @MainActor in
                        guard let self, !self.stopping, self.server != nil else { return }
                        self.tunnel = nil
                        let wait = min(60, pow(2, Double(self.tunnelTries)))
                        self.tunnelTries += 1
                        self.guestLinkReady = false
                        self.guestLinkMessage = own ? "The guest link dropped — reconnecting…" : "The guest link dropped — getting a new one…"
                        self.writeLog("[tunnel] stopped (\(code)) — trying again in \(Int(wait)) s")
                        try? await Task.sleep(for: .seconds(wait))
                        if !self.stopping, self.server != nil { self.startTunnel() }
                    }
                })
            tunnel = t
            try? String(t.pid).write(to: pidFile, atomically: true, encoding: .utf8)
        } catch {
            guestLinkMessage = "The guest link couldn't start: \(error.localizedDescription)"
        }
    }

    private func setGuestBase(_ url: String) {
        guard !url.isEmpty else { return }
        let changed = !guestBase.isEmpty && guestBase != url
        guestBase = url
        guestLinkMessage = "Checking your guest link works…"
        server?.send(["publicUrl": url])              // every page and invite now shows this address
        if changed { onLinkChanged?(url) }
        Task {
            let ok = await reachable(url)
            if self.guestBase == url {
                self.guestLinkReady = ok
                self.guestLinkMessage = ok ? "Guests can join" : (self.prefs.guestLink == .own
                    ? "Your guest link isn't reachable yet — check your tunnel's Public hostname points at http://localhost:\(self.prefs.ownPort)"
                    : "Your guest link isn't reachable yet — it usually starts working within a minute")
            }
        }
    }

    private func reachable(_ url: String) async -> Bool {
        let until = Date().addingTimeInterval(60)
        while Date() < until, guestBase == url {
            if let u = URL(string: url + "/api/info") {
                var req = URLRequest(url: u); req.timeoutInterval = 5
                if let (_, r) = try? await URLSession.shared.data(for: req), (r as? HTTPURLResponse)?.statusCode == 200 { return true }
            }
            try? await Task.sleep(for: .seconds(2))
        }
        return false
    }

    /// A guest-link program left running by a crash last time is stopped (only if it really is cloudflared).
    private func tidyUpOldTunnel() {
        guard let s = try? String(contentsOf: pidFile, encoding: .utf8), let pid = pid_t(s.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0 else { return }
        var buf = [CChar](repeating: 0, count: 4096)
        if proc_pidpath(pid, &buf, UInt32(buf.count)) > 0, String(cString: buf).hasSuffix("cloudflared") { kill(pid, SIGTERM) }
        try? FileManager.default.removeItem(at: pidFile)
    }

    // MARK: - while running

    /// Is a show going on? (recording, files still uploading or being made, or people in the studio)
    func busyReason(api: StudioAPI?) async -> String {
        guard isRunning, let api else { return "" }
        guard let r = try? await api.rooms() else { return "" }
        var bits: [String] = []
        let rec = r.rooms.filter { $0.recording == true }.map(\.name)
        if !rec.isEmpty { bits.append("recording in \(rec.joined(separator: ", "))") }
        let making = Set(r.rooms.filter { ($0.takes ?? []).contains { ["waiting", "queued", "processing"].contains($0.status) } }.map(\.name))
        if !making.isEmpty { bits.append("still receiving or making the files for \(making.sorted().joined(separator: ", "))") }
        let online = r.rooms.reduce(0) { $0 + ($1.online?.count ?? 0) }
        if online > 0 { bits.append("\(online) \(online == 1 ? "person is" : "people are") in the studio") }
        return bits.isEmpty ? "" : "Your studio is \(bits.joined(separator: ", and "))."
    }

    // MARK: - the studio's diary

    static var logFile: URL { Prefs.supportDir.appendingPathComponent("studio.log") }

    private func openLog() {
        if logHandle != nil { return }
        if !FileManager.default.fileExists(atPath: Self.logFile.path) { FileManager.default.createFile(atPath: Self.logFile.path, contents: nil) }
        logHandle = try? FileHandle(forWritingTo: Self.logFile)
        _ = try? logHandle?.seekToEnd()
    }

    private func writeLog(_ line: String) {
        try? logHandle?.write(contentsOf: Data((line + "\n").utf8))
    }

    // MARK: - helpers

    static func cleanAddress(_ a: String) -> String? {
        var s = a.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.lowercased().hasPrefix("http") { s = "https://" + s }
        guard let u = URL(string: s), u.scheme == "https", let host = u.host?.lowercased(),
              host.range(of: #"^[a-z0-9-]+(\.[a-z0-9-]+)+$"#, options: .regularExpression) != nil, !host.hasSuffix("trycloudflare.com") else { return nil }
        return "https://\(host)"
    }

    static func freePort() -> Int {
        let s = socket(AF_INET, SOCK_STREAM, 0)
        defer { close(s) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, len) } }
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(s, $0, &len) } }
        let p = Int(UInt16(bigEndian: addr.sin_port))
        return p > 0 ? p : 8790
    }

    static func portFree(_ port: Int) -> Bool {
        let s = socket(AF_INET, SOCK_STREAM, 0)
        defer { close(s) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        let len = socklen_t(MemoryLayout<sockaddr_in>.size)
        return withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, len) } } == 0
    }
}

func randomToken(_ bytes: Int) -> String {
    var b = [UInt8](repeating: 0, count: bytes)
    _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &b)
    return Data(b).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

func randomHex(_ bytes: Int) -> String {
    var b = [UInt8](repeating: 0, count: bytes)
    _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &b)
    return b.map { String(format: "%02x", $0) }.joined()
}
