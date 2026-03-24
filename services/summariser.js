const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LLM_TIMEOUT = 300000; // 5 minutes (large transcripts need more time)
const OBSIDIAN_FILENAME_LIMIT = 120;

/**
 * Format a date for inclusion in an LLM prompt.
 *
 * Accepts an ISO string or a directory-name timestamp like "2026-03-17_18-02-27".
 * Returns e.g. "Monday 17 March 2026 at 18:02" (UK style) or null on failure.
 */
function formatDateForPrompt(value) {
  if (!value) return null;

  // Normalise directory-name timestamps: "2026-03-17_18-02-27" → "2026-03-17T18:02:27"
  const normalised = String(value).replace(
    /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})$/,
    '$1T$2:$3:$4'
  );

  const date = new Date(normalised);
  if (Number.isNaN(date.getTime())) return null;

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const dayName = dayNames[date.getDay()];
  const day = date.getDate();
  const month = monthNames[date.getMonth()];
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${dayName} ${day} ${month} ${year} at ${hours}:${minutes}`;
}

/**
 * Check if Codex CLI is available
 *
 * @returns {boolean}
 */
function isCodexAvailable() {
  try {
    execSync('which codex', { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Check if Claude CLI is available
 *
 * @returns {boolean}
 */
function isClaudeAvailable() {
  try {
    execSync('which claude', { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Run a prompt through Codex CLI headlessly
 *
 * Same pattern as essaybuddy's codex_provider — shells out to
 * `codex exec --full-auto --ephemeral` with a minimal config
 * that disables MCP servers to avoid startup latency.
 *
 * @param {string} prompt - The prompt to send
 * @returns {Promise<string>} The response text
 */
async function runCodex(prompt) {
  // Use a stable directory under real home (Codex refuses to run with HOME in /tmp)
  const realHome = os.homedir();
  const isolatedHome = path.join(realHome, '.cache', 'notes4chris-codex');
  const codexDir = path.join(isolatedHome, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });

  try {
    // Minimal codex config (no MCP servers to avoid startup latency)
    fs.writeFileSync(path.join(codexDir, 'config.toml'), '[mcp_servers]\n', 'utf-8');

    // Copy auth from real codex config
    const realAuth = path.join(realHome, '.codex', 'auth.json');
    if (fs.existsSync(realAuth)) {
      fs.copyFileSync(realAuth, path.join(codexDir, 'auth.json'));
    }

    const env = {
      PATH: process.env.PATH || '',
      HOME: isolatedHome,
    };

    for (const key of ['CODEX_TOKEN', 'OPENAI_API_KEY']) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }

    return new Promise((resolve, reject) => {
      const proc = spawn('codex', ['exec', '--full-auto', '--skip-git-repo-check', '--ephemeral'], {
        cwd: isolatedHome,
        env: env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      // Suppress EPIPE errors on stdin (child may exit before we finish writing)
      proc.stdin.on('error', (err) => {
        if (err.code !== 'EPIPE') throw err;
      });

      // Use end(data) to write + close atomically, handling backpressure
      proc.stdin.end(prompt, 'utf-8');

      const timeout = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (e) { /* already dead */ }
        reject(new Error(`Codex timed out after ${LLM_TIMEOUT / 1000}s`));
      }, LLM_TIMEOUT);

      proc.on('close', (code) => {
        clearTimeout(timeout);

        const output = stripAnsi(stdout).trim();

        if (code !== 0 && !output) {
          const err = stderr.trim();
          reject(new Error(`Codex failed: ${truncateError(err)}`));
          return;
        }

        const content = extractContent(output);
        if (!content) {
          reject(new Error('Codex returned empty output'));
          return;
        }

        resolve(content);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start Codex: ${err.message}`));
      });
    });
  } finally {
    // Stable cache dir — no cleanup needed
  }
}

/**
 * Run a prompt through Claude CLI headlessly
 *
 * Uses `claude -p` (print mode) with stdin for the prompt.
 * Fallback provider when Codex is unavailable or fails.
 *
 * @param {string} prompt - The prompt to send
 * @returns {Promise<string>} The response text
 */
