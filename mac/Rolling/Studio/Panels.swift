import SwiftUI

// MARK: - soundboard

struct SoundboardPanel: View {
    @Bindable var session: StudioSession
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Level").foregroundStyle(.secondary)
                Slider(value: $session.boardLevel, in: -30...6, step: 0.5).frame(width: 140)
                Text(dbText(session.boardLevel)).font(.caption.monospacedDigit())
                Toggle("Dip music under voices", isOn: $session.duckBeds)
            }
            Button { session.stopAllPads() } label: { Label("Stop All", systemImage: "stop.fill") }.buttonStyle(.glass)
            if session.sounds.isEmpty {
                ContentUnavailableView("No sounds yet", systemImage: "square.grid.3x3", description: Text("Add jingles, ads and music beds in the main window: the show's Soundboard tab."))
            } else {
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 10)], spacing: 10) {
                        ForEach(Array(session.sounds.enumerated()), id: \.element.id) { i, pad in
                            Button { session.press(pad) } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        if i < 12 { Text("F\(i + 1)").font(.caption2.monospaced()).opacity(0.7) }
                                        Spacer()
                                        Image(systemName: pad.mode == "bed" ? "repeat" : pad.mode == "effect" ? "sparkles" : "music.note")
                                    }
                                    Text(pad.name).font(.callout.bold()).lineLimit(2).multilineTextAlignment(.leading)
                                    Spacer(minLength: 0)
                                    Text(clock((pad.dur ?? 0) * 1000)).font(.caption2.monospacedDigit()).opacity(0.7)
                                    if let p = session.boardProgress[pad.id] {
                                        ProgressView(value: min(1, p)).tint(.white)
                                    }
                                }
                                .padding(10)
                                .frame(maxWidth: .infinity, minHeight: 84, alignment: .topLeading)
                                .background(Color(hex: pad.color).opacity(session.boardProgress[pad.id] != nil ? 0.95 : 0.55), in: RoundedRectangle(cornerRadius: 12))
                                .foregroundStyle(.white)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            Text("Everyone hears the soundboard. Jingles and beds: press again to stop. F1–F12 play the first twelve.").font(.caption).foregroundStyle(.secondary)
        }
        .padding(14)
    }
}

// MARK: - show: producer notes, rundown, script & teleprompter, live transcript

struct ShowPanel: View {
    @Bindable var session: StudioSession
    @State private var note = ""
    @State private var script = ""
    @State private var share = "hosts"
    @State private var prompter = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                section("Producer note") {
                    Text("A timed note for the edit list (not a chapter).").font(.caption).foregroundStyle(.secondary)
                    HStack {
                        TextField("e.g. Check the date he mentioned", text: $note).onSubmit(addNote)
                        Button("Add", action: addNote).disabled(note.isEmpty || session.recordingSince == nil)
                    }
                    ForEach(session.markers.filter { $0.tag == "note" }) { m in
                        HStack(alignment: .top) { Text(clock(m.at)).monospacedDigit().foregroundStyle(.secondary); Text(m.label) }.font(.callout)
                    }
                }
                section("Rundown") {
                    if session.rundown.isEmpty {
                        Text("No rundown yet — make one in the main window: the show's Rundown tab.").font(.callout).foregroundStyle(.secondary)
                    }
                    ForEach(Array(session.rundown.enumerated()), id: \.offset) { i, r in
                        HStack {
                            Image(systemName: session.segment?.idx == i ? "play.circle.fill" : "circle").foregroundStyle(session.segment?.idx == i ? Color.rec : .secondary)
                            Text(r.name)
                            Spacer()
                            Text("\(Int(r.mins)) min").foregroundStyle(.secondary)
                            Button("Start") { session.startSegment(i) }.controlSize(.small)
                        }
                    }
                    if !session.rundown.isEmpty {
                        HStack {
                            Button("Next Segment") { session.startSegment(min(session.rundown.count - 1, (session.segment?.idx ?? -1) + 1)) }
                            Button("Stop the Clock") { session.stopSegments() }
                        }
                    }
                }
                section("Script") {
                    TextEditor(text: $script).font(.body).frame(minHeight: 140)
                        .scrollContentBackground(.hidden).padding(6).background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))
                    HStack {
                        Picker("Show it to", selection: $share) { Text("Hosts only").tag("hosts"); Text("Everyone").tag("all") }.frame(width: 200)
                        Spacer()
                        Button("Save") { session.saveScript(script, share: share) }
                        Button("Teleprompter") { prompter = true }
                    }
                    if let s = session.script, !s.by.isEmpty { Text("Last saved by \(s.by)").font(.caption).foregroundStyle(.secondary) }
                }
                section("Live transcript") {
                    if let tx = session.transcript {
                        let lines = (tx["recent"] as? [[String: Any]]) ?? []
                        if lines.isEmpty { Text(b(tx, "engine") ? "Waiting for the first lines…" : "The transcript engine isn't installed on this studio.").foregroundStyle(.secondary) }
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                            (Text(s(l, "who") + ": ").bold() + Text(highlightFillers(s(l, "text")))).font(.callout)
                        }
                    } else {
                        Text("Appears while you record (if transcripts are on).").foregroundStyle(.secondary).font(.callout)
                    }
                }
            }
            .padding(14)
        }
        .onAppear { script = session.script?.text ?? ""; share = session.script?.share ?? "hosts" }
        .onChange(of: session.script) { if let s = session.script { script = s.text; share = s.share } }
        .sheet(isPresented: $prompter) { Teleprompter(text: script) }
    }

    private func addNote() {
        guard !note.isEmpty else { return }
        if session.marker("note", label: note) { note = "" }
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ c: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) { Text(title).font(.headline); c() }
    }

    private func highlightFillers(_ t: String) -> AttributedString {
        var a = AttributedString(t)
        for w in ["um", "uh", "erm", "er"] {
            var search = a.startIndex..<a.endIndex
            while let r = a[search].range(of: w, options: [.caseInsensitive]) {
                a[r].backgroundColor = .yellow.opacity(0.35)
                search = r.upperBound..<a.endIndex
            }
        }
        return a
    }
}

