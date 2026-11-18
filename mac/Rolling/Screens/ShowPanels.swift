import SwiftUI
import UniformTypeIdentifiers

// MARK: - invite a guest

/// Email a guest their link, a 5-minute setup checklist and a calendar entry — or copy it to send yourself.
struct InviteSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let room: Room
    @State private var name = ""
    @State private var email = ""
    @State private var host = ""
    @State private var hasTime = true
    @State private var date = Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
    @State private var minutes = 60
    @State private var note = ""
    @State private var result = ""
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Invite a Guest").font(.title2.bold())
            Form {
                TextField("Guest's name", text: $name)
                TextField("Their email", text: $email, prompt: Text("Only needed to send it by email"))
                TextField("From (your name)", text: $host)
                Toggle("Add a calendar entry", isOn: $hasTime)
                if hasTime {
                    DatePicker("When", selection: $date)
                    Stepper("Length: \(minutes) minutes", value: $minutes, in: 10...600, step: 15)
                }
                TextField("A note for them (optional)", text: $note, axis: .vertical).lineLimit(2...5)
            }
            .formStyle(.grouped)
            if room.emailReady != true {
                Text("Email isn't set up yet (Settings) — copy the invite and send it yourself.").font(.callout).foregroundStyle(.secondary)
            }
            if !result.isEmpty { Text(result).font(.callout).foregroundStyle(result.hasPrefix("⚠") ? Color.rec : .ok) }
            HStack {
                Button("Close", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Copy Invite") { Task { await send(false) } }.disabled(busy)
                Button("Send Email") { Task { await send(true) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || room.emailReady != true || !email.contains("@"))
            }
        }
        .padding(24)
        .frame(width: 520)
        .onAppear { host = model.prefs.myName }
    }

    private func send(_ email: Bool) async {
        guard let api = model.api else { return }
        busy = true; defer { busy = false }
        var body: [String: Any] = ["name": name, "email": self.email, "host": host, "note": note, "send": email,
                                   "tz": TimeZone.current.identifier, "minutes": minutes]
        if hasTime { body["when"] = ISO8601DateFormatter().string(from: date) }
        do {
            let d = try await api.data("POST", "/api/rooms/\(room.id)/invite", json: body, key: room.hostKey)
            let o = (try? JSONSerialization.jsonObject(with: d) as? [String: Any]) ?? [:]
            if email { result = "Sent ✓ — \(self.email) has their invite" }
            else {
                copy("\(o["subject"] as? String ?? "")\n\n\(o["text"] as? String ?? "")")
                result = "Invite copied — paste it into an email, WhatsApp or Messages"
            }
        } catch { result = "⚠ \(error.localizedDescription)" }
    }
}

// MARK: - rundown

/// The show's running order: segments with their planned length. Shown to everyone in the studio as a show clock;
/// each segment becomes a chapter.
struct RundownEditor: View {
    @Environment(AppModel.self) private var model
    let room: Room
    @State private var items: [RundownItem] = []
    @State private var saved = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Everyone in the studio sees the rundown and a show clock. Start each segment from the studio's Show panel; segments become chapters in the files.")
                .foregroundStyle(.secondary)
            List {
                ForEach($items) { $it in
                    HStack {
                        Image(systemName: "line.3.horizontal").foregroundStyle(.tertiary)
                        TextField("Segment", text: $it.name)
                        TextField("Minutes", value: $it.mins, format: .number).frame(width: 70).multilineTextAlignment(.trailing)
                        Text("min").foregroundStyle(.secondary)
                        Button(role: .destructive) { items.removeAll { $0.id == it.id } } label: { Image(systemName: "minus.circle") }.buttonStyle(.borderless)
                    }
                }
                .onMove { items.move(fromOffsets: $0, toOffset: $1) }
            }
            .listStyle(.inset(alternatesRowBackgrounds: true))
            .onChange(of: items) { saved = false }
            HStack {
                Button { items.append(RundownItem(name: "Segment \(items.count + 1)", mins: 5)) } label: { Label("Add Segment", systemImage: "plus") }
                Text("Total \(Int(items.reduce(0) { $0 + $1.mins })) minutes").foregroundStyle(.secondary)
                Spacer()
                Button(saved ? "Saved ✓" : "Save Rundown") {
                    Task { await model.update(room, ["rundown": items.map { ["name": $0.name, "mins": $0.mins] }]); saved = true }
                }
                .buttonStyle(.borderedProminent).disabled(saved)
            }
        }
        .padding(20)
        .onAppear { items = room.rundown ?? []; DispatchQueue.main.async { saved = true } }
    }
}

// MARK: - soundboard pads

/// Up to 24 pads per show — jingles, stings, ads and music beds, played live from the studio (F1–F12).
struct PadsEditor: View {
    @Environment(AppModel.self) private var model
    let room: Room
    @State private var message = ""
    @State private var picking = false

