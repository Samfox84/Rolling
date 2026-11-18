import SwiftUI

/// The audio Console: the programme loudness against the target, auto level / auto mix, scenes, and a strip per
/// person. Fader moves and settings are baked into the Producer mix and remembered per person.
struct ConsolePanel: View {
    @Bindable var session: StudioSession
    @State private var storeArmed = false

    var body: some View {
        VStack(spacing: 12) {
            master
            Text("Faders, mute and solo change what you hear live. EQ, compressor, gate, low cut and pan are baked into the Producer mix.")
                .font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12)
            Divider()
            let list = session.people.filter { !$0.control }
            if list.isEmpty {
                ContentUnavailableView("Nobody on the Console yet", systemImage: "slider.vertical.3", description: Text("Each person gets a channel when they come in."))
            } else {
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: 8) {
                        ForEach(list) { p in Strip(session: session, person: p) }
                    }
                    .padding(.horizontal, 12).padding(.bottom, 8)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 10)
    }

    private var master: some View {
        HStack(alignment: .top, spacing: 14) {
            ProgrammeMeter(loud: session.programme, level: session.programmeLevel, target: session.target, limiting: session.limiting)
                .frame(width: 34, height: 150)
            VStack(alignment: .leading, spacing: 8) {
                Text("Programme").font(.caption.bold()).foregroundStyle(.secondary)
                Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 2) {
                    GridRow { Text("Momentary").foregroundStyle(.secondary); Text(lufs(session.programme.M)).monospacedDigit() }
                    GridRow { Text("Short-term").foregroundStyle(.secondary); Text(lufs(session.programme.S)).monospacedDigit().foregroundStyle(loudColor(session.programme.S)) }
                    GridRow { Text("Integrated").foregroundStyle(.secondary); Text(lufs(session.programme.I)).monospacedDigit().bold() }
                    GridRow { Text("True peak").foregroundStyle(.secondary); Text(session.programme.TPmax.map { String(format: "%.1f dBTP", $0) } ?? "–").monospacedDigit()
                        .foregroundStyle((session.programme.TPmax ?? -99) > -1 ? Color.rec : .primary) }
                }
                .font(.callout)
                Picker("Target", selection: $session.target) {
                    Text("−16 LUFS (podcast)").tag(-16.0)
                    Text("−19 LUFS").tag(-19.0)
                    Text("−23 LUFS (broadcast)").tag(-23.0)
                }
                .frame(width: 230)
                HStack {
                    Button { session.autoLevel() } label: { Label("Auto Level", systemImage: "dial.medium") }
                        .help("Sets every fader so each person lands on the target")
                    Toggle("Auto Mix", isOn: $session.autoMix).toggleStyle(.button)
                        .help("Gain sharing: whoever's talking stays up, the others dip, so room noise doesn't add up")
                }
                HStack(spacing: 6) {
                    Text("Scenes").font(.caption).foregroundStyle(.secondary)
                    ForEach(["A", "B", "C"], id: \.self) { slot in
                        Button(slot) {
                            if storeArmed { session.storeScene(slot); storeArmed = false } else { session.recallScene(slot) }
                        }
                        .buttonStyle(.bordered)
                        .tint(session.scenes[slot] != nil ? .accentColor : nil)
                    }
                    Toggle("Store", isOn: $storeArmed).toggleStyle(.button).tint(.warn)
                        .help("Press Store, then A, B or C to save the Console into that scene")
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
    }
}

/// A tall loudness bar with the target line.
struct ProgrammeMeter: View {
    let loud: Loud
    let level: Float
    let target: Double
    let limiting: Bool
    var body: some View {
        GeometryReader { g in
            let pos = { (v: Double) -> CGFloat in CGFloat(min(1, max(0, (v + 40) / 40))) }
            ZStack(alignment: .bottom) {
                RoundedRectangle(cornerRadius: 4).fill(.black.opacity(0.4))
                if let s = loud.S {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(s > target + 3 ? Color.rec : s < target - 6 ? Color.warn : Color.ok)
                        .frame(height: g.size.height * pos(s))
                }
                Rectangle().fill(.white).frame(height: 2).offset(y: -g.size.height * pos(target) + 1)
                if limiting { Circle().fill(Color.rec).frame(width: 10, height: 10).offset(y: -g.size.height + 8).help("Limiting") }
            }
        }
    }
}

/// One person's channel strip.
struct Strip: View {
    @Bindable var session: StudioSession
    let person: Person

    var body: some View {
        let c = session.chan(person.id)
        VStack(spacing: 8) {
            Text(person.name).font(.callout.bold()).lineLimit(1).frame(width: 96)
            HStack(spacing: 4) {
                small("LOW CUT", on: c.hpf) { var x = c; x.hpf.toggle(); session.setChan(person.id, x) }
                small("GATE", on: c.gate) { var x = c; x.gate.toggle(); session.setChan(person.id, x) }
            }
            knob("High", c.high) { v in var x = c; x.high = v; session.setChan(person.id, x) }
            knob("Presence", c.pres) { v in var x = c; x.pres = v; session.setChan(person.id, x) }
            knob("Low", c.low) { v in var x = c; x.low = v; session.setChan(person.id, x) }
            small("COMP", on: c.comp) { var x = c; x.comp.toggle(); session.setChan(person.id, x) }
            VStack(spacing: 2) {
                Text("Pan").font(.caption2).foregroundStyle(.secondary)
                Slider(value: Binding(get: { c.pan }, set: { v in var x = c; x.pan = (v * 20).rounded() / 20; session.setChan(person.id, x) }), in: -1...1)
                    .controlSize(.mini)
            }
            HStack(alignment: .bottom, spacing: 6) {
                LevelMeter(level: person.level, peak: person.peakHold, vertical: true).frame(width: 8, height: 170)
                Fader(db: Binding(get: { c.db ?? -60 }, set: { v in var x = c; x.db = v <= -59.5 ? nil : v; session.setChan(person.id, x, ride: true) }))
                    .frame(width: 34, height: 170)
            }
            Text(dbText((c.db ?? -60) + person.autoDb)).font(.caption.monospacedDigit())
                .foregroundStyle(person.autoDb < -0.5 ? Color.tone : .primary)
            HStack(spacing: 4) {
                small("MUTE", on: c.cut, color: .rec) { var x = c; x.cut.toggle(); session.setChan(person.id, x, ride: true) }
                    .help("Mutes them in what you hear AND the Producer mix")
                small("SOLO", on: c.solo, color: .warn) { var x = c; x.solo.toggle(); session.setChan(person.id, x) }
                    .help("Hear only them (your ears only)")
            }
            small("🎧 OFF", on: c.mute) { var x = c; x.mute.toggle(); session.setChan(person.id, x) }
                .help("Silence them in your headphones only")
            HoldButton(down: { session.talk(to: person.id) }, up: { session.talk(to: nil) }) { Text("TALK").font(.caption.bold()) }
            Text("\(lufs(person.loud.S)) LUFS").font(.caption2.monospacedDigit()).foregroundStyle(loudColor(person.loud.S))
        }
        .padding(8)
        .frame(width: 112)
        .background(session.selectedStrip == person.id ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        .onTapGesture { session.selectedStrip = person.id }
    }

    private func small(_ t: String, on: Bool, color: Color = .accentColor, _ act: @escaping () -> Void) -> some View {
        Button(action: act) { Text(t).font(.system(size: 9, weight: .bold)).frame(maxWidth: .infinity) }
            .buttonStyle(.bordered).controlSize(.small).tint(on ? color : nil)
            .background(on ? color.opacity(0.35) : .clear, in: RoundedRectangle(cornerRadius: 5))
    }

    private func knob(_ label: String, _ v: Double, _ set: @escaping (Double) -> Void) -> some View {
        VStack(spacing: 0) {
            HStack { Text(label).font(.caption2).foregroundStyle(.secondary); Spacer(); Text(String(format: "%+.0f", v)).font(.caption2.monospacedDigit()) }
            Slider(value: Binding(get: { v }, set: { set(($0 * 2).rounded() / 2) }), in: -12...12).controlSize(.mini)
        }
    }
}

/// A vertical fader: drag to move (Option-drag for fine), double-click for 0 dB.
struct Fader: View {
    @Binding var db: Double
    @State private var start: Double?
    var body: some View {
        GeometryReader { g in
            let y = g.size.height * (1 - Self.pos(db))
            ZStack(alignment: .top) {
                Capsule().fill(.black.opacity(0.45)).frame(width: 4).frame(maxHeight: .infinity)
                ForEach([12.0, 6, 0, -6, -12, -24, -40], id: \.self) { m in
                    Rectangle().fill(.secondary.opacity(m == 0 ? 0.8 : 0.4)).frame(width: m == 0 ? 22 : 14, height: 1)
                        .offset(y: g.size.height * (1 - Self.pos(m)))
                }
                RoundedRectangle(cornerRadius: 4).fill(.white.gradient).frame(width: 30, height: 18)
                    .overlay(Rectangle().fill(.black.opacity(0.6)).frame(height: 1))
                    .shadow(radius: 2)
                    .offset(y: y - 9)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { v in
                    if start == nil { start = Self.pos(db) }
                    let fine = NSEvent.modifierFlags.contains(.option) ? 0.25 : 1
                    let p = (start ?? 0) - Double(v.translation.height / g.size.height) * fine
                    db = Self.db(min(1, max(0, p)))
                }
                .onEnded { _ in start = nil })
            .onTapGesture(count: 2) { db = 0 }
        }
    }
    /// fader position 0…1 ↔ dB (−60…+12), more room near 0 dB
    static func pos(_ db: Double) -> Double { db <= -60 ? 0 : db >= 12 ? 1 : db >= -24 ? 0.4 + (db + 24) / 36 * 0.6 : (db + 60) / 36 * 0.4 }
    static func db(_ p: Double) -> Double { let v = p >= 0.4 ? -24 + (p - 0.4) / 0.6 * 36 : -60 + p / 0.4 * 36; return (v * 4).rounded() / 4 }
}
