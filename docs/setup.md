# Environment & Setup

## Prerequisites

| Dependency | Purpose | Install |
|------------|---------|---------|
| Node.js | Electron runtime | `brew install node` |
| sox | Audio recording | `brew install sox` |
| BlackHole 2ch | Virtual audio device for system audio capture | [existential.audio](https://existential.audio/blackhole/) |
| whisper.cpp | Local speech-to-text | Built via `setup.sh` |
| Codex CLI | Local note generation CLI | `npm install -g @anthropic-ai/codex` |

## Quick Start

```bash
# 1. Clone and install
git clone <repo-url>
cd notes4chris
npm install

# 2. Install system dependencies
./setup.sh

# 3. Download whisper model (if setup.sh didn't)
# Place ggml-base.en.bin in models/

# 4. Install Codex CLI
npm install -g @anthropic-ai/codex

# 5. Launch
npm start
```

## BlackHole Setup

1. Install BlackHole 2ch from [existential.audio](https://existential.audio/blackhole/)
2. Open **Audio MIDI Setup** (macOS)
3. Create a **Multi-Output Device** combining your speakers + BlackHole 2ch
4. Set the Multi-Output Device as your system output
5. Notes4Chris will capture system audio via BlackHole

## Build

```bash
npm run build    # Produces dmg + zip in dist/
```

Build configuration is in `package.json` under `"build"`. The app is signed with hardened runtime and includes microphone entitlements via `entitlements.mac.plist`.

## Re-summarise Existing Recordings

```bash
npm run summaryonly    # Runs summarise-only.js on existing session directories
```
