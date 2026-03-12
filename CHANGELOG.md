# Changelog

All notable changes to Notes4Chris will be documented in this file.

## [Unreleased]

### Added
- 2026-03-08: Compound documentation infrastructure (CLAUDE.md, .claude/rules/, docs/, /documenter command)

## [1.0.0] - 2026-03-08

### Added
- Dual-track recording (system audio + microphone) with speaker separation
- whisper.cpp transcription with per-track CSV output
- Transcript merger combining tracks with speaker labels (Remote/Me)
- Speaker-aware summarisation via Ollama
- macOS menu bar tray app with settings window
- Audio device detection and preflight checks
- Configurable recording mode (system-only or dual-track)
- Session directory structure with manifest.json
- Auto-cleanup of old recordings (configurable retention)
- macOS entitlements for microphone access
