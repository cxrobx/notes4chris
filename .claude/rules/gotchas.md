# Known Gotchas

Organised by category. 4 items, condensed format. Original numbering preserved (gaps intentional).

## Index

| # | Issue | Category |
|---|-------|----------|
| 1 | system_profiler parsing format | Environment |
| 2 | BlackHole 2ch must be installed separately | Environment |
| 3 | whisper.cpp model path is hardcoded | Environment |
| 4 | Orphaned sox processes on crash | Backend |

---

## Environment

### 1. system_profiler SPAudioDataType Parsing Format
**Symptom**: Audio device detection fails or returns wrong devices
**Cause**: `system_profiler` output uses specific indentation — device names at 8 spaces, properties at 10 spaces
**Solution**: The parser in `utils/audioDevices.js` handles this correctly. Do not change the indent-based parsing logic.
**Pattern**: `utils/audioDevices.js` → `listInputDevices()`

### 2. BlackHole 2ch Must Be Installed Separately
**Symptom**: Dual-track recording unavailable, system audio not captured
**Cause**: BlackHole is a third-party virtual audio device not bundled with the app
**Solution**: User must install BlackHole 2ch and configure it as a multi-output device in macOS Audio MIDI Setup
**Pattern**: `utils/audioDevices.js` → `findBlackHoleDevice()`

### 3. whisper.cpp Model Path
**Symptom**: Transcription fails with "model not found"
**Cause**: whisper.cpp expects `ggml-base.en.bin` in the `models/` directory
**Solution**: Run `setup.sh` which downloads the model, or manually place it in `models/`
**Pattern**: `services/transcriber.js`

## Backend

### 4. Orphaned sox Processes on Crash
**Symptom**: sox processes keep running after app crash, recording indefinitely
**Cause**: App crash bypasses normal cleanup in `cleanupProcesses()`
**Solution**: All sox processes are registered via `registerProcess()`. On normal exit they're killed. On crash, user may need to manually `killall sox`.
**Pattern**: `main.js` → `registerProcess()`, `cleanupProcesses()`

## Lifecycle Management

- **SUPERSEDED**: When a gotcha is resolved, mark it: `## #N: [Title] ~~SUPERSEDED~~`
- **Numbering**: Original numbers are permanent — gaps are intentional. Never renumber.
- **Categories**: Environment, Backend, Frontend, Security, Deployment
