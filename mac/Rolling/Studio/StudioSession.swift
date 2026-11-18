import AppKit
import AVFoundation
import Foundation
import Observation
import WebRTC

/// The producer in one show's studio: the connection to the studio engine, the calls with everyone, the Console,
/// soundboard, recording and everything the studio window shows.
@MainActor @Observable
final class StudioSession {
    enum Phase: Equatable { case connecting, waiting, inside, reconnecting, refused(String, String), left }

    let api: StudioAPI
    let room: Room
    let myName: String
    let controlRoom: Bool
    let guestLink: String
    private(set) var prefs: Prefs

    // the studio
    private(set) var phase = Phase.connecting
    private(set) var myId = ""
    private(set) var people: [Person] = []
    private(set) var knocks: [(id: String, name: String)] = []
    private(set) var chat: [ChatLine] = []
    var chatUnread = 0
    private(set) var markers: [LiveMarker] = []
    private(set) var recordingSince: Double?        // studio time the take started
    private(set) var recTake: String?
    private(set) var recN = 0
    private(set) var nextEpisode = 1
    private(set) var roomTone: (start: Double, end: Double)?
    private(set) var roomToneSeconds = 20.0
    private(set) var countdownFrom: Date?
    private(set) var rundown: [RundownItem] = []
    private(set) var segment: Segment?
    private(set) var script: Script?
    private(set) var sounds: [Pad] = []
    private(set) var scenes: [String: [String: Any]] = [:]
    private(set) var cue: (text: String, from: String, until: Date)?
    private(set) var talkIn: String?                // someone talking back to me
    private(set) var talkingTo: String?
    private(set) var toasts: [Toast] = []
    private(set) var build: [String: Any]?          // the last take's files being made
    private(set) var transcript: [String: Any]?     // live transcript progress
    private(set) var serverDisk: [String: Any]?
    private(set) var studioInfo: [String: Any]?
    private(set) var fps = 25.0
    private(set) var maxPeople = 5
    private(set) var gbPerPersonHour = 4.0
    private(set) var serverRtt: Double?
    private var clockOffset = 0.0
    private var syncSamples: [(Double, Double)] = []

    // me
    var micOn = true { didSet { updateSenders(); sendState() } }
    private(set) var coughing = false
    private(set) var camOn = false
    private(set) var cameraProblem: String?
    private(set) var audioProblems: [String] = []
    var monitor: Double = 1 { didSet { media.audio.controls.withLock { $0.monitor = Float(monitor) } } }
    private(set) var myLevel: Float = 0
    private(set) var myLoud = Loud(nil)
    private(set) var programme = Loud(nil)
    private(set) var programmeLevel: Float = 0
    private(set) var limiting = false
    private(set) var micSilent = false
    var target: Double { didSet { prefs.target = target } }
    var autoMix: Bool { didSet { prefs.autoMix = autoMix; if !autoMix { resetAutoMix() } } }
    var boardLevel: Double { didSet { prefs.boardLevel = boardLevel; media.board.setLevel(boardLevel, duck: duckBeds) } }
    var duckBeds: Bool { didSet { prefs.duckBeds = duckBeds; media.board.setLevel(boardLevel, duck: duckBeds) } }
    private(set) var boardProgress: [String: Double] = [:]

    // the Console
    private(set) var chans: [String: Chan] = [:]
    private var chanMemory: [String: Any] = [:]
    var selectedStrip: String?

    let media: Media
    let recorder: Recorder
    private var links: [String: PeerLink] = [:]
    private var pendingSignals: [String: [[String: Any]]] = [:]
    private var ws: URLSessionWebSocketTask?
    private var wsSession = URLSession(configuration: .default)
    private var tasks: [Task<Void, Never>] = []
    private var lastPong = Date()
    private var leaving = false
    private var ice: [[String: Any]] = []
    private var lastStateKey = ""
    private var chanTimers: [String: Task<Void, Never>] = [:]
    private let clientId: String

    var hasLeft: Bool { if case .left = phase { return true }; if case .refused = phase { return true }; return false }

