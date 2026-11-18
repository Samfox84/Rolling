import SwiftUI
import WebRTC

/// Everyone's pictures, sized to fill the stage. The green room (not recorded) sits apart, under the stage.
struct TilesGrid: View {
    let session: StudioSession
    var onKick: (Person) -> Void
    var onHelp: (Person) -> Void

    var body: some View {
        let onAir = session.people.filter { !$0.control && !$0.green }
        let green = session.people.filter { $0.green }
        let screens = session.people.filter { $0.screen != nil }
        let count = onAir.count + screens.count + (session.controlRoom ? 0 : 1)
        VStack(spacing: 10) {
            GeometryReader { g in
                let cols = columns(count, in: g.size)
                let w = (g.size.width - CGFloat(cols - 1) * 10) / CGFloat(cols)
                let rows = Int(ceil(Double(max(1, count)) / Double(cols)))
                let h = min(w * 9 / 16, (g.size.height - CGFloat(rows - 1) * 10) / CGFloat(rows))
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(min(w, h * 16 / 9)), spacing: 10), count: cols), spacing: 10) {
                    if !session.controlRoom { MyTile(session: session).frame(height: h) }
                    ForEach(onAir) { p in
                        PersonTile(session: session, person: p, onKick: onKick, onHelp: onHelp).frame(height: h)
                    }
                    ForEach(screens) { p in
                        ZStack(alignment: .bottomLeading) {
                            VideoView(track: p.screen).clipShape(RoundedRectangle(cornerRadius: 12))
                            Text("\(p.name)'s screen").font(.caption.bold()).padding(6).glassEffect(.regular, in: .capsule).padding(8)
                        }
                        .frame(height: h)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if count == (session.controlRoom ? 0 : 1) && green.isEmpty {
                Text(session.guestLink.isEmpty ? "Waiting for guests…" : "Waiting for guests — send them the guest link (toolbar).").foregroundStyle(.secondary)
            }
            if !green.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Green room — only hosts see and hear them, and they aren't recorded", systemImage: "leaf.fill").font(.caption.bold()).foregroundStyle(.ok)
                    HStack(spacing: 10) {
                        ForEach(green) { p in
                            PersonTile(session: session, person: p, onKick: onKick, onHelp: onHelp)
                                .frame(width: 240, height: 135)
                                .overlay(alignment: .topTrailing) {
                                    Button("Bring on Air") { session.bringOnAir(p.id) }.buttonStyle(.glassProminent).tint(.ok).padding(8)
                                }
                        }
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassEffect(.regular.tint(.ok.opacity(0.12)), in: .rect(cornerRadius: 14))
            }
        }
        .padding(12)
    }

    private func columns(_ n: Int, in size: CGSize) -> Int {
        guard n > 1 else { return 1 }
        var best = 1, bestArea: CGFloat = 0
        for c in 1...n {
            let r = Int(ceil(Double(n) / Double(c)))
            let w = (size.width - CGFloat(c - 1) * 10) / CGFloat(c)
            let h = min(w * 9 / 16, (size.height - CGFloat(r - 1) * 10) / CGFloat(r))
            let area = h * h * 16 / 9
            if area > bestArea { bestArea = area; best = c }
        }
        return best
    }
}

/// My own picture.
struct MyTile: View {
    let session: StudioSession
    var body: some View {
        ZStack(alignment: .bottom) {
            if session.camOn, let cam = session.media.camera {
                VideoView(track: cam)
            } else {
                Avatar(name: session.myName)
            }
            TileFooter(name: "\(session.myName) (you)", level: session.myLevel, peak: 0, loud: session.myLoud.S,
                       micOff: !session.micOn, coughing: session.coughing, rec: session.recorder.current != nil, warnings: session.micSilent ? 1 : 0)
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(session.coughing ? Color.warn : .clear, lineWidth: 3))
    }
}

struct PersonTile: View {
    let session: StudioSession
    let person: Person
    var onKick: (Person) -> Void
    var onHelp: (Person) -> Void

    var body: some View {
        ZStack(alignment: .bottom) {
            if let v = person.video { VideoView(track: v) } else { Avatar(name: person.name) }
            TileFooter(name: person.name, level: person.level, peak: person.peakHold, loud: person.loud.S,
                       micOff: person.micOff, coughing: person.coughing, rec: person.state.rec == "recording", warnings: person.state.warnings.count)
            if person.conn != "connected" {
                Text(person.conn == "failed" ? "Connection problem — retrying…" : "Connecting…")
                    .font(.caption.bold()).padding(8).glassEffect(.regular, in: .capsule)
                    .frame(maxHeight: .infinity)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(person.level > 0.06 ? Color.ok : .clear, lineWidth: 2))
        .contextMenu {
            Button("Send a Cue…") { session.selectedStrip = person.id; session.toast("Type the cue in the Cues panel") }
            Button("Help \(person.name)…") { onHelp(person) }
            if person.green { Button("Bring on Air") { session.bringOnAir(person.id) } }
            Divider()
            Button("Remove from the Studio…", role: .destructive) { onKick(person) }
        }
    }
}

struct Avatar: View {
    let name: String
    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(white: 0.16), Color(white: 0.1)], startPoint: .top, endPoint: .bottom)
            Text(initials).font(.system(size: 44, weight: .semibold, design: .rounded)).foregroundStyle(.white.opacity(0.7))
                .frame(width: 96, height: 96).background(Circle().fill(.white.opacity(0.08)))
        }
    }
    private var initials: String {
        name.split(separator: " ").prefix(2).compactMap { $0.first.map(String.init) }.joined().uppercased()
    }
}

struct TileFooter: View {
    let name: String
    let level: Float
    let peak: Float
    let loud: Double?
    let micOff: Bool
    let coughing: Bool
    let rec: Bool
    let warnings: Int
    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 6) {
                if rec { Circle().fill(Color.rec).frame(width: 8, height: 8).help("Recording on their computer") }
                Text(name).font(.callout.weight(.semibold)).lineLimit(1)
                if micOff { Image(systemName: "mic.slash.fill").foregroundStyle(.rec) }
                if coughing { Image(systemName: "hand.raised.fill").foregroundStyle(.warn).help("Holding cough") }
                Spacer()
                if warnings > 0 { Label("\(warnings)", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.warn).font(.caption) }
                Text("\(lufs(loud)) LUFS").font(.caption.monospacedDigit()).foregroundStyle(loudColor(loud))
            }
            LevelMeter(level: level, peak: peak).frame(height: 4)
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .glassEffect(.regular, in: .rect(cornerRadius: 10))
        .padding(8)
    }
}
