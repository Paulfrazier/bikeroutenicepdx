import AVFoundation
import UIKit

/// Spoken + haptic turn guidance. Wraps `AVSpeechSynthesizer` and configures an
/// audio session that ducks music and keeps talking with the screen locked
/// (paired with the `audio` background mode). `NavigationSession` decides *what*
/// to say and *when*; this type just says it.
@MainActor
final class VoiceGuide {
    private let synth = AVSpeechSynthesizer()
    private let haptics = UINotificationFeedbackGenerator()
    private let impact = UIImpactFeedbackGenerator(style: .rigid)

    /// User toggle. When false, no audio (haptics still fire so silent riders
    /// keep the wrist/phone cue).
    var voiceEnabled = true

    /// Prepare the shared audio session for spoken guidance over other audio.
    func activate() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers, .mixWithOthers, .interruptSpokenAudioAndMixWithOthers])
        try? session.setActive(true)
        haptics.prepare()
        impact.prepare()
    }

    func deactivate() {
        synth.stopSpeaking(at: .immediate)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Speak `text`, interrupting any in-progress utterance (newer guidance always
    /// supersedes older — a stale "in 200 feet" must never queue behind "turn now").
    func speak(_ text: String, interrupt: Bool = true) {
        guard voiceEnabled, !text.isEmpty else { return }
        if interrupt { synth.stopSpeaking(at: .immediate) }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        synth.speak(utterance)
    }

    /// A firm double-buzz at the moment of a turn.
    func turnHaptic() {
        haptics.notificationOccurred(.success)
    }

    /// A light cue for a "prepare to turn" / infrastructure-change heads-up.
    func prepareHaptic() {
        impact.impactOccurred()
    }

    // MARK: - Phrasing helpers

    /// Spoken distance, rounded to friendly imperial increments ("300 feet",
    /// "a quarter mile", "half a mile").
    static func spokenDistance(_ meters: Double) -> String {
        let feet = meters * 3.28084
        if feet < 80 { return "now" }
        if feet < 1000 {
            let rounded = Int((feet / 50).rounded()) * 50
            return "in \(rounded) feet"
        }
        let miles = meters / 1609.344
        if miles < 0.3 { return "in a quarter mile" }
        if miles < 0.6 { return "in half a mile" }
        if miles < 0.85 { return "in three quarters of a mile" }
        return "in \(String(format: "%.1f", miles)) miles"
    }

    /// Distance phrase without the leading "in " — for embedding mid-sentence
    /// ("busy street for 300 feet").
    static func spokenDistanceBare(_ meters: Double) -> String {
        let phrase = spokenDistance(meters)
        return phrase.hasPrefix("in ") ? String(phrase.dropFirst(3)) : phrase
    }
}
