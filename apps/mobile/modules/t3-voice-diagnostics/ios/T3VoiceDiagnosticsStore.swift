import AVFoundation
import CryptoKit
import Foundation
import MetricKit
import UIKit

/// A bounded, local-only record of native audio and OS health. Nothing here
/// leaves the device until the JavaScript diagnostics exporter includes it in
/// a report the user explicitly shares. Audio content is never recorded.
final class T3VoiceDiagnosticsStore: NSObject, @unchecked Sendable {
  static let shared = T3VoiceDiagnosticsStore()

  private let queue = DispatchQueue(label: "com.t3tools.voice-diagnostics")
  private let enabled = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil
  private var started = false
  private var fileHandle: FileHandle?
  private var observers: [NSObjectProtocol] = []
  private var eventHandler: ((String, [String: Any]) -> Void)?

  private static let maxEventFileBytes = 1_500_000
  private static let keptRotatedFiles = 3
  private static let eventMaxAge: TimeInterval = 7 * 24 * 3600
  private static let metricMaxAge: TimeInterval = 30 * 24 * 3600

  private lazy var timestamp: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  private var directory: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return base.appendingPathComponent("T3VoiceDiagnostics", isDirectory: true)
  }

  private var metricsDirectory: URL {
    directory.appendingPathComponent("metrickit", isDirectory: true)
  }

  private var eventsFile: URL {
    directory.appendingPathComponent("events.jsonl")
  }

  func start(handler: @escaping (String, [String: Any]) -> Void) {
    guard enabled else { return }
    let shouldRegister = queue.sync { () -> Bool in
      eventHandler = handler
      guard !started else { return false }
      started = true
      do {
        try FileManager.default.createDirectory(at: metricsDirectory, withIntermediateDirectories: true)
        pruneLocked()
      } catch {
        NSLog("T3VoiceDiagnostics cannot create its directory: \(error)")
        started = false
        return false
      }
      logLocked("app.native_diagnostics_started", [
        "version": appVersion,
        "device": UIDevice.current.model,
        "os": UIDevice.current.systemVersion,
        "lowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled,
      ])
      return true
    }
    guard shouldRegister else { return }
    MXMetricManager.shared.add(self)
    observeAudioSession()
  }

  func log(_ event: String, _ fields: [String: Any] = [:], emit: Bool = false) {
    guard enabled else { return }
    queue.async {
      self.logLocked(event, fields)
      if emit { self.eventHandler?(event, fields) }
    }
  }

  private func logLocked(_ event: String, _ fields: [String: Any]) {
    guard started else { return }
    var line: [String: Any] = ["t": timestamp.string(from: Date()), "e": event]
    line.merge(fields) { _, new in new }
    guard JSONSerialization.isValidJSONObject(line),
          var data = try? JSONSerialization.data(withJSONObject: line, options: [.withoutEscapingSlashes])
    else { return }
    data.append(0x0A)
    rotateIfNeededLocked()
    if fileHandle == nil {
      FileManager.default.createFile(atPath: eventsFile.path, contents: nil)
      fileHandle = try? FileHandle(forWritingTo: eventsFile)
    }
    do {
      try fileHandle?.seekToEnd()
      try fileHandle?.write(contentsOf: data)
    } catch {
      try? fileHandle?.close()
      fileHandle = nil
    }
  }

  private func rotateIfNeededLocked() {
    let size = (try? eventsFile.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    guard size > Self.maxEventFileBytes else { return }
    try? fileHandle?.close()
    fileHandle = nil
    let rotated = directory.appendingPathComponent("events-\(fileTimestamp()).jsonl")
    try? FileManager.default.moveItem(at: eventsFile, to: rotated)
    pruneLocked()
  }

  private func pruneLocked() {
    let manager = FileManager.default
    let now = Date()
    let files = (try? manager.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: [.creationDateKey],
      options: .skipsHiddenFiles
    )) ?? []
    let rotated = files.filter { $0.lastPathComponent.hasPrefix("events-") }.sorted {
      $0.lastPathComponent < $1.lastPathComponent
    }
    for (index, file) in rotated.enumerated() {
      let created = (try? file.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? now
      if index < rotated.count - Self.keptRotatedFiles || now.timeIntervalSince(created) > Self.eventMaxAge {
        try? manager.removeItem(at: file)
      }
    }
    let metrics = (try? manager.contentsOfDirectory(
      at: metricsDirectory,
      includingPropertiesForKeys: [.creationDateKey],
      options: .skipsHiddenFiles
    )) ?? []
    for file in metrics {
      let created = (try? file.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? now
      if now.timeIntervalSince(created) > Self.metricMaxAge {
        try? manager.removeItem(at: file)
      }
    }
  }

  // MARK: - Actual iOS audio route

  func audioSessionState() -> [String: Any] {
    let session = AVAudioSession.sharedInstance()
    let outputs = session.currentRoute.outputs.map(portDescription)
    let availableInputs = (session.availableInputs ?? []).map(portDescription)
    let externalOutputs = outputs.filter { ($0["external"] as? Bool) == true }
    let hasExternalAudioDevice = !externalOutputs.isEmpty || availableInputs.contains {
      ($0["external"] as? Bool) == true
    }
    var state: [String: Any] = [
      "category": session.category.rawValue,
      "categoryOptions": session.categoryOptions.rawValue,
      "mode": session.mode.rawValue,
      "sampleRate": session.sampleRate,
      "ioBufferDuration": session.ioBufferDuration,
      "inputNumberOfChannels": session.inputNumberOfChannels,
      "outputNumberOfChannels": session.outputNumberOfChannels,
      "inputLatency": session.inputLatency,
      "outputLatency": session.outputLatency,
      "outputVolume": session.outputVolume,
      "inputAvailable": session.isInputAvailable,
      "recordPermission": session.recordPermission.rawValue,
      "otherAudioPlaying": session.isOtherAudioPlaying,
      "secondaryAudioShouldBeSilenced": session.secondaryAudioShouldBeSilencedHint,
      "inputs": session.currentRoute.inputs.map(portDescription),
      "outputs": outputs,
      "hasExternalOutput": !externalOutputs.isEmpty,
      "hasExternalAudioDevice": hasExternalAudioDevice,
      "availableInputs": availableInputs,
    ]
    if session.isInputGainSettable {
      state["inputGain"] = session.inputGain
    }
    if let preferredInput = session.preferredInput {
      state["preferredInput"] = portDescription(preferredInput)
    }
    return state
  }

  private func portDescription(_ port: AVAudioSessionPortDescription) -> [String: Any] {
    let uidHash = SHA256.hash(data: Data(port.uid.utf8)).prefix(8).map {
      String(format: "%02x", $0)
    }.joined()
    return [
      "type": port.portType.rawValue,
      "uidHash": uidHash,
      "external": Self.externalOutputPorts.contains(port.portType),
      "channels": port.channels?.count ?? 0,
      "dataSourceIDs": (port.dataSources ?? []).map(\.dataSourceID),
    ]
  }

  private static let externalOutputPorts: Set<AVAudioSession.Port> = [
    .headphones,
    .headsetMic,
    .bluetoothA2DP,
    .bluetoothHFP,
    .bluetoothLE,
    .usbAudio,
    .HDMI,
    .airPlay,
    .carAudio,
    .lineOut,
  ]

  private func observeAudioSession() {
    let center = NotificationCenter.default
    observers.append(center.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: nil,
      queue: nil
    ) { [weak self] notification in
      guard let self else { return }
      let reason = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.intValue ?? -1
      var fields = self.audioSessionState()
      fields["reason"] = reason
      if let previous = notification.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription {
        fields["previousOutputs"] = previous.outputs.map(self.portDescription)
      }
      self.log("audio.route_changed", fields, emit: true)
    })
    observers.append(center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: nil,
      queue: nil
    ) { [weak self] notification in
      guard let self else { return }
      var fields = self.audioSessionState()
      fields["type"] = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.intValue ?? -1
      fields["options"] = (notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? NSNumber)?.intValue ?? 0
      self.log("audio.interruption", fields, emit: true)
    })
    for (name, event) in [
      (AVAudioSession.mediaServicesWereLostNotification, "audio.media_services_lost"),
      (AVAudioSession.mediaServicesWereResetNotification, "audio.media_services_reset"),
      (AVAudioSession.silenceSecondaryAudioHintNotification, "audio.secondary_hint_changed"),
    ] {
      observers.append(center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
        guard let self else { return }
        self.log(event, self.audioSessionState(), emit: true)
      })
    }
    observers.append(center.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.log("app.memory_warning")
    })
  }

  // MARK: - Summary and export

  func summary() -> [String: Any] {
    queue.sync {
      let defaults = UserDefaults.standard
      var events = 0
      var bytes = 0
      for file in eventFilesLocked() {
        bytes += (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if let data = try? Data(contentsOf: file, options: .mappedIfSafe) {
          events += data.reduce(0) { $0 + ($1 == 0x0A ? 1 : 0) }
        }
      }
      for file in metricFilesLocked() {
        bytes += (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
      }
      return [
        "nativeEvents": events,
        "nativeBytes": bytes,
        "crashes": defaults.integer(forKey: "t3.diagnostics.crashes"),
        "hangs": defaults.integer(forKey: "t3.diagnostics.hangs"),
        "lastCrash": (defaults.object(forKey: "t3.diagnostics.lastCrash") as? Date)?.timeIntervalSince1970 ?? 0,
        "metricKitAvailable": true,
      ]
    }
  }

  func exportDiagnostics() -> [String: Any] {
    queue.sync {
      logLocked("diagnostics.native_exported", [:])
      try? fileHandle?.close()
      fileHandle = nil
      let eventFiles = eventFilesLocked().compactMap { file -> [String: String]? in
        guard let contents = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        return ["name": file.lastPathComponent, "jsonl": contents]
      }
      let metricFiles = metricFilesLocked().compactMap { file -> [String: String]? in
        guard let contents = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        return ["name": file.lastPathComponent, "json": contents]
      }
      return [
        "eventFiles": eventFiles,
        "metricKitFiles": metricFiles,
        "audioSessionAtExport": audioSessionState(),
      ]
    }
  }

  func clearDiagnostics() {
    queue.sync {
      try? fileHandle?.close()
      fileHandle = nil
      try? FileManager.default.removeItem(at: directory)
      try? FileManager.default.createDirectory(at: metricsDirectory, withIntermediateDirectories: true)
      for key in ["t3.diagnostics.crashes", "t3.diagnostics.hangs", "t3.diagnostics.lastCrash"] {
        UserDefaults.standard.removeObject(forKey: key)
      }
      logLocked("diagnostics.native_cleared", [:])
    }
  }

  private func eventFilesLocked() -> [URL] {
    let files = (try? FileManager.default.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: nil,
      options: .skipsHiddenFiles
    )) ?? []
    return files.filter {
      $0.lastPathComponent == "events.jsonl" || $0.lastPathComponent.hasPrefix("events-")
    }.sorted { $0.lastPathComponent < $1.lastPathComponent }
  }

  private func metricFilesLocked() -> [URL] {
    ((try? FileManager.default.contentsOfDirectory(
      at: metricsDirectory,
      includingPropertiesForKeys: nil,
      options: .skipsHiddenFiles
    )) ?? []).sorted { $0.lastPathComponent < $1.lastPathComponent }
  }

  private var appVersion: String {
    let info = Bundle.main.infoDictionary
    return "\(info?["CFBundleShortVersionString"] as? String ?? "?") (\(info?["CFBundleVersion"] as? String ?? "?"))"
  }

  private func fileTimestamp(_ date: Date = Date()) -> String {
    timestamp.string(from: date).replacingOccurrences(of: ":", with: "-")
  }
}

