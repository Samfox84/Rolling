import SwiftUI

/// First run (or after "Stop hosting"): host the studio on this Mac, or connect to one on a server.
struct WelcomeView: View {
    @Environment(AppModel.self) private var model
    @State private var server = ""
    @State private var password = ""
    @State private var token = ""
    @State private var error = ""

    var body: some View {
        @Bindable var model = model
        ScrollView {
            VStack(spacing: 28) {
                VStack(spacing: 8) {
                    Image(systemName: "dot.radiowaves.left.and.right")
                        .font(.system(size: 44, weight: .semibold))
                        .foregroundStyle(.rec)
                    Text("Rolling").font(.largeTitle.bold())
                    Text("Your own remote recording studio. Guests click a link — nothing to install.")
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 30)

                HStack(alignment: .top, spacing: 20) {
                    hostCard($model.prefs)
                    connectCard($model.prefs)
                }
                .frame(maxWidth: 980)

                if !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.rec)
                }
            }
            .padding(30)
            .frame(maxWidth: .infinity)
        }
        .onAppear { server = model.prefs.server }
    }

    private func hostCard(_ prefs: Binding<Prefs>) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Host on this Mac", systemImage: "desktopcomputer").font(.title2.bold())
            Text("No server needed. Rolling runs the whole studio on this Mac and gives your guests an internet link. Keep the Mac awake and online during the show.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Form {
                LabeledContent("Studio folder") {
                    FolderField(path: prefs.studioFolder)
                }
                Picker("Guest link", selection: prefs.guestLink) {
                    Text("Free link (new address each time)").tag(Prefs.GuestLink.quick)
                    Text("My own address (Cloudflare)").tag(Prefs.GuestLink.own)
                }
                if prefs.wrappedValue.guestLink == .own {
                    TextField("Address", text: prefs.ownAddress, prompt: Text("podcast.example.com"))
                    TextField("Port", value: prefs.ownPort, format: .number.grouping(.never))
                    SecureField("Tunnel token", text: $token, prompt: Text(Keychain.get("tunnel-token") == nil ? "Paste from Cloudflare" : "Saved — paste to replace"))
                }
            }
            .formStyle(.columns)
            Spacer(minLength: 0)
            Button {
                error = ""
                if prefs.wrappedValue.guestLink == .own {
                    guard LocalStudio.cleanAddress(prefs.wrappedValue.ownAddress) != nil else { error = "Type your own address, like podcast.example.com"; return }
                    guard (1024...65535).contains(prefs.wrappedValue.ownPort) else { error = "The port must be a number from 1024 to 65535"; return }
                    let t = token.split(whereSeparator: \.isWhitespace).last(where: { $0.count >= 40 }).map(String.init) ?? token.trimmingCharacters(in: .whitespaces)
                    if !t.isEmpty { Keychain.set("tunnel-token", t) }
                    guard Keychain.get("tunnel-token") != nil else { error = "Paste your tunnel token from Cloudflare"; return }
                }
                Task { await model.startHosting() }
            } label: {
                Label("Start My Studio", systemImage: "play.fill").frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
        }
        .padding(22)
        .frame(maxWidth: .infinity, minHeight: 360, alignment: .topLeading)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
    }

    private func connectCard(_ prefs: Binding<Prefs>) -> some View {
        let isHostLink = AppModel.parseHostLink(server.trimmingCharacters(in: .whitespaces)) != nil
        return VStack(alignment: .leading, spacing: 14) {
            Label("Connect to a studio server", systemImage: "server.rack").font(.title2.bold())
            Text("Your studio runs on a server. Sign in with its admin password for every show — or paste one show's host link. Every recording is saved on this Mac too.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Form {
                TextField("Studio", text: $server, prompt: Text("podcast.example.com or a host link"))
                if !isHostLink {
                    SecureField("Admin password", text: $password, prompt: Text("The studio's admin password"))
                }
                Toggle("Save a copy of every recording on this Mac", isOn: prefs.saveCopies)
                if prefs.wrappedValue.saveCopies {
                    LabeledContent("Save in") { FolderField(path: prefs.copiesFolder) }
                }
            }
            .formStyle(.columns)
            Spacer(minLength: 0)
            Button {
                error = ""
                Task { await model.connect(to: server, password: password.isEmpty ? nil : password) }
            } label: {
                Label("Connect", systemImage: "link").frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
            .disabled(server.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(22)
        .frame(maxWidth: .infinity, minHeight: 360, alignment: .topLeading)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
    }
}

/// A folder path with a Choose… button.
struct FolderField: View {
    @Binding var path: String
    var body: some View {
        HStack {
            Text((path as NSString).abbreviatingWithTildeInPath)
                .lineLimit(1).truncationMode(.middle)
                .foregroundStyle(.secondary)
            Spacer()
            Button("Choose…") {
                let p = NSOpenPanel()
                p.canChooseDirectories = true; p.canChooseFiles = false; p.canCreateDirectories = true
                p.directoryURL = URL(fileURLWithPath: path).deletingLastPathComponent()
                if p.runModal() == .OK, let u = p.url { path = u.path }
            }
        }
    }
}
