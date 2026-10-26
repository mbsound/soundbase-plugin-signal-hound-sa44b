// sa44b-vm — boots the plugin's Linux guest on Apple's Virtualization.framework.
//
// This is the macOS half of running Signal Hound's x86-64 Linux SA API on
// Apple Silicon without Lima, Homebrew or ssh. It:
//
//   - boots a prebuilt arm64 kernel + initramfs (driver/microvm/guest/)
//   - shares Rosetta with the guest (VZLinuxRosettaDirectoryShare), so the
//     guest can run the x86-64 worker and Signal Hound's library
//   - shares host directories over virtiofs (the x86-64 payload, the plugin's
//     cache with the library and calibration files)
//   - exposes a vsock: guest→host ports are proxied to TCP ports on 127.0.0.1
//     (the shim reaches ftdi-bridge this way), and host→guest ports are
//     reachable through unix sockets on the host (the plugin reaches the
//     worker agent this way)
//
// It speaks JSON lines on stdout to driver/mac-host.js:
//   {"event":"started"}                     the VM is running
//   {"event":"console","line":"..."}        a line of guest console output
//   {"event":"ready"}                       the console showed --ready-marker
//   {"event":"error","code":"...","message":"..."}
//   {"event":"stopped"}
// and exits when its stdin closes — the plugin going away takes the VM with
// it, so no worker can outlive the plugin that started it.
//
// Usage:
//   sa44b-vm --kernel Image --initrd initramfs.img [--cmdline "..."]
//            [--cpus N] [--memory MB]
//            [--share TAG=/path[:ro]]            single-directory share
//            [--share TAG=name:/path[:ro] ...]   one entry of a multi-directory share
//            [--rosetta]                         share Rosetta under the tag "rosetta"
//            [--vsock-listen GUESTPORT:TCPPORT]  guest connects to host:GUESTPORT -> 127.0.0.1:TCPPORT
//            [--forward /path.sock:GUESTPORT]    unix socket -> guest vsock port
//            [--ready-marker TEXT]
//   sa44b-vm --dry-run <same args>     print the parsed configuration, start nothing
//   sa44b-vm --check-rosetta           print Rosetta's availability on this Mac
//
// Build: scripts/build-launcher.sh (swiftc + codesign with the
// com.apple.security.virtualization entitlement; see docs/macos-runtime.md).

import Foundation
import Virtualization

// MARK: - output

let outLock = NSLock()
func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj), var line = String(data: data, encoding: .utf8) else { return }
  line += "\n"
  outLock.lock()
  FileHandle.standardOutput.write(line.data(using: .utf8)!)
  outLock.unlock()
}
func fail(_ code: String, _ message: String, exit status: Int32) -> Never {
  emit(["event": "error", "code": code, "message": message])
  exit(status)
}

// MARK: - configuration

struct ShareEntry { let name: String; let path: String; let readOnly: Bool }
struct VsockListen { let guestPort: UInt32; let tcpPort: UInt16 }
struct Forward { let path: String; let guestPort: UInt32 }

struct LauncherConfig {
  var kernel: String?
  var initrd: String?
  var cmdline = "console=hvc0"
  var cpus = 2
  var memoryMB: UInt64 = 1024
  var shares: [String: [ShareEntry]] = [:]   // tag -> entries; a single entry named "" is a single-directory share
  var rosetta = false
  var vsockListens: [VsockListen] = []
  var forwards: [Forward] = []
  var readyMarker: String?
  var dryRun = false
  var checkRosetta = false

  func asJSON() -> [String: Any] {
    var shareJSON: [String: Any] = [:]
    for (tag, entries) in shares {
      shareJSON[tag] = entries.map { ["name": $0.name, "path": $0.path, "readOnly": $0.readOnly] }
    }
    return [
      "kernel": kernel ?? NSNull(), "initrd": initrd ?? NSNull(), "cmdline": cmdline,
      "cpus": cpus, "memoryMB": memoryMB, "shares": shareJSON, "rosetta": rosetta,
      "vsockListens": vsockListens.map { ["guestPort": $0.guestPort, "tcpPort": $0.tcpPort] },
      "forwards": forwards.map { ["path": $0.path, "guestPort": $0.guestPort] },
      "readyMarker": readyMarker ?? NSNull(),
    ]
  }
}