async function runClaude(prompt) {
  // Inherit full env so Claude CLI can find its auth/config in ~/.claude/
  // Strip nested-session blockers that prevent launching from within Claude Code
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', [
      '-p',
      '--model', 'sonnet',
      '--output-format', 'text',
      '--no-session-persistence',
    ], {
      cwd: os.homedir(),
      env: env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    // Suppress EPIPE errors on stdin (child may exit before we finish writing)
    proc.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') throw err;
    });

    proc.stdin.end(prompt, 'utf-8');

    const timeout = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (e) { /* already dead */ }
      reject(new Error(`Claude timed out after ${LLM_TIMEOUT / 1000}s`));
    }, LLM_TIMEOUT);

    proc.on('close', (code) => {
      clearTimeout(timeout);

      const output = stdout.trim();

      if (code !== 0 && !output) {
        const err = stderr.trim();
        reject(new Error(`Claude failed (exit ${code}): ${err.slice(0, 300)}`));
        return;
      }

      if (!output) {
        reject(new Error('Claude returned empty output'));
        return;
      }

      // Detect auth/login errors that Claude emits as stdout with exit 0
      if (output.match(/not logged in|please run \/login/i)) {
        reject(new Error('Claude CLI not authenticated. Run "claude" in a terminal to log in.'));
        return;
      }

      resolve(output);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start Claude: ${err.message}`));
    });
  });
}

/**
 * Strip ANSI escape codes from text
 */
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Extract meaningful error from Codex stderr
 */
function truncateError(err) {
  const lines = err.split('\n');
  const errorLines = [];
  for (const line of lines) {
    if (line.startsWith('--------') || line.startsWith('session id:') || line.startsWith('user')) break;
    const stripped = line.trim();
    if (stripped && !stripped.startsWith('Reading prompt from stdin')) {
      errorLines.push(stripped);
    }
  }
  if (errorLines.length) return errorLines.join(' ').slice(0, 300);
  return err.slice(0, 300);
}

/**
 * Extract AI response content from Codex CLI output
 */
function extractContent(text) {
  const match = text.match(/\bassistant\s*\n/);
  if (match) {
    text = text.slice(match.index + match[0].length);
  }

  const fenced = text.match(/```(?:markdown|md)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return fenced[1].trim();

  return text.trim();
}

/**
 * Export generated notes to an Obsidian vault.
 *
 * Keeps the app's internal notes copy intact and writes a vault-friendly
 * Markdown file using a stable name when reprocessing an existing session.
 *
 * @param {string} notesPath - Path to the generated markdown notes
 * @param {string} vaultDir - Obsidian vault directory
 * @param {object} [options]
 * @param {string} [options.title] - Preferred title for the exported note
 * @param {string} [options.startTime] - ISO timestamp used in the filename
 * @param {string} [options.existingPath] - Existing export path to overwrite
 * @returns {string|null} Exported file path, or null when no vault is configured
 */
function exportNotesToObsidian(notesPath, vaultDir, options = {}) {
  if (!vaultDir) {
    return null;
  }

  if (!fs.existsSync(notesPath)) {
    throw new Error(`Notes file not found: ${notesPath}`);
  }

  const resolvedVaultDir = path.resolve(vaultDir);
  if (!fs.existsSync(resolvedVaultDir)) {
    fs.mkdirSync(resolvedVaultDir, { recursive: true });
  }

  const exportPath = resolveObsidianExportPath(resolvedVaultDir, notesPath, options);
  fs.mkdirSync(path.dirname(exportPath), { recursive: true });
  fs.copyFileSync(notesPath, exportPath);

  console.log(`Obsidian export complete: ${exportPath}`);
  return exportPath;
}

/**
 * Resolve the target vault path for an exported note.
 */
function resolveObsidianExportPath(vaultDir, notesPath, options) {
  if (options.existingPath) {
    return path.resolve(options.existingPath);
  }

  const filename = buildObsidianFilename(notesPath, options);
  return path.join(vaultDir, filename);
}

/**
 * Build an Obsidian-friendly filename from note metadata.
 */
function buildObsidianFilename(notesPath, options) {
  const title = normaliseExportTitle(options.title || path.basename(notesPath, '.md')) || 'Meeting summary';
  const timestamp = formatTimestampForFilename(options.startTime);
  const stem = timestamp ? `${title} ${timestamp}` : title;
  return `${truncateFilename(stem)}.md`;
}

/**
 * Convert a title into a filesystem-safe form.
 */
function normaliseExportTitle(value) {
  return String(value || '')
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]+notes?$/i, '')
    .replace(/[_-]+transcript$/i, '')
    .replace(/[_-]+session$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Format a timestamp for a note filename in local time.
 */
function formatTimestampForFilename(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = String(date.getFullYear()).slice(-2);

  return `${month}.${day}.${year}`;
}

/**
 * Keep exported filenames readable and below a sensible limit.
 */
function truncateFilename(value) {
  if (value.length <= OBSIDIAN_FILENAME_LIMIT) {
    return value;
  }

  return value.slice(0, OBSIDIAN_FILENAME_LIMIT).trim();
}

/**
 * Generate meeting notes from transcript (legacy single-track)
 *
 * Uses Codex CLI only.
 *
 * @param {string} transcriptPath - Path to transcript text file
 * @param {Function} [progressCallback] - Optional callback for progress updates
 * @returns {Promise<string>} Path to generated notes markdown file
 */
async function generateNotes(transcriptPath, progressCallback) {
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`Transcript file not found: ${transcriptPath}`);
  }

  const transcript = fs.readFileSync(transcriptPath, 'utf-8');
  if (transcript.trim().length === 0) {
    throw new Error('Transcript is empty. Cannot generate notes from empty transcript.');
  }

  const outputPath = transcriptPath.replace('_transcript.txt', '_notes.md');

  console.log(`Generating notes from transcript: ${transcriptPath}`);

  // Try to extract the recording date from the session directory name (e.g. "2026-03-17_18-02-27_session")
  const dirMatch = transcriptPath.match(/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})_session/);
  const formattedDate = dirMatch ? formatDateForPrompt(dirMatch[1]) : null;

  const dateInstruction = formattedDate
    ? `This meeting was recorded on ${formattedDate}. Use this date in the title.`
    : `Infer the meeting date if it's mentioned or implied.`;

  const dateTitle = formattedDate
    ? `Meeting Notes [${formattedDate.replace(/^\w+ /, '').replace(/ at .*$/, '')}]`
    : 'Meeting Notes [Include inferred date]';

  const prompt = `You create clear and structured meeting notes. Read the transcript and produce well-organised notes with accurate detail and concise wording. ${dateInstruction}

Use the following sections when they apply:

${dateTitle}
Action Items
Meeting Purpose
Key Takeaways
Topics Discussed
Problem
Blocker
Solution or Proposal
Next Steps

Write in plain UK English. Keep each section brief but complete. Do not invent details that aren't supported by the transcript.

---

TRANSCRIPT:
${transcript}

---

Generate comprehensive meeting notes following the format above. Extract actual names, specific action items, and technical details from the transcript. If certain sections don't apply (e.g., no blockers discussed), you can omit them. Be concise but thorough.`;

  const notes = await runLLM(prompt, progressCallback);
  fs.writeFileSync(outputPath, notes, 'utf-8');
  console.log(`Notes generated successfully: ${outputPath}`);
  return outputPath;
}

