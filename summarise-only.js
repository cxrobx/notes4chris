#!/usr/bin/env node

/**
 * Standalone script for testing summary generation
 * Usage: npm run summaryonly <transcript-file-path>
 *
 * Generates notes via Codex CLI and outputs the result to the console.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateNotes, generateSessionNotes, exportNotesToObsidian, isCodexAvailable, isClaudeAvailable } = require('./services/summariser');

const OBSIDIAN_VAULT_DIRECTORY = path.join(os.homedir(), 'Documents', 'CX');

/**
 * Detect whether a transcript is a merged dual-track format
 * (contains speaker-labelled lines like "[MM:SS - MM:SS] Speaker: text")
 */
function isMergedTranscript(transcript) {
  return /\[\d{2,}:\d{2}\s*-\s*\d{2,}:\d{2}\]\s+\S+:/.test(transcript);
}

async function generateSummary(transcriptPath) {
  if (!isCodexAvailable() && !isClaudeAvailable()) {
    throw new Error(
      'No AI provider found.\n' +
      'Install one of:\n' +
      '  Codex CLI:  npm install -g @anthropic-ai/codex\n' +
      '  Claude CLI: npm install -g @anthropic-ai/claude-code'
    );
  }

  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`Transcript file not found: ${transcriptPath}`);
  }

  const transcript = fs.readFileSync(transcriptPath, 'utf-8');
  if (transcript.trim().length === 0) {
    throw new Error('Transcript is empty.');
  }

  console.log(`Reading transcript: ${transcriptPath}`);
  console.log(`Transcript length: ${transcript.length} characters`);

  let notesPath;
  if (isMergedTranscript(transcript)) {
    console.log('Detected merged dual-track transcript — using speaker-aware summarisation\n');
    // Build a minimal manifest for generateSessionNotes
    const manifest = {
      tracks: {
        system: { label: 'Remote' },
        mic: { label: 'Me' }
      }
    };
    notesPath = await generateSessionNotes(transcriptPath, manifest);
  } else {
    console.log('Detected single-track transcript — using standard summarisation\n');
    notesPath = await generateNotes(transcriptPath);
  }

  const obsidianPath = exportNotesToObsidian(notesPath, OBSIDIAN_VAULT_DIRECTORY, {
    title: path.basename(transcriptPath, path.extname(transcriptPath)).replace(/_transcript$/i, ''),
    startTime: fs.statSync(transcriptPath).birthtime.toISOString()
  });
  const notes = fs.readFileSync(notesPath, 'utf-8');

  console.log('='.repeat(80));
  console.log(notes);
  console.log('\n' + '='.repeat(80));
  console.log(`\nSummary generated and saved to: ${notesPath}`);
  console.log(`Obsidian export written to: ${obsidianPath}`);
}

async function main() {
  const transcriptPath = process.argv[2];

  if (!transcriptPath) {
    console.error('Usage: npm run summaryonly <transcript-file-path>');
    process.exit(1);
  }

  try {
    await generateSummary(transcriptPath);
  } catch (err) {
    console.error('\nError:', err.message);
    process.exit(1);
  }
}

main();
