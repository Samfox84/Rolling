import AVFoundation
import os
import WebRTC

/// The host's own recording, exactly as a guest's browser makes it: lossless 24-bit sound from this Mac's
/// microphone in one-second pieces stamped with studio time, and the camera as an MP4 made on this Mac — both sent
/// to the studio as they're made, so the take lines everyone up. The studio is told this part is complete once
/// the last piece of both is in.
final class Recorder: NSObject, @unchecked Sendable {
    struct Seg { var seg: String; var take: String; var tok: String; var samples = 0; var stopping = false }

    private let base: URL
    private let room: String
    private let lock = OSAllocatedUnfairLock(initialState: (cur: Seg?.none, buf: [Float](), bufT: 0.0))
    private let uploader = Uploader()
    /// Studio time now (ms) — set by the session.
    var serverNow: @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }
    private var video: CameraRecording?

    init(base: URL, room: String) {
        self.base = base; self.room = room
    }

    var current: String? { lock.withLock { $0.cur.flatMap { $0.stopping ? nil : $0.seg } } }
    func current(forTake take: String) -> String? { lock.withLock { $0.cur.flatMap { $0.take == take ? $0.seg : nil } } }

    /// The studio asked this Mac to record (a record-start message).
    func start(take: String, seg: String, tok: String, camera: RTCVideoTrack?, fps: Double) {
        if current == seg { return }
        if let old = current { stop(seg: old) }
        uploader.saved = false
        lock.withLock { $0.cur = Seg(seg: seg, take: take, tok: tok); $0.buf = []; $0.bufT = 0 }
        if let camera {
            let url = upURL(take: take, seg: seg, tok: tok, kind: "video") + "&mime=video%2Fmp4"
            video = CameraRecording(track: camera, fps: fps, serverNow: serverNow) { [uploader] i, st, data in
                uploader.add(url: url + "&i=\(i)&st=\(String(format: "%.1f", st))", body: data)
            }
        }
    }

    private func upURL(take: String, seg: String, tok: String, kind: String) -> String {
        base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/up/\(room)/\(take)/\(seg)/\(kind)?tok=\(tok)"
    }

    /// Microphone sound (48 kHz mono) as it arrives — on the audio thread.
    func push(_ samples: UnsafeBufferPointer<Float>) {
        var full: (Seg, [Float], Double)?
        lock.withLock { s in
            guard let c = s.cur, !c.stopping else { return }
            if s.buf.isEmpty { s.bufT = serverNow() - Double(samples.count) * 1000 / StudioAudio.rate }
            s.buf.append(contentsOf: samples)
            if s.buf.count >= Int(StudioAudio.rate) {
                full = (c, s.buf, s.bufT)
                s.cur?.samples += s.buf.count
                s.buf.removeAll(keepingCapacity: true)
            }
        }
        if let (c, buf, t) = full { send(c, buf, t) }
    }

    private func send(_ c: Seg, _ buf: [Float], _ t: Double) {
        var body = Data(count: buf.count * 3)
        body.withUnsafeMutableBytes { raw in
            guard let p = raw.bindMemory(to: UInt8.self).baseAddress else { return }
            for (i, v) in buf.enumerated() {
                let x = Double(max(-1, min(1, v)))
                let n = Int32((x < 0 ? x * 8_388_608 : x * 8_388_607).rounded())
                p[i * 3] = UInt8(truncatingIfNeeded: n); p[i * 3 + 1] = UInt8(truncatingIfNeeded: n >> 8); p[i * 3 + 2] = UInt8(truncatingIfNeeded: n >> 16)
            }
        }
        let url = upURL(take: c.take, seg: c.seg, tok: c.tok, kind: "audio") + "&s=\(c.samples)&t=\(String(format: "%.1f", t))&rate=48000"
        uploader.add(url: url, body: body)
    }

    /// Stop: send what's left, then (once the camera file is finished too) tell the studio this part is complete.
    func stop(seg: String) {
        var ending: (Seg, [Float], Double)?
        lock.withLock { s in
            guard let c = s.cur, c.seg == seg else { return }
            ending = (c, s.buf, s.bufT)
            s.cur = nil; s.buf = []
        }
        guard let (c, buf, t) = ending else { return }
        if !buf.isEmpty { send(c, buf, t) }
        let v = video; video = nil
        let done = upURL(take: c.take, seg: c.seg, tok: c.tok, kind: "done")
        Task {
            await v?.finish()
            self.uploader.add(url: done, body: nil)
        }
    }

    /// For my state report: ("recording" / "uploading" / "saved" / "", bytes still to send).
    func report() -> (String, Int) {
        let pending = uploader.pending
        if current != nil { return ("recording", pending) }
        if pending > 0 { return ("uploading", pending) }
        return (uploader.saved ? "saved" : "", 0)
    }
}

