import AppKit
import Foundation
import Observation

/// Everything the windows show: how this Mac uses Rolling, the studio it's talking to, its shows.
@MainActor @Observable
final class AppModel {
    enum Phase: Equatable { case welcome, starting(String), ready, failed(String) }

    var prefs = Prefs.load() { didSet { if prefs != oldValue { prefs.save() } } }
    private(set) var phase: Phase = .welcome
    let local = LocalStudio()
    private(set) var api: StudioAPI?
    /// Signed in as the studio's owner (all shows, studio settings) — or just one show from its host link.
    private(set) var isOwner = false
    private(set) var onlyRoom: String?
    private(set) var rooms: [Room] = []
    private(set) var disk: Disk?
    private(set) var studioVersion = ""
    private(set) var studioName = "Rolling"
    private(set) var serverLink = ""                 // the studio's public address (guest links)
    private(set) var lastError = ""
    var selection: String?                           // a show's id
    private(set) var mirror: Mirror?
    /// Live studios open in their own windows, by show id.
    private(set) var studios: [String: StudioSession] = [:]
    private var refresher: Task<Void, Never>?

    var hosting: Bool { prefs.mode == .host && local.isRunning }

    init() {
        local.onCrash = { [weak self] why in self?.phase = .failed("Your studio stopped unexpectedly (\(why)). Recordings already made are safe in \(self?.prefs.studioFolder ?? "your studio folder"). Press Start to run it again.") }
        local.onLinkChanged = { url in
            let a = NSAlert()
            a.messageText = "Your studio has a new internet address"
            a.informativeText = "The guest link dropped and a new one was made:\n\(url)\n\nAnyone who was disconnected needs the new link. Recordings are safe — they upload when people come back."
            a.addButton(withTitle: "Copy the new link"); a.addButton(withTitle: "OK")
            if a.runModal() == .alertFirstButtonReturn { copy(url) }
        }
    }

    private var resumed = false
    /// On launch: carry on the way this Mac was used last time.
    func resume(again: Bool = false) {
        guard !resumed || again else { return }
        resumed = true
        switch prefs.mode {
        case .host: Task { await startHosting() }
        case .connect:
            if !prefs.server.isEmpty { Task { await connect(to: prefs.server, password: nil) } }
        case .none: phase = .welcome
        }
    }

    // MARK: - hosting on this Mac

