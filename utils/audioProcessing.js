const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Trim leading and trailing silence from a WAV file using sox.
 *
 * Gracefully degrades — resolves (never rejects) so the pipeline
 * continues with the untrimmed file on any error.
 *
 * @param {string} inputFile - Absolute path to the WAV file
 * @param {object} [options]
 * @param {number} [options.threshold=0.1] - Silence threshold (% amplitude)
 * @param {number} [options.minDuration=0.5] - Minimum silence duration (seconds)
 * @param {number} [options.minOutputBytes=1024] - Files smaller than this after trim are considered all-silence
 * @param {Function} [options.registerProcess] - Optional callback to register spawned process for cleanup
 * @returns {Promise<{trimmed: boolean, allSilence?: boolean, originalSize?: number, trimmedSize?: number, savedBytes?: number}>}
 */
function trimSilence(inputFile, options = {}) {
  const {
    threshold = 0.1,
    minDuration = 0.5,
    minOutputBytes = 1024,
    registerProcess
  } = options;

  return new Promise((resolve) => {
    // Verify input file exists
    if (!fs.existsSync(inputFile)) {
      console.warn(`trimSilence: input file not found: ${inputFile}`);
      resolve({ trimmed: false });
      return;
    }

    const originalSize = fs.statSync(inputFile).size;
    const dir = path.dirname(inputFile);
    const ext = path.extname(inputFile);
    const base = path.basename(inputFile, ext);
    const tmpFile = path.join(dir, `${base}_trimmed${ext}`);

    // sox in.wav out.wav silence 1 <dur> <thresh>% reverse silence 1 <dur> <thresh>% reverse
    // This trims leading silence, reverses, trims leading silence (= trailing), reverses back
    const args = [
      inputFile,
      '-r', '16000', '-b', '16', '-c', '1',
      tmpFile,
      'silence', '1', `${minDuration}`, `${threshold}%`,
      'reverse',
      'silence', '1', `${minDuration}`, `${threshold}%`,
      'reverse'
    ];

    const proc = spawn('sox', args);

    if (registerProcess) {
      registerProcess(proc);
    }

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('error', (err) => {
      console.warn(`trimSilence: sox spawn error: ${err.message}`);
      // Clean up temp file if it was partially written
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      resolve({ trimmed: false });
    });

    proc.on('exit', (code) => {
      if (code !== 0) {
        console.warn(`trimSilence: sox exited with code ${code}: ${stderr.trim()}`);
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        resolve({ trimmed: false });
        return;
      }

      try {
        const trimmedSize = fs.statSync(tmpFile).size;

        // All-silence guard: if output is too small, keep original
        if (trimmedSize < minOutputBytes) {
          console.log(`trimSilence: output too small (${trimmedSize} bytes) — likely all silence, keeping original`);
          try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
          resolve({ trimmed: false, allSilence: true, originalSize });
          return;
        }

        // Replace original with trimmed version
        fs.renameSync(tmpFile, inputFile);

        const savedBytes = originalSize - trimmedSize;
        const savedPct = ((savedBytes / originalSize) * 100).toFixed(1);
        console.log(`trimSilence: ${path.basename(inputFile)} — ${savedPct}% trimmed (${(savedBytes / 1024).toFixed(0)} KB saved)`);

        resolve({
          trimmed: true,
          originalSize,
          trimmedSize,
          savedBytes
        });
      } catch (err) {
        console.warn(`trimSilence: post-processing error: ${err.message}`);
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        resolve({ trimmed: false });
      }
    });
  });
}

/**
 * Repair a WAV file whose RIFF/data size headers are zero (e.g. from an
 * unclean SCK shutdown).  Calculates the correct sizes from the actual
 * file length and patches the header in-place.
 *
 * @param {string} wavPath - Absolute path to the WAV file
 * @returns {boolean} true if the header was repaired, false if no repair was needed
 */
function repairWavHeader(wavPath) {
  if (!fs.existsSync(wavPath)) return false;

  const fd = fs.openSync(wavPath, 'r+');
  try {
    const header = Buffer.alloc(44);
    const bytesRead = fs.readSync(fd, header, 0, 44, 0);
    if (bytesRead < 44) return false;

    // Verify this is a RIFF/WAVE file
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      return false;
    }

    const riffSize = header.readUInt32LE(4);
    const dataSize = header.readUInt32LE(40);

    // Only repair if both size fields are zero (placeholder header)
    if (riffSize !== 0 || dataSize !== 0) return false;

    const fileSize = fs.fstatSync(fd).size;
    const actualDataSize = fileSize - 44;
    if (actualDataSize <= 0) return false;

    // Patch RIFF chunk size (offset 4) = fileSize - 8
    const buf4 = Buffer.alloc(4);
    buf4.writeUInt32LE(fileSize - 8, 0);
    fs.writeSync(fd, buf4, 0, 4, 4);

    // Patch data chunk size (offset 40)
    buf4.writeUInt32LE(actualDataSize, 0);
    fs.writeSync(fd, buf4, 0, 4, 40);

    console.log(`WAV header repaired: ${path.basename(wavPath)} (data size: ${(actualDataSize / (1024 * 1024)).toFixed(2)} MB)`);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { trimSilence, repairWavHeader };