/**
 * Generate speaker-aware meeting notes from a merged dual-track transcript
 *
 * @param {string} mergedTranscriptPath - Path to merged speaker-labeled transcript
 * @param {object} manifest - Session manifest object
 * @param {Function} [progressCallback] - Optional callback for progress updates
 * @returns {Promise<string>} Path to generated notes markdown file
 */
async function generateSessionNotes(mergedTranscriptPath, manifest, progressCallback) {
  if (!fs.existsSync(mergedTranscriptPath)) {
    throw new Error(`Merged transcript not found: ${mergedTranscriptPath}`);
  }

  const transcript = fs.readFileSync(mergedTranscriptPath, 'utf-8');
  if (transcript.trim().length === 0) {
    throw new Error('Merged transcript is empty. Cannot generate notes.');
  }

  const outputDir = path.dirname(mergedTranscriptPath);
  const outputPath = path.join(outputDir, 'notes.md');

  const systemLabel = manifest.tracks.system.label || 'Remote';
  const micLabel = manifest.tracks.mic.label || 'Me';
  const ctx = manifest.meetingContext || {};

  console.log(`Generating speaker-aware notes from: ${mergedTranscriptPath}`);
  console.log(`Speakers: ${systemLabel} (system), ${micLabel} (mic)`);
  if (ctx.title) console.log(`Meeting context: ${ctx.title}`);

  // Build context block if any meeting context was provided
  let contextBlock = '';
  if (ctx.title || ctx.participants || ctx.agenda) {
    contextBlock = '\n\nMeeting context provided by the user:\n';
    if (ctx.title) contextBlock += `- Meeting title: ${ctx.title}\n`;
    if (ctx.participants) contextBlock += `- Participants: ${ctx.participants}\n`;
    if (ctx.agenda) contextBlock += `- Agenda/notes: ${ctx.agenda}\n`;
    contextBlock += '\nUse this context to improve accuracy — use real participant names where possible, and reference the agenda topics.\n';
  }

  // Format the recording date from the manifest
  const formattedDate = formatDateForPrompt(manifest.startTime);
  const dateInstruction = formattedDate
    ? `This meeting was recorded on ${formattedDate}. Use this date in the title.`
    : `Infer the meeting date if it's mentioned or implied.`;
  const dateTitle = formattedDate
    ? `Meeting Notes [${formattedDate.replace(/^\w+ /, '').replace(/ at .*$/, '')}]`
    : 'Meeting Notes [Include inferred date]';

  const prompt = `You create clear and structured meeting notes from a dual-track transcript. The transcript has two speakers:
- "${systemLabel}" — the remote participant(s) heard through system audio
- "${micLabel}" — the local user speaking into their microphone
${contextBlock}
Read the transcript and produce well-organised, speaker-aware notes with accurate detail and concise wording. ${dateInstruction}

Use the following sections when they apply:

## ${dateTitle}

## Participants
List the speakers identified in the transcript.

## Meeting Purpose
Brief summary of what this meeting was about.

## Key Takeaways
The most important outcomes or decisions.

## Topics Discussed
Organized by topic, noting who raised each point.

## Action Items
All action items with owner attribution:
- [ ] [Owner] Action item description

## My Commitments
Things "${micLabel}" agreed to do or follow up on.

## Their Commitments
Things "${systemLabel}" agreed to do or follow up on.

## Problems / Blockers
Any issues raised, noting who raised them.

## Solutions / Proposals
Solutions discussed, noting who proposed them.

## Next Steps
Agreed next steps and timeline.

Write in plain UK English. Keep each section brief but complete. Do not invent details that aren't supported by the transcript. Attribute statements and commitments to the correct speaker.

---

TRANSCRIPT:
${transcript}

---

Generate comprehensive speaker-aware meeting notes following the format above. Be concise but thorough.`;

  const notes = await runLLM(prompt, progressCallback);
  fs.writeFileSync(outputPath, notes, 'utf-8');
  console.log(`Notes generated successfully: ${outputPath}`);
  return outputPath;
}