enum ArgError: Error { case usage(String) }

func parseArgs(_ args: [String]) throws -> LauncherConfig {
  var c = LauncherConfig()
  var i = 0
  func value(_ flag: String) throws -> String {
    i += 1
    guard i < args.count else { throw ArgError.usage("\(flag) needs a value") }
    return args[i]
  }
  func port(_ s: String, _ flag: String) throws -> UInt32 {
    guard let p = UInt32(s), p > 0 else { throw ArgError.usage("\(flag): bad port \"\(s)\"") }
    return p
  }
  while i < args.count {
    let a = args[i]
    switch a {
    case "--kernel": c.kernel = try value(a)
    case "--initrd": c.initrd = try value(a)
    case "--cmdline": c.cmdline = try value(a)
    case "--cpus":
      guard let n = Int(try value(a)), n >= 1 else { throw ArgError.usage("--cpus wants a positive integer") }
      c.cpus = n
    case "--memory":
      guard let n = UInt64(try value(a)), n >= 64 else { throw ArgError.usage("--memory wants megabytes (>= 64)") }
      c.memoryMB = n
    case "--share":
      // TAG=/path[:ro]  or  TAG=name:/path[:ro]
      let v = try value(a)
      guard let eq = v.firstIndex(of: "=") else { throw ArgError.usage("--share wants TAG=[name:]/path[:ro], got \"\(v)\"") }
      let tag = String(v[..<eq])
      var rest = String(v[v.index(after: eq)...])
      var ro = false
      if rest.hasSuffix(":ro") { ro = true; rest = String(rest.dropLast(3)) }
      var name = ""
      if !rest.hasPrefix("/") {
        guard let colon = rest.firstIndex(of: ":") else { throw ArgError.usage("--share: \"\(rest)\" is neither an absolute path nor name:/path") }
        name = String(rest[..<colon])
        rest = String(rest[rest.index(after: colon)...])
        guard rest.hasPrefix("/") else { throw ArgError.usage("--share: path must be absolute, got \"\(rest)\"") }
      }
      if tag.isEmpty || tag == "rosetta" { throw ArgError.usage("--share: tag \"\(tag)\" is reserved or empty") }
      let entry = ShareEntry(name: name, path: rest, readOnly: ro)
      var list = c.shares[tag] ?? []
      if list.contains(where: { $0.name.isEmpty }) || (!list.isEmpty && name.isEmpty) {
        throw ArgError.usage("--share: tag \"\(tag)\" mixes a single-directory share with named entries")
      }
      list.append(entry)
      c.shares[tag] = list
    case "--rosetta": c.rosetta = true
    case "--vsock-listen":
      let v = try value(a)
      let parts = v.split(separator: ":", maxSplits: 1).map(String.init)
      guard parts.count == 2, let tcp = UInt16(parts[1]), tcp > 0 else { throw ArgError.usage("--vsock-listen wants GUESTPORT:TCPPORT, got \"\(v)\"") }
      c.vsockListens.append(VsockListen(guestPort: try port(parts[0], a), tcpPort: tcp))
    case "--forward":
      let v = try value(a)
      guard let colon = v.lastIndex(of: ":") else { throw ArgError.usage("--forward wants /path.sock:GUESTPORT, got \"\(v)\"") }
      let path = String(v[..<colon])
      guard path.hasPrefix("/") else { throw ArgError.usage("--forward: socket path must be absolute") }
      c.forwards.append(Forward(path: path, guestPort: try port(String(v[v.index(after: colon)...]), a)))
    case "--ready-marker": c.readyMarker = try value(a)
    case "--dry-run": c.dryRun = true
    case "--check-rosetta": c.checkRosetta = true
    default: throw ArgError.usage("unknown argument \"\(a)\"")
    }
    i += 1
  }
  if !c.checkRosetta {
    guard let k = c.kernel, !k.isEmpty else { throw ArgError.usage("--kernel is required") }
    guard let r = c.initrd, !r.isEmpty else { throw ArgError.usage("--initrd is required") }
    if !c.dryRun {
      for p in [k, r] where !FileManager.default.isReadableFile(atPath: p) { throw ArgError.usage("cannot read \(p)") }
      for (_, entries) in c.shares {
        for e in entries where !FileManager.default.fileExists(atPath: e.path) { throw ArgError.usage("shared directory does not exist: \(e.path)") }
      }
    }
  }
  return c
}

