import Foundation

// What the studio's web API sends back. Every field the studio might leave out is optional, so an older or newer
// studio still loads.

struct Disk: Codable, Hashable {
    var free: Double?
    var total: Double?
}

struct Asset: Codable, Hashable {
    var name: String?
    var dur: Double?
}

struct RundownItem: Codable, Hashable, Identifiable {
    var id = UUID()
    var name: String
    var mins: Double
    enum CodingKeys: String, CodingKey { case name, mins }
}

struct Pad: Codable, Hashable, Identifiable {
    var id: String
    var name: String
    var mode: String          // jingle, bed, effect
    var vol: Double           // dB
    var color: String         // #rrggbb
    var dur: Double?
}

struct Output: Codable, Hashable, Identifiable {
    var file: String
    var kind: String          // audio, cleaned, mix, normalised, producermix, roomtone, screen, soundboard, video, video-original, …
    var person: String?
    var size: Double
    var id: String { file }
}

struct Marker: Codable, Hashable, Identifiable {
    var id = UUID()
    var at: Double            // ms from the start of the take
    var label: String
    var by: String?
    var tag: String?
    enum CodingKeys: String, CodingKey { case at, label, by, tag }
}

struct Level: Codable, Hashable {
    struct Verdict: Codable, Hashable { var level: String?; var text: String? }
    var I: Double?
    var LRA: Double?
    var TP: Double?
    var verdict: Verdict?
}

struct Episode: Codable, Hashable {
    var n: Int?
    var title: String?
}

struct CopyStatus: Codable, Hashable {   // backup drive and cloud
    var ok: Bool?
    var busy: Bool?
    var at: Double?
    var error: String?
    var path: String?
    var dest: String?
}

struct TranscriptStatus: Codable, Hashable {
    struct Failed: Codable, Hashable { var who: String?; var error: String? }
    struct Line: Codable, Hashable { var who: String?; var at: Double?; var text: String? }
    var engine: Bool?
    var on: Bool?
    var pct: Double?
    var lines: Int?
    var recent: [Line]?
    var failed: [Failed]?
    var hasFile: Bool?
    var canMake: Bool?
}

struct Take: Codable, Hashable, Identifiable {
    var id: String
    var n: Int
    var started: Double
    var stopped: Double?
    var status: String        // recording, waiting, queued, processing, ready, error
    var progress: String?
    var error: String?
    var people: [String]?
    var outputs: [Output]?
    var markers: [Marker]?
    var backup: CopyStatus?
    var cloud: CopyStatus?
    var pct: Double?
    var levels: [String: Level?]?
    var episode: Episode?
    var compacted: Bool?
    var transcript: TranscriptStatus?
    var totalSize: Double?

    var isBusy: Bool { ["recording", "waiting", "queued", "processing"].contains(status) }
    var title: String {
        if let e = episode, let n = e.n { return "Episode \(n)" + (e.title.map { $0.isEmpty ? "" : " — \($0)" } ?? "") }
        return "Take \(n)"
    }
    var length: Double? { stopped.map { $0 - started } }
}

struct Room: Codable, Hashable, Identifiable {
    var id: String
    var name: String
    var created: Double?
    var hostKey: String
    var waitingRoom: Bool?
    var notifyEmail: String?
    var assets: [String: Asset]?
    var lastEpisode: Int?
    var rundown: [RundownItem]?
    var sounds: [Pad]?
    var online: [String]?
    var recording: Bool?
    var takes: [Take]?
    var disk: Disk?
    var emailReady: Bool?
}

struct RoomsReply: Codable {
    var rooms: [Room]
    var disk: Disk?
    var version: String?
}

struct StudioInfo: Codable {
    var name: String?
    var admin: Bool?
    var maxPeople: Int?
    var version: String?
    var link: String?
}

struct StudioSettings: Codable {
    struct Smtp: Codable { var host: String?; var port: Int?; var user: String?; var pass: String?; var from: String? }
    struct Turn: Codable { var keyId: String?; var token: String? }
    struct Cloud: Codable { var remote: String? }
    struct Backup: Codable { var set: Bool?; var ok: Bool?; var free: Double?; var msg: String? }
    struct Transcribe: Codable { var enabled: Bool?; var model: String?; var language: String?; var installed: Bool?; var models: [String]? }
    /// Clean-up files: what's done to each voice after a take (the untouched files are always kept).
    struct Clean: Codable, Hashable {
        var auto: Bool = true
        var declip: Bool = false
        var rumble: Bool = true
        var mains: Int = 50
        var noise: String = "medium"   // off, light, medium, strong
        var gate: Bool = false
        var deess: Bool = true
        var compress: Bool = true
        var pauses: Double = 0
    }
    var smtp: Smtp?
    var turn: Turn?
    var backupDir: String?
    var cloud: Cloud?
    var publicUrl: String?
    var backup: Backup?
    var emailAvailable: Bool?
    var turnError: String?
    var passwordChanged: Bool?
    var transcribe: Transcribe?
    var autoCompact: Bool?
    var clean: Clean?
    var fps: Int?
}

/// Any JSON value (for the few places the studio's shape is open-ended).
enum JSONValue: Codable, Hashable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }
    var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    var number: Double? { if case .number(let n) = self { return n }; return nil }
    var string: String? { if case .string(let s) = self { return s }; return nil }
}
