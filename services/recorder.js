const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findBlackHoleDevice, checkSckAvailable } = require('../utils/audioDevices');

/**
 * Determine the best system audio capture method available.
 *
 * Priority: ScreenCaptureKit > sox+BlackHole
 *
 * @param {string|null} sckBinaryPath - Path to sck-audio-capture binary
 * @returns {{method: 'sck'|'blackhole', sckBinaryPath?: string, blackholeDevice?: string}}
 * @throws {Error} If no capture method is available
 */
function resolveSystemCaptureMethod(sckBinaryPath) {
  // Try SCK first
  if (sckBinaryPath) {
    const sckStatus = checkSckAvailable(sckBinaryPath);
    if (sckStatus.available && sckStatus.permitted) {
      console.log('System audio capture: using ScreenCaptureKit');
      return { method: 'sck', sckBinaryPath };
    }
    if (sckStatus.available && sckStatus.permitted === false) {
      console.warn('ScreenCaptureKit available but permission not granted, falling back to BlackHole');
    } else {
      console.log(`ScreenCaptureKit not available: ${sckStatus.reason}`);
    }
  }

  // Fall back to BlackHole
  try {
    const device = findBlackHoleDevice();
    console.log('System audio capture: using BlackHole');
    return { method: 'blackhole', blackholeDevice: device };
  } catch (err) {
    throw new Error(
      'No system audio capture method available.\n' +
      'Either grant Screen Recording permission (macOS 13+) or install BlackHole 2ch.'
    );
  }
}

/**
 * Audio Recorder Service
 *
 * Records system audio via ScreenCaptureKit (preferred) or sox+BlackHole (fallback).
 * Handles subprocess management, file size monitoring, and graceful shutdown.
 */
class Recorder {
  /**
   * Create a new Recorder instance
   *
   * @param {string} outputDir - Base directory for recordings
   * @param {string|null} [sckBinaryPath=null] - Path to sck-audio-capture binary
   */
  constructor(outputDir, sckBinaryPath = null) {
    this.outputDir = outputDir;
    this.sckBinaryPath = sckBinaryPath;
    this.captureProcess = null;
    this.captureMethod = null;
    this.currentFile = null;
    this.isRecording = false;
    this.startTime = null;
    this.sizeInterval = null;
    this.maxRecordingSize = 1024 * 1024 * 1024; // 1GB
  }

  /**
   * Start recording audio
   *
   * @param {Function} [warningCallback] - Optional callback for size warnings
   * @returns {{filepath: string, startTime: number, captureMethod: string}} Recording metadata
   * @throws {Error} If already recording or if device not found
   */
  start(warningCallback) {
    if (this.isRecording) {
      throw new Error('Already recording. Stop the current recording first.');
    }

    // Ensure recordings directory exists
    const recordingsDir = path.join(this.outputDir, 'recordings');
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    this.currentFile = path.join(recordingsDir, `${timestamp}_recording.wav`);

    // Resolve capture method
    const capture = resolveSystemCaptureMethod(this.sckBinaryPath);
    this.captureMethod = capture.method;

    if (capture.method === 'sck') {
      this.captureProcess = spawn(capture.sckBinaryPath, [
        this.currentFile,
        '--sample-rate', '16000',
        '--channels', '1',
        '--bit-depth', '16'
      ]);
      console.log('Using ScreenCaptureKit for system audio capture');
    } else {
      this.captureProcess = spawn('sox', [
        '-t', 'coreaudio',
        capture.blackholeDevice,
        '-r', '16000',
        '-b', '16',
        '-c', '1',
        this.currentFile
      ]);
      console.log(`Using sox+BlackHole for system audio capture (device: ${capture.blackholeDevice})`);
    }

    // Handle process errors
    this.captureProcess.on('error', (err) => {
      console.error(`${this.captureMethod} process error:`, err);
      this.isRecording = false;
      throw new Error(`Failed to start recording: ${err.message}`);
    });

    // Handle unexpected exit
    this.captureProcess.on('exit', (code, signal) => {
      if (this.isRecording) {
        console.error(`${this.captureMethod} process exited unexpectedly: code=${code}, signal=${signal}`);
        // Check for SCK permission error
        if (this.captureMethod === 'sck' && code === 2 && warningCallback) {
          warningCallback('Screen Recording permission denied. Please grant permission in System Settings.');
        }
        this.isRecording = false;
      }
    });

    // Log stderr for debugging
    this.captureProcess.stderr.on('data', (data) => {
      console.log(`${this.captureMethod} stderr: ${data}`);
    });

    this.isRecording = true;
    this.startTime = Date.now();

    // Health check: if SCK produces no audio after 3s, fall back to BlackHole
    if (capture.method === 'sck') {
      this._sckHealthTimeout = setTimeout(() => {
        if (!this.isRecording) return;
        try {
          const stats = fs.statSync(this.currentFile);
          if (stats.size <= 44) {
            console.warn('SCK produced no audio data after 3s — falling back to BlackHole');
            this._fallbackToBlackHole(warningCallback);
          }
        } catch { /* file not ready yet */ }
      }, 3000);
    }

    // Start file size monitoring
    if (warningCallback) {
      this.startSizeMonitor(warningCallback);
    }

    return {
      filepath: this.currentFile,
      startTime: this.startTime,
      captureMethod: this.captureMethod
    };
  }