struct Teleprompter: View {
    @Environment(\.dismiss) private var dismiss
    let text: String
    @State private var offset: CGFloat = 0
    @State private var running = false
    @State private var speed: Double = 40
    private let tick = Timer.publish(every: 1 / 30, on: .main, in: .common).autoconnect()
    var body: some View {
        VStack(spacing: 0) {
            GeometryReader { g in
                Text(text).font(.system(size: 44, weight: .semibold)).foregroundStyle(.white).lineSpacing(10)
                    .padding(.horizontal, 60).frame(width: g.size.width, alignment: .leading)
                    .offset(y: g.size.height / 3 - offset)
            }
            .background(.black).clipped()
            HStack {
                Button(running ? "Pause" : "Start") { running.toggle() }.keyboardShortcut(.space, modifiers: [])
                Button("Back to the Top") { offset = 0 }
                Text("Speed"); Slider(value: $speed, in: 5...150).frame(width: 200)
                Spacer()
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .padding(12)
        }
        .frame(minWidth: 900, minHeight: 600)
        .onReceive(tick) { _ in if running { offset += CGFloat(speed / 30) } }
    }
}

// MARK: - chat

struct ChatPanel: View {
    let session: StudioSession
    @State private var text = ""
    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { sv in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(session.chat) { c in
                            VStack(alignment: c.mine ? .trailing : .leading, spacing: 2) {
                                Text(c.mine ? "You" : c.from).font(.caption.bold()).foregroundStyle(.secondary)
                                Text(c.text).padding(.horizontal, 10).padding(.vertical, 6)
                                    .background(c.mine ? Color.accentColor.opacity(0.3) : Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
                                    .textSelection(.enabled)
                            }
                            .frame(maxWidth: .infinity, alignment: c.mine ? .trailing : .leading)
                            .id(c.id)
                        }
                    }
                    .padding(12)
                }
                .onChange(of: session.chat.count) { if let l = session.chat.last { sv.scrollTo(l.id, anchor: .bottom) } }
            }
            HStack {
                TextField("Message everyone", text: $text).textFieldStyle(.roundedBorder).onSubmit(go)
                Button("Send", action: go).disabled(text.isEmpty)
            }
            .padding(10)
        }
    }
    private func go() { session.say(text); text = "" }
}

// MARK: - cues and tags

