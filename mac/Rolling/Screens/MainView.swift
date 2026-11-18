import SwiftUI

/// The main window: how you use Rolling (first time), then your shows and their recordings.
struct MainView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            switch model.phase {
            case .welcome:
                WelcomeView()
            case .starting(let what):
                VStack(spacing: 14) {
                    ProgressView().controlSize(.large)
                    Text(what).font(.title3)
                    if model.prefs.mode == .host { Text("Getting it ready on this Mac, then a link for your guests.").foregroundStyle(.secondary) }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let why):
                ContentUnavailableView {
                    Label(model.prefs.mode == .host ? "Your studio didn't start" : "Couldn't connect", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(why).textSelection(.enabled)
                } actions: {
                    Button("Try Again") { model.resume(again: true) }.buttonStyle(.glassProminent)
                    Button("Choose Another Way") { Task { await model.signOut() } }.buttonStyle(.glass)
                }
            case .ready:
                ShowsSplitView()
            }
        }
        .task { model.resume() }
    }
}
