import Foundation
import WebRTC

// What the studio window shows about the people and the show.

/// Loudness as a meter reports it (LUFS / dBTP; nil = nothing yet).
struct Loud: Equatable {
    var M: Double?, S: Double?, I: Double?, TP: Double?, TPmax: Double?
    init(_ d: [String: Any]?) {
        func g(_ k: String) -> Double? { (d?[k] as? NSNumber)?.doubleValue }
        M = g("M"); S = g("S"); I = g("I"); TP = g("TP"); TPmax = g("TPmax")
    }
    init(meter m: LoudnessMeter) {
        func f(_ v: Double) -> Double? { v.isFinite ? v : nil }
        M = f(m.momentary); S = f(m.shortTerm); I = f(m.integrated)
        let tp = m.peakMax > 0 ? 20 * log10(m.peakMax) : -Double.infinity
        TP = f(tp); TPmax = f(tp)
    }
}

/// What someone's computer reports about itself (their "state" messages).
struct PeerState: Equatable {
    var control = false, mic = true, cam = false
    var rec = ""                       // recording / uploading / saved / ""
    var pending = 0.0
    var warnings: [String] = []
    var glitches = 0.0, loss = 0.0
    var relay = false
    var rtt: Double?
    init() {}
    init(_ d: [String: Any]?) {
        guard let d else { return }
        control = d["control"] as? Bool ?? false
        mic = d["mic"] as? Bool ?? true
        cam = d["cam"] as? Bool ?? false
        rec = d["rec"] as? String ?? ""
        pending = (d["pending"] as? NSNumber)?.doubleValue ?? 0
        warnings = d["warnings"] as? [String] ?? []
        glitches = (d["glitches"] as? NSNumber)?.doubleValue ?? 0
        loss = (d["loss"] as? NSNumber)?.doubleValue ?? 0
        relay = d["relay"] as? Bool ?? false
        rtt = (d["rtt"] as? NSNumber)?.doubleValue
    }
}

/// A guest's microphones etc., so the producer can help from the desk.
struct GuestDevices: Equatable {
    var mics: [Device] = []
    var mic = ""
    var headphones = false
    var micOn = true
    init(_ d: [String: Any]?) {
        guard let d else { return }
        mics = (d["mics"] as? [[String: Any]] ?? []).map { Device(id: $0["id"] as? String ?? "", name: $0["label"] as? String ?? "Device") }
        mic = d["mic"] as? String ?? ""
        headphones = d["headphones"] as? Bool ?? false
        micOn = d["micOn"] as? Bool ?? true
    }
}

/// Someone else in the studio.
@MainActor @Observable
final class Person: Identifiable {
    let id: String
    var name: String
    var control: Bool
    var green: Bool
    var camId: String?
    var screenId: String?
    var state = PeerState()
    var devices: GuestDevices?
    var loud = Loud(nil)
    var level: Float = 0               // their voice right now, 0…1
    var peakHold: Float = 0
    var coughing = false
    var conn = "connecting"
    var rtt: Double?
    var loss: Double?
    var video: RTCVideoTrack?
    var screen: RTCVideoTrack?
    var voice: RTCAudioTrack?
    var autoDb = 0.0
    var autoSent = 0.0
    var history: [Double] = []         // short-term loudness, once a second (the last 5 minutes)
    let joined = Date()

    init(id: String, name: String, control: Bool, green: Bool, camId: String?, screenId: String?) {
        self.id = id; self.name = name; self.control = control; self.green = green; self.camId = camId; self.screenId = screenId
    }

    var micOff: Bool { !state.mic || devices?.micOn == false }
}

/// One person's channel on the Console. `mute`/`solo` are for my ears only; `cut` takes them out of the Producer
/// mix too. The rest is baked into the Producer mix (and remembered for next time by their name).
struct Chan: Equatable {
    var db: Double? = 0
    var mute = false, solo = false, cut = false
    var pan = 0.0
    var hpf = false
    var low = 0.0, pres = 0.0, high = 0.0
    var comp = false, gate = false

    init() {}
    init(memory d: [String: Any]) {
        db = d["db"] is NSNull ? nil : (d["db"] as? NSNumber)?.doubleValue ?? 0
        cut = d["mute"] as? Bool ?? false
        pan = (d["pan"] as? NSNumber)?.doubleValue ?? 0
        hpf = d["hpf"] as? Bool ?? false
        low = (d["low"] as? NSNumber)?.doubleValue ?? 0
        pres = (d["pres"] as? NSNumber)?.doubleValue ?? 0
        high = (d["high"] as? NSNumber)?.doubleValue ?? 0
        comp = d["comp"] as? Bool ?? false
        gate = d["gate"] as? Bool ?? false
    }
    var memory: [String: Any] {
        ["db": db.map { $0 as Any } ?? NSNull(), "mute": cut, "pan": pan, "hpf": hpf, "low": low, "pres": pres, "high": high, "comp": comp, "gate": gate]
    }
    /// The level into the Producer mix (nil = out of it).
    var mixDb: Double? { cut ? nil : db }
}

struct ChatLine: Identifiable {
    let id = UUID()
    var from: String
    var text: String
    var ts: Double
    var mine: Bool
}

struct LiveMarker: Identifiable {
    let id = UUID()
    var at: Double
    var label: String
    var by: String
    var tag: String?
    var n: Int
}

struct Toast: Identifiable, Equatable {
    let id = UUID()
    var text: String
    var until: Date
}

struct Segment: Equatable {
    var idx: Int
    var name: String
    var mins: Double
    var at: Double
}

struct Script: Equatable {
    var text: String
    var share: String
    var by: String
}

/// Short words for a warning (toasts, the Health panel).
func shortWarning(_ w: String) -> String {
    switch w {
    case "mic-lost": "microphone unplugged"
    case "mic-silent": "no sound from the microphone"
    case "clipping": "too loud — distorting"
    case "glitch": "computer too busy"
    case "behind": "upload falling behind"
    case "offline": "connection lost"
    case "storage": "can't save to disk"
    case "disk": "studio nearly full"
    case "cam-lost": "camera stopped"
    default: "problem"
    }
}

// reading the studio's messages
func s(_ d: [String: Any], _ k: String) -> String { (d[k] as? String) ?? (d[k] as? NSNumber)?.stringValue ?? "" }
func n(_ d: [String: Any], _ k: String) -> Double { (d[k] as? NSNumber)?.doubleValue ?? Double(d[k] as? String ?? "") ?? 0 }
func b(_ d: [String: Any], _ k: String) -> Bool { (d[k] as? Bool) ?? ((d[k] as? NSNumber)?.boolValue ?? false) }
func arr(_ d: [String: Any], _ k: String) -> [[String: Any]] { d[k] as? [[String: Any]] ?? [] }
