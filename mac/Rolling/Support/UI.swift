import SwiftUI

// Small pieces shared by the windows.

extension Color {
    /// "#3b82f6"
    init(hex: String) {
        var v: UInt64 = 0
        Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&v)
        self.init(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }
    static let rec = Color(red: 0.89, green: 0.24, blue: 0.24)
    static let ok = Color(red: 0.27, green: 0.75, blue: 0.43)
    static let warn = Color(red: 0.91, green: 0.65, blue: 0.18)
    static let tone = Color(red: 0.27, green: 0.55, blue: 0.9)
}

/// A small coloured label ("Recording", "Ready", "2 in the studio").
struct Pill: View {
    var text: String
    var color: Color = .secondary
    var systemImage: String?
    var body: some View {
        Label {
            Text(text)
        } icon: {
            if let systemImage { Image(systemName: systemImage) }
        }
        .labelStyle(.titleAndIcon)
        .font(.caption.weight(.medium))
        .foregroundStyle(color)
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(color.opacity(0.15), in: Capsule())
    }
}

/// hh:mm:ss (or m:ss) from milliseconds.
func clock(_ ms: Double, hours: Bool = false) -> String {
    let s = max(0, Int(ms / 1000))
    let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
    return (h > 0 || hours) ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
}

/// Studio timecode hh:mm:ss:ff.
func timecode(_ ms: Double, fps: Double = 25) -> String {
    let v = max(0, ms)
    let s = Int(v / 1000), f = Int((v.truncatingRemainder(dividingBy: 1000)) / 1000 * fps)
    return String(format: "%02d:%02d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60, f)
}

func when(_ ms: Double) -> String {
    let d = Date(timeIntervalSince1970: ms / 1000)
    return d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())
}

func lufs(_ v: Double?) -> String {
    guard let v, v.isFinite, v > -70 else { return "–" }
    return String(format: "%.1f", v)
}

func loudColor(_ v: Double?) -> Color {
    guard let v, v.isFinite, v > -70 else { return .secondary }
    return v > -12 ? .rec : v > -28 ? .ok : .warn
}

func dbText(_ db: Double) -> String { db <= -60 ? "−∞" : String(format: "%+.1f dB", db).replacingOccurrences(of: "-", with: "−") }

/// A level meter, 0…1 linear, coloured by level.
struct LevelMeter: View {
    var level: Float
    var peak: Float = 0
    var vertical = false
    var body: some View {
        GeometryReader { g in
            let x = CGFloat(Self.position(level)), p = CGFloat(Self.position(peak))
            ZStack(alignment: vertical ? .bottom : .leading) {
                RoundedRectangle(cornerRadius: 2).fill(.black.opacity(0.35))
                RoundedRectangle(cornerRadius: 2)
                    .fill(Self.color(level))
                    .frame(width: vertical ? nil : g.size.width * x, height: vertical ? g.size.height * x : nil)
                if peak > 0.001 {
                    Rectangle().fill(Self.color(peak))
                        .frame(width: vertical ? nil : 2, height: vertical ? 2 : nil)
                        .offset(x: vertical ? 0 : g.size.width * p - 2, y: vertical ? -g.size.height * p + 2 : 0)
                }
            }
        }
        .animation(.linear(duration: 0.08), value: level)
    }
    static func position(_ l: Float) -> Float { let db = 20 * log10(max(l, 1e-6)); return min(1, max(0, (db + 60) / 60)) }
    static func color(_ l: Float) -> Color { let db = 20 * log10(max(l, 1e-6)); return db > -3 ? .rec : db > -12 ? .warn : .ok }
}

extension View {
    /// A rounded card on the window background.
    func card(padding: CGFloat = 16) -> some View {
        self.padding(padding)
            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// What kind of file this is, in words, for the Recordings list.
func kindName(_ kind: String) -> String {
    switch kind {
    case "audio": "Audio — lossless WAV (untouched)"
    case "cleaned": "Cleaned"
    case "normalised": "Normalised"
    case "roomtone": "Room tone — noise print"
    case "mix": "Mix — all voices together"
    case "producermix": "Producer mix"
    case "roughmix": "Rough mix"
    case "soundboard": "Soundboard"
    case "editlist": "Edit list"
    case "intro": "Intro"
    case "outro": "Outro"
    case "video": "Video — MP4 (H.264)"
    case "video-original": "Video — camera original"
    case "screen": "Screen share"
    case "session": "Session (for your editor)"
    case "transcript": "Transcript"
    case "chapters": "Chapters"
    case "markers": "Markers"
    case "report": "Level report"
    case "chat": "Chat"
    default: kind.prefix(1).uppercased() + kind.dropFirst()
    }
}

func kindIcon(_ kind: String) -> String {
    switch kind {
    case "audio", "cleaned", "normalised", "roomtone": "waveform"
    case "mix", "producermix", "roughmix": "slider.horizontal.3"
    case "soundboard", "intro", "outro": "music.note"
    case "video", "video-original": "video"
    case "screen": "rectangle.on.rectangle"
    case "transcript", "chat": "text.quote"
    case "session": "film.stack"
    default: "doc.text"
    }
}
