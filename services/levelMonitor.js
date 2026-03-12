const fs = require('fs');

/**
 * Audio Level Monitor
 *
 * Polls WAV files being written and computes RMS audio levels.
 * Works by reading the trailing bytes of each file and computing
 * a dB-scaled level from 16-bit PCM data.
 *
 * No changes needed to the recording processes — we just read
 * the files they're writing.
 */
class LevelMonitor {
  /**
   * @param {Function} callback - Called with { trackName: level (0-1), ... }
   * @param {number} [intervalMs=150] - Polling interval in ms
   */
  constructor(callback, intervalMs = 150) {
    this.callback = callback;
    this.intervalMs = intervalMs;
    this.tracks = {};
    this.interval = null;
  }

  /**
   * Register a WAV file to monitor
   *
   * @param {string} name - Track identifier (e.g. 'system', 'mic')
   * @param {string} filePath - Path to the WAV file being written
   */
  addTrack(name, filePath) {
    this.tracks[name] = { path: filePath };
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => this._poll(), this.intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.tracks = {};
  }

  /** @private */
  _poll() {
    const levels = {};

    for (const [name, track] of Object.entries(this.tracks)) {
      levels[name] = this._readLevel(track.path);
    }

    this.callback(levels);
  }

  /**
   * Read the last ~100ms of a 16kHz 16-bit mono WAV and compute RMS level.
   *
   * @param {string} filePath
   * @returns {number} Level between 0 and 1
   * @private
   */
  _readLevel(filePath) {
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const stats = fs.fstatSync(fd);
      const fileSize = stats.size;

      // 100ms of 16kHz 16-bit mono = 3200 bytes
      const WAV_HEADER = 44;
      const chunkSize = 3200;
      const dataSize = fileSize - WAV_HEADER;

      if (dataSize <= 0) {
        return 0;
      }

      const readLength = Math.min(chunkSize, dataSize);
      const readStart = WAV_HEADER + dataSize - readLength;

      const buffer = Buffer.alloc(readLength);
      fs.readSync(fd, buffer, 0, readLength, readStart);

      // Compute RMS from 16-bit signed PCM samples
      let sumSquares = 0;
      const sampleCount = Math.floor(readLength / 2);

      if (sampleCount === 0) return 0;

      for (let i = 0; i < sampleCount; i++) {
        const sample = buffer.readInt16LE(i * 2) / 32768;
        sumSquares += sample * sample;
      }

      const rms = Math.sqrt(sumSquares / sampleCount);

      // Convert to dB, map -60dB..0dB → 0..1
      const db = 20 * Math.log10(Math.max(rms, 0.000001));
      return Math.max(0, Math.min(1, (db + 60) / 60));
    } catch {
      return 0;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }
}

module.exports = { LevelMonitor };