  /**
   * Fall back from SCK to sox+BlackHole mid-recording
   * @private
   */
  _fallbackToBlackHole(warningCallback) {
    try {
      if (this.captureProcess) this.captureProcess.kill('SIGTERM');
    } catch { /* already dead */ }

    let blackholeDevice;
    try {
      blackholeDevice = findBlackHoleDevice();
    } catch (err) {
      console.error('BlackHole fallback failed — no device:', err.message);
      if (warningCallback) warningCallback('System audio capture failed. No fallback available.');
      return;
    }

    try { fs.unlinkSync(this.currentFile); } catch { /* ignore */ }

    this.captureMethod = 'blackhole';
    this.captureProcess = spawn('sox', [
      '-t', 'coreaudio',
      blackholeDevice,
      '-r', '16000',
      '-b', '16',
      '-c', '1',
      this.currentFile
    ]);

    this.captureProcess.on('error', (err) => {
      console.error('BlackHole fallback error:', err);
    });

    this.captureProcess.stderr.on('data', (data) => {
      console.log(`system capture (blackhole) stderr: ${data}`);
    });

    console.log(`Fell back to sox+BlackHole (device: ${blackholeDevice})`);
    if (warningCallback) warningCallback('ScreenCaptureKit unavailable — using BlackHole for system audio.');
  }

  /**
   * Stop recording audio
   *
   * @returns {Promise<{filepath: string, duration: number, size: number}>} Recording metadata
   * @throws {Error} If not currently recording
   */
  stop() {
    return new Promise((resolve, reject) => {
      if (!this.isRecording || !this.captureProcess) {
        reject(new Error('Not currently recording'));
        return;
      }

      // Mark as stopped immediately so tray menu can update
      const duration = Date.now() - this.startTime;
      this.isRecording = false;

      // Clear SCK health check if pending
      if (this._sckHealthTimeout) {
        clearTimeout(this._sckHealthTimeout);
        this._sckHealthTimeout = null;
      }

      // Stop size monitoring
      if (this.sizeInterval) {
        clearInterval(this.sizeInterval);
        this.sizeInterval = null;
      }

      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;

        // Verify file exists and get size
        if (!fs.existsSync(this.currentFile)) {
          reject(new Error('Recording file was not created'));
          return;
        }

        const stats = fs.statSync(this.currentFile);

        // Verify file has content
        if (stats.size === 0) {
          reject(new Error('Recording file is empty. Check audio routing.'));
          return;
        }

        resolve({
          filepath: this.currentFile,
          duration: duration,
          size: stats.size
        });
      };

      // Wait for process to finish writing
      this.captureProcess.on('exit', () => finish());

      // Send SIGTERM to gracefully stop
      try {
        this.captureProcess.kill('SIGTERM');
      } catch (err) {
        reject(new Error(`Failed to stop recording: ${err.message}`));
        return;
      }

      // Timeout: if process doesn't exit after 10s, SIGKILL and resolve
      setTimeout(() => {
        if (settled) return;
        console.warn('Recorder process did not exit after 10s — sending SIGKILL');
        try { this.captureProcess.kill('SIGKILL'); } catch { /* already dead */ }
        setTimeout(() => finish(), 200);
      }, 10000);
    });
  }

  /**
   * Get current recording status
   *
   * @returns {{isRecording: boolean, duration: number, filepath: string}|null}
   */
  getStatus() {
    if (!this.isRecording) {
      return null;
    }

    return {
      isRecording: true,
      duration: Date.now() - this.startTime,
      filepath: this.currentFile
    };
  }

  /**
   * Monitor recording file size and warn if too large
   *
   * @param {Function} callback - Called with warning message if size exceeds limit
   * @private
   */
  startSizeMonitor(callback) {
    this.sizeInterval = setInterval(() => {
      if (!this.isRecording || !this.currentFile) {
        clearInterval(this.sizeInterval);
        return;
      }

      try {
        const stats = fs.statSync(this.currentFile);

        if (stats.size > this.maxRecordingSize) {
          const sizeMB = Math.round(stats.size / (1024 * 1024));
          callback(`Recording size is ${sizeMB}MB. Consider stopping to avoid disk space issues.`);
        }
      } catch (err) {
        // File might not exist yet
      }
    }, 30000); // Check every 30 seconds
  }

  /**
   * Force cleanup (for emergency shutdown)
   */
  cleanup() {
    if (this.sizeInterval) {
      clearInterval(this.sizeInterval);
      this.sizeInterval = null;
    }

    if (this.captureProcess && this.isRecording) {
      try {
        this.captureProcess.kill('SIGKILL');
      } catch (err) {
        // Process already dead
      }
    }

    this.isRecording = false;
  }
}

