import AVFoundation
import AudioToolbox
import os
import WebRTC

/// The studio's sound, between this Mac and the call:
///
///   microphone ─┬─ the lossless recording (24-bit, 48 kHz, untouched)
///               ├─ my loudness meter
///               └─ + soundboard ──► the call (everyone hears it)
///   the call (everyone, by Console fader) + soundboard ──► my headphones, and the programme meter
///
/// libwebrtc mixes the people in the call; this class is its "audio device", so the soundboard can be added to what
/// goes out, and what comes in can be metered. Runs on the audio threads: no waiting on locks, no allocating.
final class StudioAudio: NSObject, RTCAudioDevice, @unchecked Sendable {
    static let rate = 48_000.0
    static let chunk = 480                            // 10 ms, what libwebrtc works in

    /// Settings the UI changes, read by the audio threads.
    struct Controls {
        var micToCall = true                          // false in the control room (unless talking) or with the mic off
        var monitor: Float = 1                        // headphone level
        var recordMic = false                         // the lossless recording is running
    }
    /// What the meters show, written by the audio threads.
    struct Meters {
        var micPeak: Float = 0
        var programmePeak: Float = 0
        var limiting = false
        var mic = LoudnessMeter()
        var programme = LoudnessMeter()
        var micSilentFor: Double = 0                  // seconds of digital silence from the mic
        var glitches = 0
    }

    let controls = OSAllocatedUnfairLock(initialState: Controls())
    let meters = OSAllocatedUnfairLock(initialState: Meters())
    let board: Board
    /// Microphone sound for the recorder (48 kHz mono, on the audio thread).
    var onMic: ((UnsafeBufferPointer<Float>) -> Void)?
    /// Problems starting a device, in words.
    private(set) var problems: [String] = []

    private var delegate: (any RTCAudioDeviceDelegate)?
    private let inEngine = AVAudioEngine()
    private let outEngine = AVAudioEngine()
    private var sink: AVAudioSinkNode?
    private var source: AVAudioSourceNode?
    private var fallbackTimer: DispatchSourceTimer?
    private var micUID = "", outUID = ""
    private var webrtcRecording = false, webrtcPlaying = false
    private var inputRunning = false, outputRunning = false

    // audio-thread buffers (made once)
    private var micBuf = [Float](repeating: 0, count: 480)
    private var micFill = 0
    private var resampler = Resampler(from: 48_000, to: 48_000)
    private var sendI16 = [Int16](repeating: 0, count: 480)
    private var boardL = [Float](repeating: 0, count: 480)
    private var boardR = [Float](repeating: 0, count: 480)
    private var playI16 = [Int16](repeating: 0, count: 4096)
    private let monitorRing = Ring(capacity: 48_000)  // soundboard for my headphones (stereo interleaved)
    private var cached = Controls()
    private var localMeters = Meters()

    init(board: Board) {
        self.board = board
        super.init()
    }

    // MARK: - choosing devices, starting and stopping

    /// Starts the microphone and headphones (call when going into the studio, and when the devices change).
    func start(mic: String, output: String) {
        micUID = mic; outUID = output
        problems = []
        startInput()
        startOutput()
    }

    func stop() {
        fallbackTimer?.cancel(); fallbackTimer = nil
        if inputRunning { inEngine.stop(); inputRunning = false }
        if outputRunning { outEngine.stop(); outputRunning = false }
        if let s = sink { inEngine.detach(s); sink = nil }
        if let s = source { outEngine.detach(s); source = nil }
    }

