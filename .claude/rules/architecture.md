# Architecture Patterns

## Tech Stack

| Component | Technology | Version |
|-----------|------------|---------|
| Runtime | Electron | 33.x |
| Audio Capture | sox | system |
| Virtual Audio | BlackHole 2ch | system |
| Transcription | whisper.cpp | local build |
| Summarisation | Ollama (llama3.2) | system |
| Calendar Source | EventKit (Swift CLI helper) | macOS 13+ |
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
│   ├── fileManager.js         # Directory structure, cleanup, stats
│   ├── meetingDetector.js     # App-based meeting detection (Zoom/FaceTime/Meet)
│   ├── calendarSuggester.js   # 60s poll, filter rules, fire pre-meeting banners
│   ├── dismissalRegistry.js   # Shared dismiss-state owner (consulted by both)
│   ├── silenceWatcher.js      # Timer-free silence-streak state machine (auto-stop)
│   ├── meetingTemplate.js     # Pure: event → context + skeleton markdown (app + MCP share)
│   ├── meetingFilter.js       # Pure: the eligibility predicate (suggester + MCP share)
│   ├── preparedMeetingStore.js # Directory-of-files handoff store (app reads/claims, MCP writes)
│   └── calendarSources/       # Pluggable calendar source layer
│       ├── index.js
│       ├── macOSCalendarSource.js  # Spawns calendar-helper Swift CLI
│       └── gmailCalendarSource.js  # v2 stub
├── shared/
│   └── paths.js               # Electron-free frozen paths + calendar-helper resolver (app + MCP share)
├── mcp/                       # Standalone MCP server (stdio, no Electron, no ports)
│   ├── server.js              # stdio server; 7 calendar/prepare tools
│   ├── handlers.js            # Tool definitions + dispatch (pure of the SDK)
│   ├── calendarFactory.js     # Builds MacOSCalendarSource + process-cleanup shim
│   └── check.js               # `npm run mcp:check` permission doctor
├── utils/
│   └── audioDevices.js        # BlackHole detection + mic enumeration
├── models/                    # whisper.cpp model files (ggml-base.en.bin)
├── assets/                    # App icons
├── native/
│   ├── sck-audio-capture/     # ScreenCaptureKit system audio CLI
│   └── calendar-helper/       # EventKit calendar CLI (request-access/upcoming/current)
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

7. **Calendar permission gating**: The macOS Calendar permission prompt fires on first `EKEventStore` access from the `calendar-helper` Swift binary — not on app launch, not from Electron. The suggester must (a) request access on first start, (b) self-disable if denied, (c) not loop helper invocations against a denied state.
   - Why: Without the user-facing permission flow, the helper exits with code 2/3 every poll and the UI never reflects the actual state.
   - Pattern: `services/calendarSources/macOSCalendarSource.js` → `ensurePermission()`; `main.js` IPC `calendar:requestPermission`.

8. **Single dismiss-state source**: Banner dismissals MUST go through `DismissalRegistry`. The meeting detector and calendar suggester both consult the same registry so dismissing the pre-meeting banner suppresses the in-meeting banner for the same occurrence (and vice versa).
   - Why: Two independent dismissal sets would re-fire the banner the moment Zoom opens, defeating the whole point.
   - Pattern: `services/dismissalRegistry.js` → `isDismissed()` / `dismiss({ kind, expiry })`.

9. **Single idempotent stop path**: Every stop trigger — tray menu, `recording:stop` IPC, silence prompt "Stop & save", and the silence grace-timer auto-stop — MUST route through `stopRecording()` in `main.js`. It carries an in-flight guard (`stopInProgress`) so concurrent triggers no-op rather than double-stopping.
   - Why: The silence feature adds *two* new stop triggers; divergent stop paths (the old tray vs. IPC duplication) drift in behaviour and a double-stop can orphan sox/SCK processes.
   - Pattern: `main.js` → `stopRecording()`; callers `handleStopRecording()`, IPC `recording:stop`, IPC `silence:stopNow`, `silenceGraceTimer`.

