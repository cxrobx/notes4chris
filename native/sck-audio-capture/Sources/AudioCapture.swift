import Foundation
import ScreenCaptureKit
import CoreMedia

/// Errors that can occur during audio capture
enum CaptureError: Error, LocalizedError {
    case permissionDenied
    case noDisplayFound
    case streamStartFailed(String)
    case fileCreationFailed(String)
    case bufferCopyFailed
    case alreadyRunning

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "Screen Recording permission denied. Grant permission in System Settings > Privacy & Security > Screen Recording."
        case .noDisplayFound:
            return "No display found for audio capture."
        case .streamStartFailed(let reason):
            return "Failed to start audio stream: \(reason)"
        case .fileCreationFailed(let path):
            return "Failed to create output file: \(path)"
        case .bufferCopyFailed:
            return "Failed to copy audio buffer data."
        case .alreadyRunning:
            return "Audio capture is already running."
        }
    }
}

/// Captures system audio using ScreenCaptureKit and writes it to a WAV file.
///
/// Uses SCStream with audio-only configuration (no display capture).
/// Implements SCStreamOutput to receive CMSampleBuffer audio frames.
@available(macOS 13.0, *)
final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let outputPath: String
    private let sampleRate: Int
    private let channels: Int
    private let bitDepth: Int

    private var stream: SCStream?
    private var wavWriter: WAVWriter?
    private var isRunning = false

    init(outputPath: String, sampleRate: Int = 48000, channels: Int = 2, bitDepth: Int = 16) {
        self.outputPath = outputPath
        self.sampleRate = sampleRate
        self.channels = channels
        self.bitDepth = bitDepth
        super.init()
    }

    /// Start capturing system audio
    func start() async throws {
        guard !isRunning else {
            throw CaptureError.alreadyRunning
        }

        fputs("DEBUG: Getting shareable content...\n", stderr)

        // Get shareable content (triggers permission prompt if needed)
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            let nsError = error as NSError
            if nsError.domain == "com.apple.screencapturekit" || nsError.code == -3801 {
                throw CaptureError.permissionDenied
            }
            throw CaptureError.streamStartFailed(error.localizedDescription)
        }

        fputs("DEBUG: Got \(content.displays.count) displays, \(content.windows.count) windows\n", stderr)

        guard let display = content.displays.first else {
            throw CaptureError.noDisplayFound
        }

        // Create content filter — capture entire display but we only want audio
        let filter = SCContentFilter(display: display, excludingWindows: [])

        // Configure stream for audio-only capture
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = sampleRate
        config.channelCount = channels

        // Minimise display capture overhead (we only want audio)
        // Note: SCK requires reasonable display config even for audio-only capture
        config.width = 16
        config.height = 16
        config.minimumFrameInterval = CMTime(value: 1, timescale: 2) // 2 fps minimum

        fputs("DEBUG: Creating WAV writer...\n", stderr)

        // Create WAV writer
        wavWriter = try WAVWriter(outputPath: outputPath, sampleRate: sampleRate, channels: channels, bitDepth: bitDepth)

        fputs("DEBUG: Starting SCStream...\n", stderr)

        // Create and start stream
        // Both audio and screen outputs must be registered for SCK to deliver audio
        let captureStream = SCStream(filter: filter, configuration: config, delegate: self)
        try captureStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .global(qos: .background))
        try captureStream.addStreamOutput(self, type: .audio, sampleHandlerQueue: .global(qos: .userInitiated))

        // Use completion handler instead of async version to avoid Swift concurrency deadlocks
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            captureStream.startCapture { error in
                if let error = error {
                    continuation.resume(throwing: CaptureError.streamStartFailed(error.localizedDescription))
                } else {
                    continuation.resume()
                }
            }
        }

        self.stream = captureStream
        self.isRunning = true

        fputs("STATUS: Recording started\n", stderr)
    }

    /// Stop capturing and finalise the WAV file
    func stop() async throws {
        guard isRunning, let stream = stream else { return }

        isRunning = false

        do {
            try await stream.stopCapture()
        } catch {
            fputs("WARNING: Error stopping stream: \(error.localizedDescription)\n", stderr)
        }

        try wavWriter?.finalise()

        self.stream = nil
        self.wavWriter = nil

        fputs("STATUS: Recording stopped\n", stderr)
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        fputs("ERROR: SCStream stopped with error: \(error.localizedDescription)\n", stderr)
        isRunning = false
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        if !isRunning {
            fputs("DEBUG: Received buffer but not running\n", stderr)
            return
        }

        if type != .audio {
            return
        }

        do {
            try wavWriter?.write(buffer: sampleBuffer)
        } catch {
            fputs("ERROR: Failed to write audio buffer: \(error.localizedDescription)\n", stderr)
        }
    }
}
