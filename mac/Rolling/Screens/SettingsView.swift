import SwiftUI

/// Rolling › Settings (⌘,): how this Mac uses Rolling, and the studio's own settings.
struct SettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        TabView {
            Tab("General", systemImage: "gearshape") { GeneralSettings() }
            Tab("Studio", systemImage: "dot.radiowaves.left.and.right") {
                if model.isOwner { StudioSettingsView() }
                else {
                    ContentUnavailableView("Studio settings", systemImage: "lock",
                        description: Text(model.prefs.mode == .none ? "Start your studio or connect to one first." : "Connected with a show's host link — sign in with the studio's admin password to change its settings."))
                }
            }
        }
        .frame(width: 640, height: 640)
    }
}

struct GeneralSettings: View {
    @Environment(AppModel.self) private var model
    @State private var token = ""
    @State private var note = ""

    var body: some View {
        @Bindable var model = model
        Form {
            Section("This Mac") {
                LabeledContent("Using Rolling") {
                    switch model.prefs.mode {
                    case .host: Text("Hosting the studio on this Mac")
                    case .connect: Text("Connected to \(model.api?.base.host() ?? model.prefs.server)")
                    case .none: Text("Not set up yet")
                    }
                }
                if model.prefs.mode != .none {
                    Button(model.prefs.mode == .host ? "Stop Hosting…" : "Disconnect…") { Task { await model.signOut() } }
                }
            }
            Section {
                LabeledContent("Studio folder") { FolderField(path: $model.prefs.studioFolder) }
                Picker("Guest link", selection: $model.prefs.guestLink) {
                    Text("Free link (new address each time)").tag(Prefs.GuestLink.quick)
                    Text("My own address (Cloudflare tunnel)").tag(Prefs.GuestLink.own)
                }
                if model.prefs.guestLink == .own {
                    TextField("Address", text: $model.prefs.ownAddress, prompt: Text("podcast.example.com"))
                    TextField("Port", value: $model.prefs.ownPort, format: .number.grouping(.never))
                    HStack {
                        SecureField("Tunnel token", text: $token, prompt: Text(Keychain.get("tunnel-token") == nil ? "Paste from Cloudflare" : "Saved in your keychain — paste to replace"))
                        Button("Save") {
                            let t = token.split(whereSeparator: \.isWhitespace).last(where: { $0.count >= 40 }).map(String.init) ?? token
                            Keychain.set("tunnel-token", t.trimmingCharacters(in: .whitespaces)); token = ""; note = "Token saved ✓"
                        }
                        .disabled(token.isEmpty)
                    }
                }
                if model.hosting { Text("Changes here take effect the next time you start the studio.").font(.caption).foregroundStyle(.secondary) }
            } header: { Text("Hosting on this Mac") }
            Section("Connected to a server") {
                Toggle("Save a copy of every recording on this Mac", isOn: $model.prefs.saveCopies)
                    .onChange(of: model.prefs.saveCopies) { model.copiesChanged() }
                LabeledContent("Save in") { FolderField(path: $model.prefs.copiesFolder) }
                    .onChange(of: model.prefs.copiesFolder) { model.copiesChanged() }
                Toggle("Remove the live copy once the finished files are saved", isOn: $model.prefs.removeLiveCopy)
            }
            if !note.isEmpty { Text(note).foregroundStyle(.secondary) }
        }
        .formStyle(.grouped)
    }
}

