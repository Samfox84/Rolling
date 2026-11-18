import SwiftUI

/// A show's takes: how each one is getting on, its levels, markers and files.
struct RecordingsList: View {
    @Environment(AppModel.self) private var model
    let room: Room

    var body: some View {
        let takes = room.takes ?? []
        if takes.isEmpty {
            ContentUnavailableView("No recordings yet", systemImage: "waveform",
                                   description: Text("Open the studio, then press Start Recording. Each take appears here, and its files a minute or two after you stop."))
        } else {
            ScrollView {
                LazyVStack(spacing: 14) {
                    ForEach(takes) { t in TakeCard(room: room, take: t) }
                }
                .padding(20)
            }
        }
    }
}

struct TakeCard: View {
    @Environment(AppModel.self) private var model
    let room: Room
    let take: Take
    @State private var showFiles = false
    @State private var showMarkers = false
    @State private var markers: [Marker] = []
    @State private var confirmDelete = false
    @State private var working = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(take.title).font(.title3.bold())
                if take.episode?.n != nil { Text("take \(take.n)").foregroundStyle(.secondary) }
                status
                Spacer()
                actions
            }
            Text(([when(take.started), take.length.map { clock($0) }, (take.people ?? []).joined(separator: ", ")].compactMap { $0 }.filter { !$0.isEmpty }).joined(separator: " · "))
                .foregroundStyle(.secondary)

            if take.isBusy && take.status != "recording" {
                ProgressView(value: min(1, (take.pct ?? 0) / 100)) {
                    Text(take.progress ?? (take.status == "waiting" ? "Waiting for everyone's uploads to finish…" : "In the queue…")).font(.callout)
                }
            }
            if let e = take.error, !e.isEmpty {
                Label(e, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.warn).font(.callout).textSelection(.enabled)
            }
            if !working.isEmpty { Text(working).font(.callout).foregroundStyle(.secondary) }
            copies
            transcript
            levels
            if !(take.markers ?? []).isEmpty {
                DisclosureGroup("Markers (\(take.markers?.count ?? 0))", isExpanded: $showMarkers) { markerEditor }
                    .onChange(of: showMarkers) { if showMarkers { markers = take.markers ?? [] } }
            }
            if let outs = take.outputs, !outs.isEmpty {
                DisclosureGroup("Files (\(outs.count) · \(bytes(take.totalSize ?? 0)))", isExpanded: $showFiles) { files(outs) }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .alert("Delete \(take.title)?", isPresented: $confirmDelete) {
            Button("Delete Take", role: .destructive) { Task { await model.takeAction(room, take, "delete") } }
            Button("Keep It", role: .cancel) {}
        } message: { Text("All its files are deleted from the studio. This can't be undone.") }
    }

    @ViewBuilder private var status: some View {
        switch take.status {
        case "recording": Pill(text: "Recording", color: .rec, systemImage: "record.circle")
        case "waiting": Pill(text: "Waiting for uploads", color: .warn)
        case "queued": Pill(text: "In the queue", color: .warn)
        case "processing": Pill(text: "Building files", color: .tone)
        case "ready": Pill(text: "Ready", color: .ok, systemImage: "checkmark")
        case "error": Pill(text: "Problem", color: .rec, systemImage: "exclamationmark.triangle")
        default: Pill(text: take.status.capitalized)
        }
    }

    // MARK: - backup and cloud

    @ViewBuilder private var copies: some View {
        if let b = take.backup {
            Label(b.ok == true ? "Backed up to \(b.path ?? "your backup drive")" : "Backup: \(b.error ?? "not done")",
                  systemImage: b.ok == true ? "externaldrive.badge.checkmark" : "externaldrive.badge.exclamationmark")
                .font(.callout).foregroundStyle(b.ok == true ? Color.secondary : .warn)
        }
        if let c = take.cloud {
            HStack {
                Label(c.busy == true ? "Uploading to the cloud…" : c.ok == true ? "In the cloud (\(c.dest ?? ""))" : "Cloud backup: \(c.error ?? "not done")",
                      systemImage: c.ok == true ? "icloud.and.arrow.up" : c.busy == true ? "arrow.up.circle" : "exclamationmark.icloud")
                    .font(.callout).foregroundStyle(c.ok == true || c.busy == true ? Color.secondary : .warn)
                if c.ok != true && c.busy != true && take.status == "ready" {
                    Button("Upload Again") { Task { await model.takeAction(room, take, "cloud") } }.controlSize(.small)
                }
            }
        }
    }

    @ViewBuilder private var transcript: some View {
        if let tx = take.transcript, take.status != "recording" {
            HStack {
                Image(systemName: "text.quote").foregroundStyle(.secondary)
                if tx.engine != true { Text("Transcript: the transcript engine isn't installed").foregroundStyle(.secondary) }
                else if tx.on != true { Text("Transcript: switched off in Settings").foregroundStyle(.secondary) }
                else if tx.hasFile == true { Text("Transcript ready — \(tx.lines ?? 0) lines") }
                else if take.isBusy { Text("Transcript: \(Int(tx.pct ?? 0))% so far").foregroundStyle(.secondary) }
                else { Text("No transcript yet").foregroundStyle(.secondary) }
                if tx.canMake == true && tx.hasFile != true && !take.isBusy {
                    Button("Make Transcript") { Task { working = "Making the transcript…"; await model.takeAction(room, take, "transcribe") } }.controlSize(.small)
                }
            }
            .font(.callout)
            ForEach(Array((tx.failed ?? []).enumerated()), id: \.offset) { _, f in
                Text("Transcript for \(f.who ?? "someone") failed: \(f.error ?? "")").font(.caption).foregroundStyle(.warn)
            }
        }
    }

    // MARK: - levels

    @ViewBuilder private var levels: some View {
        let rows = (take.levels ?? [:]).compactMap { k, v in v.map { (k, $0) } }.sorted { $0.0 < $1.0 }
        if !rows.isEmpty {
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 4) {
                GridRow {
                    Text("Levels (EBU R128)").font(.caption.bold())
                    Text("Loudness").font(.caption.bold())
                    Text("True peak").font(.caption.bold())
                    Text("").font(.caption)
                }
                .foregroundStyle(.secondary)
                ForEach(rows, id: \.0) { who, l in
                    GridRow {
                        Text(who)
                        Text("\(lufs(l.I)) LUFS").monospacedDigit().foregroundStyle(loudColor(l.I))
                        Text("\(lufs(l.TP)) dBTP").monospacedDigit()
                        Text(l.verdict?.text ?? "").foregroundStyle(l.verdict?.level == "good" ? Color.secondary : l.verdict?.level == "bad" ? .rec : .warn)
                    }
                    .font(.callout)
                }
            }
        }
    }

    // MARK: - markers

    private var markerEditor: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Used for chapters and in the session files.").font(.caption).foregroundStyle(.secondary)
            ForEach($markers) { $m in
                HStack {
                    Text(clock(m.at, hours: true)).monospacedDigit().foregroundStyle(.secondary).frame(width: 70, alignment: .leading)
                    TextField("Name", text: $m.label).textFieldStyle(.roundedBorder)
                    if let by = m.by, !by.isEmpty { Text(by).font(.caption).foregroundStyle(.secondary) }
                    Button(role: .destructive) { markers.removeAll { $0.id == m.id } } label: { Image(systemName: "trash") }.buttonStyle(.borderless)
                }
            }
            HStack {
                Spacer()
                Button("Save Markers") {
                    let list = markers.map { m -> [String: Any] in var d: [String: Any] = ["at": m.at, "label": m.label, "by": m.by ?? ""]; if let t = m.tag { d["tag"] = t }; return d }
                    Task { await model.takeAction(room, take, "markers", json: ["markers": list]); working = "Markers saved — updating the documents…" }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(.top, 6)
    }

    // MARK: - files

    private func localFile(_ o: Output) -> URL? {
        guard model.prefs.mode == .host else {
            // connected to a server: the copy saved on this Mac, if there is one
            let u = URL(fileURLWithPath: model.prefs.copiesFolder).appendingPathComponent(safeName(room.name)).appendingPathComponent(takeFolderName(take)).appendingPathComponent(o.file)
            return FileManager.default.fileExists(atPath: u.path) ? u : nil
        }
        let u = URL(fileURLWithPath: model.prefs.studioFolder).appendingPathComponent("rooms/\(room.id)/takes/\(take.id)/out/\(o.file)")
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }

    private func files(_ outs: [Output]) -> some View {
        let groups = Dictionary(grouping: outs, by: \.kind).sorted { order($0.key) < order($1.key) }
        return VStack(alignment: .leading, spacing: 10) {
            ForEach(groups, id: \.key) { kind, list in
                VStack(alignment: .leading, spacing: 4) {
                    Label(kindName(kind), systemImage: kindIcon(kind)).font(.caption.bold()).foregroundStyle(.secondary)
                    ForEach(list) { o in
                        HStack {
                            Text(o.file).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Text(bytes(o.size)).foregroundStyle(.secondary).monospacedDigit()
                            if let u = localFile(o) {
                                Button("Open") { NSWorkspace.shared.open(u) }.controlSize(.small)
                                Button { NSWorkspace.shared.activateFileViewerSelecting([u]) } label: { Image(systemName: "folder") }
                                    .controlSize(.small).help("Show in Finder")
                            } else {
                                Button("Download") { download("/dl/\(room.id)/\(take.id)/\(o.file.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? o.file)", name: o.file) }
                                    .controlSize(.small)
                            }
                        }
                        .font(.callout)
                    }
                }
            }
        }
        .padding(.top, 6)
    }

    private func order(_ k: String) -> Int {
        ["producermix", "audio", "cleaned", "mix", "video", "screen", "soundboard", "session", "transcript", "editlist", "chapters", "markers", "report", "normalised", "roomtone", "video-original"].firstIndex(of: k) ?? 99
    }

    private func download(_ path: String, name: String) {
        let p = NSSavePanel()
        p.nameFieldStringValue = name
        p.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        guard p.runModal() == .OK, let dest = p.url, let api = model.api else { return }
        working = "Saving \(name)…"
        Task {
            do { try await api.download(path, to: dest, key: room.hostKey); working = "Saved ✓ \(dest.lastPathComponent)"; NSWorkspace.shared.activateFileViewerSelecting([dest]) }
            catch { working = "Couldn't save it: \(error.localizedDescription)" }
        }
    }

    // MARK: - actions

    private var actions: some View {
        Menu {
            if let outs = take.outputs, !outs.isEmpty {
                Button("Download Everything (Zip)…") { download("/zip/\(room.id)/\(take.id)", name: "\(room.name) - \(take.title).zip") }
                if outs.contains(where: { $0.file.hasSuffix(".altaudio") }) {
                    Button("Download for Altered Audio Editor…") { download("/zip/\(room.id)/\(take.id)?for=altered", name: "\(room.name) - \(take.title) (Altered).zip") }
                }
                if model.prefs.mode == .host {
                    Button("Show Files in Finder") {
                        NSWorkspace.shared.open(URL(fileURLWithPath: model.prefs.studioFolder).appendingPathComponent("rooms/\(room.id)/takes/\(take.id)/out"))
                    }
                }
                Divider()
            }
            Button("Clean Again") { Task { working = "Cleaning again…"; await model.takeAction(room, take, "clean") } }
                .disabled(!["ready", "error"].contains(take.status))
            Button(take.compacted == true ? "Update Documents" : "Rebuild Files") { Task { working = "Rebuilding…"; await model.takeAction(room, take, "rebuild") } }
                .disabled(take.status == "recording")
            Menu("Free Up Space") {
                Button("Delete Camera Originals") { Task { await model.takeAction(room, take, "compact", json: ["what": "camera-originals"]) } }
                Button("Delete Rebuild Data") { Task { await model.takeAction(room, take, "compact", json: ["what": "rebuild-data"]) } }
            }
            .disabled(take.status != "ready")
            Divider()
            Button("Delete Take…", role: .destructive) { confirmDelete = true }
                .disabled(take.isBusy)
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .menuStyle(.button)
        .buttonStyle(.glass)
        .fixedSize()
    }
}
