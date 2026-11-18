import Foundation
import WebRTC

/// The call with one other person: "perfect negotiation", exactly like the browsers, so either side can add or
/// change what it sends at any time. The newcomer makes the first offer.
final class PeerLink: NSObject, RTCPeerConnectionDelegate, @unchecked Sendable {
    let id: String
    let polite: Bool
    let pc: RTCPeerConnection
    let mainAudio: RTCAudioTrack
    let talkAudio: RTCAudioTrack
    private var canOffer: Bool
    private var makingOffer = false
    private var ignoreOffer = false
    private var chain: Task<Void, Never>?
    private let send: @Sendable ([String: Any]) -> Void
    /// Things that happened, for the session (on the main actor).
    var onTrack: (@MainActor (RTCMediaStreamTrack, String) -> Void)?
    var onState: (@MainActor (String) -> Void)?

    init?(id: String, myId: String, initiator: Bool, ice: [[String: Any]], media: Media, controlRoom: Bool, send: @escaping @Sendable ([String: Any]) -> Void) {
        self.id = id
        self.polite = myId > id
        self.canOffer = initiator
        self.send = send
        let cfg = RTCConfiguration()
        cfg.iceServers = ice.compactMap { s in
            let urls = (s["urls"] as? [String]) ?? (s["urls"] as? String).map { [$0] } ?? []
            guard !urls.isEmpty else { return nil }
            return RTCIceServer(urlStrings: urls, username: s["username"] as? String, credential: s["credential"] as? String)
        }
        cfg.sdpSemantics = .unifiedPlan
        cfg.bundlePolicy = .maxBundle
        cfg.continualGatheringPolicy = .gatherContinually
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        mainAudio = media.audioTrack("voice")
        talkAudio = media.audioTrack("talk")
        talkAudio.isEnabled = false
        guard let pc = media.factory.peerConnection(with: cfg, constraints: constraints, delegate: nil) else { return nil }
        self.pc = pc
        super.init()
        pc.delegate = self
        // my voice (and the soundboard) with my camera; a private talkback channel; my camera or "nothing to send"
        pc.add(mainAudio, streamIds: [media.streamId])
        let talkInit = RTCRtpTransceiverInit()
        talkInit.direction = .sendOnly
        talkInit.streamIds = [media.talkStreamId]
        pc.addTransceiver(with: talkAudio, init: talkInit)
        if let cam = media.camera, !controlRoom {
            pc.add(cam, streamIds: [media.streamId])
        } else {
            let v = RTCRtpTransceiverInit()
            v.direction = .recvOnly
            pc.addTransceiver(of: .video, init: v)
        }
    }

    func close() {
        chain?.cancel()
        pc.close()
    }

    // MARK: - signalling

    /// An offer, answer or network address from them.
    func signal(_ data: [String: Any]) {
        let prev = chain
        chain = Task { [weak self] in
            await prev?.value
            await self?.handle(data)
        }
    }

    private func handle(_ data: [String: Any]) async {
        if let sdp = data["sdp"] as? [String: Any], let type = sdp["type"] as? String, let text = sdp["sdp"] as? String {
            let desc = RTCSessionDescription(type: RTCSessionDescription.type(for: type), sdp: text)
            let collision = desc.type == .offer && (makingOffer || pc.signalingState != .stable)
            ignoreOffer = !polite && collision
            if ignoreOffer { return }
            do {
                if collision { try await setRemote(RTCSessionDescription(type: .rollback, sdp: "")) }
                try await setRemote(desc)
                if desc.type == .offer {
                    try await setLocal()
                    sendLocal()
                    canOffer = true
                }
            } catch { NSLog("Rolling: signal from \(id): \(error.localizedDescription)") }
        } else if let c = data["candidate"] as? [String: Any], let cand = c["candidate"] as? String {
            let ic = RTCIceCandidate(sdp: cand, sdpMLineIndex: Int32((c["sdpMLineIndex"] as? Int) ?? 0), sdpMid: c["sdpMid"] as? String)
            do { try await pc.add(ic) } catch { if !ignoreOffer { NSLog("Rolling: ice from \(id): \(error.localizedDescription)") } }
        }
    }

    private func setRemote(_ d: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            pc.setRemoteDescription(d) { e in if let e { c.resume(throwing: e) } else { c.resume() } }
        }
    }

    private func setLocal() async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            pc.setLocalDescriptionWithCompletionHandler { e in if let e { c.resume(throwing: e) } else { c.resume() } }
        }
    }

    private func sendLocal() {
        guard let d = pc.localDescription else { return }
        send(["t": "signal", "to": id, "data": ["sdp": ["type": RTCSessionDescription.string(for: d.type), "sdp": d.sdp]]])
    }

    private func negotiate() {
        guard canOffer else { return }
        let prev = chain
        chain = Task { [weak self] in
            await prev?.value
            guard let self else { return }
            self.makingOffer = true
            defer { self.makingOffer = false }
            do {
                try await self.setLocal()
                if self.pc.signalingState == .haveLocalOffer { self.sendLocal() }
            } catch { NSLog("Rolling: offer to \(self.id): \(error.localizedDescription)") }
        }
    }

    // MARK: - RTCPeerConnectionDelegate (called on WebRTC's own thread)

    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) { negotiate() }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        send(["t": "signal", "to": id, "data": ["candidate": ["candidate": candidate.sdp, "sdpMid": candidate.sdpMid as Any, "sdpMLineIndex": candidate.sdpMLineIndex]]])
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams mediaStreams: [RTCMediaStream]) {
        guard let track = rtpReceiver.track else { return }
        let sid = mediaStreams.first?.streamId ?? ""
        Task { @MainActor in self.onTrack?(track, sid) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        let s: String
        switch newState {
        case .connected: s = "connected"
        case .connecting, .new: s = "connecting"
        case .failed: s = "failed"
        case .disconnected: s = "disconnected"
        case .closed: s = "closed"
        @unknown default: s = "connecting"
        }
        Task { @MainActor in self.onState?(s) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        if newState == .failed { peerConnection.restartIce() }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

    // MARK: - numbers for the meters and the Health panel

    /// Their voice level (0…1), how the connection is doing.
    func stats() async -> (level: Float, rtt: Double?, loss: Double?) {
        await withCheckedContinuation { c in
            pc.statistics { report in
                var level: Float = 0, rtt: Double?, lost = 0.0, got = 0.0
                for s in report.statistics.values {
                    if s.type == "inbound-rtp", (s.values["kind"] as? String) == "audio" {
                        level = max(level, (s.values["audioLevel"] as? NSNumber)?.floatValue ?? 0)
                        lost += (s.values["packetsLost"] as? NSNumber)?.doubleValue ?? 0
                        got += (s.values["packetsReceived"] as? NSNumber)?.doubleValue ?? 0
                    }
                    if s.type == "candidate-pair", (s.values["nominated"] as? NSNumber)?.boolValue == true,
                       let r = (s.values["currentRoundTripTime"] as? NSNumber)?.doubleValue { rtt = r * 1000 }
                }
                c.resume(returning: (level, rtt, got + lost > 0 ? lost / (got + lost) : nil))
            }
        }
    }
}