    init(api: StudioAPI, room: Room, name: String, controlRoom: Bool, prefs: Prefs, guestLink: String) {
        self.api = api; self.room = room; self.myName = name; self.controlRoom = controlRoom; self.prefs = prefs; self.guestLink = guestLink
        target = prefs.target; autoMix = prefs.autoMix; boardLevel = prefs.boardLevel; duckBeds = prefs.duckBeds
        // the same person every time in this show (so a reconnect carries on the same recording)
        let key = "clientId-\(room.id)"
        if let c = UserDefaults.standard.string(forKey: key) { clientId = c } else { clientId = randomHex(6); UserDefaults.standard.set(clientId, forKey: key) }
        media = Media()
        recorder = Recorder(base: api.base, room: room.id)
        sounds = room.sounds ?? []
        rundown = room.rundown ?? []
    }

    // MARK: - going in and out

    func start() {
        recorder.serverNow = { [weak self] in
            // read without hopping to the main actor: the audio thread asks
            Date().timeIntervalSince1970 * 1000 + (self?.offsetForAudio ?? 0)
        }
        media.audio.onMic = { [recorder] buf in recorder.push(buf) }
        media.audio.controls.withLock { $0.monitor = Float(monitor); $0.micToCall = !controlRoom && micOn }
        media.board.setLevel(boardLevel, duck: duckBeds)
        tasks.append(Task { await self.begin() })
    }

    nonisolated(unsafe) private var offsetForAudio = 0.0

    private func begin() async {
        if !controlRoom || true {
            // the microphone: on air it's me; in the control room it's for talkback
            _ = await AVCaptureDeviceAccess.requestMic()
        }
        media.audio.start(mic: prefs.mic, output: prefs.speakers)
        audioProblems = media.audio.problems
        if !controlRoom && prefs.camera != "off" {
            if await media.startCamera(prefs.camera, fps: fps) != nil { camOn = true }
            cameraProblem = media.cameraProblem
        }
        tasks.append(Task { await self.connection() })
        tasks.append(Task { await self.everySecond() })
        tasks.append(Task { await self.meters() })
        for p in sounds { loadPad(p) }
    }

    func leave() {
        guard !leaving else { return }
        leaving = true
        if let seg = recorder.current { recorder.stop(seg: seg) }
        for (_, l) in links { l.close() }
        links = [:]
        ws?.cancel(with: .goingAway, reason: nil)
        for t in tasks { t.cancel() }
        media.close()
        if case .refused = phase {} else { phase = .left }
    }

    // MARK: - the connection to the studio engine

