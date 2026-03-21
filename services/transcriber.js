const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { mergeTranscripts } = require('./transcriptMerger');
const { checkForProvider, readSharedTranscript, writeCompanionOutputs } = require('./companionTranscript');

/**
 * Find whisper.cpp binary
 *
 * Checks multiple common installation locations.
 *
 * @returns {string} Path to whisper binary
 * @throws {Error} If whisper.cpp binary not found
 */
function findWhisperBinary() {
  const possiblePaths = [
    '/opt/homebrew/bin/whisper-cpp',            // Homebrew (Apple Silicon)
    '/opt/homebrew/bin/whisper-cli',            // Homebrew alt name
    '/usr/local/bin/whisper-cpp',               // Homebrew (Intel)
    '/usr/local/bin/whisper-cli',               // Homebrew alt name (Intel)
    './whisper.cpp/build/bin/whisper-cli',      // Local CMake build
    './whisper.cpp/main',                        // Local Makefile build
    path.join(__dirname, '../whisper.cpp/build/bin/whisper-cli'),
    path.join(__dirname, '../whisper.cpp/main'),
    '/usr/local/bin/whisper',
    '/opt/homebrew/bin/whisper',
    path.join(process.env.HOME, '.local/bin/whisper')
  ];

  for (let p of possiblePaths) {
    const resolvedPath = path.resolve(p);
    if (fs.existsSync(resolvedPath)) {
      console.log(`Found whisper binary at: ${resolvedPath}`);
      return resolvedPath;
    }
  }

  throw new Error(
    'whisper.cpp binary not found.\n' +
    'Please run ./setup.sh or manually compile whisper.cpp:\n' +
    '  git clone https://github.com/ggerganov/whisper.cpp.git\n' +
    '  cd whisper.cpp && make'
  );
}

/**
 * Find whisper model file
 *
 * Checks multiple common model locations.
 *
 * @returns {string} Path to model file
 * @throws {Error} If model file not found
 */
function findWhisperModel() {
  const possibleModels = [
    // VoiceInk's large-v3-turbo (best quality)
    path.join(process.env.HOME, 'Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels/ggml-large-v3-turbo.bin'),
    path.join(process.env.HOME, 'Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels/ggml-large-v3-turbo-q5_0.bin'),
    // Homebrew whisper-cpp model location
    '/opt/homebrew/share/whisper-cpp/models/ggml-base.en.bin',
    // Local project models
    './models/ggml-base.en.bin',
    './whisper.cpp/models/ggml-base.en.bin',
    path.join(__dirname, '../models/ggml-base.en.bin'),
    path.join(__dirname, '../whisper.cpp/models/ggml-base.en.bin'),
    path.join(process.env.HOME, '.whisper/models/ggml-base.en.bin')
  ];

  for (let m of possibleModels) {
    const resolvedPath = path.resolve(m);
    if (fs.existsSync(resolvedPath)) {
      console.log(`Found whisper model at: ${resolvedPath}`);
      return resolvedPath;
    }
  }

  throw new Error(
    'Whisper model not found.\n' +
    'Please run ./setup.sh or manually download:\n' +
    '  cd whisper.cpp\n' +
    '  bash ./models/download-ggml-model.sh base.en\n' +
    '  cp models/ggml-base.en.bin ../models/'
  );
}

/**
 * Transcribe audio file using whisper.cpp
 *
 * @param {string} wavPath - Path to WAV audio file
 * @param {string} outputDir - Base directory for output
 * @param {Function} [progressCallback] - Optional callback for progress updates (0-100)
 * @param {string} [outputPrefix] - Optional output prefix (defaults to basename-derived)
 * @param {boolean} [outputCsv=false] - Also output CSV format for merging
 * @returns {Promise<string>} Path to generated transcript file
 * @throws {Error} If transcription fails
 */