    var body: some View {
        let pads = room.sounds ?? []
        VStack(alignment: .leading, spacing: 12) {
            Text("Everyone hears the soundboard live. It's recorded as its own track and mixed into the Producer mix. Music beds loop and dip under speech.")
                .foregroundStyle(.secondary)
            if pads.isEmpty {
                ContentUnavailableView("No sounds yet", systemImage: "square.grid.3x3", description: Text("Add jingles, stings, ads and music beds (any audio file)."))
            } else {
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(Array(pads.enumerated()), id: \.element.id) { i, p in PadRow(room: room, pad: p, key: i < 12 ? "F\(i + 1)" : "") }
                    }
                }
            }
            HStack {
                Button { picking = true } label: { Label("Add Sounds…", systemImage: "plus") }
                    .buttonStyle(.glass).disabled(pads.count >= 24)
                Text(message).foregroundStyle(.secondary)
                Spacer()
                Text("\(pads.count) of 24").foregroundStyle(.secondary)
            }
        }
        .padding(20)
        .fileImporter(isPresented: $picking, allowedContentTypes: [.audio], allowsMultipleSelection: true) { r in
            guard case .success(let urls) = r, let api = model.api else { return }
            Task {
                for u in urls {
                    message = "Adding \(u.lastPathComponent)…"
                    let ok = u.startAccessingSecurityScopedResource(); defer { if ok { u.stopAccessingSecurityScopedResource() } }
                    do { _ = try await api.upload("/api/rooms/\(room.id)/sounds", file: u, key: room.hostKey) }
                    catch { message = "⚠ \(u.lastPathComponent): \(error.localizedDescription)"; return }
                }
                message = "Added ✓"
                await model.refresh()
            }
        }
    }
}

struct PadRow: View {
    @Environment(AppModel.self) private var model
    let room: Room
    let pad: Pad
    let key: String
    @State private var name = ""
    @State private var mode = "jingle"
    @State private var vol = 0.0
    @State private var color = Color.blue
    @State private var dirty = false

    var body: some View {
        HStack(spacing: 12) {
            Text(key).font(.caption.monospaced()).foregroundStyle(.secondary).frame(width: 28)
            ColorPicker("", selection: $color, supportsOpacity: false).labelsHidden()
            TextField("Name", text: $name).frame(minWidth: 140)
            Picker("", selection: $mode) {
                Text("Jingle").tag("jingle"); Text("Music bed").tag("bed"); Text("Effect").tag("effect")
            }
            .labelsHidden().frame(width: 120)
            Slider(value: $vol, in: -30...6, step: 0.5).frame(width: 140)
            Text(dbText(vol)).monospacedDigit().frame(width: 64, alignment: .trailing)
            Text(clock((pad.dur ?? 0) * 1000)).foregroundStyle(.secondary).monospacedDigit()
            Button("Save") {
                Task {
                    try? await model.api?.call("POST", "/api/rooms/\(room.id)/sounds/\(pad.id)", json: ["name": name, "mode": mode, "vol": vol, "color": color.hex], key: room.hostKey)
                    dirty = false; await model.refresh()
                }
            }
            .disabled(!dirty)
            Button(role: .destructive) {
                Task { try? await model.api?.call("DELETE", "/api/rooms/\(room.id)/sounds/\(pad.id)", key: room.hostKey); await model.refresh() }
            } label: { Image(systemName: "trash") }
            .buttonStyle(.borderless)
        }
        .padding(10)
        .background(Color(hex: pad.color).opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        .onAppear { name = pad.name; mode = pad.mode; vol = pad.vol; color = Color(hex: pad.color); DispatchQueue.main.async { dirty = false } }
        .onChange(of: name) { dirty = true }
        .onChange(of: mode) { dirty = true }
        .onChange(of: vol) { dirty = true }
        .onChange(of: color) { dirty = true }
    }
}

extension Color {
    var hex: String {
        let c = NSColor(self).usingColorSpace(.sRGB) ?? .systemBlue
        return String(format: "#%02x%02x%02x", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
    }
}

// MARK: - show settings

struct ShowSettingsView: View {
    @Environment(AppModel.self) private var model
    let room: Room
    @State private var notify = ""
    @State private var message = ""
    @State private var picking: String?

    var body: some View {
        Form {
            Section("Guests") {
                Toggle("Waiting room — guests knock and you let them in", isOn: Binding(
                    get: { room.waitingRoom != false },
                    set: { v in Task { await model.update(room, ["waitingRoom": v]) } }))
            }
            Section("Email") {
                HStack {
                    TextField("Email me when a take is ready", text: $notify, prompt: Text("you@example.com"))
                    Button("Save") { Task { await model.update(room, ["notifyEmail": notify]); message = "Saved ✓" } }
                        .disabled(notify == (room.notifyEmail ?? ""))
                }
            }
            Section {
                ForEach(["intro", "outro"], id: \.self) { kind in
                    LabeledContent(kind == "intro" ? "Intro" : "Outro") {
                        if let a = room.assets?[kind] {
                            Text("\(a.name ?? kind) · \(clock((a.dur ?? 0) * 1000))").foregroundStyle(.secondary)
                            Button("Replace…") { picking = kind }
                            Button("Remove", role: .destructive) {
                                Task { try? await model.api?.call("DELETE", "/api/rooms/\(room.id)/asset/\(kind)", key: room.hostKey); await model.refresh() }
                            }
                        } else {
                            Button("Add…") { picking = kind }
                        }
                    }
                }
            } header: { Text("Intro and outro") } footer: {
                Text("Added to the session files and the Producer mix of every take.").foregroundStyle(.secondary)
            }
            if !message.isEmpty { Text(message).foregroundStyle(.secondary) }
        }
        .formStyle(.grouped)
        .onAppear { notify = room.notifyEmail ?? "" }
        .fileImporter(isPresented: Binding(get: { picking != nil }, set: { if !$0 { picking = nil } }), allowedContentTypes: [.audio]) { r in
            guard case .success(let u) = r, let kind = picking, let api = model.api else { return }
            Task {
                message = "Adding \(u.lastPathComponent)…"
                let ok = u.startAccessingSecurityScopedResource(); defer { if ok { u.stopAccessingSecurityScopedResource() } }
                do { _ = try await api.upload("/api/rooms/\(room.id)/asset/\(kind)", file: u, key: room.hostKey); message = "Saved ✓"; await model.refresh() }
                catch { message = "⚠ \(error.localizedDescription)" }
            }
        }
    }
}
