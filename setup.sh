#!/bin/bash

echo "Meeting Recorder - Setup Script"
echo "================================"
echo ""

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
  echo "❌ This app requires macOS"
  exit 1
fi

# Check for Homebrew
if ! command -v brew &> /dev/null; then
  echo "❌ Homebrew not found. Install from: https://brew.sh"
  exit 1
fi

echo "✅ macOS and Homebrew detected"
echo ""

# Install sox
echo "📦 Installing sox..."
if command -v sox &> /dev/null; then
  echo "✅ sox already installed ($(sox --version | head -n1))"
else
  brew install sox
  echo "✅ sox installed successfully"
fi
echo ""

# Check for BlackHole
echo "🔍 Checking for BlackHole audio device..."
if system_profiler SPAudioDataType | grep -q "BlackHole"; then
  echo "✅ BlackHole detected"
else
  echo "⚠️  BlackHole 2ch not detected"
  echo ""
  echo "   BlackHole is required to capture system audio."
  echo "   Download from: https://github.com/ExistentialAudio/BlackHole"
  echo ""
  echo "   After installation:"
  echo "   1. Open Audio MIDI Setup"
  echo "   2. Create a Multi-Output Device"
  echo "   3. Check both your speakers and BlackHole 2ch"
  echo "   4. Set Multi-Output Device as your system output"
  echo ""
  read -p "Press Enter after installing BlackHole to continue..."
fi
echo ""

# Check for cmake (required for whisper.cpp compilation)
echo "📦 Checking for cmake..."
if ! command -v cmake &> /dev/null; then
  echo "📥 Installing cmake..."
  brew install cmake
  echo "✅ cmake installed"
else
  echo "✅ cmake already installed"
fi
echo ""

# Clone and build whisper.cpp
echo "📦 Setting up whisper.cpp..."
if [ ! -d "whisper.cpp" ]; then
  echo "📥 Cloning whisper.cpp repository..."
  git clone https://github.com/ggerganov/whisper.cpp.git
else
  echo "✅ whisper.cpp directory already exists"
fi

# Check if binary exists, compile if not
# New location: whisper.cpp/build/bin/whisper-cli (CMake build)
# Old location: whisper.cpp/main (old Makefile build)
if [ -f "whisper.cpp/build/bin/whisper-cli" ] || [ -f "whisper.cpp/main" ]; then
  echo "✅ whisper.cpp binary already compiled"
else
  echo "🔨 Compiling whisper.cpp..."
  cd whisper.cpp
  make
  cd ..

  if [ -f "whisper.cpp/build/bin/whisper-cli" ]; then
    echo "✅ whisper.cpp compiled successfully (CMake build)"
  elif [ -f "whisper.cpp/main" ]; then
    echo "✅ whisper.cpp compiled successfully (Makefile build)"
  else
    echo "❌ Compilation failed - please check for errors above"
  fi
fi
echo ""

# Download whisper model
echo "📥 Checking for whisper model..."
if [ -f "whisper.cpp/models/ggml-base.en.bin" ]; then
  echo "✅ Whisper model already downloaded"
else
  echo "📥 Downloading base.en model (this may take a while)..."
  cd whisper.cpp
  bash ./models/download-ggml-model.sh base.en
  cd ..
  echo "✅ Whisper model downloaded"
fi
echo ""

# Copy model to models directory
if [ -f "models/ggml-base.en.bin" ]; then
  echo "✅ Model already in models/ directory"
else
  echo "📋 Copying model to models/ directory..."
  cp whisper.cpp/models/ggml-base.en.bin models/
  echo "✅ Model copied"
fi
echo ""

# Build calendar-helper Swift binary
echo "🔨 Building calendar-helper (EventKit CLI)..."
if [ -d "native/calendar-helper" ]; then
  if command -v swift &> /dev/null; then
    (cd native/calendar-helper && swift build -c release \
        -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist \
        -Xlinker "$PWD/Info.plist" \
      && codesign -f -s - --entitlements CalendarHelper.entitlements \
        --identifier com.christopherrobinson.calendar-helper .build/release/calendar-helper)
    if [ -f "native/calendar-helper/.build/release/calendar-helper" ]; then
      echo "✅ calendar-helper built and signed"
    else
      echo "⚠️  calendar-helper build did not produce a binary"
    fi
  else
    echo "⚠️  swift not available — install Xcode Command Line Tools to build calendar-helper"
  fi
else
  echo "⚠️  native/calendar-helper/ not found"
fi
echo ""

# ── Parakeet (default transcription backend) ─────────────────────────────────
# Parakeet-TDT (via parakeet-mlx) is the default transcriber — best local
# accuracy on meeting speech, fully on-device. Runs via `uv`; whisper.cpp stays
# as the automatic fallback. Force whisper with NOTES4CHRIS_TRANSCRIBER=whisper.
echo "🦜 Setting up Parakeet (default transcription backend)..."
if command -v uv >/dev/null 2>&1; then
  echo "  uv found: $(command -v uv)"
  echo "  Pre-pulling the Parakeet model (parakeet-tdt-0.6b-v3, ~2.3GB)..."
  if uvx --from parakeet-mlx python -c "from parakeet_mlx import from_pretrained; from_pretrained('mlx-community/parakeet-tdt-0.6b-v3'); print('ok')" >/dev/null 2>&1; then
    echo "  ✅ Parakeet model ready."
  else
    echo "  ⚠️  Parakeet model pre-pull failed — it will download on first transcription."
  fi
else
  echo "  ⚠️  'uv' not installed — Parakeet needs it; transcription falls back to whisper.cpp."
  echo "      Install:  curl -LsSf https://astral.sh/uv/install.sh | sh"
fi
echo ""

echo "================================"
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Configure Multi-Output Device in Audio MIDI Setup"
echo "     (System audio → Multi-Output Device with BlackHole + Speakers)"
echo "  2. Install Codex CLI: npm install -g @anthropic-ai/codex"
echo "  3. Run the app: npm start"
echo "  4. Click the menu bar icon to start recording"
echo ""
echo "For troubleshooting, see the README.md file"
echo "================================"