/**
 * Run a prompt through the best available LLM provider
 *
 * Strategy: Codex primary, Claude CLI fallback. If Codex is available it's
 * tried first; on failure we fall through to Claude. If neither is installed
 * an error with install instructions is thrown.
 *
 * @param {string} prompt
 * @param {Function} [progressCallback]
 * @returns {Promise<string>} Response text
 */
async function runLLM(prompt, progressCallback) {
  const codexOk = isCodexAvailable();
  const claudeOk = isClaudeAvailable();

  if (!codexOk && !claudeOk) {
    throw new Error(
      'No AI summarisation provider found.\n' +
      'Install one of:\n' +
      '  Codex CLI:  npm install -g @anthropic-ai/codex\n' +
      '  Claude CLI: npm install -g @anthropic-ai/claude-code'
    );
  }

  if (progressCallback) progressCallback(10);

  // Try Codex first if available
  if (codexOk) {
    try {
      console.log('Using Codex CLI for summarisation...');
      const result = await runCodex(prompt);
      if (progressCallback) progressCallback(100);
      return result;
    } catch (err) {
      if (claudeOk) {
        console.warn(`Codex failed, falling back to Claude CLI: ${err.message}`);
      } else {
        throw new Error(`Codex summarisation failed: ${err.message}`);
      }
    }
  }

  // Claude fallback (or primary if Codex not installed)
  console.log('Using Claude CLI for summarisation...');
  try {
    const result = await runClaude(prompt);
    if (progressCallback) progressCallback(100);
    return result;
  } catch (err) {
    throw new Error(`Claude summarisation failed: ${err.message}`);
  }
}

/**
 * Estimate note generation time
 *
 * @param {number} transcriptLength - Transcript length in characters
 * @returns {number} Estimated time in milliseconds
 */
function estimateGenerationTime(transcriptLength) {
  const estimatedTokens = Math.ceil(transcriptLength / 4);
  const tokensPerSecond = 50;
  const seconds = Math.ceil(estimatedTokens / tokensPerSecond);
  return seconds * 1000;
}

module.exports = {
  exportNotesToObsidian,
  generateNotes,
  generateSessionNotes,
  isCodexAvailable,
  isClaudeAvailable,
  estimateGenerationTime,
};