// MARK: - rosetta

func rosettaAvailability() -> String {
  if #available(macOS 13.0, *) {
    switch VZLinuxRosettaDirectoryShare.availability {
    case .notSupported: return "notSupported"
    case .notInstalled: return "notInstalled"
    case .installed: return "installed"
    @unknown default: return "unknown"
    }
  }
  return "notSupported"
}

// MARK: - byte pumps

/// Copies bytes both ways between two descriptors on two threads; closes both when done.
final class Pump {
  private let a: Int32, b: Int32
  private let lock = NSLock()
  private var remaining = 2
  private let onDone: () -> Void

  init(_ a: Int32, _ b: Int32, onDone: @escaping () -> Void) {
    self.a = a; self.b = b; self.onDone = onDone
    Thread { self.copy(self.a, self.b) }.start()
    Thread { self.copy(self.b, self.a) }.start()
  }

  private func copy(_ from: Int32, _ to: Int32) {
    var buf = [UInt8](repeating: 0, count: 65536)
    outer: while true {
      let n = buf.withUnsafeMutableBytes { read(from, $0.baseAddress, $0.count) }
      if n < 0 && errno == EINTR { continue }
      if n <= 0 { break }
      var off = 0
      while off < n {
        let w = buf.withUnsafeBytes { write(to, $0.baseAddress! + off, n - off) }
        if w < 0 && errno == EINTR { continue }
        if w <= 0 { break outer }
        off += w
      }
    }
    // half-close so the other side sees EOF; the other direction may still be flowing
    shutdown(to, SHUT_WR)
    lock.lock()
    remaining -= 1
    let last = remaining == 0
    lock.unlock()
    if last {
      close(a); close(b)
      onDone()
    }
  }
}

// MARK: - the launcher

final class Launcher: NSObject, VZVirtualMachineDelegate, VZVirtioSocketListenerDelegate {
  let config: LauncherConfig
  let queue = DispatchQueue(label: "sa44b-vm")
  var vm: VZVirtualMachine!
  var consolePipe = Pipe()
  var ready = false
  var connections: [ObjectIdentifier: VZVirtioSocketConnection] = [:]
  let connLock = NSLock()

  init(config: LauncherConfig) { self.config = config }

  func retain(_ conn: VZVirtioSocketConnection) {
    connLock.lock(); connections[ObjectIdentifier(conn)] = conn; connLock.unlock()
  }
  func release(_ conn: VZVirtioSocketConnection) {
    connLock.lock(); connections[ObjectIdentifier(conn)] = nil; connLock.unlock()
  }