/**
 * Dual-Track Audio Recorder
 *
 * Records system audio (via ScreenCaptureKit or BlackHole) and microphone audio
 * simultaneously as separate tracks in a session directory.
 * Enables pseudo-speaker separation.
 */
class DualTrackRecorder {
  /**
   * Create a new DualTrackRecorder
   *
   * @param {string} outputDir - Base directory for recordings
   * @param {string} micDevice - Microphone device name for sox
   * @param {string} [systemLabel='Remote'] - Label for system audio speaker
   * @param {string} [micLabel='Me'] - Label for mic audio speaker
   * @param {string|null} [sckBinaryPath=null] - Path to sck-audio-capture binary
   * @param {object} [meetingContext={}] - Meeting context (title, participants, agenda)
   */
  constructor(outputDir, micDevice, systemLabel = 'Remote', micLabel = 'Me', sckBinaryPath = null, meetingContext = {}) {
    this.outputDir = outputDir;
    this.micDevice = micDevice;
    this.systemLabel = systemLabel;
    this.micLabel = micLabel;
    this.sckBinaryPath = sckBinaryPath;
    this.meetingContext = meetingContext;
    this.systemProcess = null;
    this.micProcess = null;
    this.captureMethod = null;
    this.sessionDir = null;
    this.systemFile = null;
    this.micFile = null;
    this.isRecording = false;
    this.startTime = null;
    this.manifest = null;
  }

