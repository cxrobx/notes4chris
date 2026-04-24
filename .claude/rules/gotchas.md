# Known Gotchas

Organised by category. 6 items, condensed format. Original numbering preserved (gaps intentional).

## Index

| # | Issue | Category |
|---|-------|----------|
| 1 | system_profiler parsing format | Environment |
| 2 | BlackHole 2ch must be installed separately | Environment |
| 3 | whisper.cpp model path is hardcoded | Environment |
| 4 | Orphaned sox processes on crash | Backend |
| 5 | SCK delivers zero-filled frames with ARK.driver loaded | Environment |
| 6 | "Both tracks silent" — compound failure diagnostic | Backend |

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
**Symptom**: sox processes keep running after app crash. Worse follow-on symptom: *new* recordings produce silent or garbled `mic.wav` because multiple sox instances are holding the same mic device open and starving each other.
**Cause**: App crash, force-quit (`pkill -f Notes4Chris`), or SIGKILL bypasses normal cleanup in `cleanupProcesses()`. New sessions launch fresh sox while orphans still hold Core Audio handles.
**Diagnostic**: `ps aux | grep -v grep | grep 'sox -t coreaudio'` — if you see sox processes writing to **multiple** `recordings/<timestamp>_session/` paths, you have orphans. Each extra entry is one orphan session fighting the current one.
**Recovery**: `pkill -9 sox` clears all orphans. Then `ps aux | grep sox | grep -v grep` should return empty. Safe to run — any in-flight recording from the live app is already compromised if orphans exist.
**Pattern**: `main.js` → `registerProcess()`, `cleanupProcesses()`
**Related**: If `system.wav` is *also* silent from the same session, don't assume this is the cause — see #5 (ARK/SCK) and #6 (compound failure).

## Environment (continued)

### 5. SCK Delivers Zero-Filled Frames When Rogue Amoeba ARK.driver Is Loaded
**Symptom**: `system.wav` has the correct byte size for its duration but `sox -n stat` reports `Maximum amplitude: 0.000000`, `RMS amplitude: 0.000000`. Manifest shows `captureMethod: "sck"` and no error is logged. SCK starts and stops "successfully."
**Cause**: Rogue Amoeba's Audio Capture Engine (ACE) installs `ARK.driver` into `coreaudiod`. It sits on the display audio bus, and the legacy `SCContentFilter(display:excludingWindows:)` shape — which uses the display's audio mix — gets starved to silence. BlackHole aggregate devices can cause the same class of issue.
**Diagnostic**:
- `ps aux | grep -i ARK.driver | grep -v grep` → a coreaudiod subprocess line means ARK is loaded.
- `sox recordings/<latest>/system.wav -n stat 2>&1 | grep -E 'amplitude|RMS'` → all zeros confirms zero-filled frames (as opposed to a file that simply wasn't written).
**Solution**: Use the per-app filter shape instead — `SCContentFilter(display:including:apps:exceptingWindows:)` with `content.applications` minus own PID. This taps per-app audio directly and bypasses the display-mix hijack. Applied in `native/sck-audio-capture/Sources/AudioCapture.swift`.
**Nuclear recovery** (if the filter swap doesn't help): `sudo killall coreaudiod` (auto-relaunches and resets driver state) or uninstall Rogue Amoeba's ACE via its official uninstaller.
**Pattern**: `native/sck-audio-capture/Sources/AudioCapture.swift` → `SystemAudioCapture.start()`

## Backend (continued)

### 6. "Both Tracks Silent" — Compound Failure Diagnostic
**Symptom**: Both `system.wav` *and* `mic.wav` are silent in the same session, tempting the (incorrect) conclusion that there's a single deep bug.
**Cause**: In practice this is almost always **two independent failures stacked**: #5 (ARK hijack → silent system track) combined with #4 (orphaned sox → silent mic track). Each has a different fix; neither fix alone resolves the compound symptom.
**Diagnostic ritual** (run *in order* — do not skip):
1. `ps aux | grep -v grep | grep 'sox -t coreaudio'` → if multiple sessions present, you have orphans (see #4). Run `pkill -9 sox` and verify empty.
2. `ps aux | grep -i ARK.driver | grep -v grep` → if present, you're vulnerable to #5. Filter fix should already be in effect from the current binary.
3. `sox recordings/<latest>/system.wav -n stat 2>&1 | grep -E 'amplitude|RMS'` and same for `mic.wav` → zeros vs non-zeros tells you which track(s) are actually silent.
4. **Cross-check with a known-good app**: does QuickTime capture mic audio right now? If yes, any mic failure in notes4chris is app-specific (usually #4). If no, the problem is OS-level and nothing in this codebase will fix it.
**Solution**: Treat the two failures independently. Never assume "both broken" = "one bug." Never propose architectural rewrites until the diagnostic ritual above is complete.

## Lifecycle Management

- **SUPERSEDED**: When a gotcha is resolved, mark it: `## #N: [Title] ~~SUPERSEDED~~`
- **Numbering**: Original numbers are permanent — gaps are intentional. Never renumber.
- **Categories**: Environment, Backend, Frontend, Security, Deployment
