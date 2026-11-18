import Darwin
import Foundation

/// A program this app runs (the studio, the guest link). Its output arrives line by line; it can be told when it ends.
/// The studio (node) also gets a message channel: what Node calls IPC, on file descriptor 3.
final class ChildProcess: @unchecked Sendable {
    let pid: pid_t
    private let outFD: Int32
    private let channelFD: Int32?
    private var exitSource: DispatchSourceProcess?
    private var reader: FileHandle?
    private var partial = ""
    private let lock = NSLock()
    private(set) var exited = false

    /// Starts `exe` with `args` and `env`. `channel`: give it a Node message channel.
    init(exe: String, args: [String], env: [String: String], cwd: String? = nil, channel: Bool = false,
         onLine: @escaping @Sendable (String) -> Void, onExit: @escaping @Sendable (Int32) -> Void) throws {
        var outPipe: [Int32] = [0, 0]
        guard pipe(&outPipe) == 0 else { throw StudioError(message: "Couldn't start \(exe) (no pipe)") }
        var pair: [Int32] = [-1, -1]
        if channel, socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) != 0 { throw StudioError(message: "Couldn't start \(exe) (no channel)") }

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, outPipe[1], 1)
        posix_spawn_file_actions_adddup2(&actions, outPipe[1], 2)
        if channel { posix_spawn_file_actions_adddup2(&actions, pair[1], 3) }
        if let cwd { posix_spawn_file_actions_addchdir_np(&actions, cwd) }

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // only the descriptors above are passed on; and it gets its own process group, so it can be stopped with its children
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP))
        posix_spawnattr_setpgroup(&attr, 0)

        var fullEnv = env
        if channel { fullEnv["NODE_CHANNEL_FD"] = "3" }
        let argv: [UnsafeMutablePointer<CChar>?] = ([exe] + args).map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = fullEnv.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { for p in argv { free(p) }; for p in envp { free(p) } }

        var newPid: pid_t = 0
        let rc = posix_spawn(&newPid, exe, &actions, &attr, argv, envp)
        close(outPipe[1])
        if channel { close(pair[1]) }
        guard rc == 0 else {
            close(outPipe[0]); if channel { close(pair[0]) }
            throw StudioError(message: "Couldn't start \((exe as NSString).lastPathComponent): \(String(cString: strerror(rc)))")
        }
        pid = newPid
        outFD = outPipe[0]
        channelFD = channel ? pair[0] : nil

        let fh = FileHandle(fileDescriptor: outFD, closeOnDealloc: true)
        reader = fh
        fh.readabilityHandler = { [weak self] h in
            let d = h.availableData
            guard let self, !d.isEmpty else { h.readabilityHandler = nil; return }
            self.lock.lock()
            self.partial += String(decoding: d, as: UTF8.self)
            var lines = self.partial.components(separatedBy: "\n")
            self.partial = lines.removeLast()
            self.lock.unlock()
            for l in lines where !l.trimmingCharacters(in: .whitespaces).isEmpty { onLine(l) }
        }
        let src = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .global())
        src.setEventHandler { [weak self] in
            var status: Int32 = 0
            waitpid(newPid, &status, 0)
            self?.exited = true
            src.cancel()
            let code = (status & 0x7f) == 0 ? (status >> 8) & 0xff : -(status & 0x7f)
            onExit(code)
        }
        src.resume()
        exitSource = src
    }

    /// Sends a message to a Node program (it arrives as process.on('message')).
    func send(_ message: [String: Any]) {
        guard let fd = channelFD, let d = try? JSONSerialization.data(withJSONObject: message) else { return }
        var line = d
        line.append(0x0a)
        line.withUnsafeBytes { p in _ = Darwin.write(fd, p.baseAddress, p.count) }
    }

    /// Asks it to stop (and anything it started).
    func stop() {
        guard !exited else { return }
        kill(-pid, SIGTERM)
        kill(pid, SIGTERM)
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) { [pid, weak self] in
            if self?.exited == false { kill(-pid, SIGKILL); kill(pid, SIGKILL) }
        }
    }

    deinit {
        if let fd = channelFD { close(fd) }
    }
}