extension T3VoiceDiagnosticsStore: MXMetricManagerSubscriber {
  nonisolated func didReceive(_ payloads: [MXMetricPayload]) {
    queue.async {
      guard self.started else { return }
      for (index, payload) in payloads.enumerated() {
        let name = "metric-\(self.fileTimestamp(payload.timeStampEnd))-\(index).json"
        try? payload.jsonRepresentation().write(to: self.metricsDirectory.appendingPathComponent(name))
      }
      self.logLocked("metrickit.metrics", ["count": payloads.count])
    }
  }

  nonisolated func didReceive(_ payloads: [MXDiagnosticPayload]) {
    queue.async {
      guard self.started else { return }
      var crashes = 0
      var hangs = 0
      for (index, payload) in payloads.enumerated() {
        let name = "diagnostic-\(self.fileTimestamp(payload.timeStampEnd))-\(index).json"
        try? payload.jsonRepresentation().write(to: self.metricsDirectory.appendingPathComponent(name))
        crashes += payload.crashDiagnostics?.count ?? 0
        hangs += payload.hangDiagnostics?.count ?? 0
      }
      let defaults = UserDefaults.standard
      if crashes > 0 {
        defaults.set(defaults.integer(forKey: "t3.diagnostics.crashes") + crashes, forKey: "t3.diagnostics.crashes")
        defaults.set(payloads.last?.timeStampEnd ?? Date(), forKey: "t3.diagnostics.lastCrash")
      }
      if hangs > 0 {
        defaults.set(defaults.integer(forKey: "t3.diagnostics.hangs") + hangs, forKey: "t3.diagnostics.hangs")
      }
      self.logLocked("metrickit.diagnostics", [
        "payloads": payloads.count,
        "crashes": crashes,
        "hangs": hangs,
      ])
    }
  }
}