  /**
   * Start dual-track recording
   *
   * @param {Function} [warningCallback] - Optional callback for warnings
   * @returns {{sessionDir: string, systemFile: string, micFile: string, startTime: number, captureMethod: string}}
   * @throws {Error} If already recording or devices not found
   */
  start(warningCallback) {
    if (this.isRecording) {
      throw new Error('Already recording. Stop the current recording first.');
    }

    // Resolve system audio capture method
    const capture = resolveSystemCaptureMethod(this.sckBinaryPath);
    this.captureMethod = capture.method;

    console.log(`Microphone device: ${this.micDevice}`);

    // Create session directory
    const recordingsDir = path.join(this.outputDir, 'recordings');
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const sessionId = timestamp;
    this.sessionDir = path.join(recordingsDir, `${timestamp}_session`);
    fs.mkdirSync(this.sessionDir, { recursive: true });

    this.systemFile = path.join(this.sessionDir, 'system.wav');
    this.micFile = path.join(this.sessionDir, 'mic.wav');

    // Write initial manifest
    this.manifest = {
      version: 1,
      sessionId: sessionId,
      mode: 'dual',
      captureMethod: this.captureMethod,
      startTime: new Date().toISOString(),
      endTime: null,
      duration: 0,
      tracks: {
        system: {
          file: 'system.wav',
          device: capture.method === 'sck' ? 'ScreenCaptureKit' : capture.blackholeDevice,
          sampleRate: 16000,
          channels: 1,
          bitDepth: 16,
          status: 'recording',
          size: 0,
          label: this.systemLabel
        },
        mic: {
          file: 'mic.wav',
          device: this.micDevice,
          sampleRate: 16000,
          channels: 1,
          bitDepth: 16,
          status: 'recording',
          size: 0,
          label: this.micLabel
        }
      },
      meetingContext: {
        title: this.meetingContext.title || '',
        participants: this.meetingContext.participants || '',
        agenda: this.meetingContext.agenda || ''
      },
      processing: {
        transcription: { system: null, mic: null, merged: null },
        summarisation: null,
        obsidianExport: null
      }
    };

    fs.writeFileSync(
      path.join(this.sessionDir, 'manifest.json'),
      JSON.stringify(this.manifest, null, 2),
      'utf-8'
    );

    // Spawn system audio process (16kHz mono — matches whisper.cpp native format)
    if (capture.method === 'sck') {
      this.systemProcess = spawn(capture.sckBinaryPath, [
        this.systemFile,
        '--sample-rate', '16000',
        '--channels', '1',
        '--bit-depth', '16'
      ]);
      console.log('System audio: ScreenCaptureKit');
    } else {
      this.systemProcess = spawn('sox', [
        '-t', 'coreaudio',
        capture.blackholeDevice,
        '-r', '16000',
        '-b', '16',
        '-c', '1',
        this.systemFile
      ]);
      console.log(`System audio: sox+BlackHole (device: ${capture.blackholeDevice})`);
    }

    this.systemProcess.on('error', (err) => {
      console.error('System capture process error:', err);
      this.manifest.tracks.system.status = 'error';
      if (warningCallback) warningCallback(`System audio error: ${err.message}`);
    });

    this.systemProcess.on('exit', (code, signal) => {
      if (this.isRecording) {
        console.error(`System capture exited unexpectedly: code=${code}, signal=${signal}`);
        this.manifest.tracks.system.status = 'failed';
        // If SCK permission denied during recording, notify
        if (this.captureMethod === 'sck' && code === 2 && warningCallback) {
          warningCallback('Screen Recording permission denied during recording.');
        }
      }
    });

    this.systemProcess.stderr.on('data', (data) => {
      console.log(`system capture stderr: ${data}`);
    });

    // Health check: if SCK produces no audio after 3s, fall back to BlackHole
    if (capture.method === 'sck') {
      this._sckHealthTimeout = setTimeout(() => {
        if (!this.isRecording) return;
        try {
          const stats = fs.statSync(this.systemFile);
          if (stats.size <= 44) {
            console.warn('SCK produced no audio data after 3s — falling back to BlackHole');
            this._fallbackToBlackHole(warningCallback);
          }
        } catch { /* file not ready yet, will be caught next time */ }
      }, 3000);
    }

    // Spawn mic sox process (always sox)
    this.micProcess = spawn('sox', [
      '-t', 'coreaudio',
      this.micDevice,
      '-r', '16000',
      '-b', '16',
      '-c', '1',
      this.micFile
    ]);

    this.micProcess.on('error', (err) => {
      console.error('Mic sox process error:', err);
      this.manifest.tracks.mic.status = 'error';
      if (warningCallback) warningCallback(`Microphone error: ${err.message}`);
    });

    this.micProcess.on('exit', (code, signal) => {
      if (this.isRecording) {
        console.error(`Mic sox exited unexpectedly: code=${code}, signal=${signal}`);
        this.manifest.tracks.mic.status = 'failed';
      }
    });

    this.micProcess.stderr.on('data', (data) => {
      console.log(`mic sox stderr: ${data}`);
    });

    this.isRecording = true;
    this.startTime = Date.now();

    console.log(`Dual-track recording started in: ${this.sessionDir}`);

    return {
      sessionDir: this.sessionDir,
      systemFile: this.systemFile,
      micFile: this.micFile,
      startTime: this.startTime,
      captureMethod: this.captureMethod
    };
  }

  /**
   * Fall back from SCK to sox+BlackHole for system audio mid-recording
   * @private
   */
  _fallbackToBlackHole(warningCallback) {
    // Kill the SCK process
    try {
      if (this.systemProcess) this.systemProcess.kill('SIGTERM');
    } catch { /* already dead */ }

    // Find BlackHole device
    let blackholeDevice;
    try {
      blackholeDevice = findBlackHoleDevice();
    } catch (err) {
      console.error('BlackHole fallback failed — no BlackHole device:', err.message);
      if (warningCallback) warningCallback('System audio capture failed. No fallback available.');
      return;
    }

    // Delete the empty system.wav and respawn with sox+BlackHole
    try { fs.unlinkSync(this.systemFile); } catch { /* ignore */ }

    this.captureMethod = 'blackhole';
    this.manifest.captureMethod = 'blackhole';
    this.manifest.tracks.system.device = blackholeDevice;

    this.systemProcess = spawn('sox', [
      '-t', 'coreaudio',
      blackholeDevice,
      '-r', '16000',
      '-b', '16',
      '-c', '1',
      this.systemFile
    ]);

    this.systemProcess.on('error', (err) => {
      console.error('BlackHole fallback process error:', err);
      this.manifest.tracks.system.status = 'error';
      if (warningCallback) warningCallback(`System audio error: ${err.message}`);
    });

    this.systemProcess.on('exit', (code, signal) => {
      if (this.isRecording) {
        console.error(`BlackHole fallback exited unexpectedly: code=${code}, signal=${signal}`);
        this.manifest.tracks.system.status = 'failed';
      }
    });

    this.systemProcess.stderr.on('data', (data) => {
      console.log(`system capture (blackhole) stderr: ${data}`);
    });

    console.log(`Fell back to sox+BlackHole (device: ${blackholeDevice})`);
    if (warningCallback) warningCallback('ScreenCaptureKit unavailable — using BlackHole for system audio.');
  }

