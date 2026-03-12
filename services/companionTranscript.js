const fs = require('fs');
const path = require('path');
const os = require('os');

const SHARED_DIR = path.join(os.homedir(), '.meeting-shared');
const PRESENCE_FILE = path.join(SHARED_DIR, 'active-session.json');

/**
 * Check if a transcript provider (meeting-copilot) is actively running.
 *
 * Reads ~/.meeting-shared/active-session.json and verifies the PID is alive.
 *
 * @returns {{ app: string, transcriptFile: string } | null}
 */
function checkForProvider() {
  try {
    if (!fs.existsSync(PRESENCE_FILE)) return null;

    const raw = fs.readFileSync(PRESENCE_FILE, 'utf-8');
    const presence = JSON.parse(raw);

    // Verify PID is alive
    try {
      process.kill(presence.pid, 0);
    } catch {
      console.log(`[Companion] Stale presence — PID ${presence.pid} is dead, ignoring`);
      return null;
    }

    return {
      app: presence.app,
      transcriptFile: presence.transcriptFile
    };
  } catch (err) {
    console.warn('[Companion] Failed to check for provider:', err.message);
    return null;
  }
}

/**
 * Read the shared JSONL transcript file.
 *
 * Each line is: { id, text, source, label, timestamp, duration, wordCount }
 *
 * @param {string} jsonlPath - Path to live-transcript.jsonl
 * @returns {Array<Object>} Parsed transcript segments
 */
function readSharedTranscript(jsonlPath) {
  try {
    if (!fs.existsSync(jsonlPath)) return [];

    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    const segments = [];
    for (const line of lines) {
      try {
        segments.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }

    return segments;
  } catch (err) {
    console.warn('[Companion] Failed to read shared transcript:', err.message);
    return [];
  }
}

/**
 * Convert segments to whisper-style CSV format.
 *
 * Whisper CSV: start,end,text (times in milliseconds).
 * Filters by source to match the track.
 *
 * @param {Array<Object>} segments - Transcript segments from JSONL
 * @param {'meeting' | 'mic'} sourceFilter - Which source to include
 * @returns {string} CSV content
 */
function convertToCSV(segments, sourceFilter) {
  const filtered = segments.filter(s => s.source === sourceFilter);

  const lines = ['start,end,text'];
  for (const seg of filtered) {
    const startMs = Math.round(seg.timestamp * 1000);
    const endMs = Math.round((seg.timestamp + (seg.duration || 10)) * 1000);
    const escapedText = `"${seg.text.replace(/"/g, '""')}"`;
    lines.push(`${startMs},${endMs},${escapedText}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Format seconds to HH:MM:SS or MM:SS timestamp.
 *
 * @param {number} seconds
 * @returns {string}
 */
function formatTimestamp(seconds) {
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Convert segments to merged transcript format.
 *
 * Output: [HH:MM:SS - HH:MM:SS] Speaker: text
 * Same format as transcriptMerger.js produces.
 *
 * @param {Array<Object>} segments - All transcript segments
 * @returns {string} Merged transcript text
 */
function convertToMerged(segments) {
  if (segments.length === 0) {
    return '(No transcript entries found)\n';
  }

  // Sort by timestamp
  const sorted = [...segments].sort((a, b) => a.timestamp - b.timestamp);

  const lines = sorted.map(seg => {
    const startStr = formatTimestamp(seg.timestamp);
    const endStr = formatTimestamp(seg.timestamp + (seg.duration || 10));
    // Use source-based speaker names to match transcriptMerger.js output
    // (meeting-copilot labels are '[You]'/'[Meeting]', but notes4chris uses 'Me'/'Remote')
    const speaker = seg.source === 'mic' ? 'Me' : 'Remote';
    return `[${startStr} - ${endStr}] ${speaker}: ${seg.text}`;
  });

  return lines.join('\n') + '\n';
}

/**
 * Write companion transcript outputs in the same format as whisper + transcriptMerger.
 *
 * Creates system_transcript.csv, mic_transcript.csv, and merged_transcript.txt
 * exactly matching what the normal pipeline would produce.
 *
 * @param {Array<Object>} segments - Transcript segments from JSONL
 * @param {string} outputDir - Processed output directory
 */
function writeCompanionOutputs(segments, outputDir) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // System track CSV
  const systemCsv = convertToCSV(segments, 'meeting');
  fs.writeFileSync(path.join(outputDir, 'system_transcript.csv'), systemCsv, 'utf-8');

  // Mic track CSV
  const micCsv = convertToCSV(segments, 'mic');
  fs.writeFileSync(path.join(outputDir, 'mic_transcript.csv'), micCsv, 'utf-8');

  // Merged transcript
  const merged = convertToMerged(segments);
  fs.writeFileSync(path.join(outputDir, 'merged_transcript.txt'), merged, 'utf-8');

  console.log(`[Companion] Wrote companion outputs to ${outputDir} (${segments.length} segments)`);
}

module.exports = {
  checkForProvider,
  readSharedTranscript,
  convertToCSV,
  convertToMerged,
  writeCompanionOutputs
};
