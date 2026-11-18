import AVFoundation
import WebRTC

/// This Mac's side of the call: the WebRTC engine, its sound (StudioAudio) and the camera.
final class Media: @unchecked Sendable {
    let factory: RTCPeerConnectionFactory
    let audio: StudioAudio
    let board = Board()
    let audioSource: RTCAudioSource
    private(set) var videoSource: RTCVideoSource?
    private(set) var camera: RTCVideoTrack?
    private var capturer: RTCCameraVideoCapturer?
    /// The ids guests use to tell my camera and voice from my talkback channel.
    let tag = String(UInt64.random(in: 0..<UInt64.max), radix: 36)
    var streamId: String { "rolling-\(tag)" }
    var talkStreamId: String { "rolling-talk-\(tag)" }
    private(set) var cameraProblem: String?

    private static let once: Void = { RTCInitializeSSL() }()

    init() {
        _ = Self.once
        audio = StudioAudio(board: board)
        factory = RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory(), audioDevice: audio)
        // the live call only: the recording is the untouched microphone
        let c = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        audioSource = factory.audioSource(with: c)
    }

    /// A sound track to one person (each person gets their own, so talkback can go to just one).
    func audioTrack(_ label: String) -> RTCAudioTrack {
        factory.audioTrack(with: audioSource, trackId: "\(label)-\(UInt32.random(in: 0..<UInt32.max))")
    }

    // MARK: - camera

    func startCamera(_ id: String, fps: Double) async -> RTCVideoTrack? {
        stopCamera()
        cameraProblem = nil
        guard id != "off" else { return nil }
        let ok = await AVCaptureDevice.requestAccess(for: .video)
        guard ok else { cameraProblem = "Rolling isn't allowed to use the camera — allow it in System Settings › Privacy & Security › Camera."; return nil }
        guard let dev = Devices.camera(id) else { cameraProblem = "No camera found."; return nil }
        let src = factory.videoSource()
        let cap = RTCCameraVideoCapturer(delegate: src)
        // 720p if it can, else the nearest
        let formats = RTCCameraVideoCapturer.supportedFormats(for: dev)
        let want = 1280 * 720
        guard let format = formats.min(by: { a, b in
            let da = CMVideoFormatDescriptionGetDimensions(a.formatDescription), db = CMVideoFormatDescriptionGetDimensions(b.formatDescription)
            return abs(Int(da.width) * Int(da.height) - want) < abs(Int(db.width) * Int(db.height) - want)
        }) else { cameraProblem = "The camera has no picture format Rolling can use."; return nil }
        let maxFps = format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 30
        do {
            try await cap.startCapture(with: dev, format: format, fps: Int(min(fps, maxFps)))
        } catch {
            cameraProblem = "The camera couldn't start: \(error.localizedDescription)"
            return nil
        }
        let t = factory.videoTrack(with: src, trackId: "cam-\(tag)")
        videoSource = src; capturer = cap; camera = t
        return t
    }

    func stopCamera() {
        capturer?.stopCapture()
        capturer = nil; camera = nil; videoSource = nil
    }

    func close() {
        stopCamera()
        audio.stop()
    }
}