/// Sends pieces to the studio one after another, trying again until it has them.
final class Uploader: @unchecked Sendable {
    private let q = OSAllocatedUnfairLock(initialState: [(String, Data?)]())
    private let busy = OSAllocatedUnfairLock(initialState: false)
    private let bytes = OSAllocatedUnfairLock(initialState: 0)
    private let savedFlag = OSAllocatedUnfairLock(initialState: false)
    var pending: Int { bytes.withLock { $0 } }
    var saved: Bool { get { savedFlag.withLock { $0 } } set { savedFlag.withLock { $0 = newValue } } }
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 60
        return URLSession(configuration: c)
    }()

    func add(url: String, body: Data?) {
        bytes.withLock { $0 += body?.count ?? 0 }
        q.withLock { $0.append((url, body)) }
        let start = busy.withLock { b -> Bool in if b { return false }; b = true; return true }
        if start { Task.detached { await self.run() } }
    }

    private func run() async {
        while true {
            guard let (url, body) = q.withLock({ $0.isEmpty ? nil : $0.removeFirst() }) else {
                busy.withLock { $0 = false }
                // something may have arrived just as we stopped
                if q.withLock({ !$0.isEmpty }), busy.withLock({ b -> Bool in if b { return false }; b = true; return true }) { continue }
                return
            }
            var wait: UInt64 = 1
            while let u = URL(string: url) {
                var req = URLRequest(url: u)
                req.httpMethod = "POST"
                req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
                req.httpBody = body ?? Data()
                if let (_, r) = try? await session.data(for: req), let code = (r as? HTTPURLResponse)?.statusCode {
                    if (200..<300).contains(code) || (400..<500).contains(code) { break }   // done, or refused for good (take deleted)
                }
                try? await Task.sleep(for: .seconds(Double(wait)))
                wait = min(30, wait * 2)
            }
            bytes.withLock { $0 = max(0, $0 - (body?.count ?? 0)) }
            if body == nil { saved = true }
        }
    }
}

/// The camera, recorded on this Mac as an MP4 in pieces (fragmented MP4: the first piece describes the file, each
/// next one holds two seconds of pictures; joined in order they're a normal MP4 file).
final class CameraRecording: NSObject, RTCVideoRenderer, AVAssetWriterDelegate, @unchecked Sendable {
    private let track: RTCVideoTrack
    private let fps: Double
    private let serverNow: @Sendable () -> Double
    private let onPiece: @Sendable (Int, Double, Data) -> Void
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var firstNs: Int64 = -1
    private var startStudio: Double = 0
    private var index = 0
    private var lastNs: Int64 = 0
    private let q = DispatchQueue(label: "rolling.camera.rec")
    private var finished = false

    init(track: RTCVideoTrack, fps: Double, serverNow: @escaping @Sendable () -> Double, onPiece: @escaping @Sendable (Int, Double, Data) -> Void) {
        self.track = track; self.fps = fps; self.serverNow = serverNow; self.onPiece = onPiece
        super.init()
        track.add(self)
    }

    func setSize(_ size: CGSize) {}

    func renderFrame(_ frame: RTCVideoFrame?) {
        guard let frame, let buf = frame.buffer as? RTCCVPixelBuffer else { return }
        let pb = buf.pixelBuffer
        let ns = frame.timeStampNs
        q.async { [self] in
            guard !finished else { return }
            if writer == nil { setUp(width: CVPixelBufferGetWidth(pb), height: CVPixelBufferGetHeight(pb)) }
            guard let input, let adaptor, input.isReadyForMoreMediaData else { return }
            if firstNs < 0 {
                firstNs = ns; startStudio = serverNow()
                writer?.startSession(atSourceTime: .zero)
            }
            if ns - lastNs < Int64(1e9 / fps) - 3_000_000 && lastNs != 0 { return }   // at most the studio's frame rate
            lastNs = ns
            adaptor.append(pb, withPresentationTime: CMTime(value: ns - firstNs, timescale: 1_000_000_000))
        }
    }

    private func setUp(width: Int, height: Int) {
        let w = AVAssetWriter(contentType: .mpeg4Movie)
        w.outputFileTypeProfile = .mpeg4AppleHLS
        w.preferredOutputSegmentInterval = CMTime(seconds: 2, preferredTimescale: 1)
        w.initialSegmentStartTime = .zero
        w.delegate = self
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width, AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: width >= 1280 ? 6_000_000 : 3_000_000,
                AVVideoMaxKeyFrameIntervalDurationKey: 2,
                AVVideoExpectedSourceFrameRateKey: fps,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ]
        let i = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        i.expectsMediaDataInRealTime = true
        guard w.canAdd(i) else { finished = true; return }
        w.add(i)
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: i, sourcePixelBufferAttributes: nil)
        w.startWriting()
        writer = w; input = i
    }

    func assetWriter(_ writer: AVAssetWriter, didOutputSegmentData segmentData: Data, segmentType: AVAssetSegmentType, segmentReport: AVAssetSegmentReport?) {
        let i = index; index += 1
        onPiece(i, startStudio, segmentData)
    }

    /// Finish the file (its last piece is sent before this returns).
    func finish() async {
        track.remove(self)
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            q.async { [self] in
                finished = true
                guard let writer, writer.status == .writing else { c.resume(); return }
                input?.markAsFinished()
                writer.finishWriting { c.resume() }
            }
        }
    }
}
