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
