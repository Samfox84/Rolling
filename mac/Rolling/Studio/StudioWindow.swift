import AppKit
import SwiftUI
import WebRTC

/// One show's live studio, in its own window: everyone's pictures, the transport (record, markers, timecode),
/// my mic / cough / talkback, and the producer's panels (Console, Soundboard, Show, Chat, Cues, Health).
struct StudioWindow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismissWindow) private var dismissWindow
    let roomId: String

    var body: some View {
        if let s = model.session(roomId) {
            StudioView(session: s)
                .navigationTitle(s.room.name)
        } else {
            ContentUnavailableView {
                Label("Not in this studio", systemImage: "mic.slash")
            } description: {
                Text("Open the studio from the show in the main window.")
            } actions: {
                Button("Close") { dismissWindow() }
            }
        }
    }
}

struct StudioView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    @Bindable var session: StudioSession
    @State private var panel: Panel = .console
    @State private var showPanel = true
    @State private var recordDialog = false
    @State private var stopDialog = false
    @State private var toneDialog = false
    @State private var leaveDialog = false
    @State private var kickWho: Person?
    @State private var helpWho: Person?
    @State private var noteText = ""
    @State private var keys: Any?
    @State private var now = Date()
    private let timer = Timer.publish(every: 0.04, on: .main, in: .common).autoconnect()

    enum Panel: String, CaseIterable, Identifiable {
        case console = "Console", board = "Soundboard", show = "Show", chat = "Chat", cues = "Cues", health = "Health"
        var id: String { rawValue }
        var icon: String {
            switch self {
            case .console: "slider.vertical.3"
            case .board: "square.grid.3x3.fill"
            case .show: "list.bullet.rectangle"
            case .chat: "bubble.left.and.bubble.right"
            case .cues: "text.bubble"
            case .health: "stethoscope"
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            switch session.phase {
            case .refused(let title, let msg):
                ContentUnavailableView(title, systemImage: "hand.raised", description: Text(msg))
            case .left:
                ContentUnavailableView("You've left the studio", systemImage: "door.left.hand.open")
            default:
                stage
                bottomBar
            }
        }
        .inspector(isPresented: $showPanel) {
            panels.inspectorColumnWidth(min: 340, ideal: 420, max: 640)
        }
        .toolbar { toolbar }
        .overlay(alignment: .bottom) { toasts }
        .overlay { overlays }
        .onReceive(timer) { now = $0 }
        .onAppear { keys = installKeys() }
        .onDisappear { if let k = keys { NSEvent.removeMonitor(k) } }
        .sheet(isPresented: $recordDialog) { RecordSheet(session: session) }
        .alert("Stop recording?", isPresented: $stopDialog) {
            Button("Stop Recording", role: .destructive) { session.stopRecording() }
            Button("Keep Recording", role: .cancel) {}
        } message: { Text("Everyone's files will finish uploading, then they'll be ready on the Recordings page.") }
        .alert("Record room tone now?", isPresented: $toneDialog) {
            Button("Start Room Tone") { session.recordRoomTone() }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Everyone will be asked to stay silent for \(Int(session.roomToneSeconds)) seconds.") }
        .alert("Leave the studio?", isPresented: $leaveDialog) {
            Button("Leave", role: .destructive) { model.closeStudio(session.room.id); dismissWindow() }
            Button("Cancel", role: .cancel) {}
        } message: { Text(session.recordingSince != nil ? "You're recording. Leaving stops your part of the take; everyone else carries on." : "You can come back any time.") }
        .alert("Remove \(kickWho?.name ?? "")?", isPresented: Binding(get: { kickWho != nil }, set: { if !$0 { kickWho = nil } })) {
            Button("Remove", role: .destructive) { if let p = kickWho { session.kick(p.id) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("They will be taken out of the studio. Their recording so far is kept.") }
        .sheet(item: $helpWho) { p in HelpGuestSheet(session: session, person: p) }
    }

    // MARK: - toolbar: leave, tally, timecode, record

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Button { leaveDialog = true } label: { Label("Leave", systemImage: "rectangle.portrait.and.arrow.right") }
                .help("Leave the studio")
        }
        ToolbarItem(placement: .principal) {
            HStack(spacing: 18) {
                tally
                timecodes
            }
        }
        ToolbarItemGroup(placement: .primaryAction) {
            if session.recordingSince == nil {
                Button { recordDialog = true } label: { Label("Start Recording", systemImage: "record.circle") }
                    .buttonStyle(.glassProminent).tint(.rec)
                    .disabled(session.phase != .inside)
            } else {
                Button { stopDialog = true } label: { Label("Stop Recording", systemImage: "stop.circle.fill") }
                    .buttonStyle(.glassProminent).tint(.rec)
                Button { toneDialog = true } label: { Label("Room Tone", systemImage: "ear") }
                    .help("Record room tone now")
                Menu {
                    Button("Marker (M)") { session.marker() }
                    Button("Great Bit (1)") { session.marker("great") }
                    Button("Cut This (2)") { session.marker("cut") }
                    Button("Retake (3)") { session.marker("retake") }
                    Button("Ad Break (4)") { session.marker("ad") }
                } label: { Label("Markers", systemImage: "mappin.and.ellipse") } primaryAction: { session.marker() }
                    .help("Drop a marker (M) — or a tag (1–4)")
            }
            Button { openWindow(id: "clock", value: session.room.id) } label: { Label("Big Clock", systemImage: "clock") }
                .help("Open a big clock (for a second screen)")
            Button { copy(session.guestLink); session.toast("Guest link copied — send it to your guests") } label: { Label("Copy Guest Link", systemImage: "link") }
                .disabled(session.guestLink.isEmpty)
            Button { showPanel.toggle() } label: { Label("Panels", systemImage: "sidebar.trailing") }
        }
    }

    private var tally: some View {
        let rec = session.recordingSince != nil
        return Text(rec ? "REC" : session.phase == .inside ? "STANDBY" : session.phase == .waiting ? "WAITING" : "CONNECTING")
            .font(.system(.callout, design: .rounded).weight(.heavy))
            .padding(.horizontal, 10).padding(.vertical, 3)
            .background(rec ? Color.rec : Color.secondary.opacity(0.25), in: Capsule())
            .foregroundStyle(rec ? .white : .primary)
            .symbolEffect(.pulse, isActive: rec)
    }

    private var timecodes: some View {
        let srv = session.serverNow()
        let rec = session.recordingSince.map { srv - $0 }
        let seg = session.segment.map { srv - $0.at }
        return HStack(spacing: 14) {
            tc("REC", rec.map { timecode($0, fps: session.fps) } ?? "--:--:--:--", color: rec == nil ? .secondary : .rec)
            tc(session.segment?.name.uppercased() ?? "SEGMENT", seg.map { timecode($0, fps: session.fps) } ?? "--:--:--:--",
               color: session.segment.map { s in (seg ?? 0) > s.mins * 60000 ? Color.warn : .primary } ?? .secondary)
            tc("TIME OF DAY", timecode(Double(Calendar.current.dateComponents([.hour, .minute, .second, .nanosecond], from: now).totalMs), fps: session.fps), color: .primary)
        }
    }

    private func tc(_ label: String, _ v: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label).font(.system(size: 8, weight: .semibold)).foregroundStyle(.secondary).lineLimit(1)
            Text(v).font(.system(.body, design: .monospaced).weight(.medium)).foregroundStyle(color)
        }
    }

    // MARK: - the stage: knocks, everyone's pictures

    private var stage: some View {
        VStack(spacing: 0) {
            if !session.knocks.isEmpty {
                VStack(spacing: 6) {
                    ForEach(session.knocks, id: \.id) { k in
                        HStack {
                            Image(systemName: "hand.wave.fill").foregroundStyle(.warn)
                            Text("\(k.name) is waiting to come in").font(.headline)
                            Spacer()
                            Button("Let In") { session.admit(k.id, allow: true) }.buttonStyle(.glassProminent).tint(.ok)
                            Button("Green Room") { session.admit(k.id, allow: true, green: true) }.buttonStyle(.glass)
                                .help("Talk to them privately first (not recorded), then bring them on air")
                            Button("Not Now") { session.admit(k.id, allow: false) }.buttonStyle(.glass)
                        }
                        .padding(10)
                        .glassEffect(.regular.tint(.warn.opacity(0.15)), in: .rect(cornerRadius: 12))
                    }
                }
                .padding([.horizontal, .top], 12)
            }
            if !session.audioProblems.isEmpty || session.cameraProblem != nil {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(session.audioProblems + [session.cameraProblem].compactMap { $0 }, id: \.self) { Label($0, systemImage: "exclamationmark.triangle").foregroundStyle(.warn) }
                }
                .font(.callout).padding(.horizontal, 14).padding(.top, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if session.phase == .waiting {
                ContentUnavailableView("Waiting to be let in", systemImage: "hourglass", description: Text("The studio has a waiting room."))
            } else {
                TilesGrid(session: session, onKick: { kickWho = $0 }, onHelp: { helpWho = $0 })
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(0.9))
        .overlay {
            if session.recordingSince != nil { RoundedRectangle(cornerRadius: 0).strokeBorder(Color.rec, lineWidth: 3).allowsHitTesting(false) }
        }
    }

    // MARK: - bottom bar: my mic, cough, talkback, headphones

    private var bottomBar: some View {
        HStack(spacing: 14) {
            if !session.controlRoom {
                Toggle(isOn: $session.micOn) { Label(session.micOn ? "Mic On" : "Mic Off", systemImage: session.micOn ? "mic.fill" : "mic.slash.fill") }
                    .toggleStyle(.button).tint(session.micOn ? .accentColor : .rec)
                LevelMeter(level: session.myLevel).frame(width: 110, height: 8)
                Text("\(lufs(session.myLoud.S)) LUFS").font(.caption.monospacedDigit()).foregroundStyle(loudColor(session.myLoud.S))
                HoldButton(down: { session.setCough(true) }, up: { session.setCough(false) }) { Label("Hold to Cough", systemImage: "hand.raised.fill") }
                    .help("Mutes your live sound while held (C). Marked for the edit; your recording is untouched.")
                Toggle(isOn: Binding(get: { session.camOn }, set: { v in Task { await session.setCamera(on: v) } })) {
                    Label("Camera", systemImage: session.camOn ? "video.fill" : "video.slash.fill")
                }
                .toggleStyle(.button)
                Divider().frame(height: 22)
            }
            Picker("Talk to", selection: Binding(get: { session.selectedStrip ?? session.people.first(where: { !$0.control })?.id ?? "" }, set: { session.selectedStrip = $0 })) {
                ForEach(session.people) { Text($0.name).tag($0.id) }
            }
            .frame(width: 180)
            HoldButton(down: { session.talk(to: session.selectedStrip ?? session.people.first?.id) }, up: { session.talk(to: nil) }) {
                Label(session.talkingTo.flatMap { session.person($0)?.name }.map { "Talking to \($0)…" } ?? "Hold to Talk", systemImage: "person.wave.2.fill")
            }
            .help("Talk privately to one person while held (T). Not recorded in the Producer mix.")
            Spacer()
            if let t = session.talkIn { Label("\(t) is talking to you", systemImage: "waveform").foregroundStyle(.warn) }
            Image(systemName: "headphones")
            Slider(value: $session.monitor, in: 0...1.5).frame(width: 120).help("Headphone level")
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .background(.bar)
    }

    // MARK: - side panels

    private var panels: some View {
        VStack(spacing: 0) {
            Picker("", selection: $panel) {
                ForEach(Panel.allCases) { p in
                    Label(p.rawValue + (p == .chat && session.chatUnread > 0 ? " (\(session.chatUnread))" : ""), systemImage: p.icon).tag(p)
                }
            }
            .pickerStyle(.segmented).labelsHidden().labelStyle(.iconOnly)
            .padding(10)
            Text(panel.rawValue).font(.headline).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14)
            Divider().padding(.top, 6)
            Group {
                switch panel {
                case .console: ConsolePanel(session: session)
                case .board: SoundboardPanel(session: session)
                case .show: ShowPanel(session: session)
                case .chat: ChatPanel(session: session).onAppear { session.chatUnread = 0 }
                case .cues: CuesPanel(session: session)
                case .health: HealthPanel(session: session)
                }
            }
            .frame(maxHeight: .infinity, alignment: .top)
        }
    }

    // MARK: - overlays: toasts, cue card, room tone, countdown

    private var toasts: some View {
        VStack(spacing: 6) {
            ForEach(session.toasts) { t in
                Text(t.text).padding(.horizontal, 14).padding(.vertical, 8)
                    .glassEffect(.regular, in: .capsule)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .padding(.bottom, 64)
        .animation(.spring(duration: 0.3), value: session.toasts)
    }

    @ViewBuilder private var overlays: some View {
        if let c = session.cue {
            VStack(spacing: 8) {
                Text(c.text).font(.system(size: 44, weight: .bold)).multilineTextAlignment(.center)
                Text("— \(c.from)").foregroundStyle(.secondary)
            }
            .padding(30).glassEffect(.regular, in: .rect(cornerRadius: 24))
            .onTapGesture { }
        }
        if let rt = session.roomTone {
            let srv = session.serverNow()
            if srv < rt.end {
                VStack(spacing: 10) {
                    Text("🤫 Quiet please").font(.system(size: 40, weight: .bold))
                    Text("Recording room tone — \(Int(ceil((rt.end - max(srv, rt.start)) / 1000))) s").font(.title2.monospacedDigit())
                    ProgressView(value: min(1, max(0, (srv - rt.start) / max(1, rt.end - rt.start))))
                        .frame(width: 320)
                }
                .padding(36).glassEffect(.regular.tint(.tone.opacity(0.25)), in: .rect(cornerRadius: 24))
            }
        }
        if let c = session.countdownFrom {
            let left = 3 - Int(now.timeIntervalSince(c))
            if left > 0 {
                Text("\(left)").font(.system(size: 160, weight: .heavy, design: .rounded)).foregroundStyle(.rec)
                    .padding(40).glassEffect(.regular, in: .circle)
            }
        }
    }

    // MARK: - keys: M, 1–4, F1–F12, hold C (cough) and T (talk)

    private func installKeys() -> Any? {
        NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { e in
            guard e.window?.identifier?.rawValue.contains("studio") == true || e.window?.title == session.room.name else { return e }
            if let r = e.window?.firstResponder, r is NSText { return e }       // typing in a box
            let down = e.type == .keyDown
            let k = e.charactersIgnoringModifiers?.lowercased() ?? ""
            if let f = Self.fKeys[e.keyCode] {
                if down && !e.isARepeat, f < session.sounds.count { session.press(session.sounds[f]) }
                return nil
            }
            switch k {
            case "m": if down && !e.isARepeat { session.marker() }; return nil
            case "1": if down { session.marker("great") }; return nil
            case "2": if down { session.marker("cut") }; return nil
            case "3": if down { session.marker("retake") }; return nil
            case "4": if down { session.marker("ad") }; return nil
            case "c": if !e.isARepeat { session.setCough(down) }; return nil
            case "t": if !e.isARepeat { session.talk(to: down ? (session.selectedStrip ?? session.people.first?.id) : nil) }; return nil
            default: return e
            }
        }
    }
    private static let fKeys: [UInt16: Int] = [122: 0, 120: 1, 99: 2, 118: 3, 96: 4, 97: 5, 98: 6, 100: 7, 101: 8, 109: 9, 103: 10, 111: 11]
}

private extension DateComponents {
    var totalMs: Int { ((hour ?? 0) * 3600 + (minute ?? 0) * 60 + (second ?? 0)) * 1000 + (nanosecond ?? 0) / 1_000_000 }
}

/// Start recording: the episode, and room tone first or not.
struct RecordSheet: View {
    @Environment(\.dismiss) private var dismiss
    let session: StudioSession
    @State private var episode = ""
    @State private var title = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Start Recording").font(.title2.bold())
            Form {
                TextField("Episode number", text: $episode)
                TextField("Episode title (optional)", text: $title, prompt: Text("e.g. The Keyword Era"))
            }
            .formStyle(.grouped)
            Text("Record \(Int(session.roomToneSeconds)) seconds of room tone first? Everyone gets a “Quiet please” countdown, then a 3-2-1 and you're live. It's saved as a separate noise-print file for each person.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let free = (session.serverDisk?["free"] as? NSNumber)?.doubleValue {
                let ppl = Double(session.people.filter { !$0.control }.count + (session.controlRoom ? 0 : 1))
                let hrs = free / 1_073_741_824 / (max(1, ppl) * session.gbPerPersonHour)
                Text("Studio: \(bytes(free)) free — room for about \(hrs >= 10 ? String(Int(hrs)) : String(format: "%.1f", hrs)) hours with \(Int(max(1, ppl))) \(ppl == 1 ? "person" : "people").")
                    .font(.callout).foregroundStyle(hrs < 1 ? Color.rec : .secondary)
            }
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Record Without Room Tone") { go(false) }
                Button("Room Tone, Then Record") { go(true) }.buttonStyle(.borderedProminent).tint(.rec).keyboardShortcut(.defaultAction)
            }
        }
        .padding(24).frame(width: 520)
        .onAppear { episode = String(session.nextEpisode) }
    }
    private func go(_ tone: Bool) { session.startRecording(roomTone: tone, episode: Int(episode.trimmingCharacters(in: .whitespaces)), title: title); dismiss() }
}

/// Help a guest from the desk: switch their microphone, headphones mode, mute.
struct HelpGuestSheet: View {
    @Environment(\.dismiss) private var dismiss
    let session: StudioSession
    let person: Person
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Help \(person.name)").font(.title2.bold())
            if let d = person.devices {
                Picker("Their microphone", selection: Binding(get: { d.mic }, set: { session.help(person.id, "mic", $0); session.toast("Switching \(person.name)'s microphone…") })) {
                    ForEach(d.mics) { Text($0.name).tag($0.id) }
                }
                Toggle("They're wearing headphones", isOn: Binding(get: { d.headphones }, set: { session.help(person.id, "headphones", $0) }))
                HStack {
                    Button("Mute Them") { session.help(person.id, "mute") }
                    Button("Unmute Them") { session.help(person.id, "unmute") }
                }
                Text(d.micOn ? "Their microphone is on." : "Their microphone is off.").foregroundStyle(.secondary)
            } else {
                Text("Their browser hasn't said which devices it has yet.").foregroundStyle(.secondary)
            }
            HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction) }
        }
        .padding(24).frame(width: 440)
    }
}