async function transcribe(wavPath, outputDir, progressCallback, outputPrefix, outputCsv = false) {
  // Verify input file exists
  if (!fs.existsSync(wavPath)) {
    throw new Error(`Audio file not found: ${wavPath}`);
  }

  // Get whisper binary and model
  const whisperBin = findWhisperBinary();
  const modelPath = findWhisperModel();

  // Ensure processed directory exists
  const processedDir = path.join(outputDir, 'processed');
  if (!fs.existsSync(processedDir)) {
    fs.mkdirSync(processedDir, { recursive: true });
  }

  // Generate output filename
  const prefix = outputPrefix || path.join(processedDir, `${path.basename(wavPath, '.wav')}_transcript`);

  console.log(`Starting transcription: ${wavPath}`);
  console.log(`Output prefix: ${prefix}`);

  // Calculate timeout based on file size: 10 minutes per 20MB, minimum 5 minutes
  const fileSizeBytes = fs.statSync(wavPath).size;
  const fileSizeMB = fileSizeBytes / (1024 * 1024);
  const timeoutMs = Math.max(5 * 60 * 1000, Math.ceil(fileSizeMB / 20) * 10 * 60 * 1000);
  console.log(`Whisper timeout: ${Math.round(timeoutMs / 60000)} minutes for ${fileSizeMB.toFixed(1)} MB file`);

  return new Promise((resolve, reject) => {
    // Build whisper args
    const args = [
      '-m', modelPath,        // Model file
      '-f', wavPath,          // Input audio file
      '-otxt',                // Output format: txt
      '-of', prefix,          // Output file prefix
      '--print-progress',     // Print progress to stderr
      '--language', 'en',     // Language: English
      '--threads', '4',       // Use 4 threads
      '--processors', '2'     // Split audio into 2 chunks processed concurrently
    ];

    // Add CSV output if requested (for dual-track merging)
    if (outputCsv) {
      args.push('-ocsv');
    }

    const whisper = spawn(whisperBin, args);
    let settled = false;

    // Timeout: kill whisper if it takes too long
    const timeoutHandle = setTimeout(() => {
      if (!settled) {
        settled = true;
        whisper.kill('SIGKILL');
        reject(new Error(`whisper.cpp timed out after ${Math.round(timeoutMs / 60000)} minutes (file: ${fileSizeMB.toFixed(1)} MB)`));
      }
    }, timeoutMs);

    let stderrData = '';
    let lastProgress = 0;

    // Capture stderr for progress updates
    whisper.stderr.on('data', (data) => {
      stderrData += data.toString();

      if (progressCallback) {
        const progressMatch = stderrData.match(/progress\s*=\s*(\d+)%/);
        if (progressMatch) {
          const progress = parseInt(progressMatch[1]);
          if (progress !== lastProgress) {
            lastProgress = progress;
            progressCallback(progress);
          }
        }
      }
    });

    // Capture stdout
    whisper.stdout.on('data', (data) => {
      console.log(`whisper stdout: ${data.toString().trim()}`);
    });

    // Handle completion
    whisper.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;

      if (code === 0) {
        const transcriptPath = `${prefix}.txt`;

        if (fs.existsSync(transcriptPath)) {
          console.log(`Transcription complete: ${transcriptPath}`);

          const stats = fs.statSync(transcriptPath);
          if (stats.size === 0) {
            reject(new Error('Transcript file is empty. Audio may be silent or corrupted.'));
            return;
          }

          resolve(transcriptPath);
        } else {
          reject(new Error(`Transcript file not created: ${transcriptPath}`));
        }
      } else {
        reject(new Error(`whisper.cpp failed with exit code ${code}\n${stderrData}`));
      }
    });

    // Handle errors
    whisper.on('error', (err) => {
      clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to start whisper.cpp: ${err.message}`));
    });
  });
}

/**
 * Transcribe a dual-track session
 *
 * Transcribes both system and mic tracks, then merges them into
 * a speaker-labeled transcript.
 *
 * @param {string} sessionDir - Path to session directory (containing manifest.json)
 * @param {string} outputDir - Base output directory
 * @param {Function} [progressCallback] - Optional callback with progress (0-100)
 * @returns {Promise<{systemTranscript: string|null, micTranscript: string|null, mergedTranscript: string}>}
 */
async function transcribeSession(sessionDir, outputDir, progressCallback, options = {}) {
  // Read manifest
  const manifestPath = path.join(sessionDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Session manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const sessionId = manifest.sessionId;

  // Create processed directory for this session
  const processedDir = path.join(outputDir, 'processed', `${sessionId}_session`);
  if (!fs.existsSync(processedDir)) {
    fs.mkdirSync(processedDir, { recursive: true });
  }

  // Companion mode check — use shared transcript from meeting-copilot if available
  const useShared = options.useSharedTranscript !== false;
  if (useShared) {
    const provider = checkForProvider();
    if (provider) {
      const segments = readSharedTranscript(provider.transcriptFile);
      if (segments.length > 0) {
        // Log segment count and time range for visibility, especially in late-start scenarios
        // where meeting-copilot started after notes4chris (partial transcript)
        const earliest = Math.min(...segments.map(s => s.timestamp));
        const latest = Math.max(...segments.map(s => s.timestamp + (s.duration || 10)));
        console.log(`[Transcriber] Companion mode — using ${segments.length} segments from ${provider.app} (${Math.round(earliest)}s – ${Math.round(latest)}s)`);

        writeCompanionOutputs(segments, processedDir);

        // Update manifest with companion source
        if (!manifest.processing) manifest.processing = {};
        if (!manifest.processing.transcription) manifest.processing.transcription = {};
        manifest.processing.transcription.system = path.join(processedDir, 'system_transcript.csv');
        manifest.processing.transcription.mic = path.join(processedDir, 'mic_transcript.csv');
        manifest.processing.transcription.merged = path.join(processedDir, 'merged_transcript.txt');
        manifest.processing.transcription.source = `companion:${provider.app}`;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

        if (progressCallback) progressCallback(100);

        return {
          systemTranscript: manifest.processing.transcription.system,
          micTranscript: manifest.processing.transcription.mic,
          mergedTranscript: manifest.processing.transcription.merged
        };
      }
      console.log('[Transcriber] Companion transcript empty, falling back to whisper');
    }
  }

  let systemTranscript = null;
  let micTranscript = null;
  let systemCsvPath = null;
  let micCsvPath = null;

  // Transcribe both tracks in parallel (0-90% progress)
  // Each track reports its own progress; we report max(system, mic) capped at 90%
  let systemProgress = 0;
  let micProgress = 0;
  const reportProgress = () => {
    if (progressCallback) {
      const combined = Math.round(Math.max(systemProgress, micProgress) * 0.9);
      progressCallback(combined);
    }
  };

  // Check if tracks are usable — trust actual file content over manifest status
  // (manifest status may be stale from an unclean shutdown)
  const systemWav = path.join(sessionDir, manifest.tracks.system.file);
  const micWav = path.join(sessionDir, manifest.tracks.mic.file);
  const systemUsable = fs.existsSync(systemWav) && fs.statSync(systemWav).size > 44;
  const micUsable = fs.existsSync(micWav) && fs.statSync(micWav).size > 44;

  const systemPromise = systemUsable
    ? (async () => {
        const systemPrefix = path.join(processedDir, 'system_transcript');
        console.log('Transcribing system track...');
        systemTranscript = await transcribe(systemWav, outputDir, (p) => {
          systemProgress = p;
          reportProgress();
        }, systemPrefix, true);
        systemCsvPath = `${systemPrefix}.csv`;
        manifest.processing.transcription.system = systemTranscript;
      })()
    : Promise.resolve();

  const micPromise = micUsable
    ? (async () => {
        const micPrefix = path.join(processedDir, 'mic_transcript');
        console.log('Transcribing mic track...');
        micTranscript = await transcribe(micWav, outputDir, (p) => {
          micProgress = p;
          reportProgress();
        }, micPrefix, true);
        micCsvPath = `${micPrefix}.csv`;
        manifest.processing.transcription.mic = micTranscript;
      })()
    : Promise.resolve();

  const results = await Promise.allSettled([systemPromise, micPromise]);

  if (results[0].status === 'rejected') {
    console.error('System track transcription failed:', results[0].reason.message);
  }
  if (results[1].status === 'rejected') {
    console.error('Mic track transcription failed:', results[1].reason.message);
  }

  // Merge transcripts (90-100% progress)
  if (progressCallback) progressCallback(90);
  console.log('Merging transcripts...');

  const mergedPath = path.join(processedDir, 'merged_transcript.txt');
  const systemLabel = manifest.tracks.system.label || 'Remote';
  const micLabel = manifest.tracks.mic.label || 'Me';

  try {
    mergeTranscripts(systemCsvPath, micCsvPath, mergedPath, systemLabel, micLabel);
  } catch (mergeErr) {
    throw new Error(`Failed to merge transcripts: ${mergeErr.message}`);
  }
  manifest.processing.transcription.merged = mergedPath;

  // Update manifest
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  if (progressCallback) progressCallback(100);

  return {
    systemTranscript,
    micTranscript,
    mergedTranscript: mergedPath
  };
}

/**
 * Get estimated transcription time
 *
 * @param {number} audioDurationMs - Audio duration in milliseconds
 * @returns {number} Estimated transcription time in milliseconds
 */
function estimateTranscriptionTime(audioDurationMs) {
  return Math.ceil(audioDurationMs / 5);
}

/**
 * Verify whisper.cpp installation
 *
 * @returns {{installed: boolean, binaryPath: string|null, modelPath: string|null, error: string|null}}
 */
function verifyInstallation() {
  const result = {
    installed: false,
    binaryPath: null,
    modelPath: null,
    error: null
  };

  try {
    result.binaryPath = findWhisperBinary();
  } catch (err) {
    result.error = err.message;
    return result;
  }

  try {
    result.modelPath = findWhisperModel();
  } catch (err) {
    result.error = err.message;
    return result;
  }

  result.installed = true;
  return result;
}

module.exports = {
  transcribe,
  transcribeSession,
  findWhisperBinary,
  findWhisperModel,
  estimateTranscriptionTime,
  verifyInstallation
};
