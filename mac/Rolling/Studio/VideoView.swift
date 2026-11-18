import SwiftUI
import WebRTC

/// A live picture from the call (someone's camera or screen, or my own camera).
struct VideoView: NSViewRepresentable {
    let track: RTCVideoTrack?
    var mirror = false

    final class Holder: NSView {
        let video = RTCMTLNSVideoView(frame: .zero)
        var track: RTCVideoTrack?
        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            layer?.backgroundColor = NSColor.black.cgColor
            video.translatesAutoresizingMaskIntoConstraints = false
            addSubview(video)
            NSLayoutConstraint.activate([
                video.leadingAnchor.constraint(equalTo: leadingAnchor), video.trailingAnchor.constraint(equalTo: trailingAnchor),
                video.topAnchor.constraint(equalTo: topAnchor), video.bottomAnchor.constraint(equalTo: bottomAnchor),
            ])
        }
        required init?(coder: NSCoder) { nil }
        func show(_ t: RTCVideoTrack?, mirror: Bool) {
            if t !== track {
                track?.remove(video)
                track = t
                t?.add(video)
            }
        }
    }

    func makeNSView(context: Context) -> Holder { let h = Holder(frame: .zero); h.show(track, mirror: mirror); return h }
    func updateNSView(_ v: Holder, context: Context) { v.show(track, mirror: mirror) }
    static func dismantleNSView(_ v: Holder, coordinator: ()) { v.show(nil, mirror: false) }
}

/// A button that does something while it's held down (cough, talkback).
struct HoldButton<Label: View>: View {
    var down: () -> Void
    var up: () -> Void
    @ViewBuilder var label: () -> Label
    @State private var held = false
    var body: some View {
        label()
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(held ? AnyShapeStyle(Color.rec) : AnyShapeStyle(.fill.tertiary), in: Capsule())
            .foregroundStyle(held ? .white : .primary)
            .contentShape(Capsule())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { _ in if !held { held = true; down() } }
                .onEnded { _ in held = false; up() })
            .animation(.easeOut(duration: 0.1), value: held)
    }
}