struct CuesPanel: View {
    @Bindable var session: StudioSession
    @State private var to = "all"
    @State private var text = ""
    private let quick = ["Wrap up", "1 minute", "30 seconds", "Speak up", "Move closer to the mic", "Great — keep going", "Stand by", "We're live"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Cue card").font(.headline)
                Picker("To", selection: $to) {
                    Text("Everyone").tag("all")
                    ForEach(session.people.filter { !$0.control }) { Text($0.name).tag($0.id) }
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 130))], spacing: 6) {
                    ForEach(quick, id: \.self) { q in Button(q) { session.cue(to, q); session.toast("Cue sent: \(q)") }.frame(maxWidth: .infinity) }
                }
                HStack {
                    TextField("Your own cue", text: $text).onSubmit(send)
                    Button("Send", action: send).disabled(text.isEmpty)
                }
                Divider()
                Text("Quick tags").font(.headline)
                Text("Marked in the edit list at the moment you press them (while recording).").font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("★ Great Bit (1)") { session.marker("great") }
                    Button("✂ Cut This (2)") { session.marker("cut") }
                }
                HStack {
                    Button("↺ Retake (3)") { session.marker("retake") }
                    Button("$ Ad Break (4)") { session.marker("ad") }
                }
                if !session.markers.isEmpty {
                    Divider()
                    Text("This take's markers").font(.headline)
                    ForEach(session.markers.reversed()) { m in
                        HStack { Text(clock(m.at)).monospacedDigit().foregroundStyle(.secondary); Text(m.label); Spacer(); Text(m.by).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
            .padding(14)
        }
    }
    private func send() { session.cue(to, text); session.toast("Cue sent"); text = "" }
}

// MARK: - health, in plain words

struct HealthPanel: View {
    let session: StudioSession
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                let issues = problems
                Label(issues.isEmpty ? "Everything looks good" : "\(issues.count) thing\(issues.count == 1 ? "" : "s") to look at",
                      systemImage: issues.isEmpty ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                    .font(.title3.bold()).foregroundStyle(issues.isEmpty ? Color.ok : .warn)
                ForEach(issues, id: \.self) { Text("• " + $0) }
                Divider()
                Text("The studio").font(.headline)
                if let free = (session.serverDisk?["free"] as? NSNumber)?.doubleValue {
                    let ppl = Double(max(1, session.people.filter { !$0.control }.count + (session.controlRoom ? 0 : 1)))
                    row("Space", "\(bytes(free)) free — about \(String(format: "%.1f", free / 1_073_741_824 / (ppl * session.gbPerPersonHour))) hours with everyone here")
                }
                if let st = session.studioInfo {
                    if n(st, "making") > 0 { row("Files", "Making the files for \(Int(n(st, "making"))) take(s)") }
                    row("Transcripts", ["on": "On", "off": "Switched off", "missing": "Not installed"][s(st, "transcripts")] ?? "–")
                    row("Backups", [s(st, "backup").isEmpty ? nil : "drive", s(st, "cloud").isEmpty ? nil : "cloud"].compactMap { $0 }.joined(separator: " + ").nilIfEmpty ?? "None set up")
                    row("Email", b(st, "email") ? "Set up" : "Not set up")
                    row("Version", s(st, "version"))
                }
                if let rtt = session.serverRtt { row("Delay to the studio", "\(Int(rtt)) ms") }
                Divider()
                Text("Each person").font(.headline)
                if !session.controlRoom {
                    personCard(name: "\(session.myName) (you)", sound: soundWords(session.myLoud.S, muted: !session.micOn),
                               rec: recWords(session.recorder.report().0, session.recorder.report().1), conn: nil, warnings: session.micSilent ? ["mic-silent"] : [], history: [])
                }
                ForEach(session.people.filter { !$0.control }) { p in
                    personCard(name: p.name, sound: soundWords(p.loud.S, muted: p.micOff), rec: recWords(p.state.rec, Int(p.state.pending)),
                               conn: connWords(p), warnings: p.state.warnings, history: p.history)
                }
            }
            .padding(14)
        }
    }

    private var problems: [String] {
        var out: [String] = []
        if session.micSilent && session.micOn && !session.controlRoom { out.append("Your microphone is sending no sound — check it's plugged in and chosen in the lobby.") }
        for p in session.people where !p.control {
            for w in p.state.warnings { out.append("\(p.name): \(shortWarning(w))") }
            if p.conn == "failed" { out.append("\(p.name): the call isn't connecting — their recording is still safe") }
        }
        if let free = (session.serverDisk?["free"] as? NSNumber)?.doubleValue, free < 5 * 1_073_741_824 { out.append("The studio is nearly full (\(bytes(free)) free)") }
        return out
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top) { Text(k).foregroundStyle(.secondary).frame(width: 130, alignment: .leading); Text(v) }.font(.callout)
    }

    private func soundWords(_ s: Double?, muted: Bool) -> String {
        if muted { return "Muted" }
        guard let s else { return "No sound yet" }
        return s > -12 ? "Too loud" : s < -35 ? "A bit quiet" : "Good (\(lufs(s)) LUFS)"
    }
    private func recWords(_ rec: String, _ pending: Int) -> String {
        switch rec {
        case "recording": "Recording and keeping up"
        case "uploading": "Finishing the upload — \(bytes(Double(pending))) to go"
        case "saved": "Everything saved ✓"
        default: "Not recording"
        }
    }
    private func connWords(_ p: Person) -> String {
        let loss = p.loss ?? p.state.loss
        if p.conn != "connected" { return p.conn == "failed" ? "Poor — the call keeps dropping (only the live call; the recording is safe)" : "Connecting…" }
        return loss > 0.05 ? "Poor (\(Int(loss * 100))% lost) — only affects the live call" : loss > 0.01 ? "OK" : "Good" + (p.rtt.map { " (\(Int($0)) ms)" } ?? "")
    }

    private func personCard(name: String, sound: String, rec: String, conn: String?, warnings: [String], history: [Double]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(name).font(.callout.bold())
            row("Sound", sound)
            row("Recording", rec)
            if let conn { row("Connection", conn) }
            ForEach(warnings, id: \.self) { Label(shortWarning($0), systemImage: "exclamationmark.triangle").foregroundStyle(.warn).font(.caption) }
            if history.contains(where: { $0.isFinite }) {
                LoudnessHistory(values: history).frame(height: 36)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
    }
}

