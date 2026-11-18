import AVFoundation
import os

/// The soundboard: up to 24 pads (jingles, music beds, effects) played live. Everyone hears them — they go into the
/// call with the host's sound — and the studio is told when each starts and stops, so the take's Soundboard track
/// matches what was heard.
final class Board: @unchecked Sendable {
    struct Sound { var left: [Float]; var right: [Float] }
    struct Playing {
        var inst: String
        var pad: Pad
        var pos = 0
        var gain: Float
        var fade: Float = 1          // 1 → 0 when stopping
        var stopping = false
    }

    private let state = OSAllocatedUnfairLock(initialState: [Playing]())
    private let sounds = OSAllocatedUnfairLock(initialState: [String: Sound]())
    private let mix = OSAllocatedUnfairLock(initialState: (level: Float(1), duck: true, talking: false))
    private var bedGain: Float = 1

    /// What's playing, for the pads' lights (pad id → progress 0…1).
    func progress() -> [String: Double] {
        state.withLock { list in
            var d: [String: Double] = [:]
            for p in list where !p.stopping { if let s = sounds.withLock({ $0[p.pad.id] }) { d[p.pad.id] = Double(p.pos) / Double(max(1, s.left.count)) } }
            return d
        }
    }

    func setLevel(_ db: Double, duck: Bool) { mix.withLock { $0.level = Float(dbToGain(db)); $0.duck = duck } }
    func setTalking(_ on: Bool) { mix.withLock { $0.talking = on } }

    /// Fetch and decode a pad (once).
    func load(_ pad: Pad, api: StudioAPI, room: Room) async throws {
        let key = pad.id + "/" + String(pad.dur ?? 0)
        if sounds.withLock({ $0[key] != nil }) { return }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("rolling-pad-\(pad.id).wav")
        try await api.download("/api/rooms/\(room.id)/sounds/\(pad.id)", to: tmp, key: room.hostKey)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let f = try AVAudioFile(forReading: tmp)
        guard let target = AVAudioFormat(standardFormatWithSampleRate: StudioAudio.rate, channels: 2),
              let inBuf = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(f.length)) else { throw StudioError(message: "couldn't read \(pad.name)") }
        try f.read(into: inBuf)
        var out = inBuf
        if f.processingFormat != target {
            guard let conv = AVAudioConverter(from: f.processingFormat, to: target),
                  let o = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(Double(f.length) * StudioAudio.rate / f.processingFormat.sampleRate) + 4096) else { throw StudioError(message: "couldn't read \(pad.name)") }
            var given = false
            var err: NSError?
            conv.convert(to: o, error: &err) { _, status in
                if given { status.pointee = .endOfStream; return nil }
                given = true; status.pointee = .haveData; return inBuf
            }
            if let err { throw err }
            out = o
        }
        let n = Int(out.frameLength)
        guard let ch = out.floatChannelData else { throw StudioError(message: "couldn't read \(pad.name)") }
        let l = Array(UnsafeBufferPointer(start: ch[0], count: n))
        let r = out.format.channelCount > 1 ? Array(UnsafeBufferPointer(start: ch[1], count: n)) : l
        sounds.withLock { $0[key] = Sound(left: l, right: r); $0[pad.id] = Sound(left: l, right: r) }
    }

    func isLoaded(_ pad: Pad) -> Bool { sounds.withLock { $0[pad.id] != nil } }

    /// Starts a pad; returns its instance id. Jingles and beds already playing stop instead (returns nil).
    func press(_ pad: Pad) -> (started: String?, stopped: [String]) {
        state.withLock { list in
            if pad.mode != "effect", let i = list.firstIndex(where: { $0.pad.id == pad.id && !$0.stopping }) {
                list[i].stopping = true
                return (nil, [list[i].inst])
            }
            let inst = String(UInt64.random(in: 0..<UInt64.max), radix: 36)
            list.append(Playing(inst: inst, pad: pad, gain: Float(dbToGain(pad.vol))))
            return (inst, [])
        }
    }

    /// Stops everything; returns the instances that were playing.
    func stopAll() -> [String] {
        state.withLock { list in
            var out: [String] = []
            for i in list.indices where !list[i].stopping { list[i].stopping = true; out.append(list[i].inst) }
            return out
        }
    }

    /// Instances that finished by themselves since the last call (to tell the studio).
    private let finishedLock = OSAllocatedUnfairLock(initialState: [String]())
    func takeFinished() -> [String] { finishedLock.withLock { let f = $0; $0 = []; return f } }

    /// Beds still playing (re-announced when a new take starts).
    func playingBeds() -> [(String, Pad)] { state.withLock { $0.filter { !$0.stopping && $0.pad.mode == "bed" }.map { ($0.inst, $0.pad) } } }
    func playingCount() -> Int { state.withLock { $0.filter { !$0.stopping }.count } }

    /// Mixes what's playing into `left`/`right` (audio thread).
    func render(frames: Int, left: inout [Float], right: inout [Float]) {
        for i in 0..<frames { left[i] = 0; right[i] = 0 }
        guard let m = mix.withLockIfAvailable({ $0 }) else { return }
        let bedTarget: Float = m.duck && m.talking ? 0.25 : 1
        _ = state.withLockIfAvailable { list in
            var ended: [String] = []
            guard let snd = sounds.withLockIfAvailable({ $0 }) else { return }
            for k in list.indices {
                guard let s = snd[list[k].pad.id], !s.left.isEmpty else { continue }
                let bed = list[k].pad.mode == "bed"
                for i in 0..<frames {
                    if list[k].pos >= s.left.count {
                        if bed { list[k].pos = 0 } else { break }
                    }
                    if list[k].stopping { list[k].fade -= 1 / 2400; if list[k].fade <= 0 { break } }   // 50 ms fade out
                    if bed { bedGain += (bedTarget - bedGain) * (bedTarget < bedGain ? 0.002 : 0.0001) }
                    let g = list[k].gain * list[k].fade * m.level * (bed ? bedGain : 1)
                    left[i] += s.left[list[k].pos] * g
                    right[i] += s.right[list[k].pos] * g
                    list[k].pos += 1
                }
                if (!bed && list[k].pos >= s.left.count) || list[k].fade <= 0 {
                    if !list[k].stopping { ended.append(list[k].inst) }
                    list[k].fade = 0
                }
            }
            list.removeAll { $0.fade <= 0 }
            if !ended.isEmpty { finishedLock.withLockIfAvailable { $0.append(contentsOf: ended) } }
        }
    }
}
