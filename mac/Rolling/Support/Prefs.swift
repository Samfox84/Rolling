import Foundation

/// How this Mac uses Rolling, remembered between runs.
struct Prefs: Codable, Equatable {
    enum Mode: String, Codable { case none, host, connect }
    enum GuestLink: String, Codable { case quick, own }

    var mode: Mode = .none
    // hosting on this Mac
    var studioFolder: String = (NSHomeDirectory() as NSString).appendingPathComponent("Rolling Studio")
    var guestLink: GuestLink = .quick
    var ownAddress: String = ""
    var ownPort: Int = 8790
    // connected to a studio server
    var server: String = ""          // https://podcast.example.com  (owner sign-in), or a host link
    var saveCopies: Bool = true      // keep a copy of every recording on this Mac
    var copiesFolder: String = (NSHomeDirectory() as NSString).appendingPathComponent("Rolling Recordings")
    var removeLiveCopy: Bool = true
    // in the studio
    var myName: String = ""
    var mic: String = ""             // device unique ids; empty = the Mac's default
    var speakers: String = ""
    var camera: String = ""
    var controlRoom: Bool = false
    var target: Double = -16
    var autoMix: Bool = false
    var boardLevel: Double = 0
    var duckBeds: Bool = true

    static let file: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Rolling", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("settings.json")
    }()
    static var supportDir: URL { file.deletingLastPathComponent() }

    static func load() -> Prefs {
        guard let d = try? Data(contentsOf: file) else { return Prefs() }
        return (try? JSONDecoder().decode(Prefs.self, from: d)) ?? Prefs()
    }

    func save() {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let d = try? enc.encode(self) { try? d.write(to: Prefs.file, options: .atomic) }
    }

    init() {}
    // settings files from older versions: missing keys take their defaults
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Prefs()
        mode = (try? c.decode(Mode.self, forKey: .mode)) ?? d.mode
        studioFolder = (try? c.decode(String.self, forKey: .studioFolder)) ?? d.studioFolder
        guestLink = (try? c.decode(GuestLink.self, forKey: .guestLink)) ?? d.guestLink
        ownAddress = (try? c.decode(String.self, forKey: .ownAddress)) ?? d.ownAddress
        ownPort = (try? c.decode(Int.self, forKey: .ownPort)) ?? d.ownPort
        server = (try? c.decode(String.self, forKey: .server)) ?? d.server
        saveCopies = (try? c.decode(Bool.self, forKey: .saveCopies)) ?? d.saveCopies
        copiesFolder = (try? c.decode(String.self, forKey: .copiesFolder)) ?? d.copiesFolder
        removeLiveCopy = (try? c.decode(Bool.self, forKey: .removeLiveCopy)) ?? d.removeLiveCopy
        myName = (try? c.decode(String.self, forKey: .myName)) ?? d.myName
        mic = (try? c.decode(String.self, forKey: .mic)) ?? d.mic
        speakers = (try? c.decode(String.self, forKey: .speakers)) ?? d.speakers
        camera = (try? c.decode(String.self, forKey: .camera)) ?? d.camera
        controlRoom = (try? c.decode(Bool.self, forKey: .controlRoom)) ?? d.controlRoom
        target = (try? c.decode(Double.self, forKey: .target)) ?? d.target
        autoMix = (try? c.decode(Bool.self, forKey: .autoMix)) ?? d.autoMix
        boardLevel = (try? c.decode(Double.self, forKey: .boardLevel)) ?? d.boardLevel
        duckBeds = (try? c.decode(Bool.self, forKey: .duckBeds)) ?? d.duckBeds
    }
}