    func startHosting() async {
        prefs.mode = .host
        phase = .starting("Starting your studio on this Mac…")
        do {
            let url = try await local.start(prefs: prefs)
            let a = StudioAPI(base: url)
            try await a.login(password: local.password)
            api = a; isOwner = true; onlyRoom = nil
            phase = .ready
            await refresh()
            startRefreshing()
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    // MARK: - connected to a studio server

    /// `address`: the studio's web address (signed in with its admin password) or a show's host link.
    func connect(to address: String, password: String?) async {
        let typed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        phase = .starting("Connecting to your studio…")
        do {
            if let (base, room, key) = Self.parseHostLink(typed) {
                let a = StudioAPI(base: base, hostKey: key)
                _ = try await a.room(room)
                api = a; isOwner = false; onlyRoom = room
            } else {
                var s = typed
                if !s.lowercased().hasPrefix("http") { s = "https://" + s }
                guard let u = URL(string: s), let host = u.host else { throw StudioError(message: "That isn't a web address — type your studio's address, like podcast.example.com") }
                let base = URL(string: "\(u.scheme ?? "https")://\(host)\(u.port.map { ":\($0)" } ?? "")")!
                let a = StudioAPI(base: base)
                let pw = password ?? Keychain.get("server:\(host)") ?? ""
                if pw.isEmpty { throw StudioError(message: "Type your studio's admin password") }
                try await a.login(password: pw)
                Keychain.set("server:\(host)", pw)
                api = a; isOwner = true; onlyRoom = nil
                s = base.absoluteString
            }
            prefs.mode = .connect
            prefs.server = typed
            phase = .ready
            await refresh()
            startRefreshing()
            startMirror()
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    static func parseHostLink(_ link: String) -> (URL, String, String)? {
        guard let u = URLComponents(string: link), let scheme = u.scheme, let host = u.host,
              let key = u.queryItems?.first(where: { $0.name == "k" })?.value, !key.isEmpty else { return nil }
        let parts = u.path.split(separator: "/")
        guard parts.count == 2, parts[0] == "r" || parts[0] == "m" else { return nil }
        let base = URL(string: "\(scheme)://\(host)\(u.port.map { ":\($0)" } ?? "")")!
        return (base, String(parts[1]), key)
    }

    private func startMirror() {
        mirror?.stop(); mirror = nil
        guard prefs.mode == .connect, prefs.saveCopies, let api else { return }
        let m = Mirror(api: api, folder: URL(fileURLWithPath: prefs.copiesFolder), removeLive: prefs.removeLiveCopy) { [weak self] in
            guard let self else { return [] }
            return self.rooms
        }
        mirror = m
        m.start()
    }

    func copiesChanged() { startMirror() }

    // MARK: - leaving

    /// Stop hosting / disconnect and go back to the welcome screen (asks first if a show is going on).
    func signOut() async {
        if let why = await busyReason(), !why.isEmpty {
            let a = NSAlert()
            a.messageText = why
            a.informativeText = hosting ? "Stopping disconnects everyone, and guests can't join until you host again." : "If you switch now, the copy on this Mac stops part-way. The studio server still has everything."
            a.addButton(withTitle: "Cancel"); a.addButton(withTitle: hosting ? "Stop the studio" : "Switch anyway")
            a.alertStyle = .warning
            if a.runModal() != .alertSecondButtonReturn { return }
        }
        stopEverything()
        prefs.mode = .none
        phase = .welcome
    }

    func stopEverything() {
        for s in studios.values { s.leave() }
        studios = [:]
        refresher?.cancel(); refresher = nil
        mirror?.stop(); mirror = nil
        local.stop()
        api = nil; rooms = []; selection = nil
    }

    /// Why closing now would cut a show off ("" = safe).
    func busyReason() async -> String? {
        if hosting { return await local.busyReason(api: api) }
        if let m = mirror, m.busy { return "Rolling is still saving your recording. \(m.detail)" }
        if studios.values.contains(where: { $0.recordingSince != nil }) { return "You're recording." }
        return nil
    }

    // MARK: - shows

    func startRefreshing() {
        refresher?.cancel()
        refresher = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                await self?.refresh()
            }
        }
    }

    func refresh() async {
        guard let api else { return }
        do {
            if isOwner {
                let r = try await api.rooms()
                rooms = r.rooms; disk = r.disk; studioVersion = r.version ?? studioVersion
            } else if let id = onlyRoom {
                let r = try await api.room(id)
                rooms = [r]; disk = r.disk
            }
            if studioName == "Rolling" || serverLink.isEmpty, let info = try? await api.info() {
                studioName = info.name ?? "Rolling"; serverLink = info.link ?? ""; studioVersion = info.version ?? studioVersion
            }
            if selection == nil || !rooms.contains(where: { $0.id == selection }) { selection = rooms.first?.id }
            lastError = ""
        } catch { lastError = error.localizedDescription }
    }

    func room(_ id: String?) -> Room? { rooms.first { $0.id == id } }

    /// The address guests use for a show.
    func guestLink(_ r: Room) -> String {
        let base = hosting ? local.guestBase : (!serverLink.isEmpty ? serverLink : api?.base.absoluteString ?? "")
        return base.isEmpty ? "" : base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/r/\(r.id)"
    }

    func makeShow(_ name: String) async -> Room? {
        guard let api else { return nil }
        do { let r = try await api.makeRoom(name: name); await refresh(); selection = r.id; return r }
        catch { report(error); return nil }
    }

    func deleteShow(_ r: Room) async {
        do { try await api?.deleteRoom(r.id); await refresh() } catch { report(error) }
    }

    func update(_ r: Room, _ changes: [String: Any]) async {
        guard let api else { return }
        do { let n = try await api.roomSettings(r, changes); if let i = rooms.firstIndex(where: { $0.id == r.id }) { rooms[i] = merge(rooms[i], n) } }
        catch { report(error) }
    }

    private func merge(_ old: Room, _ new: Room) -> Room { var n = new; if n.takes == nil { n.takes = old.takes }; return n }

    func takeAction(_ r: Room, _ t: Take, _ action: String, json: Any? = nil) async {
        do { try await api?.call(action == "delete" ? "DELETE" : "POST", "/api/rooms/\(r.id)/takes/\(t.id)\(action == "delete" ? "" : "/" + action)", json: json, key: r.hostKey); await refresh() }
        catch { report(error) }
    }

    // MARK: - the live studio

    func openStudio(_ r: Room, name: String, controlRoom: Bool) -> StudioSession? {
        guard let api else { return nil }
        if let s = studios[r.id], !s.hasLeft { return s }
        prefs.myName = name
        prefs.controlRoom = controlRoom
        let s = StudioSession(api: api, room: r, name: name, controlRoom: controlRoom, prefs: prefs, guestLink: guestLink(r))
        studios[r.id] = s
        s.start()
        return s
    }

    func session(_ id: String) -> StudioSession? { studios[id] }

    func closeStudio(_ id: String) {
        studios[id]?.leave()
        studios[id] = nil
    }

    // MARK: - telling the person

    func report(_ error: Error) {
        let a = NSAlert(error: error)
        a.runModal()
    }
}

func copy(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}
