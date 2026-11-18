import AppKit
import SwiftUI

@main
struct RollingApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()

    var body: some Scene {
        Window("Rolling", id: "main") {
            MainView()
                .environment(model)
                .frame(minWidth: 960, minHeight: 620)
                .onAppear { delegate.model = model }
        }
        .defaultSize(width: 1180, height: 780)
        .commands { RollingCommands(model: model) }

        WindowGroup("Studio", id: "studio", for: String.self) { $roomId in
            StudioWindow(roomId: roomId ?? "")
                .environment(model)
                .frame(minWidth: 1100, minHeight: 680)
        }
        .defaultSize(width: 1440, height: 900)
        .windowToolbarStyle(.unified(showsTitle: false))

        WindowGroup("Big Clock", id: "clock", for: String.self) { $roomId in
            BigClockWindow(roomId: roomId ?? "")
                .environment(model)
        }
        .defaultSize(width: 720, height: 300)
        .windowStyle(.hiddenTitleBar)

        Settings {
            SettingsView()
                .environment(model)
        }
    }
}

/// Never cut a show off by quitting too early.
final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor var model: AppModel?

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Task { @MainActor in
            guard let model = self.model else { NSApp.reply(toApplicationShouldTerminate: true); return }
            let why = await model.busyReason() ?? ""
            if why.isEmpty && !model.hosting {
                model.stopEverything(); NSApp.reply(toApplicationShouldTerminate: true); return
            }
            let a = NSAlert()
            a.alertStyle = why.isEmpty ? .informational : .warning
            a.messageText = why.isEmpty ? "Stop hosting your studio?" : why
            a.informativeText = model.hosting ? "Quitting Rolling stops your studio: everyone is disconnected and guests can't join."
                                              : "If you quit now, the copy on this Mac stops part-way. The studio server still has everything."
            a.addButton(withTitle: model.hosting ? "Keep the studio running" : "Keep saving")
            a.addButton(withTitle: model.hosting ? "Quit and stop the studio" : "Quit anyway")
            let quit = a.runModal() == .alertSecondButtonReturn
            if quit { model.stopEverything() }
            NSApp.reply(toApplicationShouldTerminate: quit)
        }
        return .terminateLater
    }
}

struct RollingCommands: Commands {
    let model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(after: .newItem) {
            Button("Refresh") { Task { await model.refresh() } }
                .keyboardShortcut("r", modifiers: [.command])
            Divider()
            Button("Show the Studio Folder") {
                NSWorkspace.shared.open(URL(fileURLWithPath: model.prefs.mode == .host ? model.prefs.studioFolder : model.prefs.copiesFolder))
            }
            Button("Show the Studio's Diary") { NSWorkspace.shared.activateFileViewerSelecting([LocalStudio.logFile]) }
                .disabled(model.prefs.mode != .host)
            Divider()
            Button(model.prefs.mode == .host ? "Stop Hosting…" : "Disconnect…") { Task { await model.signOut() } }
                .disabled(model.prefs.mode == .none)
        }
        CommandGroup(replacing: .help) {
            Button("Rolling on GitHub") { NSWorkspace.shared.open(URL(string: "https://github.com/Samfox84/Rolling")!) }
            Button("What's New in the Studio") { NSWorkspace.shared.open(URL(string: "https://github.com/Samfox84/Rolling/blob/main/CHANGELOG.md")!) }
        }
    }
}
