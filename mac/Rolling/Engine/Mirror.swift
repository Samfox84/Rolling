import Foundation
import Observation

/// Connected to a studio server: everything is saved on this Mac as well.
///
///  • While a take records: a live copy of everyone's full-quality audio (24-bit WAV, the exact samples their
///    browser recorded) and camera, pulled from the server a few seconds behind. Only audio that has arrived
///    complete with no gaps is copied, so nothing already saved ever changes.
///  • When the take is ready: every finished file is downloaded and checked. If the take is rebuilt later
///    (Clean again, marker edits…), the changed files are fetched again.
///  • Once the finished files are safely saved, the live copy can be removed (it's the same audio).
///
/// The same folder layout and notes file as Rolling Desk, so the two can take turns.
@MainActor @Observable
final class Mirror {
    private(set) var busy = false
    private(set) var recording = false
    private(set) var detail = "Connecting…"
    private(set) var error = ""
    private(set) var lowDisk = false

    let folder: URL
    let removeLive: Bool
    private let api: StudioAPI
    private var rooms: () async throws -> [Room]
    private var task: Task<Void, Never>?
    private var state = Notes()

    struct Notes: Codable {
        struct TakeNote: Codable {
            var dir: String
            var live: [String: LiveNote] = [:]
            var files: [String: Double] = [:]
            var complete = false
        }
        struct LiveNote: Codable { var audio = 0; var video = 0; var videoBytes: Int? }
        struct RoomNote: Codable { var since: Double; var takes: [String: TakeNote] = [:] }
        var rooms: [String: RoomNote] = [:]
    }

    init(api: StudioAPI, folder: URL, removeLive: Bool, rooms: @escaping () async throws -> [Room]) {
        self.api = api; self.folder = folder; self.removeLive = removeLive; self.rooms = rooms
    }

    private var notesFile: URL { folder.appendingPathComponent(".rolling-desk.json") }