    private func use(_ uid: String, on unit: AudioUnit?, input: Bool) {
        guard let unit, var dev = Devices.audioID(uid, input: input) else { return }
        AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioDeviceID>.size))
    }

    private func startInput() {
        if inputRunning { inEngine.stop(); inputRunning = false }
        if let s = sink { inEngine.detach(s); sink = nil }
        fallbackTimer?.cancel(); fallbackTimer = nil
        let granted = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        guard granted, Devices.defaultDevice(input: true) != nil || !micUID.isEmpty else {
            if !granted { problems.append("Rolling isn't allowed to use the microphone — allow it in System Settings › Privacy & Security › Microphone.") }
            startClock(); return
        }
        use(micUID, on: inEngine.inputNode.audioUnit, input: true)
        let fmt = inEngine.inputNode.outputFormat(forBus: 0)
        guard fmt.sampleRate > 0, fmt.channelCount > 0 else { problems.append("The microphone couldn't start."); startClock(); return }
        resampler = Resampler(from: fmt.sampleRate, to: Self.rate)
        let s = AVAudioSinkNode { [weak self] _, frames, abl in
            self?.captured(abl, frames: Int(frames))
            return noErr
        }
        inEngine.attach(s)
        inEngine.connect(inEngine.inputNode, to: s, format: fmt)
        sink = s
        do { try inEngine.start(); inputRunning = true }
        catch { problems.append("The microphone couldn't start: \(error.localizedDescription)"); startClock() }
    }

    /// No microphone: a steady clock still sends the soundboard (and silence) to the call.
    private func startClock() {
        let t = DispatchSource.makeTimerSource(flags: .strict, queue: DispatchQueue(label: "rolling.audio.clock", qos: .userInteractive))
        t.schedule(deadline: .now(), repeating: .milliseconds(10), leeway: .milliseconds(1))
        t.setEventHandler { [weak self] in
            guard let self else { return }
            for i in 0..<Self.chunk { self.micBuf[i] = 0 }
            self.processChunk(fromMic: false)
        }
        t.resume()
        fallbackTimer = t
    }

    private func startOutput() {
        if outputRunning { outEngine.stop(); outputRunning = false }
        if let s = source { outEngine.detach(s); source = nil }
        use(outUID, on: outEngine.outputNode.audioUnit, input: false)
        guard let fmt = AVAudioFormat(standardFormatWithSampleRate: Self.rate, channels: 2) else { return }
        let s = AVAudioSourceNode(format: fmt) { [weak self] _, _, frames, abl -> OSStatus in
            self?.render(abl, frames: Int(frames))
            return noErr
        }
        outEngine.attach(s)
        outEngine.connect(s, to: outEngine.mainMixerNode, format: fmt)
        source = s
        do { try outEngine.start(); outputRunning = true }
        catch { problems.append("The headphones couldn't start: \(error.localizedDescription)") }
    }

    // MARK: - the microphone (audio thread)

    private func captured(_ abl: UnsafePointer<AudioBufferList>, frames: Int) {
        let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: abl))
        guard let first = list.first, let data = first.mData else { return }
        // the first channel (a mono mic, or the left of a stereo interface)
        let p = data.assumingMemoryBound(to: Float.self)
        let stride = Int(first.mNumberChannels)
        if stride == 1 {
            let buf = UnsafeBufferPointer(start: p, count: frames)
            resampler.run(buf) { add($0) }
        } else {
            for i in 0..<frames { resamplerOne(p[i * stride]) }
        }
        func add(_ x: Float) {
            micBuf[micFill] = x; micFill += 1
            if micFill == Self.chunk { micFill = 0; processChunk(fromMic: true) }
        }
    }
    private var single = [Float](repeating: 0, count: 1)
    private func resamplerOne(_ x: Float) {
        single[0] = x
        single.withUnsafeBufferPointer { b in
            resampler.run(b) { v in
                micBuf[micFill] = v; micFill += 1
                if micFill == Self.chunk { micFill = 0; processChunk(fromMic: true) }
            }
        }
    }

    /// 10 ms of microphone: meter it, record it, add the soundboard, send it to the call.
    private func processChunk(fromMic: Bool) {
        if let c = controls.withLockIfAvailable({ $0 }) { cached = c }
        let n = Self.chunk
        var peak: Float = 0
        var silent = true
        if fromMic {
            for i in 0..<n {
                let x = micBuf[i]
                localMeters.mic.push(x)
                let a = abs(x); if a > peak { peak = a }
                if x != 0 { silent = false }
            }
            if cached.recordMic { micBuf.withUnsafeBufferPointer { onMic?($0) } }
        }
        // the soundboard: into the call, and kept for my headphones
        board.render(frames: n, left: &boardL, right: &boardR)
        monitorRing.write(left: boardL, right: boardR, count: n)
        let micOn = cached.micToCall && fromMic
        for i in 0..<n {
            let v = (micOn ? micBuf[i] : 0) + (boardL[i] + boardR[i]) * 0.5
            sendI16[i] = Int16(max(-1, min(1, v)) * 32767)
        }
        localMeters.micPeak = max(localMeters.micPeak, peak)
        if fromMic { localMeters.micSilentFor = silent ? localMeters.micSilentFor + 0.01 : 0 }
        let snapshot = localMeters
        meters.withLockIfAvailable { m in
            m.micPeak = max(m.micPeak, snapshot.micPeak); m.mic = snapshot.mic; m.micSilentFor = snapshot.micSilentFor
        }
        localMeters.micPeak = 0
        guard webrtcRecording, let d = delegate else { return }
        sendI16.withUnsafeMutableBytes { raw in
            var abl = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(n * 2), mData: raw.baseAddress))
            var flags = AudioUnitRenderActionFlags()
            var ts = AudioTimeStamp()
            ts.mSampleTime = Double(sampleCount); ts.mFlags = .sampleTimeValid
            sampleCount += Int64(n)
            _ = d.deliverRecordedData(&flags, &ts, 0, UInt32(n), &abl, nil, nil)
        }
    }
    private var sampleCount: Int64 = 0

    // MARK: - my headphones (audio thread)

    private func render(_ abl: UnsafeMutablePointer<AudioBufferList>, frames: Int) {
        let list = UnsafeMutableAudioBufferListPointer(abl)
        guard list.count >= 2, let lp = list[0].mData?.assumingMemoryBound(to: Float.self),
              let rp = list[1].mData?.assumingMemoryBound(to: Float.self) else { return }
        if let c = controls.withLockIfAvailable({ $0 }) { cached = c }
        // everyone in the call, as libwebrtc mixes them (each at their Console fader)
        var haveCall = false
        if webrtcPlaying, let d = delegate, frames <= playI16.count {
            playI16.withUnsafeMutableBytes { raw in
                var out = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(frames * 2), mData: raw.baseAddress))
                var flags = AudioUnitRenderActionFlags()
                var ts = AudioTimeStamp()
                haveCall = d.getPlayoutData(&flags, &ts, 0, UInt32(frames), &out) == noErr
            }
        }
        var peak: Float = 0
        var limiting = false
        for i in 0..<frames {
            let call: Float = haveCall ? Float(playI16[i]) / 32768 : 0
            var bl: Float = 0, br: Float = 0
            monitorRing.read(&bl, &br)
            let prog = call + (bl + br) * 0.5
            localMeters.programme.push(prog)
            let a = abs(prog); if a > peak { peak = a }
            var l = (call + bl) * cached.monitor, r = (call + br) * cached.monitor
            if abs(l) > 0.98 || abs(r) > 0.98 { limiting = true; l = max(-0.98, min(0.98, l)); r = max(-0.98, min(0.98, r)) }
            lp[i] = l; rp[i] = r
        }
        let prog = localMeters.programme
        meters.withLockIfAvailable { m in
            m.programmePeak = max(m.programmePeak, peak); m.programme = prog; m.limiting = m.limiting || limiting
        }
    }

    func resetProgrammeMeter() {
        localMeters.programme.reset()
        meters.withLock { $0.programme.reset() }
    }

    // MARK: - RTCAudioDevice (what libwebrtc asks of its audio device)

    var deviceInputSampleRate: Double { Self.rate }
    var inputIOBufferDuration: TimeInterval { 0.01 }
    var inputNumberOfChannels: Int { 1 }
    var inputLatency: TimeInterval { 0.01 }
    var deviceOutputSampleRate: Double { Self.rate }
    var outputIOBufferDuration: TimeInterval { 0.01 }
    var outputNumberOfChannels: Int { 1 }
    var outputLatency: TimeInterval { 0.02 }
    var isInitialized: Bool { delegate != nil }

    func initialize(with delegate: any RTCAudioDeviceDelegate) -> Bool { self.delegate = delegate; return true }
    func terminateDevice() -> Bool { webrtcRecording = false; webrtcPlaying = false; delegate = nil; return true }
    var isPlayoutInitialized: Bool { true }
    func initializePlayout() -> Bool { true }
    var isPlaying: Bool { webrtcPlaying }
    func startPlayout() -> Bool { webrtcPlaying = true; return true }
    func stopPlayout() -> Bool { webrtcPlaying = false; return true }
    var isRecordingInitialized: Bool { true }
    func initializeRecording() -> Bool { true }
    var isRecording: Bool { webrtcRecording }
    func startRecording() -> Bool { webrtcRecording = true; return true }
    func stopRecording() -> Bool { webrtcRecording = false; return true }
}

/// Stereo sound passed from one audio thread to another (soundboard → headphones). Single writer, single reader.
final class Ring: @unchecked Sendable {
    private var buf: [Float]
    private let cap: Int
    private var w = 0, r = 0
    init(capacity: Int) { cap = capacity; buf = [Float](repeating: 0, count: capacity * 2) }
    func write(left: [Float], right: [Float], count: Int) {
        for i in 0..<count {
            buf[(w % cap) * 2] = left[i]; buf[(w % cap) * 2 + 1] = right[i]
            w += 1
        }
        if w - r > cap { r = w - cap }               // the reader fell behind: drop the oldest
    }
    func read(_ l: inout Float, _ rr: inout Float) {
        // keep about 20 ms in hand so the two clocks can drift a little
        if w - r <= 0 { l = 0; rr = 0; return }
        if w - r > 4800 { r = w - 960 }
        l = buf[(r % cap) * 2]; rr = buf[(r % cap) * 2 + 1]
        r += 1
    }
}
