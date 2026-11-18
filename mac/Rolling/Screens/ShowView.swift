import SwiftUI
import UniformTypeIdentifiers

/// One show: its guest link, the way into its studio, its recordings and its settings.
struct ShowView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    let room: Room
    @State private var tab = Tab.recordings
    @State private var inviting = false
    @State private var lobby = false
    @State private var renaming = false
    @State private var newName = ""

    enum Tab: String, CaseIterable { case recordings = "Recordings", rundown = "Rundown", soundboard = "Soundboard", settings = "Show Settings" }

    var body: some View {
        VStack(spacing: 0) {
            header
            Picker("", selection: $tab) {
                ForEach(Tab.allCases, id: \.self) { Text($0.rawValue) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 520)
            .padding(.vertical, 12)
            Divider()
            switch tab {
            case .recordings: RecordingsList(room: room)
            case .rundown: RundownEditor(room: room)
            case .soundboard: PadsEditor(room: room)
            case .settings: ShowSettingsView(room: room)
            }
        }
        .navigationTitle(room.name)
        .navigationSubtitle(room.recording == true ? "Recording now" : (room.online?.isEmpty == false ? "\(room.online!.count) in the studio" : ""))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    if let s = model.session(room.id), !s.hasLeft { openWindow(id: "studio", value: room.id) } else { lobby = true }
                } label: {
                    Label("Open Studio", systemImage: "mic.fill")
                }
                .buttonStyle(.glassProminent)
                .tint(.rec)
                .help("Go into this show's studio")
            }
        }
        .sheet(isPresented: $inviting) { InviteSheet(room: room) }
        .sheet(isPresented: $lobby) {
            LobbySheet(room: room) { name, control in
                if model.openStudio(room, name: name, controlRoom: control) != nil { openWindow(id: "studio", value: room.id) }
            }
        }
        .alert("Rename Show", isPresented: $renaming) {
            TextField("Name", text: $newName)
            Button("Rename") { Task { await model.update(room, ["name": newName]) } }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    Text(room.name).font(.largeTitle.bold())
                    Button { newName = room.name; renaming = true } label: { Image(systemName: "pencil") }
                        .buttonStyle(.borderless).help("Rename this show")
                    if room.recording == true { Pill(text: "Recording", color: .rec, systemImage: "record.circle") }
                    if let online = room.online, !online.isEmpty { Pill(text: online.joined(separator: ", "), color: .ok, systemImage: "person.2.fill") }
                }
                let link = model.guestLink(room)
                HStack(spacing: 8) {
                    Image(systemName: "link").foregroundStyle(.secondary)
                    if link.isEmpty {
                        Text("The guest link appears here once the internet link is ready.").foregroundStyle(.secondary)
                    } else {
                        Text(link).font(.body.monospaced()).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
                        Button("Copy") { copy(link) }.buttonStyle(.glass).controlSize(.small)
                    }
                    Button("Invite a Guest…") { inviting = true }.buttonStyle(.glass).controlSize(.small)
                }
            }
            Spacer()
        }
        .padding(.horizontal, 24).padding(.top, 18)
    }
}

/// Before going in: your name, on air or control room, and which mic, speakers and camera.
struct LobbySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let room: Room
    var go: (String, Bool) -> Void
    @State private var name = ""
    @State private var control = false
    @State private var mics: [Device] = []
    @State private var speakers: [Device] = []
    @State private var cameras: [Device] = []

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 18) {
            Text("Go into \(room.name)").font(.title2.bold())
            Form {
                TextField("Your name", text: $name, prompt: Text("Shown to your guests"))
                Picker("How", selection: $control) {
                    Text("On air — I'm a host on the show (camera, mic, recorded)").tag(false)
                    Text("Control room — I'm producing (not seen, not recorded)").tag(true)
                }
                .pickerStyle(.radioGroup)
                Picker("Microphone", selection: $model.prefs.mic) {
                    Text("Mac's default").tag("")
                    ForEach(mics) { Text($0.name).tag($0.id) }
                }
                Picker("Headphones", selection: $model.prefs.speakers) {
                    Text("Mac's default").tag("")
                    ForEach(speakers) { Text($0.name).tag($0.id) }
                }
                if !control {
                    Picker("Camera", selection: $model.prefs.camera) {
                        Text("Mac's default").tag("")
                        Text("No camera").tag("off")
                        ForEach(cameras) { Text($0.name).tag($0.id) }
                    }
                }
            }
            .formStyle(.grouped)
            Text(control ? "Hold Talk to speak to one person privately. The soundboard is heard by everyone."
                         : "Wear headphones so your guests don't hear themselves back. Your voice is recorded in full quality on this Mac as well as live.")
                .font(.callout).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Go In") {
                    let n = name.trimmingCharacters(in: .whitespaces)
                    go(n.isEmpty ? "Host" : n, control); dismiss()
                }
                .buttonStyle(.borderedProminent).tint(.rec).keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 560)
        .onAppear {
            name = model.prefs.myName; control = model.prefs.controlRoom
            mics = Devices.microphones(); speakers = Devices.outputs(); cameras = Devices.cameras()
        }
    }
}
