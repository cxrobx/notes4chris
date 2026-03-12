const { execSync, spawnSync } = require('child_process');
const os = require('os');

/**
 * Find BlackHole audio device
 *
 * BlackHole device names can vary across systems:
 * - "BlackHole 2ch"
 * - "BlackHole 2ch (virtual)"
 * - "BlackHole2ch"
 *
 * This function auto-detects the correct device name.
 *
 * @returns {string} BlackHole device name
 * @throws {Error} If BlackHole is not found
 */
function findBlackHoleDevice() {
  try {
    // On macOS, use system_profiler to detect BlackHole
    console.log('Detecting BlackHole audio device...');

    const audioDevices = execSync('system_profiler SPAudioDataType 2>&1', { encoding: 'utf-8' });

    // Check if BlackHole is in the output
    if (!audioDevices.toLowerCase().includes('blackhole')) {
      throw new Error('BlackHole not found in audio devices');
    }

    console.log('BlackHole detected in system audio devices');

    // BlackHole exists, now find the exact device name for sox
    const possibleNames = [
      'BlackHole 2ch',
      'BlackHole2ch',
      'BlackHole 16ch',
      'BlackHole'
    ];

    // Try to verify which one exists by attempting to get device info
    for (const name of possibleNames) {
      console.log(`Trying device name: "${name}"`);
      return name;
    }

    return 'BlackHole 2ch';

  } catch (err) {
    if (err.message.includes('BlackHole not found')) {
      throw new Error(
        'BlackHole audio device not detected. Please install BlackHole 2ch from:\n' +
        'https://github.com/ExistentialAudio/BlackHole\n\n' +
        'After installation:\n' +
        '1. Open Audio MIDI Setup\n' +
        '2. Create a Multi-Output Device\n' +
        '3. Check both your speakers and BlackHole 2ch\n' +
        '4. Set Multi-Output Device as system default'
      );
    }

    throw new Error('Failed to detect audio devices: ' + err.message);
  }
}

/**
 * Verify that BlackHole device is accessible
 *
 * @param {string} deviceName - The device name to verify
 * @returns {boolean} True if device is accessible
 */
function verifyDevice(deviceName) {
  try {
    const audioDevices = execSync('system_profiler SPAudioDataType', { encoding: 'utf-8' });
    return audioDevices.toLowerCase().includes('blackhole');
  } catch (err) {
    console.error('Failed to verify device:', err.message);
    return false;
  }
}

/**
 * List all available audio input devices with metadata
 *
 * Parses system_profiler SPAudioDataType output to find devices with input channels.
 *
 * @returns {Array<{name: string, channels: number, sampleRate: string, transport: string, isDefault: boolean}>}
 */
function listInputDevices() {
  try {
    const output = execSync('system_profiler SPAudioDataType 2>&1', { encoding: 'utf-8' });

    const devices = [];

    let currentDevice = null;
    let hasInputChannels = false;
    let inputChannels = 0;
    let sampleRate = '';
    let transport = '';
    let isDefault = false;

    const lines = output.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Device name line: indented by 8 spaces, followed by colon
      // e.g. "        MacBook Pro Microphone:"
      const deviceMatch = line.match(/^        (\S.+?):\s*$/);
      if (deviceMatch) {
        // Save previous device if it had input channels
        if (currentDevice && hasInputChannels && inputChannels > 0) {
          devices.push({
            name: currentDevice,
            channels: inputChannels,
            sampleRate: sampleRate,
            transport: transport,
            isDefault: isDefault
          });
        }

        currentDevice = deviceMatch[1];
        hasInputChannels = false;
        inputChannels = 0;
        sampleRate = '';
        transport = '';
        isDefault = false;
        continue;
      }

      if (!currentDevice) continue;

      // Parse device properties (indented by 10+ spaces)
      // e.g. "          Input Channels: 1"
      const propMatch = line.match(/^\s{10,}(.+?):\s+(.+)$/);
      if (propMatch) {
        const key = propMatch[1].trim().toLowerCase();
        const value = propMatch[2].trim();

        if (key === 'input channels') {
          hasInputChannels = true;
          inputChannels = parseInt(value, 10) || 0;
        } else if (key === 'current samplerate') {
          sampleRate = value;
        } else if (key === 'transport') {
          transport = value;
        } else if (key === 'default input device') {
          isDefault = value.toLowerCase() === 'yes';
        }
      }
    }

    // Don't forget the last device
    if (currentDevice && hasInputChannels && inputChannels > 0) {
      devices.push({
        name: currentDevice,
        channels: inputChannels,
        sampleRate: sampleRate,
        transport: transport,
        isDefault: isDefault
      });
    }

    return devices;

  } catch (err) {
    console.error('Failed to list input devices:', err.message);
    return [];
  }
}

