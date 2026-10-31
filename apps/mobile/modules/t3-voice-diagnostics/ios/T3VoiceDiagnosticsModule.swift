import AVFoundation
import CryptoKit
import ExpoModulesCore
import WebRTC

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

    /// The whole voice route policy, in one place. iOS picks the output:
    /// Bluetooth (car, AirPods) and wired headphones always win, and
    /// `.defaultToSpeaker` only decides between the speaker and the earpiece
    /// when nothing is connected. It is written into WebRTC's own
    /// configuration because WebRTC re-applies that configuration when its
    /// audio unit starts; an option set only on AVAudioSession is lost there.
    /// No output-port override is ever applied, since a speaker override
    /// outranks Bluetooth.
    Function("configureVoiceRoute") { (speaker: Bool) -> [String: Any] in
      var options: AVAudioSession.CategoryOptions = [.allowBluetooth, .allowBluetoothA2DP]
      if speaker { options.insert(.defaultToSpeaker) }
      let config = RTCAudioSessionConfiguration.webRTC()
      config.category = AVAudioSession.Category.playAndRecord.rawValue
      config.mode = AVAudioSession.Mode.voiceChat.rawValue
      config.categoryOptions = options
      RTCAudioSessionConfiguration.setWebRTC(config)
      let session = RTCAudioSession.sharedInstance()
      session.lockForConfiguration()
      defer { session.unlockForConfiguration() }
      try session.setConfiguration(config, active: true)
      try session.overrideOutputAudioPort(.none)
      var state = self.store.audioSessionState()
      state["speakerPreferred"] = speaker
      self.store.log("audio.route_configured", state)
      return state
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
