# Changelog

All notable changes to Notes4Chris will be documented in this file.

## [Unreleased]

### Added
- 2026-05-14: Calendar-aware note-taking suggestions. New `native/calendar-helper/` Swift CLI queries macOS EventKit (request-access / upcoming / current). `services/calendarSuggester.js` polls every 60s, filters events (≥2 attendees, not all-day, not declined, not in user denylist), and fires a pre-meeting banner at a configurable lead time (default 2 min). `services/dismissalRegistry.js` is now the single source of truth for banner dismissals — the meeting detector consults it through the calendar `occurrenceFingerprint` when an enricher hit lines up a Zoom/FaceTime/Meet detection with the current calendar event. Pre-record popup is seeded from the calendar event's title, attendees, and notes when "Take notes" is clicked on an enriched banner. New settings: `calendarSuggestionsEnabled`, `calendarLeadTimeMinutes`, `calendarDenylist`, `calendarDismissedFingerprints`. New entitlement `com.apple.security.personal-information.calendars` + `NSCalendarsUsageDescription` / `NSCalendarsFullAccessUsageDescription` usage strings on both the app and the helper.

### Fixed
- 2026-04-21: System audio silently captured zero-filled frames when Rogue Amoeba's `ARK.driver` was loaded in coreaudiod. Switched `SCContentFilter(display:excludingWindows:)` to the per-app `SCContentFilter(display:including:exceptingWindows:)` shape in `native/sck-audio-capture/Sources/AudioCapture.swift`. SCK no longer pulls from the display-mix audio path that ARK can hijack.

### Added (earlier)
- 2026-04-21: Gotchas #5 (SCK ARK-driver zero-frames) and #6 (compound "both tracks silent" diagnostic ritual) in `.claude/rules/gotchas.md`. Expanded #4 (orphaned sox) with mic-contention failure mode and recovery commands.
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
