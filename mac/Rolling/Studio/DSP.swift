import Foundation

// Small sound tools that run on the audio thread: no locks, no allocations once made.

/// One second-order filter (the K-weighting stages of the loudness meter).
struct Biquad {
    var b0: Double, b1: Double, b2: Double, a1: Double, a2: Double
    var z1 = 0.0, z2 = 0.0
    mutating func run(_ x: Double) -> Double {
        let y = b0 * x + z1
        z1 = b1 * x - a1 * y + z2
        z2 = b2 * x - a2 * y
        return y
    }
}

/// Broadcast loudness (EBU R128 / ITU-R BS.1770) at 48 kHz: momentary (400 ms), short-term (3 s), integrated
/// (gated), and the sample peak — the same numbers the guests' browsers report.
struct LoudnessMeter {
    private var shelf = Biquad(b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585)
    private var hp = Biquad(b0: 1.0, b1: -2.0, b2: 1.0, a1: -1.99004745483398, a2: 0.99007225036621)
    private var blocks = [Double](repeating: 0, count: 30)   // 100 ms mean squares, newest last
    private var acc = 0.0, n = 0
    private var gated: [Double] = []                         // 400 ms block powers for the integrated value
    private(set) var momentary = -Double.infinity
    private(set) var shortTerm = -Double.infinity
    private(set) var integrated = -Double.infinity
    private(set) var peak: Double = 0                         // linear, since last read
    private(set) var peakMax: Double = 0

    mutating func reset() { self = LoudnessMeter() }

    mutating func push(_ x: Float) {
        let v = Double(x)
        let a = abs(v); if a > peak { peak = a }; if a > peakMax { peakMax = a }
        let k = hp.run(shelf.run(v))
        acc += k * k; n += 1
        if n == 4800 { endBlock() }
    }

    mutating func takePeak() -> Double { let p = peak; peak = 0; return p }

    private mutating func endBlock() {
        blocks.removeFirst(); blocks.append(acc / Double(n)); acc = 0; n = 0
        let m = blocks.suffix(4).reduce(0, +) / 4
        momentary = lufs(m)
        shortTerm = lufs(blocks.reduce(0, +) / 30)
        if momentary > -70 {
            gated.append(m)
            if gated.count > 36000 { gated.removeFirst(gated.count - 36000) }   // an hour of 100 ms steps
            let mean = gated.reduce(0, +) / Double(gated.count)
            let rel = mean * 0.1                                  // −10 LU, in power
            var sum = 0.0, count = 0
            for g in gated where g > rel { sum += g; count += 1 }
            integrated = count == 0 ? -.infinity : lufs(sum / Double(count))
        }
    }

    private func lufs(_ ms: Double) -> Double { ms > 0 ? -0.691 + 10 * log10(ms) : -.infinity }

    /// What a guest's browser sends as its meter (rounded to 0.1).
    func report() -> [String: Any] {
        func r(_ v: Double) -> Any { v.isFinite ? (v * 10).rounded() / 10 : NSNull() }
        let tp = peakMax > 0 ? 20 * log10(peakMax) : -Double.infinity
        return ["M": r(momentary), "S": r(shortTerm), "I": r(integrated), "TP": r(tp), "TPmax": r(tp)]
    }
}

/// Changes the sample rate (e.g. a 44.1 kHz microphone to the studio's 48 kHz). Linear: fine for speech.
struct Resampler {
    let ratio: Double          // in rate / out rate
    private var pos = 0.0
    private var last: Float = 0
    init(from: Double, to: Double) { ratio = from / to }

    /// Feeds `input`, calls `out` for each output sample.
    mutating func run(_ input: UnsafeBufferPointer<Float>, _ out: (Float) -> Void) {
        if ratio == 1 { for x in input { out(x) }; return }
        var i = 0
        while true {
            let idx = Int(pos)
            if idx >= input.count { break }
            let a = idx == 0 ? last : input[idx - 1], b = input[idx]
            let f = Float(pos - Double(idx))
            out(a + (b - a) * f)
            pos += ratio
            i += 1
        }
        pos -= Double(input.count)
        if let l = input.last { last = l }
    }
}

@inline(__always) func dbToGain(_ db: Double) -> Double { db <= -60 ? 0 : pow(10, db / 20) }
