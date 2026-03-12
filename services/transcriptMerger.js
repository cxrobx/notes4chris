const fs = require('fs');
const path = require('path');

/**
 * Parse a whisper.cpp CSV transcript file
 *
 * Whisper CSV format: start,end,text
 * Times are in milliseconds.
 *
 * @param {string} csvPath - Path to CSV transcript file
 * @returns {Array<{start: number, end: number, text: string}>} Parsed entries
 */
function parseCsvTranscript(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV transcript not found: ${csvPath}`);
  }

  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());

  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip header row
    if (i === 0 && (line.toLowerCase().startsWith('start') || line.toLowerCase().startsWith('"start'))) {
      continue;
    }

    // Skip empty lines
    if (!line) continue;

    // Parse CSV line: split on first two commas, then strip surrounding quotes from text
    const firstComma = line.indexOf(',');
    const secondComma = line.indexOf(',', firstComma + 1);
    if (firstComma === -1 || secondComma === -1) continue;

    const startStr = line.slice(0, firstComma).trim();
    const endStr = line.slice(firstComma + 1, secondComma).trim();
    let text = line.slice(secondComma + 1).trim();

    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    if (isNaN(start) || isNaN(end)) continue;

    // Strip surrounding quotes if present
    if (text.startsWith('"') && text.endsWith('"')) {
      text = text.slice(1, -1);
    }
    text = text.trim();

    if (text) {
      entries.push({ start, end, text });
    }
  }

  return entries;
}

/**
 * Format milliseconds to [HH:MM:SS] timestamp
 *
 * @param {number} ms - Time in milliseconds
 * @returns {string} Formatted timestamp
 */
function formatTimestamp(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Merge two speaker transcripts into a single speaker-labeled transcript
 *
 * @param {string|null} systemCsvPath - Path to system audio CSV transcript (or null)
 * @param {string|null} micCsvPath - Path to mic audio CSV transcript (or null)
 * @param {string} outputPath - Path to write merged transcript
 * @param {string} [systemLabel='Remote'] - Label for system audio speaker
 * @param {string} [micLabel='Me'] - Label for mic audio speaker
 * @returns {string} Path to merged transcript file
 */
function mergeTranscripts(systemCsvPath, micCsvPath, outputPath, systemLabel = 'Remote', micLabel = 'Me') {
  const entries = [];

  // Parse system transcript
  if (systemCsvPath && fs.existsSync(systemCsvPath)) {
    const systemEntries = parseCsvTranscript(systemCsvPath);
    for (const entry of systemEntries) {
      entries.push({ ...entry, speaker: systemLabel });
    }
  }

  // Parse mic transcript
  if (micCsvPath && fs.existsSync(micCsvPath)) {
    const micEntries = parseCsvTranscript(micCsvPath);
    for (const entry of micEntries) {
      entries.push({ ...entry, speaker: micLabel });
    }
  }

  // Both tracks empty — surface as an error so callers don't feed a placeholder to the LLM
  if (entries.length === 0) {
    throw new Error('Transcript merge produced no entries — both tracks were empty or unparseable');
  }

  // Sort by start timestamp
  entries.sort((a, b) => a.start - b.start);

  // Format output
  const lines = entries.map(entry => {
    const startStr = formatTimestamp(entry.start);
    const endStr = formatTimestamp(entry.end);
    return `[${startStr} - ${endStr}] ${entry.speaker}: ${entry.text}`;
  });

  const output = lines.join('\n') + '\n';
  fs.writeFileSync(outputPath, output, 'utf-8');

  console.log(`Merged transcript written: ${outputPath} (${entries.length} entries)`);
  return outputPath;
}

module.exports = {
  parseCsvTranscript,
  mergeTranscripts,
  formatTimestamp
};
