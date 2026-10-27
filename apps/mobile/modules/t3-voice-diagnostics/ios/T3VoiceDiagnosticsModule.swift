import AVFoundation
import CryptoKit
import ExpoModulesCore

/// Native half of the on-device diagnostics report. The store owns persistence
/// even when JavaScript is not listening; route events are also forwarded so
/// the voice adapter can stop forcing speaker when headphones appear.
public final class T3VoiceDiagnosticsModule: Module {
  private let store = T3VoiceDiagnosticsStore.shared

  public func definition() -> ModuleDefinition {
    Events("onAudioSessionEvent")

    OnCreate {
      self.startStore()
    }

    Function("startDiagnostics") { () in
      self.startStore()
    }

    Function("getAudioSessionState") { () -> [String: Any] in
      self.store.audioSessionState()
    }

    Function("prepareVoiceAudioSession") { () -> [String: Any] in
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        options: [.allowBluetooth, .allowBluetoothA2DP]
      )
      try session.setActive(true)
      return self.store.audioSessionState()
    }

    AsyncFunction("getDiagnosticsSummary") { () -> [String: Any] in
      self.store.summary()
    }

    AsyncFunction("exportDiagnostics") { () -> [String: Any] in
      self.store.exportDiagnostics()
    }

    AsyncFunction("clearDiagnostics") { () -> [String: Any] in
      self.store.clearDiagnostics()
      return self.store.summary()
    }
  }

  private func startStore() {
    store.start { [weak self] event, fields in
      DispatchQueue.main.async {
        self?.sendEvent("onAudioSessionEvent", ["event": event, "fields": fields])
      }
    }
  }
}