struct StudioSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var s: StudioSettings?
    @State private var smtp = StudioSettings.Smtp()
    @State private var testTo = ""
    @State private var backupDir = ""
    @State private var cloud = ""
    @State private var autoCompact = false
    @State private var tx = StudioSettings.Transcribe()
    @State private var clean = StudioSettings.Clean()
    @State private var fps = 25
    @State private var turn = StudioSettings.Turn()
    @State private var status: [String: String] = [:]
    @State private var currentPw = ""
    @State private var newPw = ""

    var body: some View {
        Form {
            if s == nil { ProgressView().frame(maxWidth: .infinity) }
            Section {
                TextField("Server", text: bind(\.host), prompt: Text("smtp.example.com"))
                TextField("Port", value: Binding(get: { smtp.port ?? 587 }, set: { smtp.port = $0 }), format: .number.grouping(.never))
                TextField("Username", text: bind(\.user))
                SecureField("Password", text: bind(\.pass))
                TextField("From", text: bind(\.from), prompt: Text("Studio <you@example.com>"))
                HStack {
                    TextField("Send a test to", text: $testTo, prompt: Text("you@example.com"))
                    Button("Send Test Email") { test("email", "/api/settings/test-email", ["to": testTo]) }.disabled(!testTo.contains("@"))
                }
                note("email")
            } header: { Text("Email") } footer: {
                Text("To get an email when a take is ready, and to send guest invites. Any email account works (Gmail: use an app password).")
            }
            Section("Backups") {
                LabeledContent("Backup drive") {
                    HStack {
                        Text(backupDir.isEmpty ? "Not set" : (backupDir as NSString).abbreviatingWithTildeInPath).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        Spacer()
                        if !backupDir.isEmpty { Button("Clear") { backupDir = "" } }
                        Button("Choose…") {
                            let p = NSOpenPanel(); p.canChooseDirectories = true; p.canChooseFiles = false; p.canCreateDirectories = true
                            if p.runModal() == .OK, let u = p.url { backupDir = u.path }
                        }
                    }
                }
                if let b = s?.backup, b.set == true, let msg = b.msg, !msg.isEmpty { Text(msg).font(.caption).foregroundStyle(.warn) }
                HStack {
                    TextField("Cloud (rclone remote)", text: $cloud, prompt: Text("gdrive:Rolling"))
                    Button("Test") { test("cloud", "/api/settings/cloud-test", ["remote": cloud]) }.disabled(cloud.isEmpty)
                }
                note("cloud")
                Toggle("Free space automatically: delete each take's rebuild data once its files are made", isOn: $autoCompact)
            }
            Section("Transcripts") {
                Toggle("Make a transcript of every take (live while recording)", isOn: Binding(get: { tx.enabled ?? true }, set: { tx.enabled = $0 }))
                Picker("Speech model", selection: Binding(get: { tx.model ?? "base.en" }, set: { tx.model = $0 })) {
                    Text("Tiny (English) — fastest").tag("tiny.en")
                    Text("Base (English) — recommended").tag("base.en")
                    Text("Small (English) — more accurate").tag("small.en")
                    Text("Medium (English) — slow").tag("medium.en")
                    Text("Base (any language)").tag("base")
                    Text("Small (any language)").tag("small")
                }
                TextField("Language", text: Binding(get: { tx.language ?? "auto" }, set: { tx.language = $0 }), prompt: Text("auto, or en, fr, de…"))
                HStack {
                    Text(tx.installed == true ? "The transcript engine is installed (\((tx.models ?? []).joined(separator: ", ")))" : "The transcript engine isn't installed on this studio.")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Test Transcription") { test("tx", "/api/settings/test-transcribe", nil) }.disabled(tx.installed != true)
                }
                note("tx")
            }
            Section("Clean-up files") {
                Toggle("Make cleaned files automatically for every take", isOn: $clean.auto)
                Picker("Noise reduction (learned from the room tone)", selection: $clean.noise) {
                    Text("Off").tag("off"); Text("Light (6 dB)").tag("light"); Text("Medium (12 dB) — recommended").tag("medium"); Text("Strong (20 dB)").tag("strong")
                }
                Toggle("Remove rumble and mains hum", isOn: $clean.rumble)
                Picker("Mains hum", selection: $clean.mains) { Text("50 Hz (UK, Europe)").tag(50); Text("60 Hz (US)").tag(60) }
                Toggle("Repair distortion (declip moments that hit the top)", isOn: $clean.declip)
                Toggle("Soften harsh “s” sounds (de-ess)", isOn: $clean.deess)
                Toggle("Even out the voice (gentle compression)", isOn: $clean.compress)
                Toggle("Quieten background between lines (gate — can clip quiet word starts)", isOn: $clean.gate)
                Stepper("Mark pauses longer than \(Int(clean.pauses)) seconds in the edit list\(clean.pauses == 0 ? " (off)" : "")", value: $clean.pauses, in: 0...30)
            }
            Section("Video and networks") {
                Picker("Video frame rate", selection: $fps) { Text("25 fps (UK, Europe)").tag(25); Text("30 fps (US)").tag(30) }
                TextField("TURN key ID", text: Binding(get: { turn.keyId ?? "" }, set: { turn.keyId = $0 }))
                SecureField("TURN API token", text: Binding(get: { turn.token ?? "" }, set: { turn.token = $0 }))
                HStack {
                    Text("A relay (Cloudflare TURN, optional) for guests on strict networks.").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Test Relay") { test("turn", "/api/settings/test-turn", nil) }
                }
                note("turn")
                if let e = s?.turnError, !e.isEmpty { Text(e).font(.caption).foregroundStyle(.warn) }
            }
            Section {
                HStack { Spacer(); note("save"); Button("Save Settings") { save() }.buttonStyle(.borderedProminent).keyboardShortcut("s") }
            }
            if model.prefs.mode == .connect {
                Section("Admin password") {
                    SecureField("Current password", text: $currentPw)
                    SecureField("New password (8 or more characters)", text: $newPw)
                    HStack {
                        note("pw"); Spacer()
                        Button("Change Password") {
                            Task {
                                do { try await model.api?.call("POST", "/api/settings/password", json: ["current": currentPw, "next": newPw]); status["pw"] = "Changed ✓"; currentPw = ""; newPw = "" }
                                catch { status["pw"] = "⚠ \(error.localizedDescription)" }
                            }
                        }
                        .disabled(currentPw.isEmpty || newPw.count < 8)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .task { await load() }
    }

    private func bind(_ k: WritableKeyPath<StudioSettings.Smtp, String?>) -> Binding<String> {
        Binding(get: { smtp[keyPath: k] ?? "" }, set: { smtp[keyPath: k] = $0 })
    }

    @ViewBuilder private func note(_ k: String) -> some View {
        if let t = status[k], !t.isEmpty { Text(t).font(.caption).foregroundStyle(t.hasPrefix("⚠") ? Color.rec : .ok) }
    }

    private func load() async {
        guard let api = model.api, let v = try? await api.settings() else { return }
        s = v
        smtp = v.smtp ?? .init(); backupDir = v.backupDir ?? ""; cloud = v.cloud?.remote ?? ""; autoCompact = v.autoCompact ?? false
        tx = v.transcribe ?? .init(); clean = v.clean ?? .init(); fps = v.fps ?? 25; turn = v.turn ?? .init()
    }

    private func save() {
        let body: [String: Any] = [
            "smtp": ["host": smtp.host ?? "", "port": smtp.port ?? 587, "user": smtp.user ?? "", "pass": smtp.pass ?? "", "from": smtp.from ?? ""],
            "turn": ["keyId": turn.keyId ?? "", "token": turn.token ?? ""],
            "backupDir": backupDir, "cloud": ["remote": cloud], "autoCompact": autoCompact, "fps": fps,
            "transcribe": ["enabled": tx.enabled ?? true, "model": tx.model ?? "base.en", "language": tx.language ?? "auto"],
            "clean": ["auto": clean.auto, "declip": clean.declip, "rumble": clean.rumble, "mains": clean.mains, "noise": clean.noise,
                      "gate": clean.gate, "deess": clean.deess, "compress": clean.compress, "pauses": clean.pauses],
        ]
        Task {
            do { try await model.api?.saveSettings(body); status["save"] = "Saved ✓"; await load() }
            catch { status["save"] = "⚠ \(error.localizedDescription)" }
        }
    }

    private func test(_ k: String, _ path: String, _ json: [String: Any]?) {
        status[k] = "Testing…"
        Task {
            // tests use what's saved, so save first
            if k != "cloud" { try? await model.api?.saveSettings(["smtp": ["host": smtp.host ?? "", "port": smtp.port ?? 587, "user": smtp.user ?? "", "pass": smtp.pass ?? "", "from": smtp.from ?? ""],
                                                                 "turn": ["keyId": turn.keyId ?? "", "token": turn.token ?? ""]]) }
            do {
                let d = try await model.api?.data("POST", path, json: json ?? [:])
                let o = d.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
                switch k {
                case "email": status[k] = "Sent ✓ — check \(testTo)"
                case "turn": status[k] = "Works ✓ (\(o["servers"] as? Int ?? 0) relay addresses)"
                case "cloud": status[k] = "Works ✓"
                default: status[k] = "Works ✓" + ((o["text"] as? String).map { " — “\($0)”" } ?? "")
                }
            } catch { status[k] = "⚠ \(error.localizedDescription)" }
        }
    }
}
