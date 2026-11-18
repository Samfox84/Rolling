import SwiftUI

/// Your shows down the side; the chosen show and its recordings on the right.
struct ShowsSplitView: View {
    @Environment(AppModel.self) private var model
    @State private var newName = ""
    @State private var making = false
    @State private var toDelete: Room?

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            List(selection: $model.selection) {
                Section {
                    StudioStatusCard()
                        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
                        .listRowSeparator(.hidden)
                        .selectionDisabled()
                }
                Section("Shows") {
                    ForEach(model.rooms) { r in
                        ShowRow(room: r)
                            .tag(r.id)
                            .contextMenu {
                                Button("Copy Guest Link") { copy(model.guestLink(r)) }.disabled(model.guestLink(r).isEmpty)
                                if model.isOwner {
                                    Divider()
                                    Button("Delete Show…", role: .destructive) { toDelete = r }
                                }
                            }
                    }
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 240, ideal: 270, max: 340)
            .safeAreaInset(edge: .bottom) {
                if model.isOwner {
                    Button { making = true } label: { Label("New Show", systemImage: "plus") }
                        .buttonStyle(.glass)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        } detail: {
            if let r = model.room(model.selection) {
                ShowView(room: r)
                    .id(r.id)
            } else {
                ContentUnavailableView {
                    Label("No shows yet", systemImage: "mic.badge.plus")
                } description: {
                    Text("Each show has its own guest link, studio and recordings. Make one per podcast (or per series).")
                } actions: {
                    if model.isOwner { Button("New Show") { making = true }.buttonStyle(.glassProminent) }
                }
            }
        }
        .sheet(isPresented: $making) {
            NewShowSheet(name: $newName) { name in
                Task { _ = await model.makeShow(name); newName = "" }
            }
        }
        .alert("Delete “\(toDelete?.name ?? "")”?", isPresented: Binding(get: { toDelete != nil }, set: { if !$0 { toDelete = nil } })) {
            Button("Delete Everything", role: .destructive) { if let r = toDelete { Task { await model.deleteShow(r) } } }
            Button("Keep It", role: .cancel) {}
        } message: {
            Text("This deletes the show and ALL its recordings from the studio. It can't be undone.")
        }
    }
}

/// Where the studio is, and whether guests can reach it.
struct StudioStatusCard: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.prefs.mode == .host {
                Label("Hosting on this Mac", systemImage: "desktopcomputer").font(.headline)
                HStack(spacing: 6) {
                    Circle().fill(model.local.guestLinkReady ? Color.ok : .warn).frame(width: 8, height: 8)
                    Text(model.local.guestLinkMessage).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                }
            } else {
                Label(model.api?.base.host() ?? "Studio", systemImage: "server.rack").font(.headline)
                if let m = model.mirror {
                    HStack(spacing: 6) {
                        Image(systemName: m.busy ? "arrow.down.circle" : "checkmark.circle").foregroundStyle(m.error.isEmpty ? Color.ok : .warn)
                        Text(m.error.isEmpty ? m.detail : m.error).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                    }
                }
            }
            if let free = model.disk?.free {
                let hours = free / 1_073_741_824 / 4
                Text("\(bytes(free)) free · about \(Int(hours)) person-hours of recording")
                    .font(.caption).foregroundStyle(hours < 3 ? Color.rec : .secondary)
            }
            if !model.lastError.isEmpty {
                Text(model.lastError).font(.caption).foregroundStyle(.rec).lineLimit(3)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 14))
    }
}

struct ShowRow: View {
    let room: Room
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(room.name).font(.body.weight(.medium))
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if room.recording == true {
                Image(systemName: "record.circle.fill").foregroundStyle(.rec).symbolEffect(.pulse)
            } else if let n = room.online?.count, n > 0 {
                Text("\(n)").font(.caption.bold()).padding(.horizontal, 6).padding(.vertical, 1).background(Color.ok.opacity(0.25), in: Capsule())
            }
        }
        .padding(.vertical, 2)
    }
    private var subtitle: String {
        let takes = room.takes ?? []
        if let online = room.online, !online.isEmpty { return "In the studio: " + online.joined(separator: ", ") }
        return takes.isEmpty ? "No recordings yet" : "\(takes.count) recording\(takes.count == 1 ? "" : "s")"
    }
}

struct NewShowSheet: View {
    @Binding var name: String
    var make: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("New Show").font(.title2.bold())
            Text("Each show has its own guest link, studio and recordings.").foregroundStyle(.secondary)
            TextField("Name", text: $name, prompt: Text("e.g. The Weekly"))
                .textFieldStyle(.roundedBorder)
                .onSubmit(go)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Make Show", action: go).buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(24)
        .frame(width: 420)
    }
    private func go() {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty else { return }
        make(n); dismiss()
    }
}