  func makeConfiguration() throws -> VZVirtualMachineConfiguration {
    let vmc = VZVirtualMachineConfiguration()
    let boot = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: config.kernel!))
    boot.initialRamdiskURL = URL(fileURLWithPath: config.initrd!)
    boot.commandLine = config.cmdline
    vmc.bootLoader = boot
    vmc.cpuCount = max(VZVirtualMachineConfiguration.minimumAllowedCPUCount,
                       min(config.cpus, VZVirtualMachineConfiguration.maximumAllowedCPUCount))
    vmc.memorySize = max(VZVirtualMachineConfiguration.minimumAllowedMemorySize,
                         min(config.memoryMB * 1024 * 1024, VZVirtualMachineConfiguration.maximumAllowedMemorySize))

    let console = VZVirtioConsoleDeviceSerialPortConfiguration()
    console.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: consolePipe.fileHandleForWriting)
    vmc.serialPorts = [console]
    vmc.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
    vmc.socketDevices = [VZVirtioSocketDeviceConfiguration()]

    var fs: [VZDirectorySharingDeviceConfiguration] = []
    for (tag, entries) in config.shares.sorted(by: { $0.key < $1.key }) {
      let dev = VZVirtioFileSystemDeviceConfiguration(tag: tag)
      if entries.count == 1 && entries[0].name.isEmpty {
        dev.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: entries[0].path), readOnly: entries[0].readOnly))
      } else {
        var dirs: [String: VZSharedDirectory] = [:]
        for e in entries { dirs[e.name] = VZSharedDirectory(url: URL(fileURLWithPath: e.path), readOnly: e.readOnly) }
        dev.share = VZMultipleDirectoryShare(directories: dirs)
      }
      fs.append(dev)
    }
    if config.rosetta {
      guard #available(macOS 13.0, *) else { fail("rosetta_not_supported", "Rosetta directory sharing needs macOS 13 or newer", exit: 3) }
      let avail = rosettaAvailability()
      if avail != "installed" {
        fail(avail == "notInstalled" ? "rosetta_not_installed" : "rosetta_not_supported",
             avail == "notInstalled" ? "Rosetta is not installed on this Mac" : "Rosetta for Linux VMs is not supported on this Mac", exit: 3)
      }
      let dev = VZVirtioFileSystemDeviceConfiguration(tag: "rosetta")
      dev.share = try VZLinuxRosettaDirectoryShare()
      fs.append(dev)
    }
    vmc.directorySharingDevices = fs
    try vmc.validate()
    return vmc
  }

  func run() {
    let vmc: VZVirtualMachineConfiguration
    do { vmc = try makeConfiguration() } catch {
      fail("invalid_configuration", "\(error)", exit: 2)
    }
    vm = VZVirtualMachine(configuration: vmc, queue: queue)
    vm.delegate = self
    watchConsole()
    watchStdin()
    queue.async {
      self.vm.start { result in
        switch result {
        case .success:
          emit(["event": "started"])
          self.wireVsock()
        case .failure(let err):
          fail("start_failed", "\(err)", exit: 1)
        }
      }
    }
    dispatchMain()
  }

  // every guest console line goes to the plugin log; one of them means "ready"
  func watchConsole() {
    let fh = consolePipe.fileHandleForReading
    Thread {
      var buffered = Data()
      while true {
        let chunk = fh.availableData
        if chunk.isEmpty { break }
        buffered.append(chunk)
        while let nl = buffered.firstIndex(of: 0x0a) {
          let lineData = buffered.subdata(in: 0..<nl)
          buffered.removeSubrange(0...nl)
          let line = String(decoding: lineData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
          if line.isEmpty { continue }
          emit(["event": "console", "line": line])
          if let marker = self.config.readyMarker, !self.ready, line.contains(marker) {
            self.ready = true
            emit(["event": "ready"])
          }
        }
      }
    }.start()
  }

  // the plugin closing our stdin (or dying) is the stop signal
  func watchStdin() {
    Thread {
      _ = FileHandle.standardInput.readDataToEndOfFile()
      emit(["event": "stopped", "reason": "stdin closed"])
      exit(0)
    }.start()
  }

  func wireVsock() {
    guard let dev = vm.socketDevices.first as? VZVirtioSocketDevice else {
      fail("no_vsock", "the VM has no vsock device", exit: 1)
    }
    for l in config.vsockListens {
      let listener = VZVirtioSocketListener()
      listener.delegate = self
      dev.setSocketListener(listener, forPort: l.guestPort)
    }
    for f in config.forwards { serveForward(f, device: dev) }
  }

  // guest -> host: the guest connected to one of our vsock ports; bridge it to TCP
  func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection,
                from socketDevice: VZVirtioSocketDevice) -> Bool {
    guard let l = config.vsockListens.first(where: { $0.guestPort == connection.destinationPort }) else { return false }
    retain(connection)
    Thread {
      let fd = socket(AF_INET, SOCK_STREAM, 0)
      var sa = sockaddr_in()
      sa.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
      sa.sin_family = sa_family_t(AF_INET)
      sa.sin_port = l.tcpPort.bigEndian
      sa.sin_addr.s_addr = inet_addr("127.0.0.1")
      let rc = withUnsafePointer(to: &sa) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
      if rc != 0 {
        emit(["event": "console", "line": "[launcher] guest vsock port \(l.guestPort): cannot reach 127.0.0.1:\(l.tcpPort) (\(String(cString: strerror(errno))))"])
        close(fd)
        connection.close()
        self.release(connection)
        return
      }
      var one: Int32 = 1
      setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, socklen_t(MemoryLayout<Int32>.size))
      // dup: Pump closes what it is given, and the connection object closes its own fd
      _ = Pump(dup(connection.fileDescriptor), fd) {
        connection.close()
        self.release(connection)
      }
    }.start()
    return true
  }

  // host -> guest: a unix socket on the host, each client becomes a vsock connection
  func serveForward(_ f: Forward, device: VZVirtioSocketDevice) {
    unlink(f.path)
    let ls = socket(AF_UNIX, SOCK_STREAM, 0)
    var sa = sockaddr_un()
    sa.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(f.path.utf8CString)
    guard pathBytes.count <= MemoryLayout.size(ofValue: sa.sun_path) else {
      fail("forward_failed", "socket path too long: \(f.path)", exit: 2)
    }
    withUnsafeMutableBytes(of: &sa.sun_path) { dst in
      for (i, b) in pathBytes.enumerated() { dst[i] = UInt8(bitPattern: b) }
    }
    sa.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let bound = withUnsafePointer(to: &sa) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(ls, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    guard bound == 0, listen(ls, 8) == 0 else {
      fail("forward_failed", "cannot listen on \(f.path): \(String(cString: strerror(errno)))", exit: 2)
    }
    Thread {
      while true {
        let client = accept(ls, nil, nil)
        if client < 0 { if errno == EINTR { continue } else { break } }
        var one: Int32 = 1
        setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        self.queue.async {
          device.connect(toPort: f.guestPort) { result in
            switch result {
            case .success(let conn):
              self.retain(conn)
              _ = Pump(client, dup(conn.fileDescriptor)) {
                conn.close()
                self.release(conn)
              }
            case .failure(let err):
              emit(["event": "console", "line": "[launcher] cannot connect to guest vsock port \(f.guestPort): \(err)"])
              close(client)
            }
          }
        }
      }
    }.start()
  }

  // VZVirtualMachineDelegate
  func guestDidStop(_ virtualMachine: VZVirtualMachine) {
    emit(["event": "stopped", "reason": "guest halted"])
    exit(ready ? 0 : 1)
  }
  func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
    fail("vm_stopped", "\(error)", exit: 1)
  }
}

// MARK: - main

signal(SIGPIPE, SIG_IGN)
let config: LauncherConfig
do {
  config = try parseArgs(Array(CommandLine.arguments.dropFirst()))
} catch ArgError.usage(let msg) {
  fail("usage", msg, exit: 2)
} catch {
  fail("usage", "\(error)", exit: 2)
}
if config.checkRosetta {
  emit(["event": "rosetta", "availability": rosettaAvailability(), "macOS": ProcessInfo.processInfo.operatingSystemVersionString])
  exit(0)
}
if config.dryRun {
  emit(["event": "config", "config": config.asJSON()])
  exit(0)
}
guard VZVirtualMachine.isSupported else {
  fail("virtualization_unsupported", "Virtualization.framework is not available on this Mac", exit: 3)
}
Launcher(config: config).run()