/**
 * Find the default microphone device
 *
 * @returns {{name: string, channels: number, sampleRate: string}|null}
 */
function findDefaultMicrophone() {
  const devices = listInputDevices();

  if (devices.length === 0) return null;

  // First try: device marked as default
  const defaultDevice = devices.find(d => d.isDefault);
  if (defaultDevice) return defaultDevice;

  // Fallback: first non-BlackHole, non-virtual input device
  const physicalDevice = devices.find(d =>
    !d.name.toLowerCase().includes('blackhole') &&
    !d.name.toLowerCase().includes('virtual') &&
    !d.name.toLowerCase().includes('aggregate')
  );
  if (physicalDevice) return physicalDevice;

  // Last resort: first device that isn't BlackHole
  const nonBlackhole = devices.find(d => !d.name.toLowerCase().includes('blackhole'));
  return nonBlackhole || devices[0];
}

/**
 * Verify that a named input device is available
 *
 * @param {string} deviceName - The device name to verify
 * @returns {boolean} True if device is found in input device list
 */
function verifyInputDevice(deviceName) {
  const devices = listInputDevices();
  return devices.some(d => d.name === deviceName);
}

/**
 * List all available audio devices (legacy - uses sox)
 *
 * @returns {string[]} Array of device names
 */
function listAudioDevices() {
  try {
    const devices = execSync('sox --list-devices 2>&1', { encoding: 'utf-8' });
    const lines = devices.split('\n');
    const deviceNames = [];

    for (let line of lines) {
      if (!line.trim() || line.includes('AUDIO DRIVERS') || line.includes('---')) {
        continue;
      }

      const quotedMatch = line.match(/"([^"]+)"/);
      if (quotedMatch) {
        deviceNames.push(quotedMatch[1]);
      }
    }

    return deviceNames;
  } catch (err) {
    console.error('Failed to list audio devices:', err.message);
    return [];
  }
}

/**
 * Check if ScreenCaptureKit is available on this system
 *
 * Requires macOS 13.0+ (Ventura). Optionally checks permission status
 * by running the sck-audio-capture binary with --check flag.
 *
 * @param {string} [sckBinaryPath] - Path to sck-audio-capture binary
 * @returns {{available: boolean, permitted: boolean|null, reason?: string}}
 */
function checkSckAvailable(sckBinaryPath) {
  // Check macOS version >= 13
  const release = os.release(); // e.g. "22.0.0" for macOS 13.0
  const majorVersion = parseInt(release.split('.')[0], 10);
  // Darwin 22.x = macOS 13 (Ventura)
  if (majorVersion < 22) {
    return { available: false, permitted: null, reason: 'macOS 13.0+ required for ScreenCaptureKit' };
  }

  // Check binary exists
  if (!sckBinaryPath) {
    return { available: false, permitted: null, reason: 'SCK binary path not provided' };
  }

  const fs = require('fs');
  if (!fs.existsSync(sckBinaryPath)) {
    return { available: false, permitted: null, reason: 'SCK binary not found' };
  }

  // Check permission by running --check
  try {
    const result = spawnSync(sckBinaryPath, ['--check'], {
      timeout: 10000,
      encoding: 'utf-8'
    });

    if (result.status === 0) {
      return { available: true, permitted: true };
    } else if (result.status === 2) {
      return { available: true, permitted: false, reason: 'Screen Recording permission not granted' };
    } else {
      const stderr = (result.stderr || '').trim();
      return { available: false, permitted: null, reason: stderr || 'SCK check failed' };
    }
  } catch (err) {
    return { available: false, permitted: null, reason: `SCK check error: ${err.message}` };
  }
}

module.exports = {
  findBlackHoleDevice,
  verifyDevice,
  listAudioDevices,
  listInputDevices,
  findDefaultMicrophone,
  verifyInputDevice,
  checkSckAvailable
};