10. **Silence detection is per-track, never auto-stops on unknown audio**: Each poll classifies every track as **live** (file grew), **unknown** (briefly not grown, `< STALL_TIMEOUT_MS` = 120s), or **ended** (not grown for `>= 120s` — capture is dead). The `SilenceWatcher` judges silence over the **live** tracks only: any relevant track `unknown` pauses the whole poll (a transient stall must not masquerade as a finished meeting); a long-stalled track is **ended** and *excluded* (it no longer poisons the decision — the 2h39m-for-25min incident, session 2026-05-29_20-03-47); when **all** relevant tracks are `ended` (a fully-dead capture) the poll is treated as silence. Every path still routes through the prompt + 60s grace timer — it **never** silently stops. `LevelMonitor` returns level `0` on read failure, indistinguishable from silence, which is why the unknown/ended split (not raw levels) gates the decision.
   - Why: The whole risk surface is accidentally killing a valid recording; the prompt-then-grace design is the safety net for the SCK zero-fill case (gotchas #5). A single global `healthy` boolean conflated transient and permanent stalls and disabled auto-stop for a half-dead capture.
   - Pattern: `services/silenceWatcher.js` → `classifyTrackGrowth()` + `update(levels, { trackHealth })`; per-track growth computed in `main.js` `startLevelMonitor()`. Tested in `services/silenceWatcher.test.js` (`npm test`, plain node).

11. **No recorder reinit mid-recording**: `settings:update` MUST skip `initRecorder()` while a recording is active (`isRecordingActive()`). Swapping the `recorder`/`dualRecorder` references mid-capture orphans the live processes; recorder-affecting settings apply on the next start.
   - Why: The always-wired Save button makes a mid-recording settings save reachable; saving silence settings during a recording must not tear down the live recorder.
   - Pattern: `main.js` IPC `settings:update` → `if (!isRecordingActive()) initRecorder();`.

12. **The handoff directory is the ONLY cross-process channel; the MCP server is read/stage-only**: The standalone MCP server (`mcp/server.js`) and the Electron app communicate *exclusively* through the filesystem handoff at `~/Library/Application Support/Notes4Chris/handoff/prepared` (computed by `shared/paths.js`, never `app.getPath`). The MCP server only **reads calendars + stages** prepared meetings (atomic tmp+rename); the app only **reads + claims** them (atomic `rename .json → .applied`). The MCP server NEVER drives a recording — there is no live-control bridge. Both sides build the template from the same `services/meetingTemplate.js` and agree on paths via the same `shared/paths.js`, so a prepared meeting and the recording the app starts can never diverge. Never route this state through `electron-store` (a second writer would clobber it).
   - Why: Two processes, one with no Electron context, must agree on a path with zero ambiguity (`name:"notes4chris"` vs `productName:"Notes4Chris"` makes `app.getPath('userData')` dev-vs-packaged ambiguous — hence the frozen literal). A live-control bridge would couple the two lifecycles; the file handoff keeps them independent (the app can be closed when meetings are prepared).
   - Pattern: `shared/paths.js` → `getPreparedDir()`; `services/preparedMeetingStore.js` (filename suffix `.json`/`.applied`/`.cancelled` is the authoritative state); `mcp/handlers.js`; `main.js` IPC `meeting:confirmRecord` → `claim()`.

13. **The skeleton is a sibling file gated on dual-track; the manifest stays flat**: The rich structured note skeleton is written to `<sessionDir>/meeting-skeleton.md` (the human jots live notes here; the AI summary still lands in `notes.md` — they never collide). Only the flat `{title, participants, agenda}` subset reaches `manifest.json` (invariant #2, summariser unchanged). Skeleton writing is gated on `useDual` — system-only mode returns a flat `.wav` with no session dir, so it is skipped + logged (never written to `undefined`).
   - Why: Widening the manifest with nested keys would fight invariant #2 and the recorder only copies the flat three. A sibling file keeps the rich template without touching the manifest/summariser contract.
   - Pattern: `main.js` → `writeMeetingSkeleton()` inside `startRecordingWithContext()` (after `dualRecorder.start()`); render via `services/meetingTemplate.js` → `renderSkeletonMarkdown()`.

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

### Calendar-Driven Templated Meetings (+ standalone MCP)
Two processes that meet only through the filesystem handoff (invariant #12):

1. **Prepare (optional, ahead of time)** — a background process / Claude routine calls the MCP server's `prepare_meeting({fingerprint|eventId})`. The server reuses the EventKit `calendar-helper`, builds the template via `meetingTemplate.js`, and stages a record to `handoff/prepared/cal_<id>.json` (atomic). Works with the app closed. No ports — stdio only.
2. **Detect** — the app's `MeetingDetector`/`CalendarSuggester` fires on a call. If a `calendarEvent` is present AND `calendarAutoTemplateEnabled` is on, `decideBannerMode()` returns `'confirm'`; else today's `'suggest'` flow is preserved.
3. **1-click confirm** — the banner shows a single **Record** button → IPC `meeting:confirmRecord` → `buildMeetingContext(event)` → `recordDismissal()` (same `DismissalRegistry`, invariant #8) → `preparedMeetingStore.claim(fp)` (best-effort; works with no prepared file) → `startRecordingWithContext(richCtx)`.
4. **Skeleton** — after `dualRecorder.start()`, `writeMeetingSkeleton()` writes `meeting-skeleton.md` (invariant #13). The flat `{title,participants,agenda}` still flows to the manifest; the summariser is unchanged.

Permission caveat (gotcha #8): a headless MCP-spawned helper may be keyed to a different code signature than the granted one. `shared/paths.js` prefers the installed app's signed helper; `npm run mcp:check` drives the grant + reports the fix.