    private func connection() async {
        var url = api.base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        url = url.replacingOccurrences(of: "https://", with: "wss://").replacingOccurrences(of: "http://", with: "ws://") + "/ws"
        while !leaving && !Task.isCancelled {
            guard let u = URL(string: url) else { return }
            let task = wsSession.webSocketTask(with: u)
            task.maximumMessageSize = 1 << 20
            ws = task
            task.resume()
            send(["t": "join", "room": room.id, "key": room.hostKey, "name": myName, "clientId": clientId,
                  "recSeg": recorder.current as Any, "camId": media.streamId, "control": controlRoom])
            for i in 0..<8 { Task { try? await Task.sleep(for: .milliseconds(250 * i)); self.ping() } }
            lastPong = Date()
            let pinger = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(5))
                    self.ping()
                    if Date().timeIntervalSince(self.lastPong) > 15 { task.cancel(with: .abnormalClosure, reason: nil) }  // no answer: reconnect
                }
            }
            while !leaving {
                guard let msg = try? await task.receive() else { break }
                if case .string(let text) = msg, let d = text.data(using: .utf8),
                   let m = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { onMessage(m) }
            }
            pinger.cancel()
            // lost the studio: drop the calls; they come back when we rejoin
            for (_, l) in links { l.close() }
            links = [:]
            people = []
            if case .refused = phase { return }
            if leaving { return }
            phase = .reconnecting
            try? await Task.sleep(for: .seconds(2))
        }
    }

    func send(_ m: [String: Any]) {
        guard let ws, let d = try? JSONSerialization.data(withJSONObject: m), let s = String(data: d, encoding: .utf8) else { return }
        ws.send(.string(s)) { _ in }
    }

    private func ping() { send(["t": "ping", "c": Date().timeIntervalSince1970 * 1000]) }

    /// Studio time now (ms): this Mac's clock, corrected by the studio's.
    func serverNow() -> Double { Date().timeIntervalSince1970 * 1000 + clockOffset }

    // MARK: - what the studio says

    private func onMessage(_ m: [String: Any]) {
        switch s(m, "t") {
        case "pong":
            lastPong = Date()
            let now = Date().timeIntervalSince1970 * 1000, rtt = now - n(m, "c")
            syncSamples.append((rtt, n(m, "s") + rtt / 2 - now))
            if syncSamples.count > 20 { syncSamples.removeFirst() }
            if let best = syncSamples.min(by: { $0.0 < $1.0 }) { clockOffset = best.1; offsetForAudio = best.1 }
            let last = syncSamples.suffix(5).map(\.0)
            serverRtt = (last.reduce(0, +) / Double(last.count)).rounded()
        case "welcome": welcome(m)
        case "waiting": phase = .waiting
        case "error":
            let title = ["full": "The studio is full", "kicked": "Removed from the studio", "denied": "Not let in", "noroom": "This show doesn't exist"][s(m, "code")] ?? "Can't go in"
            phase = .refused(title, s(m, "msg"))
            leave()
        case "notice": toast(s(m, "text"), seconds: 8)
        case "peer-joined":
            if let p = m["peer"] as? [String: Any] { addPeer(p, initiator: false); toast("\(s(p, "name")) joined") }
        case "peer-left":
            let id = s(m, "id")
            if let p = person(id) { toast("\(p.name) left") }
            if talkingTo == id { talk(to: nil) }
            pendingSignals[id] = nil
            removePeer(id)
        case "peer-state":
            guard let p = person(s(m, "id")) else { return }
            let before = Set(p.state.warnings)
            p.state = PeerState(m["state"] as? [String: Any])
            for w in p.state.warnings where !before.contains(w) { toast("⚠ \(p.name): \(shortWarning(w))", seconds: 5) }
        case "screen":
            if let p = person(s(m, "id")) { p.screenId = b(m, "on") ? s(m, "streamId") : nil; if !b(m, "on") { p.screen = nil } }
        case "signal":
            let from = s(m, "from"), data = m["data"] as? [String: Any] ?? [:]
            if let l = links[from] { l.signal(data) } else { pendingSignals[from, default: []].append(data) }
        case "recording":
            if b(m, "on") {
                recordingSince = n(m, "started"); recTake = s(m, "take"); recN = Int(n(m, "n"))
                toast("Recording started (take \(recN))")
                markers = []; build = nil
                if m["nextEpisode"] != nil { nextEpisode = Int(n(m, "nextEpisode")) }
                if !b(m, "roomTone") { countdownFrom = Date() }
                sendAllRides()
                for (inst, pad) in media.board.playingBeds() { sendBoard("start", inst: inst, pad: pad) }
                media.audio.resetProgrammeMeter()
            } else {
                recordingSince = nil
                toast("Recording stopped — finishing uploads…", seconds: 3.5)
            }
            NSApp.dockTile.badgeLabel = recordingSince != nil ? "REC" : nil
        case "record-start":
            guard !controlRoom else { return }
            recorder.start(take: s(m, "take"), seg: s(m, "seg"), tok: s(m, "tok"), camera: camOn ? media.camera : nil, fps: fps)
            media.audio.controls.withLock { $0.recordMic = true }
        case "record-stop":
            if let seg = recorder.current(forTake: s(m, "take")) { recorder.stop(seg: seg) }
            media.audio.controls.withLock { $0.recordMic = false }
            if roomTone != nil { roomTone = nil; countdownFrom = nil }
        case "roomtone": roomTone = (n(m, "start"), n(m, "end"))
        case "chat": addChat(m)
        case "marker":
            let mk = LiveMarker(at: n(m, "at"), label: s(m, "label"), by: s(m, "by"), tag: m["tag"] as? String, n: Int(n(m, "n")))
            markers.append(mk)
            if mk.tag != "note" { toast("📍 \(mk.label) at \(clock(mk.at))") }
        case "knock":
            let id = s(m, "id")
            if !knocks.contains(where: { $0.id == id }) { knocks.append((id, s(m, "name"))); NSSound(named: "Glass")?.play() }
            NSApp.requestUserAttention(.informationalRequest)
        case "knock-gone": knocks.removeAll { $0.id == s(m, "id") }
        case "server":
            serverDisk = m["disk"] as? [String: Any]
            if let st = m["studio"] as? [String: Any] { studioInfo = st }
        case "meter": person(s(m, "id"))?.loud = Loud(m["m"] as? [String: Any])
        case "build": build = m
        case "tx": transcript = m
        case "cough": person(s(m, "id"))?.coughing = b(m, "on")
        case "cue": cue = (s(m, "text"), s(m, "from"), Date().addingTimeInterval(10))
        case "talk": talkIn = b(m, "on") ? s(m, "name") : nil
        case "segment": segment = segmentFrom(m["segment"] as? [String: Any])
        case "rundown": rundown = arr(m, "rundown").map { RundownItem(name: s($0, "name"), mins: n($0, "mins")) }
        case "sounds":
            sounds = decodePads(m["sounds"])
            for p in sounds { loadPad(p) }
        case "scenes": scenes = m["scenes"] as? [String: [String: Any]] ?? [:]
        case "script": script = scriptFrom(m["script"] as? [String: Any])
        case "onair":
            if let list = m["peers"] as? [[String: Any]] {
                for info in list where person(s(info, "id")) == nil { addPeer(info, initiator: true) }
            } else { person(s(m, "id"))?.green = false }
        case "devices": person(s(m, "id"))?.devices = GuestDevices(m["devices"] as? [String: Any])
        case "control":
            // a producer helping me from their desk
            switch s(m, "action") {
            case "mute": micOn = false; toast("\(s(m, "from")) muted your microphone")
            case "unmute": micOn = true; toast("\(s(m, "from")) turned your microphone on")
            default: break
            }
        default: break
        }
    }

    private func welcome(_ m: [String: Any]) {
        phase = .inside
        myId = s(m, "id")
        ice = m["ice"] as? [[String: Any]] ?? []
        roomToneSeconds = m["roomToneSeconds"] != nil ? n(m, "roomToneSeconds") : 20
        gbPerPersonHour = m["gbPerPersonHour"] != nil ? n(m, "gbPerPersonHour") : 4
        maxPeople = m["maxPeople"] != nil ? Int(n(m, "maxPeople")) : 5
        serverDisk = m["disk"] as? [String: Any]
        studioInfo = m["studio"] as? [String: Any]
        if m["nextEpisode"] != nil { nextEpisode = Int(n(m, "nextEpisode")) }
        if chat.isEmpty { for c in arr(m, "chat") { chat.append(ChatLine(from: s(c, "from"), text: s(c, "text"), ts: n(c, "ts"), mine: s(c, "pid") == myId)) } }
        knocks = arr(m, "waiting").map { ($0["id"] as? String ?? "", $0["name"] as? String ?? "") }
        if let r = m["recording"] as? [String: Any] {
            recordingSince = n(r, "started"); recTake = s(r, "take"); recN = Int(n(r, "n"))
        } else {
            recordingSince = nil
            if let seg = recorder.current { recorder.stop(seg: seg); media.audio.controls.withLock { $0.recordMic = false } }
        }
        if let rt = m["roomTone"] as? [String: Any] { roomTone = (n(rt, "start"), n(rt, "end")) } else { roomTone = nil }
        rundown = arr(m, "rundown").map { RundownItem(name: s($0, "name"), mins: n($0, "mins")) }
        segment = segmentFrom(m["segment"] as? [String: Any])
        if m["fps"] != nil { fps = n(m, "fps") }
        chanMemory = m["channels"] as? [String: Any] ?? [:]
        if let sc = m["scenes"] as? [String: [String: Any]] { scenes = sc }
        script = scriptFrom(m["script"] as? [String: Any])
        if m["sounds"] != nil { sounds = decodePads(m["sounds"]); for p in sounds { loadPad(p) } }
        if let b = m["build"] as? [String: Any] { build = b }
        for p in arr(m, "peers") { addPeer(p, initiator: true) }
        for id in (m["coughing"] as? [String] ?? []) { person(id)?.coughing = true }
        sendState(force: true)
    }

    private func segmentFrom(_ d: [String: Any]?) -> Segment? {
        guard let d else { return nil }
        return Segment(idx: Int(n(d, "idx")), name: s(d, "name"), mins: n(d, "mins"), at: n(d, "at"))
    }
    private func scriptFrom(_ d: [String: Any]?) -> Script? {
        guard let d else { return nil }
        return Script(text: s(d, "text"), share: s(d, "share"), by: s(d, "by"))
    }
    private func decodePads(_ v: Any?) -> [Pad] {
        guard let v, let d = try? JSONSerialization.data(withJSONObject: v) else { return [] }
        return (try? JSONDecoder().decode([Pad].self, from: d)) ?? []
    }

    private func addChat(_ m: [String: Any]) {
        let mine = s(m, "pid") == myId
        chat.append(ChatLine(from: s(m, "from"), text: s(m, "text"), ts: n(m, "ts"), mine: mine))
        if !mine { chatUnread += 1; toast("💬 \(s(m, "from")): \(String(s(m, "text").prefix(60)))") }
    }

    func toast(_ text: String, seconds: Double = 2.5) {
        let t = Toast(text: text, until: Date().addingTimeInterval(seconds))
        toasts.append(t)
        if toasts.count > 4 { toasts.removeFirst(toasts.count - 4) }
        Task { try? await Task.sleep(for: .seconds(seconds)); toasts.removeAll { $0.id == t.id } }
    }

    // MARK: - the people and the calls

    func person(_ id: String) -> Person? { people.first { $0.id == id } }

    private func addPeer(_ info: [String: Any], initiator: Bool) {
        let id = s(info, "id")
        guard !id.isEmpty else { return }
        if links[id] != nil { removePeer(id) }
        let p = Person(id: id, name: s(info, "name"), control: b(info, "control"), green: b(info, "green"),
                       camId: info["camId"] as? String, screenId: info["screenId"] as? String)
        p.state = PeerState(info["state"] as? [String: Any])
        if let d = info["devices"] as? [String: Any] { p.devices = GuestDevices(d) }
        people.append(p)
        if chans[id] == nil { chans[id] = (chanMemory[p.name] as? [String: Any]).map { Chan(memory: $0) } ?? Chan() }
        let sendFn: @Sendable ([String: Any]) -> Void = { [weak self] m in Task { @MainActor in self?.send(m) } }
        guard let link = PeerLink(id: id, myId: myId, initiator: initiator, ice: ice, media: media, controlRoom: controlRoom, send: sendFn) else {
            toast("⚠ Couldn't start the call with \(p.name)", seconds: 8); return
        }
        link.onTrack = { [weak self, weak p] track, streamId in
            guard let self, let p else { return }
            if let v = track as? RTCVideoTrack {
                if (p.screenId != nil && streamId == p.screenId) || (p.camId != nil && streamId != p.camId) { p.screen = v; if p.screenId == nil { p.screenId = streamId } }
                else { p.video = v }
            } else if let a = track as? RTCAudioTrack {
                if p.camId == nil || streamId == p.camId { p.voice = a; self.applyChan(p.id) }
                // anything else is another host's talkback or soundboard: heard as it comes
            }
        }
        link.onState = { [weak p] st in p?.conn = st }
        links[id] = link
        updateSenders()
        for d in pendingSignals.removeValue(forKey: id) ?? [] { link.signal(d) }
    }

    private func removePeer(_ id: String) {
        links.removeValue(forKey: id)?.close()
        people.removeAll { $0.id == id }
    }

    /// What I send to each person: my voice to everyone unless I'm holding cough or talking back; talkback only to
    /// its one person. In the control room my voice goes nowhere except talkback (the soundboard still does).
    private func updateSenders() {
        let talking = talkingTo != nil
        media.audio.controls.withLock { $0.micToCall = (micOn && !controlRoom && !coughing) || talking }
        for (id, l) in links {
            l.mainAudio.isEnabled = !talking && !coughing
            l.talkAudio.isEnabled = talkingTo == id
        }
    }

    // MARK: - my actions

    func setCough(_ on: Bool) {
        guard on != coughing, !controlRoom else { return }
        coughing = on
        updateSenders()
        send(["t": "cough", "on": on, "at": serverNow()])
    }

    func talk(to id: String?) {
        if let cur = talkingTo, cur != id {
            send(["t": "talk", "to": cur, "on": false, "at": serverNow()])
            talkingTo = nil
        }
        if let id, talkingTo != id {
            guard person(id) != nil else { toast("Nobody to talk to yet"); return }
            talkingTo = id
            send(["t": "talk", "to": id, "on": true, "at": serverNow()])
        }
        updateSenders()
    }

    @discardableResult
    func marker(_ tag: String? = nil, label: String? = nil) -> Bool {
        guard recordingSince != nil else { toast("Markers work while recording"); return false }
        var m: [String: Any] = ["t": "marker", "at": serverNow()]
        if let tag { m["tag"] = tag }
        if let label { m["label"] = label }
        send(m)
        return true
    }

    func startRecording(roomTone: Bool, episode: Int?, title: String) {
        send(["t": "record", "on": true, "roomTone": roomTone, "episode": ["n": episode.map { String($0) } ?? "", "title": title]])
    }
    func stopRecording() { send(["t": "record", "on": false]) }
    func recordRoomTone() { send(["t": "roomtone"]) }
    func admit(_ id: String, allow: Bool, green: Bool = false) {
        send(["t": "admit", "id": id, "allow": allow, "green": green]); knocks.removeAll { $0.id == id }
    }
    func bringOnAir(_ id: String) { send(["t": "onair", "id": id]) }
    func kick(_ id: String) { send(["t": "kick", "id": id]) }
    func cue(_ to: String, _ text: String) { send(["t": "cue", "to": to, "text": text]) }
    func help(_ to: String, _ action: String, _ value: Any? = nil) {
        var m: [String: Any] = ["t": "control", "to": to, "action": action]
        if let value { m["value"] = value }
        send(m)
    }
    func say(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { send(["t": "chat", "text": t]) }
    }
    func startSegment(_ i: Int) { send(["t": "segment", "idx": i, "at": serverNow()]) }
    func stopSegments() { send(["t": "segment", "idx": -1]) }
    func saveScript(_ text: String, share: String) { send(["t": "script", "text": text, "share": share]) }

    func setCamera(on: Bool) async {
        if on {
            guard await media.startCamera(prefs.camera.isEmpty || prefs.camera == "off" ? "" : prefs.camera, fps: fps) != nil else { cameraProblem = media.cameraProblem; return }
            camOn = true
            toast("Camera on — it's added to the call next time people rejoin")
        } else {
            media.stopCamera(); camOn = false
        }
        sendState(force: true)
    }

    // MARK: - the Console

    func chan(_ id: String) -> Chan { chans[id] ?? Chan() }

    func setChan(_ id: String, _ c: Chan, ride: Bool = false) {
        chans[id] = c
        applyChan(id)
        // tell the studio (a moment later, so a fader drag isn't hundreds of messages)
        chanTimers[id]?.cancel()
        chanTimers[id] = Task {
            try? await Task.sleep(for: .milliseconds(ride ? 60 : 300))
            guard !Task.isCancelled else { return }
            if ride { sendRide(id) }
            sendChan(id)
        }
    }

    /// What I hear of them: fader (and auto mix), mute, solo.
    func applyChan(_ id: String) {
        let anySolo = chans.values.contains { $0.solo }
        for p in people {
            let c = chan(p.id)
            let audible = !c.mute && !c.cut && (!anySolo || c.solo) && c.db != nil
            let g = audible ? dbToGain((c.db ?? -60) + p.autoDb) : 0
            p.voice?.source.volume = min(10, g)
            _ = id
        }
    }

    func rideDb(_ id: String) -> Double? {
        guard let db = chan(id).mixDb else { return nil }
        return min(12, max(-60, ((db + (person(id)?.autoDb ?? 0)) * 10).rounded() / 10))
    }

    func sendRide(_ id: String) {
        guard recordingSince != nil else { return }
        send(["t": "ride", "id": id, "db": rideDb(id).map { $0 as Any } ?? NSNull(), "at": serverNow()])
    }

    func sendChan(_ id: String) {
        guard let p = person(id), !p.control else { return }
        let st = chan(id).memory
        chanMemory[p.name] = st
        send(["t": "chan", "id": id, "s": st])
    }

    /// A take starts from where the Console is now.
    private func sendAllRides() { for p in people where !p.control { sendRide(p.id); sendChan(p.id) } }

    /// One press sets every fader so each person lands on the loudness target.
    func autoLevel() {
        var done: [String] = []
        for p in people where !p.control && !p.green {
            guard let L = p.loud.I ?? p.loud.S else { continue }
            var c = chan(p.id)
            c.db = max(-20, min(10, ((target - L) * 2).rounded() / 2))
            setChan(p.id, c, ride: true)
            done.append("\(p.name) \(dbText(c.db ?? 0))")
        }
        toast(done.isEmpty ? "⚖ Nobody has talked enough yet to measure — ask everyone to say a few words, then press again"
                           : "⚖ Auto level (\(Int(target)) LUFS): \(done.joined(separator: " · "))", seconds: 7)
    }

    func storeScene(_ slot: String) {
        var data: [String: Any] = [:]
        for p in people where !p.control { data[p.name] = chan(p.id).memory }
        guard !data.isEmpty else { toast("Nobody is on the Console yet"); return }
        send(["t": "scene", "slot": slot, "data": data])
        toast("💾 Scene \(slot) saved: \(data.keys.sorted().joined(separator: ", "))")
    }

    func recallScene(_ slot: String) {
        guard let sc = scenes[slot], let data = sc["data"] as? [String: Any] else { toast("Scene \(slot) is empty — press Store, then \(slot)"); return }
        var got: [String] = []
        for p in people where !p.control {
            guard let st = data[p.name] as? [String: Any] else { continue }
            var c = Chan(memory: st)
            c.mute = chan(p.id).mute; c.solo = chan(p.id).solo
            setChan(p.id, c, ride: true); got.append(p.name)
        }
        toast(got.isEmpty ? "Scene \(slot) has nobody who's here now" : "🎛 Scene \(slot): \(got.joined(separator: ", "))")
    }

    private func resetAutoMix() {
        for p in people where p.autoDb != 0 { p.autoDb = 0; p.autoSent = 0; applyChan(p.id); sendRide(p.id) }
    }

    /// Auto mix (gain sharing): whoever's talking stays up, the others dip (at most 12 dB), so room noise doesn't
    /// add up. Moves of 1 dB or more go to the studio as fader rides, so the Producer mix matches.
    private func autoMixStep() {
        guard autoMix else { return }
        let on = people.filter { !$0.control && !$0.green && chan($0.id).mixDb != nil }
        guard on.count >= 2 else { return }
        let pw = on.map { p -> (Person, Double) in
            let a = dbToGain(chan(p.id).mixDb ?? 0) * Double(p.level)
            return (p, a * a + 1e-4)
        }
        let top = pw.map(\.1).max() ?? 1
        for (p, x) in pw {
            let want = max(-12, 10 * log10(x / top))
            p.autoDb = want > p.autoDb ? want : max(want, p.autoDb - 1.5)
            if recordingSince != nil && abs(p.autoDb - p.autoSent) >= 1 { p.autoSent = p.autoDb; sendRide(p.id) }
        }
        applyChan("")
    }

    // MARK: - the soundboard

    private func loadPad(_ p: Pad) {
        guard !media.board.isLoaded(p) else { return }
        Task {
            do { try await media.board.load(p, api: api, room: room) }
            catch { toast("⚠ Couldn't load “\(p.name)”: \(error.localizedDescription)", seconds: 5) }
        }
    }

    func press(_ pad: Pad) {
        guard media.board.isLoaded(pad) else { loadPad(pad); toast("Loading “\(pad.name)”…"); return }
        let r = media.board.press(pad)
        for inst in r.stopped { sendBoard("stop", inst: inst, pad: pad) }
        if let inst = r.started { sendBoard("start", inst: inst, pad: pad) }
    }

    func stopAllPads() {
        for inst in media.board.stopAll() { send(["t": "board", "ev": "stop", "inst": inst, "at": serverNow()]) }
    }

    private func sendBoard(_ ev: String, inst: String, pad: Pad) {
        send(["t": "board", "ev": ev, "inst": inst, "sid": pad.id, "vol": pad.vol + boardLevel, "duck": duckBeds, "at": serverNow()])
    }

    // MARK: - what I report, meters and the clock

    func myState() -> [String: Any] {
        let (rec, pending) = recorder.report()
        var warnings: [String] = []
        if micSilent && micOn && !controlRoom { warnings.append("mic-silent") }
        return ["control": controlRoom, "mic": micOn && !controlRoom, "cam": camOn && !controlRoom, "rec": rec, "pending": pending, "pendingAudio": pending,
                "warnings": warnings, "glitches": 0, "loss": 0, "relay": false, "rtt": serverRtt.map { $0 as Any } ?? NSNull(), "durable": true]
    }

    func sendState(force: Bool = false) {
        guard phase == .inside else { return }
        let st = myState()
        let key = "\(st["mic"]!)\(st["cam"]!)\(st["rec"]!)\((st["pending"] as? Int ?? 0) / 524_288)\(st["warnings"]!)"
        if key != lastStateKey || force { lastStateKey = key; send(["t": "state", "state": st]) }
    }

    private func everySecond() async {
        var tick = 0
        while !Task.isCancelled && !leaving {
            try? await Task.sleep(for: .seconds(1))
            tick += 1
            sendState(force: tick % 10 == 0)
            for p in people where !p.control {
                p.history.append(!p.micOff ? (p.loud.S ?? .nan) : .nan)
                if p.history.count > 300 { p.history.removeFirst() }
            }
            if let c = cue, c.until < Date() { cue = nil }
            if countdownFrom.map({ Date().timeIntervalSince($0) > 4 }) == true { countdownFrom = nil }
            for (i, link) in links {
                let (lvl, rtt, loss) = await link.stats()
                _ = lvl
                if let p = person(i) { p.rtt = rtt; p.loss = loss }
            }
            // pads that finished by themselves
            for inst in media.board.takeFinished() { send(["t": "board", "ev": "stop", "inst": inst, "at": serverNow()]) }
        }
    }

    /// Meters, ~20 times a second; my loudness to the hosts five times a second; auto mix.
    private func meters() async {
        var tick = 0
        while !Task.isCancelled && !leaving {
            try? await Task.sleep(for: .milliseconds(50))
            tick += 1
            let m = media.audio.meters.withLock { m -> StudioAudio.Meters in let c = m; m.micPeak = 0; m.programmePeak = 0; m.limiting = false; return c }
            myLevel = max(m.micPeak, myLevel * 0.85)
            myLoud = Loud(meter: m.mic)
            programme = Loud(meter: m.programme)
            programmeLevel = max(m.programmePeak, programmeLevel * 0.85)
            limiting = m.limiting
            micSilent = m.micSilentFor > 5
            if tick % 2 == 0 {
                var talking = false
                for (id, link) in links {
                    let (lvl, _, _) = await link.stats()
                    if let p = person(id) {
                        p.level = max(lvl, p.level * 0.7)
                        p.peakHold = max(p.level, p.peakHold * 0.97)
                        if !p.control && p.level > 0.04 { talking = true }
                    }
                }
                media.board.setTalking(talking)
            }
            if tick % 4 == 0 && !controlRoom { send(["t": "meter", "m": m.mic.report()]) }
            autoMixStep()
            boardProgress = media.board.progress()
        }
    }
}

enum AVCaptureDeviceAccess {
    static func requestMic() async -> Bool { await AVCaptureDevice.requestAccess(for: .audio) }
}