    func start() {
        guard task == nil else { return }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if let d = try? Data(contentsOf: notesFile), let s = try? JSONDecoder().decode(Notes.self, from: d) { state = s }
        task = Task { [weak self] in
            while !Task.isCancelled {
                await self?.pollOnce()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func stop() { task?.cancel(); task = nil }

    private func saveNotes() {
        if let d = try? JSONEncoder().encode(state) { try? d.write(to: notesFile, options: .atomic) }
    }

    func pollOnce() async {
        var anyBusy = false, anyRec = false, lastDetail = "Ready — new takes are saved here automatically", err = ""
        do {
            for room in try await rooms() {
                var rs = state.rooms[room.id] ?? Notes.RoomNote(since: Date().timeIntervalSince1970 * 1000 - 60000)
                let roomDir = folder.appendingPathComponent(safeName(room.name))
                for t in room.takes ?? [] {
                    if rs.takes[t.id] == nil && t.started < rs.since { continue }   // takes from before this Mac was connected
                    var ts = rs.takes[t.id] ?? Notes.TakeNote(dir: roomDir.appendingPathComponent(takeFolderName(t)).path)
                    do {
                        if t.isBusy {
                            if t.status == "recording" { anyRec = true }
                            anyBusy = true
                            let got = ts.complete ? 0 : try await syncLive(room, t, &ts)
                            lastDetail = t.status == "recording" ? "Saving a live copy · \(bytes(Double(got)))" : "The studio is finishing the take…"
                        } else if let outs = t.outputs, !outs.isEmpty {
                            let left = try await syncFinished(room, t, &ts)
                            if left > 0 { anyBusy = true; lastDetail = "Downloading the finished files · \(left) to go" }
                        }
                    } catch {
                        anyBusy = anyBusy || !ts.complete
                        err = "\(takeFolderName(t)): \(error.localizedDescription)"
                    }
                    rs.takes[t.id] = ts
                }
                state.rooms[room.id] = rs
            }
        } catch { err = error.localizedDescription }
        saveNotes()
        if let v = try? folder.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage {
            lowDisk = v < 2 * 1_073_741_824
        }
        if !anyBusy && err.isEmpty && state.rooms.values.contains(where: { $0.takes.values.contains { $0.complete } }) {
            lastDetail = "All saved on this Mac — safe to close"
        }
        busy = anyBusy; recording = anyRec; detail = lastDetail; error = err
    }

    // MARK: - while recording: the live copy

    private struct LiveSeg: Decodable {
        struct A: Decodable { var rate: Int; var solid: Int; var end: Int? }
        struct V: Decodable { var mime: String?; var ready: Int }
        var id: String; var person: String; var done: Bool?; var audio: A?; var video: V?
    }
    private struct Live: Decodable { var status: String; var started: Double; var segs: [LiveSeg]; var raw: Bool }

    private func syncLive(_ room: Room, _ t: Take, _ ts: inout Notes.TakeNote) async throws -> Int {
        let live = try await api.get(Live.self, "/api/rooms/\(room.id)/takes/\(t.id)/live", key: room.hostKey)
        guard live.raw else { return 0 }
        let dir = URL(fileURLWithPath: ts.dir).appendingPathComponent("Live copy")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var total = 0
        for s in live.segs {
            var st = ts.live[s.id] ?? Notes.LiveNote()
            if let a = s.audio, a.solid * 3 > st.audio {                    // new complete audio: fetch just that stretch
                let file = dir.appendingPathComponent("\(safeName(s.person)).wav"), want = a.solid * 3
                let (d, code) = try await api.range("/api/rooms/\(room.id)/takes/\(t.id)/live/\(s.id)/audio", from: st.audio, to: want - 1, key: room.hostKey)
                guard code == 206 || code == 200 else { throw StudioError(message: "live audio for \(s.person) → \(code)") }
                var buf = code == 200 ? d.subdata(in: min(st.audio, d.count)..<min(want, d.count)) : d
                buf = buf.prefix(buf.count - buf.count % 3)
                if !FileManager.default.fileExists(atPath: file.path) { FileManager.default.createFile(atPath: file.path, contents: nil) }
                let fh = try FileHandle(forWritingTo: file)
                try fh.seek(toOffset: UInt64(44 + st.audio))
                try fh.write(contentsOf: buf)
                st.audio += buf.count
                try fh.seek(toOffset: 0)
                try fh.write(contentsOf: wavHeader(dataBytes: st.audio, rate: a.rate))   // keep the WAV playable as it grows
                try fh.close()
            }
            if let v = s.video, v.ready > st.video {                         // camera pieces, in order
                let ext = (v.mime ?? "").contains("mp4") ? "mp4" : "webm"
                let file = dir.appendingPathComponent("\(safeName(s.person)) - camera.\(ext)")
                for i in st.video..<v.ready {
                    let piece = try await api.data("GET", "/api/rooms/\(room.id)/takes/\(t.id)/live/\(s.id)/video/\(i)", key: room.hostKey)
                    if !FileManager.default.fileExists(atPath: file.path) { FileManager.default.createFile(atPath: file.path, contents: nil) }
                    let fh = try FileHandle(forWritingTo: file)
                    try fh.seekToEnd(); try fh.write(contentsOf: piece); try fh.close()
                    st.video = i + 1; st.videoBytes = (st.videoBytes ?? 0) + piece.count
                }
            }
            ts.live[s.id] = st
            total += st.audio + (st.videoBytes ?? 0)
        }
        return total
    }

    // MARK: - when ready: the finished files

    private func syncFinished(_ room: Room, _ t: Take, _ ts: inout Notes.TakeNote) async throws -> Int {
        let dir = URL(fileURLWithPath: ts.dir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let outs = t.outputs ?? []
        let todo = outs.filter { ts.files[$0.file] != $0.size || !FileManager.default.fileExists(atPath: dir.appendingPathComponent($0.file).path) }
        for o in todo {
            let dest = dir.appendingPathComponent(o.file), part = dir.appendingPathComponent(o.file + ".downloading")
            detail = "Downloading the finished files · \(o.file)"
            try await api.download("/dl/\(room.id)/\(t.id)/\(o.file.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? o.file)", to: part, key: room.hostKey)
            let size = (try? FileManager.default.attributesOfItem(atPath: part.path)[.size] as? Double) ?? 0
            if size != o.size {
                try? FileManager.default.removeItem(at: part)
                throw StudioError(message: "\(o.file) arrived incomplete (\(Int(size)) of \(Int(o.size)) bytes) — will try again")
            }
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: part, to: dest)
            ts.files[o.file] = o.size
        }
        // files the studio no longer has (renamed documents etc.) are tidied away
        for f in ts.files.keys where !outs.contains(where: { $0.file == f }) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(f)); ts.files[f] = nil
        }
        ts.complete = true
        let live = dir.appendingPathComponent("Live copy")
        if removeLive, FileManager.default.fileExists(atPath: live.path) { try? FileManager.default.removeItem(at: live) }
        return 0
    }
}

func safeName(_ s: String) -> String {
    let bad = CharacterSet(charactersIn: "/\\:*?\"<>|").union(.controlCharacters)
    let cleaned = s.components(separatedBy: bad).joined(separator: " ").split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return cleaned.isEmpty ? "Untitled" : String(cleaned.prefix(120))
}

func takeFolderName(_ t: Take) -> String {
    let ep = t.episode?.n.map { "Ep \($0)" + ((t.episode?.title).map { $0.isEmpty ? "" : " - \($0)" } ?? "") } ?? ""
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_GB_POSIX"); f.timeZone = TimeZone(identifier: "UTC"); f.dateFormat = "yyyy-MM-dd HH.mm"
    return safeName("\(ep.isEmpty ? "Take \(t.n)" : ep) (\(f.string(from: Date(timeIntervalSince1970: t.started / 1000))))")
}

func wavHeader(dataBytes: Int, rate: Int, channels: Int = 1) -> Data {   // 24-bit PCM
    var h = Data()
    func u32(_ v: Int) { var x = UInt32(v).littleEndian; h.append(Data(bytes: &x, count: 4)) }
    func u16(_ v: Int) { var x = UInt16(v).littleEndian; h.append(Data(bytes: &x, count: 2)) }
    h.append(Data("RIFF".utf8)); u32(36 + dataBytes); h.append(Data("WAVE".utf8))
    h.append(Data("fmt ".utf8)); u32(16); u16(1); u16(channels); u32(rate); u32(rate * 3 * channels); u16(3 * channels); u16(24)
    h.append(Data("data".utf8)); u32(dataBytes)
    return h
}

func bytes(_ n: Double) -> String {
    n > 1e9 ? String(format: "%.2f GB", n / 1e9) : n > 1e6 ? String(format: "%.0f MB", n / 1e6) : String(format: "%.0f KB", max(1, n / 1e3))
}