/// The last five minutes of someone's loudness.
struct LoudnessHistory: View {
    let values: [Double]
    var body: some View {
        Canvas { ctx, size in
            let pos = { (v: Double) -> CGFloat in size.height * (1 - CGFloat(min(1, max(0, (v + 40) / 35)))) }
            var path = Path()
            var started = false
            for (i, v) in values.enumerated() {
                let x = size.width * CGFloat(i) / CGFloat(max(1, values.count - 1))
                guard v.isFinite else { started = false; continue }
                if started { path.addLine(to: CGPoint(x: x, y: pos(v))) } else { path.move(to: CGPoint(x: x, y: pos(v))); started = true }
            }
            ctx.stroke(path, with: .color(.ok), lineWidth: 1.5)
            var t = Path(); t.move(to: CGPoint(x: 0, y: pos(-20))); t.addLine(to: CGPoint(x: size.width, y: pos(-20)))
            ctx.stroke(t, with: .color(.secondary.opacity(0.5)), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
        }
    }
}

extension String { var nilIfEmpty: String? { isEmpty ? nil : self } }

// MARK: - big clock (second screen)

struct BigClockWindow: View {
    @Environment(AppModel.self) private var model
    let roomId: String
    @State private var now = Date()
    private let timer = Timer.publish(every: 0.04, on: .main, in: .common).autoconnect()
    var body: some View {
        let sess = model.session(roomId)
        let srv = sess?.serverNow() ?? Date().timeIntervalSince1970 * 1000
        let rec = sess?.recordingSince.map { srv - $0 }
        VStack(spacing: 6) {
            Text(rec != nil ? "REC" : "STANDBY").font(.system(size: 30, weight: .heavy)).foregroundStyle(rec != nil ? Color.rec : .secondary)
            Text(timecode(rec ?? 0, fps: sess?.fps ?? 25)).font(.system(size: 96, weight: .bold, design: .monospaced)).minimumScaleFactor(0.3)
            if let seg = sess?.segment {
                let el = srv - seg.at
                Text("\(seg.name) · \(clock(el)) of \(Int(seg.mins)):00").font(.title).foregroundStyle(el > seg.mins * 60000 ? Color.warn : .secondary)
            }
        }
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.black)
        .foregroundStyle(.white)
        .overlay { if rec != nil { Rectangle().strokeBorder(Color.rec, lineWidth: 8) } }
        .onReceive(timer) { now = $0 }
    }
}
