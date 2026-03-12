# Architecture Patterns

## Tech Stack

| Component | Technology | Version |
|-----------|------------|---------|
| Runtime | Electron | 33.x |
| Audio Capture | sox | system |
| Virtual Audio | BlackHole 2ch | system |
| Transcription | whisper.cpp | local build |
| Summarisation | Ollama (llama3.2) | system |
| Config Store | electron-store | 8.x |
| Build Tool | electron-builder | 24.x |

## Directory Structure

```
notes4chris/
├── main.js                    # Electron main process, IPC, recording orchestration
├── preload.js                 # contextBridge API for renderer
├── summarise-only.js          # Standalone re-summarisation script
├── setup.sh                   # Dependency installer
├── renderer/
│   ├── index.html             # Settings UI
│   ├── app.js                 # UI logic, mic dropdown, mode toggle, preflight
│   └── styles.css             # macOS-style UI with dark mode
├── services/
│   ├── recorder.js            # Recorder (single) + DualTrackRecorder classes
│   ├── transcriber.js         # whisper.cpp wrapper + transcribeSession()
│   ├── transcriptMerger.js    # CSV parser + merge algorithm
│   ├── summariser.js          # Ollama wrapper + generateSessionNotes()
│   └── fileManager.js         # Directory structure, cleanup, stats
├── utils/
│   └── audioDevices.js        # BlackHole detection + mic enumeration
├── models/                    # whisper.cpp model files (ggml-base.en.bin)
├── assets/                    # App icons
└── whisper.cpp/               # Local whisper.cpp build (git submodule/clone)
```

## Critical Invariants (DO NOT BREAK)

Qualification: A rule belongs here if (1) violating it breaks the system in non-obvious ways, (2) it's not self-evident from the code, and (3) it applies codebase-wide.

1. **Dual-track requires BlackHole**: System audio capture depends on BlackHole 2ch virtual audio device. The app must verify its presence before starting dual-track recording.
   - Why: Without BlackHole, system audio capture silently fails
   - Pattern: `utils/audioDevices.js` → `findBlackHoleDevice()`

2. **Session directory contract**: Each recording session creates `recordings/{timestamp}_session/` containing `manifest.json`, `system.wav`, and optionally `mic.wav`. The manifest drives all downstream processing.
   - Why: Transcriber and summariser rely on manifest structure
   - Pattern: `services/fileManager.js` → `ensureDirectoryStructure()`

3. **Process registration**: All spawned child processes (sox, whisper) must be registered with `registerProcess()` in `main.js` and cleaned up on app exit.
   - Why: Orphaned sox processes keep recording indefinitely, filling disk
   - Pattern: `main.js` → `registerProcess()`, `cleanupProcesses()`

4. **British English spelling**: The codebase uses British English throughout — `summariser`, `organisation`, `colour`, etc.
   - Why: Consistency across codebase and UI text
   - Pattern: All files

5. **Privacy-first / local-only processing**: No network calls for transcription or summarisation. whisper.cpp and Ollama run locally.
   - Why: Core product promise — meeting audio never leaves the machine

6. **Config store defaults**: `electron-store` defaults are defined in `main.js`. Default recording mode is `'dual'`, default labels are `'Remote'`/`'Me'`.
   - Why: Changing defaults affects all new users and existing users without saved preferences

## Key Patterns

### IPC Communication
- Main ↔ Renderer communication via `ipcMain.handle()` / `ipcRenderer.invoke()`
- Preload script exposes safe API through `contextBridge.exposeInMainWorld()`
- All IPC channels defined in `preload.js`

### Recording Flow
1. User clicks "Start Recording" in menu bar
2. Preflight checks run (sox, BlackHole, mic, Ollama)
3. `DualTrackRecorder` spawns two sox processes (system + mic)
4. On stop: both wav files saved to session directory
5. `transcribeSession()` runs whisper.cpp on each track → CSV output
6. `transcriptMerger.js` merges per-track CSVs with speaker labels
7. `generateSessionNotes()` sends merged transcript to Ollama
8. Markdown notes saved alongside recordings

### Audio Device Detection
- `system_profiler SPAudioDataType` parsed for device enumeration
- Device names at 8-space indent, properties at 10-space indent
- `listInputDevices()` returns all available input devices