  /**
   * Stop dual-track recording
   *
   * @returns {Promise<{sessionDir: string, systemFile: string, micFile: string, duration: number, systemSize: number, micSize: number, manifest: object}>}
   */
  stop() {
    return new Promise((resolve, reject) => {
      if (!this.isRecording) {
        reject(new Error('Not currently recording'));
        return;
      }

      const duration = Date.now() - this.startTime;
      this.isRecording = false;

      // Clear SCK health check if pending
      if (this._sckHealthTimeout) {
        clearTimeout(this._sckHealthTimeout);
        this._sckHealthTimeout = null;
      }

      // Helper: stop a process with a 10s timeout before SIGKILL
      const stopWithTimeout = (proc, label) => new Promise((res) => {
        if (!proc) { res(label); return; }

        let done = false;
        proc.on('exit', () => { if (!done) { done = true; res(label); } });

        try {
          proc.kill('SIGTERM');
        } catch (err) {
          console.error(`Failed to stop ${label} process:`, err.message);
          done = true; res(label); return;
        }

        setTimeout(() => {
          if (done) return;
          console.warn(`${label} process did not exit after 10s — sending SIGKILL`);
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
          setTimeout(() => { if (!done) { done = true; res(label); } }, 200);
        }, 10000);
      });

      // Kill both processes and wait for them to settle
      const stopPromises = [
        stopWithTimeout(this.systemProcess, 'system'),
        stopWithTimeout(this.micProcess, 'mic')
      ];

      // Wait for both to finish (partial success is OK)
      Promise.allSettled(stopPromises).then(() => {
        // Small delay to let files flush
        setTimeout(() => {
          let systemSize = 0;
          let micSize = 0;

          // Check system file
          if (fs.existsSync(this.systemFile)) {
            const stats = fs.statSync(this.systemFile);
            systemSize = stats.size;
            this.manifest.tracks.system.size = systemSize;
            this.manifest.tracks.system.status = systemSize > 0 ? 'complete' : 'empty';
          } else {
            this.manifest.tracks.system.status = 'missing';
          }

          // Check mic file
          if (fs.existsSync(this.micFile)) {
            const stats = fs.statSync(this.micFile);
            micSize = stats.size;
            this.manifest.tracks.mic.size = micSize;
            this.manifest.tracks.mic.status = micSize > 0 ? 'complete' : 'empty';
          } else {
            this.manifest.tracks.mic.status = 'missing';
          }

          // Update manifest
          this.manifest.endTime = new Date().toISOString();
          this.manifest.duration = duration;

          fs.writeFileSync(
            path.join(this.sessionDir, 'manifest.json'),
            JSON.stringify(this.manifest, null, 2),
            'utf-8'
          );

          console.log(`Dual-track recording stopped. Duration: ${Math.round(duration / 1000)}s`);
          console.log(`  System: ${(systemSize / (1024 * 1024)).toFixed(2)} MB (${this.manifest.tracks.system.status})`);
          console.log(`  Mic: ${(micSize / (1024 * 1024)).toFixed(2)} MB (${this.manifest.tracks.mic.status})`);

          resolve({
            sessionDir: this.sessionDir,
            systemFile: this.systemFile,
            micFile: this.micFile,
            duration: duration,
            systemSize: systemSize,
            micSize: micSize,
            manifest: this.manifest
          });
        }, 500);
      });
    });
  }

  /**
   * Get current recording status
   *
   * @returns {{isRecording: boolean, duration: number, sessionDir: string, tracks: object}|null}
   */
  getStatus() {
    if (!this.isRecording) {
      return null;
    }

    return {
      isRecording: true,
      duration: Date.now() - this.startTime,
      sessionDir: this.sessionDir,
      tracks: {
        system: { status: this.manifest.tracks.system.status },
        mic: { status: this.manifest.tracks.mic.status }
      }
    };
  }

  /**
   * Force cleanup (for emergency shutdown)
   */
  cleanup() {
    if (this.systemProcess && this.isRecording) {
      try { this.systemProcess.kill('SIGKILL'); } catch (err) { /* already dead */ }
    }
    if (this.micProcess && this.isRecording) {
      try { this.micProcess.kill('SIGKILL'); } catch (err) { /* already dead */ }
    }
    this.isRecording = false;
  }
}

module.exports = { Recorder, DualTrackRecorder };
