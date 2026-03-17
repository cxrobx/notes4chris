const { app, Tray, Menu, BrowserWindow, shell, nativeImage, Notification, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');
const { execSync } = require('child_process');

// Suppress EPIPE errors on stdout/stderr when launched from Finder (no terminal attached)
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

// Ensure homebrew paths are available (packaged .app has minimal PATH)
const EXTRA_PATHS = [
  '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin',
  path.join(os.homedir(), '.nvm/versions/node/v24.11.1/bin'),  // nvm-installed globals (codex)
  path.join(os.homedir(), '.local/bin'),                        // claude CLI
];
const missingPaths = EXTRA_PATHS.filter(p => !(process.env.PATH || '').includes(p));
if (missingPaths.length) {
  process.env.PATH = missingPaths.join(':') + ':' + (process.env.PATH || '');
}
console.log('PATH:', process.env.PATH);

const { Recorder, DualTrackRecorder } = require('./services/recorder');
const { LevelMonitor } = require('./services/levelMonitor');
const { transcribe, transcribeSession, verifyInstallation: verifyWhisper } = require('./services/transcriber');
const { generateNotes, generateSessionNotes, exportNotesToObsidian, isCodexAvailable, isClaudeAvailable } = require('./services/summariser');
const { ensureDirectoryStructure, cleanupOldRecordings, getStorageStats } = require('./services/fileManager');
const { listInputDevices, findDefaultMicrophone, verifyInputDevice, findBlackHoleDevice, checkSckAvailable } = require('./utils/audioDevices');
const { trimSilence } = require('./utils/audioProcessing');
const { checkForProvider } = require('./services/companionTranscript');

const OBSIDIAN_VAULT_DIRECTORY = path.join(app.getPath('documents'), 'CX');

// Persistent config store
const store = new Store({
  defaults: {
    outputDirectory: path.join(app.getPath('documents'), 'Notes4ChrisRecordings'),
    retentionDays: 7,
    autoProcess: true,
    recordingMode: 'dual',
    micDevice: null,
    systemLabel: 'Remote',
    micLabel: 'Me',
    meetingContext: {
      title: '',
      participants: '',
      agenda: ''
    },
    useSharedTranscript: true
  }
});

let tray = null;
let settingsWindow = null;
let preRecordWindow = null;
let recorder = null;
let dualRecorder = null;
let currentRecordingPath = null;
let statusUpdateInterval = null;
let levelMonitor = null;
let trayIcon = null;
let latestLevels = { system: 0, mic: 0 };

// Track active processes for cleanup
const activeProcesses = new Set();

// Track dependency status
let dependenciesStatus = {
  sox: false,
  whisper: false,
  codex: false,
  mic: false,
  systemAudio: false,
  lastChecked: null
};

/**
 * Export generated notes to the configured Obsidian vault.
 */
function exportNotesToVault(notesPath, options = {}) {
  return exportNotesToObsidian(notesPath, OBSIDIAN_VAULT_DIRECTORY, options);
}

/**
 * Build a readable note title for flat transcript/note files.
 */
function buildSingleTrackNoteTitle(filepath) {
  return path.basename(filepath, path.extname(filepath))
    .replace(/_transcript$/i, '')
    .replace(/_notes$/i, '')
    .trim() || 'Meeting summary';
}

/**
 * Use meeting context when available, otherwise fall back to a generic title.
 */
function buildSessionNoteTitle(manifest) {
  return (manifest.meetingContext && manifest.meetingContext.title) || 'Meeting summary';
}

/**
 * Best-effort capture of when a single-track artefact was created.
 */
function getFileStartTime(filepath) {
  try {
    return fs.statSync(filepath).birthtime.toISOString();
  } catch (err) {
    return null;
  }
}

/**
 * Resolve path to the sck-audio-capture binary
 */
function getSckBinaryPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'sck-audio-capture');
  }
  return path.join(__dirname, 'native', 'sck-audio-capture', '.build', 'release', 'sck-audio-capture');
}

/**
 * Register a child process for cleanup on app exit
 */
function registerProcess(proc) {
  activeProcesses.add(proc);
  proc.on('exit', () => activeProcesses.delete(proc));
}

/**
 * Check if all required dependencies are installed
 */
function checkDependencies() {
  console.log('\n=== Checking Dependencies ===');

  const status = {
    sox: false,
    whisper: false,
    codex: false,
    mic: false,
    lastChecked: Date.now()
  };

  // Check sox
  console.log('Checking sox...');
  try {
    const soxPath = execSync('which sox', { encoding: 'utf-8' }).trim();
    console.log(`sox found at: ${soxPath}`);
    status.sox = true;
  } catch (err) {
    console.log('sox not found in PATH');
  }

  // Check whisper.cpp
  console.log('\nChecking whisper.cpp...');
  try {
    const whisperCheck = verifyWhisper();
    status.whisper = whisperCheck.installed;

    if (whisperCheck.installed) {
      console.log(`whisper binary found at: ${whisperCheck.binaryPath}`);
      console.log(`whisper model found at: ${whisperCheck.modelPath}`);
    } else {
      console.log(`whisper.cpp not found: ${whisperCheck.error}`);
    }
  } catch (err) {
    console.log('whisper.cpp check failed:', err.message);
    status.whisper = false;
  }

  // Check system audio capture (SCK or BlackHole)
  console.log('\nChecking system audio capture...');
  const sckPath = getSckBinaryPath();
  const sckStatus = checkSckAvailable(sckPath);
  let blackholeOk = false;
  try {
    findBlackHoleDevice();
    blackholeOk = true;
  } catch (err) {
    blackholeOk = false;
  }
  // SCK doesn't need sox; BlackHole fallback does
  status.systemAudio = (sckStatus.available && sckStatus.permitted) || (blackholeOk && status.sox);
  if (sckStatus.available && sckStatus.permitted) {
    console.log('System audio: ScreenCaptureKit available and permitted');
  } else if (blackholeOk && status.sox) {
    console.log('System audio: BlackHole + sox available (SCK fallback)');
  } else {
    console.log('System audio: no capture method available');
    if (blackholeOk && !status.sox) {
      console.log('  (BlackHole detected but sox is missing)');
    }
  }

  // Check microphone availability
  console.log('\nChecking microphone...');
  const mode = store.get('recordingMode');
  if (mode === 'dual') {
    const micDevice = store.get('micDevice');
    if (micDevice) {
      status.mic = verifyInputDevice(micDevice);
      console.log(`Mic device "${micDevice}": ${status.mic ? 'available' : 'not found'}`);
    } else {
      const defaultMic = findDefaultMicrophone();
      status.mic = defaultMic !== null;
      console.log(`Default mic: ${defaultMic ? defaultMic.name : 'none found'}`);
    }
  } else {
    status.mic = true; // Not needed in system-only mode
  }

  // Check AI summarisation (Codex or Claude CLI)
  console.log('\nChecking AI summarisation...');
  const codexOk = isCodexAvailable();
  const claudeOk = isClaudeAvailable();
  status.codex = codexOk || claudeOk;
  const provider = codexOk ? 'Codex' : claudeOk ? 'Claude' : 'none';
  console.log(`AI summarisation: ${status.codex ? `available (${provider})` : 'not found'}`);

  console.log('\n=== Dependency Check Summary ===');
  console.log(`sox:          ${status.sox ? 'OK' : 'MISSING'}`);
  console.log(`system audio: ${status.systemAudio ? 'OK' : 'MISSING'}`);
  console.log(`whisper:      ${status.whisper ? 'OK' : 'MISSING'}`);
  console.log(`ai summary:   ${status.codex ? 'OK' : 'MISSING'}`);
  console.log(`mic:          ${status.mic ? 'OK' : 'MISSING'}`);
  console.log('================================\n');

  dependenciesStatus = status;
  return status;
}

/**
 * Show a user-friendly notification
 */
function showNotification(title, body, isError = false) {
  if (Notification.isSupported()) {
    new Notification({
      title: title,
      body: body,
      silent: false
    }).show();
  } else if (isError) {
    dialog.showErrorBox(title, body);
  }
}

/**
 * Resolve the mic device name to use
 */
function resolveMicDevice() {
  const savedDevice = store.get('micDevice');
  if (savedDevice) {
    if (verifyInputDevice(savedDevice)) {
      return savedDevice;
    }
    console.warn(`Saved mic device "${savedDevice}" not available (disconnected?), falling back to default`);
  }

  const defaultMic = findDefaultMicrophone();
  if (defaultMic) {
    console.log(`Using default microphone: ${defaultMic.name}`);
    return defaultMic.name;
  }

  return null;
}

/**
 * Initialize recorder instances
 */
function initRecorder() {
  const outputDir = store.get('outputDirectory');
  ensureDirectoryStructure(outputDir);

  const sckBinaryPath = getSckBinaryPath();

  // Always create single-track recorder as fallback
  recorder = new Recorder(outputDir, sckBinaryPath);
  console.log(`Recorder initialized with output directory: ${outputDir}`);

  // Create dual-track recorder if mode is dual
  const mode = store.get('recordingMode');
  if (mode === 'dual') {
    const micDevice = resolveMicDevice();
    if (micDevice) {
      const systemLabel = store.get('systemLabel');
      const micLabel = store.get('micLabel');
      const meetingContext = store.get('meetingContext') || {};
      dualRecorder = new DualTrackRecorder(outputDir, micDevice, systemLabel, micLabel, sckBinaryPath, meetingContext);
      console.log(`DualTrackRecorder initialized with mic: ${micDevice}`);
    } else {
      console.warn('No mic device available - dual mode will fall back to system-only');
      dualRecorder = null;
    }
  } else {
    dualRecorder = null;
  }
}

/**
 * Create menu bar tray icon
 */
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  trayIcon = nativeImage.createFromPath(iconPath).resize({
    height: process.platform === 'darwin' ? 18 : 18
  });
  trayIcon.setTemplateImage(false);

  tray = new Tray(trayIcon);
  tray.setToolTip('Notes4Chris');

  updateTrayMenu();
}

/**
 * Create or show settings window
 */
function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 940,
    height: 780,
    minWidth: 760,
    minHeight: 560,
    title: 'Notes4Chris',
    titleBarStyle: 'hiddenInset',
    hasShadow: true,
    backgroundColor: '#000000',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    },
    show: false
  });

  settingsWindow.webContents.session.clearCache();
  settingsWindow.loadFile('renderer/index.html');

  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

/**
 * Update tray menu based on recording state
 */
function updateTrayMenu() {
  const mode = store.get('recordingMode');
  const isDualMode = mode === 'dual' && dualRecorder;
  const activeRecorder = isDualMode ? dualRecorder : recorder;
  const isRecording = activeRecorder && activeRecorder.isRecording;
  const status = activeRecorder ? activeRecorder.getStatus() : null;
  const canRecord = dependenciesStatus.systemAudio;

  const modeLabel = isDualMode ? 'Dual Track' : 'System Only';

  const menuTemplate = [
    {
      label: isRecording ? '⏹  Stop Recording' : '⏺  Start Recording',
      click: isRecording ? handleStopRecording : handleStartRecording,
      enabled: isRecording || canRecord
    },
    {
      label: isRecording
        ? `Recording (${modeLabel}): ${formatDuration(status.duration)}`
        : (canRecord ? `Ready (${modeLabel})` : 'Dependencies missing'),
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Settings...',
      click: openSettingsWindow
    },
    { type: 'separator' },
    {
      label: 'Open Recordings Folder',
      click: () => {
        const recordingsPath = path.join(store.get('outputDirectory'), 'recordings');
        ensureDirectoryStructure(store.get('outputDirectory'));
        shell.openPath(recordingsPath);
      }
    },
    {
      label: 'View Processed Notes',
      click: () => {
        const processedPath = path.join(store.get('outputDirectory'), 'processed');
        ensureDirectoryStructure(store.get('outputDirectory'));
        shell.openPath(processedPath);
      }
    },
    { type: 'separator' },
    {
      label: 'Refresh Dependencies',
      click: () => {
        checkDependencies();
        setTimeout(() => {
          showNotification('Dependencies Checked', 'Check the console for details');
        }, 500);
      }
    },
    {
      label: 'Check Dependencies',
      click: showDependencyStatus
    },
    {
      label: 'Run Setup Script',
      click: runSetupScript
    },
    { type: 'separator' },
    {
      label: 'Storage Stats',
      click: showStorageStats
    },
    {
      label: 'Cleanup Old Recordings',
      click: runCleanup
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      }
    }
  ];

  const contextMenu = Menu.buildFromTemplate(menuTemplate);
  tray.setContextMenu(contextMenu);
}

/**
 * Start recording handler
 */
function handleStartRecording() {
  showPreRecordPopup();
}

/**
 * Show pre-record popup for meeting context, then start recording
 */
function showPreRecordPopup() {
  if (preRecordWindow && !preRecordWindow.isDestroyed()) {
    preRecordWindow.focus();
    return;
  }

  preRecordWindow = new BrowserWindow({
    width: 460,
    height: 470,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-prerecord.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  preRecordWindow.loadFile(path.join(__dirname, 'renderer', 'pre-record.html'));
  preRecordWindow.once('ready-to-show', () => {
    preRecordWindow.show();
    preRecordWindow.focus();
    app.dock.show();  // Ensure app appears in dock so it can take focus
  });
  preRecordWindow.on('closed', () => { preRecordWindow = null; });
}

/**
 * Actually start the recording after context is collected
 */
function startRecordingWithContext(meetingContext) {
  // Save context for next time
  store.set('meetingContext', meetingContext);

  // Reinitialize recorder so it picks up the new context
  initRecorder();

  const mode = store.get('recordingMode');
  const useDual = mode === 'dual' && dualRecorder;

  try {
    if (useDual) {
      // Dual-track mode
      const result = dualRecorder.start((warning) => {
        console.warn(warning);
      });
      console.log(`Dual recording started in: ${result.sessionDir}`);
    } else {
      // System-only mode
      const result = recorder.start((warning) => {
        console.warn(warning);
      });
      currentRecordingPath = result.filepath;
      console.log(`Recording started: ${currentRecordingPath}`);
    }

    statusUpdateInterval = setInterval(() => {
      const activeRecorder = useDual ? dualRecorder : recorder;
      if (!activeRecorder.isRecording) {
        clearInterval(statusUpdateInterval);
        statusUpdateInterval = null;
      } else {
        updateTrayMenu();
      }
    }, 1000);

    updateTrayMenu();

    // Start audio level monitoring
    startLevelMonitor(useDual);

    // Check for companion transcript provider
    let companionProvider = null;
    if (store.get('useSharedTranscript') !== false) {
      companionProvider = checkForProvider();
      if (companionProvider) {
        console.log(`[Companion] Detected provider: ${companionProvider.app}`);
      }
    }

    // Notify settings window that recording started
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('recording:update', {
        state: 'recording',
        mode: useDual ? 'dual' : 'system',
        startTime: Date.now()
      });
      if (companionProvider) {
        settingsWindow.webContents.send('companion-mode-status', {
          active: true,
          provider: companionProvider.app
        });
      }
    }

  } catch (err) {
    console.error('Failed to start recording:', err);

    const errorMessage = err.message.split('\n')[0];
    showNotification('Cannot Start Recording', errorMessage, true);

    if (err.message.includes('sox')) {
      setTimeout(() => {
        const response = dialog.showMessageBoxSync({
          type: 'error',
          title: 'Dependencies Missing',
          message: 'sox is not installed',
          detail: 'sox is required for audio recording.\n\nWould you like to run the setup script now?',
          buttons: ['Run Setup', 'Install Manually', 'Cancel'],
          defaultId: 0
        });

        if (response === 0) {
          runSetupScript();
        } else if (response === 1) {
          shell.openExternal('https://github.com/andyjarrett/notes4me#setup');
        }
      }, 100);
    }
  }
}

/**
 * Stop recording handler
 */
async function handleStopRecording() {
  const mode = store.get('recordingMode');
  const useDual = mode === 'dual' && dualRecorder && dualRecorder.isRecording;

  try {
    stopLevelMonitor();

    // Clear interval and update menu immediately (isRecording is set to false
    // synchronously in both Recorder.stop() and DualTrackRecorder.stop())
    if (statusUpdateInterval) {
      clearInterval(statusUpdateInterval);
      statusUpdateInterval = null;
    }

    // Start stop but don't await yet — update UI first
    const stopPromise = useDual ? dualRecorder.stop() : recorder.stop();

    updateTrayMenu();

    // Notify settings window immediately
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('recording:update', { state: 'stopped' });
      settingsWindow.webContents.send('companion-mode-status', { active: false });
    }

    // Now await the actual stop result for logging and auto-processing
    const result = await stopPromise;

    if (useDual) {
      console.log(`Dual recording stopped: ${result.sessionDir}`);
      console.log(`Duration: ${formatDuration(result.duration)}`);
      console.log(`System: ${(result.systemSize / (1024 * 1024)).toFixed(2)} MB`);
      console.log(`Mic: ${(result.micSize / (1024 * 1024)).toFixed(2)} MB`);

      const autoProcess = store.get('autoProcess');
      if (autoProcess) {
        processSession(result.sessionDir, result.duration).catch(err => {
          console.error('Auto-processing session failed (tray):', err);
          showNotification('Processing Error', `Failed: ${err.message.split('\n')[0]}`, true);
          if (settingsWindow && !settingsWindow.isDestroyed()) {
            settingsWindow.webContents.send('processing:complete', { error: err.message });
          }
        });
      }
    } else {
      console.log(`Recording stopped: ${result.filepath}`);
      console.log(`Duration: ${formatDuration(result.duration)}`);
      console.log(`Size: ${(result.size / (1024 * 1024)).toFixed(2)} MB`);

      const autoProcess = store.get('autoProcess');
      if (autoProcess) {
        processRecording(result.filepath, result.duration).catch(err => {
          console.error('Auto-processing recording failed (tray):', err);
          showNotification('Processing Error', `Failed: ${err.message.split('\n')[0]}`, true);
        });
      }
    }

  } catch (err) {
    console.error('Failed to stop recording:', err);

    // Ensure UI is updated even on error
    if (statusUpdateInterval) {
      clearInterval(statusUpdateInterval);
      statusUpdateInterval = null;
    }
    updateTrayMenu();
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('recording:update', { state: 'stopped' });
      settingsWindow.webContents.send('companion-mode-status', { active: false });
    }
    showNotification('Recording Error', `Failed to stop: ${err.message}`, true);
  }
}

/**
 * Convert a 0-1 level to a block character for menu bar display
 */
const LEVEL_BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function levelToBar(level) {
  const idx = Math.min(LEVEL_BLOCKS.length - 1, Math.round(level * (LEVEL_BLOCKS.length - 1)));
  return LEVEL_BLOCKS[idx];
}

/**
 * Start polling WAV files for audio levels and sending to the settings window + tray
 */
function startLevelMonitor(isDual) {
  stopLevelMonitor();

  levelMonitor = new LevelMonitor((levels) => {
    // Store latest levels for tray menu display
    latestLevels = levels;

    // Send to settings window
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('recording:levels', levels);
    }

    // Show live levels in the menu bar next to the tray icon
    const sysBar = levelToBar(levels.system || 0);
    if (isDual) {
      const micBar = levelToBar(levels.mic || 0);
      tray.setTitle(`S${sysBar} M${micBar}`);
    } else {
      tray.setTitle(`S${sysBar}`);
    }
  });

  if (isDual && dualRecorder) {
    levelMonitor.addTrack('system', dualRecorder.systemFile);
    levelMonitor.addTrack('mic', dualRecorder.micFile);
  } else if (recorder && recorder.currentFile) {
    levelMonitor.addTrack('system', recorder.currentFile);
  }

  levelMonitor.start();
}

/**
 * Stop the audio level monitor
 */
function stopLevelMonitor() {
  if (levelMonitor) {
    levelMonitor.stop();
    levelMonitor = null;
  }
  if (tray) {
    tray.setTitle('');
  }
}

/**
 * Process a single-track recording: transcribe audio and generate meeting notes
 */
async function processRecording(wavPath, duration) {
  const outputDir = store.get('outputDirectory');

  try {
    // Step 0: Trim silence from recording
    tray.setToolTip('Trimming silence...');
    console.log(`Trimming silence from: ${wavPath}`);
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('processing:progress', {
        stage: 'Trimming',
        progress: 0,
        message: 'Trimming silence from recording...'
      });
    }

    const trimResult = await trimSilence(wavPath, { registerProcess });
    if (trimResult.trimmed) {
      console.log(`Silence trimmed: saved ${(trimResult.savedBytes / 1024).toFixed(0)} KB`);
    } else if (trimResult.allSilence) {
      console.warn('Recording appears to be all silence');
    }

    // Step 1: Transcribe
    tray.setToolTip('Transcribing audio...');
    console.log(`Starting transcription for: ${wavPath}`);

    const transcriptPath = await transcribe(wavPath, outputDir, (progress) => {
      tray.setToolTip(`Transcribing: ${progress}%`);
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('processing:progress', {
          stage: 'Transcribing',
          progress,
          message: `Processing audio: ${progress}%`
        });
      }
    });

    console.log(`Transcription complete: ${transcriptPath}`);

    tray.setToolTip('Generating notes...');
    console.log(`Starting note generation from: ${transcriptPath}`);

    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('processing:progress', {
        stage: 'Summarising',
        progress: 0,
        message: 'Generating notes...'
      });
    }

    let lastNoteUpdate = 0;
    const notesPath = await generateNotes(transcriptPath, (progress) => {
      const now = Date.now();
      if (now - lastNoteUpdate < 500) return; // Throttle to 2 updates/sec
      lastNoteUpdate = now;

      tray.setToolTip(`Generating notes... (${progress}%)`);
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('processing:progress', {
          stage: 'Summarising',
          progress: Math.min(95, progress),
          message: `Generating notes... (${progress}%)`
        });
      }
    });

    const obsidianPath = exportNotesToVault(notesPath, {
      title: buildSingleTrackNoteTitle(transcriptPath),
      startTime: getFileStartTime(wavPath)
    });

    console.log(`Note generation complete: ${notesPath}`);
    console.log(`Obsidian note exported: ${obsidianPath}`);

    tray.setToolTip('Notes4Chris');

    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('processing:complete');
    }

    showNotification('Processing Complete', 'Meeting notes generated successfully!');

  } catch (err) {
    console.error('Processing failed:', err);
    tray.setToolTip('Notes4Chris');
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('processing:complete');
    }
    showNotification('Processing Error', `Failed: ${err.message.split('\n')[0]}`, true);
  }
}

/**
 * Process a dual-track session: transcribe both tracks, merge, generate speaker-aware notes
 */
async function processSession(sessionDir, duration) {
  const outputDir = store.get('outputDirectory');

  try {
    // Read manifest
    const manifestPath = path.join(sessionDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    // Step 0: Trim silence from both tracks
    tray.setToolTip('Trimming silence...');
    console.log(`Trimming silence from session tracks: ${sessionDir}`);
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('processing:progress', {
        stage: 'Trimming',
        progress: 0,
        message: 'Trimming silence from audio tracks...'
      });
    }

    const systemFile = path.join(sessionDir, manifest.tracks.system.file);
    const micFile = path.join(sessionDir, manifest.tracks.mic.file);
    const trimOpts = { registerProcess };

    const [systemTrim, micTrim] = await Promise.all([
      trimSilence(systemFile, trimOpts),
      trimSilence(micFile, trimOpts)
    ]);

    // Log trim results
    if (systemTrim.trimmed) {
      console.log(`System track: trimmed ${(systemTrim.savedBytes / 1024).toFixed(0)} KB silence`);
      manifest.tracks.system.silenceTrimmed = systemTrim;
    }
    if (micTrim.trimmed) {
      console.log(`Mic track: trimmed ${(micTrim.savedBytes / 1024).toFixed(0)} KB silence`);
      manifest.tracks.mic.silenceTrimmed = micTrim;
    }
    if (systemTrim.allSilence) console.warn('System track appears to be all silence');
    if (micTrim.allSilence) console.warn('Mic track appears to be all silence');

    // Update manifest with trim stats
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    // Step 1: Transcribe both tracks
    tray.setToolTip('Transcribing dual tracks...');
    console.log(`Starting session transcription for: ${sessionDir}`);

    const transcripts = await transcribeSession(sessionDir, outputDir, (progress) => {
      tray.setToolTip(`Transcribing: ${progress}%`);
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('processing:progress', {
          stage: 'Transcribing',
          progress,
          message: `Processing dual tracks: ${progress}%`
        });
      }
    }, { useSharedTranscript: store.get('useSharedTranscript') });

    console.log(`Transcription complete. Merged: ${transcripts.mergedTranscript}`);

    // Step 2: Generate speaker-aware notes
    tray.setToolTip('Generating speaker-aware notes...');
    console.log(`Starting note generation from merged transcript`);

    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('processing:progress', {
        stage: 'Summarising',
        progress: 0,
        message: 'Generating speaker-aware notes...'
      });
    }

    // Re-read manifest (updated by transcribeSession)
    const updatedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    let lastSummaryUpdate = 0;
    const notesPath = await generateSessionNotes(transcripts.mergedTranscript, updatedManifest, (progress) => {
      const now = Date.now();
      if (now - lastSummaryUpdate < 500) return; // Throttle to 2 updates/sec
      lastSummaryUpdate = now;

      tray.setToolTip(`Generating notes... (${progress}%)`);
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('processing:progress', {
          stage: 'Summarising',
          progress: Math.min(95, progress),
          message: `Generating notes... (${progress}%)`
        });
      }
    });

    if (!updatedManifest.processing) {
      updatedManifest.processing = {};
    }

    const obsidianPath = exportNotesToVault(notesPath, {
      title: buildSessionNoteTitle(updatedManifest),
      startTime: updatedManifest.startTime,
      existingPath: updatedManifest.processing.obsidianExport
    });

    // Update manifest with summarisation path
    updatedManifest.processing.summarisation = notesPath;
    updatedManifest.processing.obsidianExport = obsidianPath;
    fs.writeFileSync(manifestPath, JSON.stringify(updatedManifest, null, 2), 'utf-8');

    console.log(`Note generation complete: ${notesPath}`);
    console.log(`Obsidian note exported: ${obsidianPath}`);

    tray.setToolTip('Notes4Chris');

    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('processing:complete');
    }

    showNotification('Processing Complete', 'Speaker-aware meeting notes generated!');

  } catch (err) {
    console.error('Session processing failed:', err);
    tray.setToolTip('Notes4Chris');
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('processing:complete');
    }
    showNotification('Processing Error', `Failed: ${err.message.split('\n')[0]}`, true);

    // Log error to manifest so failed sessions are identifiable
    try {
      const manifestPath = path.join(sessionDir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (!manifest.processing) manifest.processing = {};
        manifest.processing.error = err.message;
        manifest.processing.failedAt = new Date().toISOString();
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
        console.log('Processing error logged to manifest');
      }
    } catch (manifestErr) {
      console.error('Failed to write error to manifest:', manifestErr);
    }
  }
}

/**
 * Show storage statistics
 */
function showStorageStats() {
  const stats = getStorageStats(store.get('outputDirectory'));

  console.log('Storage Statistics:');
  console.log(`Total Size: ${stats.totalSizeFormatted}`);
  console.log(`Audio: ${stats.audioSizeFormatted}`);
  console.log(`AI Output: ${stats.generatedSizeFormatted}`);
  console.log(`Recordings: ${stats.recordingCount}`);
  console.log(`Transcripts: ${stats.transcriptCount}`);
  console.log(`Notes: ${stats.notesCount}`);

  showNotification(
    'Storage Stats',
    `Total: ${stats.totalSizeFormatted}\nAudio: ${stats.audioSizeFormatted}\nAI Output: ${stats.generatedSizeFormatted}`
  );
}

/**
 * Run cleanup of old recordings
 */
function runCleanup() {
  const deleted = cleanupOldRecordings(
    store.get('outputDirectory'),
    store.get('retentionDays')
  );

  console.log(`Cleanup complete. Deleted ${deleted.length} old recordings.`);

  if (deleted.length > 0) {
    console.log('Deleted files:', deleted);
  }
}

/**
 * Show dependency status
 */
function showDependencyStatus() {
  const status = checkDependencies();

  const statusEmoji = (installed) => installed ? 'OK' : 'MISSING';
  const canRunSetup = !status.sox || !status.whisper;
  const allReady = status.sox && status.whisper && status.codex && status.mic;
  const statusText = `Dependencies Status:\n\n` +
    `${statusEmoji(status.sox)} sox (audio recording)\n` +
    `${statusEmoji(status.whisper)} whisper.cpp (transcription)\n` +
    `${statusEmoji(status.codex)} AI Summarisation (Codex/Claude)\n` +
    `${statusEmoji(status.mic)} Microphone (dual-track)\n\n` +
    (allReady
      ? 'All dependencies installed!'
      : (canRunSetup
          ? 'Some recording dependencies are missing.\nRun "setup.sh" to install them.\n\nAI summarisation installs separately:\n  npm install -g @anthropic-ai/codex\n  npm install -g @anthropic-ai/claude-code'
          : 'AI summarisation requires Codex CLI or Claude CLI.\nInstall one with:\n  npm install -g @anthropic-ai/codex\n  npm install -g @anthropic-ai/claude-code'));

  dialog.showMessageBox({
    type: allReady ? 'info' : 'warning',
    title: 'Dependency Status',
    message: 'Notes4Chris Dependencies',
    detail: statusText,
    buttons: canRunSetup ? ['Run Setup', 'OK'] : ['OK']
  }).then((result) => {
    if (result.response === 0 && canRunSetup) {
      runSetupScript();
    }
  });

  updateTrayMenu();
}

/**
 * Run setup script in terminal
 */
function runSetupScript() {
  try {
    const appleScript = `
      tell application "Terminal"
        activate
        do script "cd \\"${__dirname}\\" && chmod +x setup.sh && ./setup.sh"
      end tell
    `;

    require('child_process').exec(`osascript -e '${appleScript}'`, (err) => {
      if (err) {
        console.error('Failed to open Terminal:', err);
        dialog.showErrorBox(
          'Cannot Run Setup',
          `Failed to open Terminal.\n\nPlease run manually:\ncd ${__dirname}\n./setup.sh`
        );
      } else {
        showNotification(
          'Setup Started',
          'The setup script is running in Terminal. Follow the instructions there.'
        );
      }
    });
  } catch (err) {
    console.error('Failed to run setup script:', err);
    dialog.showErrorBox(
      'Cannot Run Setup',
      `Failed to run setup script.\n\nPlease run manually:\ncd ${__dirname}\n./setup.sh`
    );
  }
}

/**
 * Format duration in milliseconds to HH:MM:SS or MM:SS
 */
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * ============================================
 * IPC Handlers
 * ============================================
 */

// Pre-record popup
ipcMain.handle('prerecord:getContext', async () => {
  return store.get('meetingContext') || { title: '', participants: '', agenda: '' };
});

ipcMain.handle('prerecord:start', async (event, context) => {
  // Close the popup
  if (preRecordWindow && !preRecordWindow.isDestroyed()) {
    preRecordWindow.close();
  }
  // Start recording with the provided context
  startRecordingWithContext(context || {});
  return { success: true };
});

ipcMain.handle('prerecord:cancel', async () => {
  if (preRecordWindow && !preRecordWindow.isDestroyed()) {
    preRecordWindow.close();
  }
  return { success: true };
});

// Recording Controls
ipcMain.handle('recording:start', async () => {
  try {
    const mode = store.get('recordingMode');
    const useDual = mode === 'dual' && dualRecorder;

    if (useDual) {
      const result = dualRecorder.start((warning) => { console.warn(warning); });
      tray.setToolTip('Notes4Chris • Recording');
      updateTrayMenu();
      startLevelMonitor(true);
      return { success: true, sessionDir: result.sessionDir };
    } else {
      const result = recorder.start((warning) => { console.warn(warning); });
      currentRecordingPath = result.filepath;
      tray.setToolTip('Notes4Chris • Recording');
      updateTrayMenu();
      startLevelMonitor(false);
      return { success: true, filepath: result.filepath };
    }
  } catch (err) {
    console.error('IPC recording:start failed:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('recording:stop', async () => {
  try {
    stopLevelMonitor();
    const mode = store.get('recordingMode');
    const useDual = mode === 'dual' && dualRecorder && dualRecorder.isRecording;

    if (useDual) {
      const result = await dualRecorder.stop();
      tray.setToolTip('Notes4Chris');
      updateTrayMenu();

      const autoProcess = store.get('autoProcess');
      if (autoProcess) {
        processSession(result.sessionDir, result.duration).catch(err => {
          console.error('Auto-processing failed:', err);
          showNotification('Processing Error', `Failed: ${err.message.split('\n')[0]}`, true);
          if (settingsWindow && !settingsWindow.isDestroyed()) {
            settingsWindow.webContents.send('processing:complete', { error: err.message });
          }
        });
      }

      return {
        success: true,
        sessionDir: result.sessionDir,
        duration: result.duration,
        systemSize: result.systemSize,
        micSize: result.micSize
      };
    } else {
      const result = await recorder.stop();
      tray.setToolTip('Notes4Chris');
      updateTrayMenu();

      const autoProcess = store.get('autoProcess');
      if (autoProcess) {
        processRecording(result.filepath, result.duration).catch(err => {
          console.error('Auto-processing failed:', err);
        });
      }

      return {
        success: true,
        filepath: result.filepath,
        duration: result.duration,
        size: result.size
      };
    }
  } catch (err) {
    console.error('IPC recording:stop failed:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('recording:status', async () => {
  const mode = store.get('recordingMode');
  const useDual = mode === 'dual' && dualRecorder;

  if (useDual && dualRecorder.isRecording) {
    const status = dualRecorder.getStatus();
    return {
      isRecording: true,
      mode: 'dual',
      duration: status.duration,
      startTime: dualRecorder.startTime,
      tracks: status.tracks
    };
  }

  if (recorder && recorder.isRecording) {
    const status = recorder.getStatus();
    return {
      isRecording: true,
      mode: 'system',
      duration: status.duration,
      startTime: recorder.startTime
    };
  }

  return { isRecording: false };
});

// Session Reprocessing
ipcMain.handle('session:reprocess', async (event, sessionDir) => {
  try {
    if (!fs.existsSync(sessionDir)) {
      return { success: false, error: 'Session directory not found' };
    }

    const manifestPath = path.join(sessionDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return { success: false, error: 'Session manifest not found' };
    }

    // Clear previous error from manifest before retrying
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (manifest.processing) {
      delete manifest.processing.error;
      delete manifest.processing.failedAt;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    }

    // Run processing (fire-and-forget with error handling)
    processSession(sessionDir, null).catch(err => {
      console.error('Reprocessing failed:', err);
    });

    return { success: true };
  } catch (err) {
    console.error('IPC session:reprocess failed:', err);
    return { success: false, error: err.message };
  }
});

// Audio Configuration
ipcMain.handle('audio:listInputDevices', async () => {
  return listInputDevices();
});

ipcMain.handle('audio:preflight', async () => {
  const checks = [];
  const mode = store.get('recordingMode');

  // Check sox
  let soxOk = false;
  try {
    execSync('which sox', { encoding: 'utf-8' });
    checks.push({ name: 'sox', pass: true, message: 'sox is installed and available' });
    soxOk = true;
  } catch (err) {
    checks.push({ name: 'sox', pass: false, message: 'sox not found. Install with: brew install sox' });
  }

  // Check system audio capture (SCK preferred, BlackHole fallback)
  const sckPath = getSckBinaryPath();
  const sckCheck = checkSckAvailable(sckPath);
  let bhAvailable = false;
  try {
    findBlackHoleDevice();
    bhAvailable = true;
  } catch (err) { /* not available */ }

  if (sckCheck.available && sckCheck.permitted) {
    checks.push({ name: 'System Audio', pass: true, message: 'ScreenCaptureKit — system audio capture ready' });
  } else if (bhAvailable) {
    const sckNote = sckCheck.available ? ' (SCK permission not granted)' : '';
    checks.push({ name: 'System Audio', pass: true, message: `BlackHole audio device detected${sckNote}` });
  } else if (sckCheck.available && sckCheck.permitted === false) {
    checks.push({ name: 'System Audio', pass: false, message: 'Screen Recording permission required. Open System Settings > Privacy & Security > Screen Recording.' });
  } else {
    checks.push({ name: 'System Audio', pass: false, message: 'No system audio capture available. Grant Screen Recording permission or install BlackHole 2ch.' });
  }

  // Check mic (if dual mode)
  if (mode === 'dual') {
    const micDevice = resolveMicDevice();
    if (micDevice) {
      checks.push({ name: 'Microphone', pass: true, message: `Mic device: ${micDevice}` });
    } else {
      checks.push({ name: 'Microphone', pass: false, message: 'No microphone detected. Check System Preferences > Sound.' });
    }
  }

  // Check whisper
  const whisperCheck = verifyWhisper();
  checks.push({
    name: 'whisper.cpp',
    pass: whisperCheck.installed,
    message: whisperCheck.installed ? 'whisper.cpp binary and model found' : (whisperCheck.error || 'Not installed')
  });

  // Check AI summarisation (Codex or Claude CLI)
  const preflightCodex = isCodexAvailable();
  const preflightClaude = isClaudeAvailable();
  const aiOk = preflightCodex || preflightClaude;
  const aiProvider = preflightCodex ? 'Codex CLI' : 'Claude CLI';
  checks.push({
    name: 'AI Summarisation',
    pass: aiOk,
    message: aiOk
      ? `${aiProvider} available for note generation`
      : 'No AI provider found. Install Codex CLI or Claude CLI'
  });

  return checks;
});

// File Management
ipcMain.handle('files:list', async () => {
  try {
    const recordingsDir = path.join(store.get('outputDirectory'), 'recordings');
    const processedDir = path.join(store.get('outputDirectory'), 'processed');

    if (!fs.existsSync(recordingsDir)) {
      return [];
    }

    const entries = fs.readdirSync(recordingsDir);
    const files = [];

    for (const entry of entries) {
      const fullPath = path.join(recordingsDir, entry);
      const stats = fs.statSync(fullPath);

      if (stats.isDirectory() && entry.endsWith('_session')) {
        // Session directory (dual-track)
        const manifestPath = path.join(fullPath, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          const sessionProcessedDir = path.join(processedDir, `${manifest.sessionId}_session`);

          // Calculate total size
          let totalSize = 0;
          if (fs.existsSync(path.join(fullPath, 'system.wav'))) {
            totalSize += fs.statSync(path.join(fullPath, 'system.wav')).size;
          }
          if (fs.existsSync(path.join(fullPath, 'mic.wav'))) {
            totalSize += fs.statSync(path.join(fullPath, 'mic.wav')).size;
          }

          files.push({
            filename: entry,
            filepath: fullPath,
            size: totalSize,
            created: stats.birthtime,
            modified: stats.mtime,
            isDualTrack: true,
            transcribed: fs.existsSync(path.join(sessionProcessedDir, 'merged_transcript.txt')),
            summarised: fs.existsSync(path.join(sessionProcessedDir, 'notes.md')),
            processingError: (manifest.processing && manifest.processing.error) || null,
            manifest: manifest
          });
        }
      } else if (entry.endsWith('.wav')) {
        // Single-track WAV file
        const basename = path.basename(entry, '.wav');
        const transcriptPath = path.join(processedDir, `${basename}_transcript.txt`);
        const notesPath = path.join(processedDir, `${basename}_notes.md`);

        files.push({
          filename: entry,
          filepath: fullPath,
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime,
          isDualTrack: false,
          transcribed: fs.existsSync(transcriptPath),
          summarised: fs.existsSync(notesPath)
        });
      }
    }

    // Sort newest first
    files.sort((a, b) => b.created - a.created);
    return files;

  } catch (err) {
    console.error('IPC files:list failed:', err);
    return [];
  }
});

ipcMain.handle('files:stats', async () => {
  try {
    const stats = getStorageStats(store.get('outputDirectory'));
    return {
      totalSize: stats.totalSize,
      totalSizeFormatted: stats.totalSizeFormatted,
      audioSize: stats.audioSize,
      audioSizeFormatted: stats.audioSizeFormatted,
      generatedSize: stats.generatedSize,
      generatedSizeFormatted: stats.generatedSizeFormatted,
      recordingsCount: stats.recordingCount,
      transcriptsCount: stats.transcriptCount,
      notesCount: stats.notesCount
    };
  } catch (err) {
    console.error('IPC files:stats failed:', err);
    return {
      totalSize: 0,
      totalSizeFormatted: '0 B',
      audioSize: 0,
      audioSizeFormatted: '0 B',
      generatedSize: 0,
      generatedSizeFormatted: '0 B',
      recordingsCount: 0,
      transcriptsCount: 0,
      notesCount: 0
    };
  }
});

ipcMain.handle('files:delete', async (event, filename) => {
  try {
    const recordingsDir = path.join(store.get('outputDirectory'), 'recordings');
    const processedDir = path.join(store.get('outputDirectory'), 'processed');
    const deletedFiles = [];

    if (filename.endsWith('_session')) {
      // Delete session directory
      const sessionPath = path.join(recordingsDir, filename);
      if (fs.existsSync(sessionPath)) {
        // Read manifest for session ID
        const manifestPath = path.join(sessionPath, 'manifest.json');
        let sessionId = filename.replace('_session', '');
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          sessionId = manifest.sessionId;
        }

        fs.rmSync(sessionPath, { recursive: true, force: true });
        deletedFiles.push(filename);

        // Delete processed session dir
        const sessionProcessedDir = path.join(processedDir, `${sessionId}_session`);
        if (fs.existsSync(sessionProcessedDir)) {
          fs.rmSync(sessionProcessedDir, { recursive: true, force: true });
          deletedFiles.push(`${sessionId}_session (processed)`);
        }
      }
    } else {
      // Delete single WAV file
      const basename = path.basename(filename, '.wav');

      const wavPath = path.join(recordingsDir, filename);
      if (fs.existsSync(wavPath)) {
        fs.unlinkSync(wavPath);
        deletedFiles.push(filename);
      }

      const transcriptPath = path.join(processedDir, `${basename}_transcript.txt`);
      if (fs.existsSync(transcriptPath)) {
        fs.unlinkSync(transcriptPath);
        deletedFiles.push(`${basename}_transcript.txt`);
      }

      const notesPath = path.join(processedDir, `${basename}_notes.md`);
      if (fs.existsSync(notesPath)) {
        fs.unlinkSync(notesPath);
        deletedFiles.push(`${basename}_notes.md`);
      }
    }

    return { success: true, deletedFiles };
  } catch (err) {
    console.error('IPC files:delete failed:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('files:cleanup', async () => {
  try {
    const deleted = cleanupOldRecordings(
      store.get('outputDirectory'),
      store.get('retentionDays')
    );

    return {
      success: true,
      deletedCount: deleted.length,
      deletedFiles: deleted,
      freedSpace: 0
    };
  } catch (err) {
    console.error('IPC files:cleanup failed:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('files:open', async (event, filepath) => {
  try {
    await shell.openPath(filepath);
    return { success: true };
  } catch (err) {
    console.error('IPC files:open failed:', err);
    return { success: false, error: err.message };
  }
});

// Processing
ipcMain.handle('process:transcribe', async (event, wavPath) => {
  try {
    const outputDir = store.get('outputDirectory');
    const transcriptPath = await transcribe(wavPath, outputDir, (progress) => {
      if (BrowserWindow.getAllWindows().length > 0) {
        BrowserWindow.getAllWindows()[0].webContents.send('processing:progress', {
          stage: 'Transcribing',
          progress,
          message: `Processing audio: ${progress}%`
        });
      }
    });

    return { success: true, transcriptPath };
  } catch (err) {
    console.error('IPC process:transcribe failed:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('process:summarise', async (event, transcriptPath) => {
  try {
    const notesPath = await generateNotes(transcriptPath, (progress) => {
      if (BrowserWindow.getAllWindows().length > 0) {
        BrowserWindow.getAllWindows()[0].webContents.send('processing:progress', {
          stage: 'Summarising',
          progress: Math.min(95, progress),
          message: `Generating notes... (${progress}%)`
        });
      }
    });

    const obsidianPath = exportNotesToVault(notesPath, {
      title: buildSingleTrackNoteTitle(transcriptPath),
      startTime: getFileStartTime(transcriptPath)
    });

    return { success: true, notesPath, obsidianPath };
  } catch (err) {
    console.error('IPC process:summarise failed:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('process:full', async (event, wavPathOrSessionDir) => {
  try {
    const outputDir = store.get('outputDirectory');

    // Detect if this is a session directory or a flat WAV file
    if (fs.existsSync(path.join(wavPathOrSessionDir, 'manifest.json'))) {
      // Session directory - use dual-track pipeline
      const manifestPath = path.join(wavPathOrSessionDir, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

      const transcripts = await transcribeSession(wavPathOrSessionDir, outputDir, (progress) => {
        if (BrowserWindow.getAllWindows().length > 0) {
          BrowserWindow.getAllWindows()[0].webContents.send('processing:progress', {
            stage: 'Transcribing',
            progress,
            message: `Processing dual tracks: ${progress}%`
          });
        }
      });

      const updatedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

      if (BrowserWindow.getAllWindows().length > 0) {
        BrowserWindow.getAllWindows()[0].webContents.send('processing:progress', {
          stage: 'Summarising',
          progress: 0,
          message: 'Generating speaker-aware notes...'
        });
      }

      const notesPath = await generateSessionNotes(transcripts.mergedTranscript, updatedManifest, (progress) => {
        if (BrowserWindow.getAllWindows().length > 0) {
          BrowserWindow.getAllWindows()[0].webContents.send('processing:progress', {
            stage: 'Summarising',
            progress: Math.min(95, progress),
            message: `Generating notes... (${progress}%)`
          });
        }
      });

      if (!updatedManifest.processing) {
        updatedManifest.processing = {};
      }

      const obsidianPath = exportNotesToVault(notesPath, {
        title: buildSessionNoteTitle(updatedManifest),
        startTime: updatedManifest.startTime,
        existingPath: updatedManifest.processing.obsidianExport
      });

      updatedManifest.processing.summarisation = notesPath;
      updatedManifest.processing.obsidianExport = obsidianPath;
      fs.writeFileSync(manifestPath, JSON.stringify(updatedManifest, null, 2), 'utf-8');

      if (BrowserWindow.getAllWindows().length > 0) {
        BrowserWindow.getAllWindows()[0].webContents.send('processing:complete');
      }

      return { success: true, mergedTranscript: transcripts.mergedTranscript, notesPath, obsidianPath };
    } else {
      // Single WAV file - use original pipeline
      const transcriptPath = await transcribe(wavPathOrSessionDir, outputDir, (progress) => {
        if (BrowserWindow.getAllWindows().length > 0) {
          BrowserWindow.getAllWindows()[0].webContents.send('processing:progress', {
            stage: 'Transcribing',
            progress,
            message: `Processing audio: ${progress}%`
          });
        }
      });

      if (BrowserWindow.getAllWindows().length > 0) {
        BrowserWindow.getAllWindows()[0].webContents.send('processing:progress', {
          stage: 'Summarising',
          progress: 0,
          message: 'Generating notes...'
        });
      }

      const notesPath = await generateNotes(transcriptPath, (progress) => {
        if (BrowserWindow.getAllWindows().length > 0) {
          BrowserWindow.getAllWindows()[0].webContents.send('processing:progress', {
            stage: 'Summarising',
            progress: Math.min(95, progress),
            message: `Generating notes... (${progress}%)`
          });
        }
      });

      const obsidianPath = exportNotesToVault(notesPath, {
        title: buildSingleTrackNoteTitle(transcriptPath),
        startTime: getFileStartTime(wavPathOrSessionDir)
      });

      if (BrowserWindow.getAllWindows().length > 0) {
        BrowserWindow.getAllWindows()[0].webContents.send('processing:complete');
      }

      return { success: true, transcriptPath, notesPath, obsidianPath };
    }
  } catch (err) {
    console.error('IPC process:full failed:', err);
    return { success: false, error: err.message };
  }
});

// Settings
ipcMain.handle('settings:get', async () => {
  return {
    outputDirectory: store.get('outputDirectory'),
    retentionDays: store.get('retentionDays'),
    autoProcess: store.get('autoProcess'),
    recordingMode: store.get('recordingMode'),
    micDevice: store.get('micDevice'),
    systemLabel: store.get('systemLabel'),
    micLabel: store.get('micLabel'),
    meetingContext: store.get('meetingContext')
  };
});

ipcMain.handle('settings:update', async (event, settings) => {
  try {
    if (settings.outputDirectory !== undefined) {
      store.set('outputDirectory', settings.outputDirectory);
    }
    if (settings.retentionDays !== undefined) {
      store.set('retentionDays', settings.retentionDays);
    }
    if (settings.autoProcess !== undefined) {
      store.set('autoProcess', settings.autoProcess);
    }
    if (settings.recordingMode !== undefined) {
      store.set('recordingMode', settings.recordingMode);
    }
    if (settings.micDevice !== undefined) {
      store.set('micDevice', settings.micDevice);
    }
    if (settings.systemLabel !== undefined) {
      store.set('systemLabel', settings.systemLabel);
    }
    if (settings.micLabel !== undefined) {
      store.set('micLabel', settings.micLabel);
    }
    if (settings.meetingContext !== undefined) {
      store.set('meetingContext', settings.meetingContext);
    }

    // Reinitialize recorder with new settings
    initRecorder();

    return { success: true };
  } catch (err) {
    console.error('IPC settings:update failed:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('settings:reset', async () => {
  try {
    store.clear();
    initRecorder();
    return { success: true };
  } catch (err) {
    console.error('IPC settings:reset failed:', err);
    return { success: false, error: err.message };
  }
});

// System Information
ipcMain.handle('system:dependencies', async () => {
  const status = checkDependencies();
  return {
    sox: status.sox,
    whisper: status.whisper,
    codex: status.codex,
    systemAudio: status.systemAudio,
    mic: status.mic
  };
});

ipcMain.handle('system:version', async () => {
  return app.getVersion();
});

ipcMain.handle('system:chooseOutputDir', async () => {
  try {
    const result = await dialog.showOpenDialog(settingsWindow || undefined, {
      title: 'Choose Output Folder',
      defaultPath: store.get('outputDirectory'),
      buttonLabel: 'Choose Folder',
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    return { canceled: false, path: result.filePaths[0] };
  } catch (err) {
    console.error('IPC system:chooseOutputDir failed:', err);
    return { canceled: true, error: err.message };
  }
});

ipcMain.handle('dialog:confirm', async (event, options = {}) => {
  try {
    const response = await dialog.showMessageBox(settingsWindow || undefined, {
      type: options.destructive ? 'warning' : 'question',
      buttons: [options.confirmLabel || 'Continue', options.cancelLabel || 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: options.title || 'Confirm',
      message: options.message || 'Are you sure?',
      detail: options.detail || ''
    });

    return { confirmed: response.response === 0 };
  } catch (err) {
    console.error('IPC dialog:confirm failed:', err);
    return { confirmed: false, error: err.message };
  }
});

ipcMain.handle('system:requestScreenCapturePermission', async () => {
  const sckPath = getSckBinaryPath();
  const sckCheck = checkSckAvailable(sckPath);

  if (sckCheck.available && sckCheck.permitted) {
    return { success: true, message: 'Permission already granted' };
  }

  if (!sckCheck.available) {
    return { success: false, message: sckCheck.reason || 'ScreenCaptureKit not available' };
  }

  // Show dialog prompting the user to grant permission
  const response = await dialog.showMessageBox({
    type: 'info',
    title: 'Screen Recording Permission Required',
    message: 'Notes4Chris needs Screen Recording permission to capture system audio.',
    detail: 'This replaces the need for BlackHole virtual audio device.\n\n' +
            'Click "Open System Settings" to grant permission, then restart the app.',
    buttons: ['Open System Settings', 'Cancel'],
    defaultId: 0
  });

  if (response.response === 0) {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }

  return { success: false, message: 'Permission not yet granted' };
});

ipcMain.handle('system:openOutputDir', async () => {
  try {
    await shell.openPath(store.get('outputDirectory'));
    return { success: true };
  } catch (err) {
    console.error('IPC system:openOutputDir failed:', err);
    return { success: false, error: err.message };
  }
});

/**
 * App lifecycle: Ready
 */
app.whenReady().then(() => {
  console.log('Notes4Chris starting...');
  console.log(`Electron version: ${process.versions.electron}`);
  console.log(`Node version: ${process.versions.node}`);
  console.log(`Recording mode: ${store.get('recordingMode')}`);

  // Hide dock icon — menu bar only app
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  // Initialize recorder and tray
  initRecorder();
  createTray();

  // Check dependencies on startup, then refresh tray menu with results
  const deps = checkDependencies();
  updateTrayMenu();

  // Run cleanup on startup
  runCleanup();

  console.log('Notes4Chris ready. Click the menu bar icon to start recording.');

  // Show welcome message if dependencies are missing
  if (!deps.sox || !deps.whisper) {
    setTimeout(() => {
      const response = dialog.showMessageBoxSync({
        type: 'info',
        title: 'Welcome to Notes4Chris',
        message: 'Setup Required',
        detail: 'Some dependencies are missing. Would you like to run the setup script now?\n\n' +
               'This will install:\n- sox (audio recording)\n- whisper.cpp (transcription)\n\n' +
               'AI summarisation installs separately:\n- npm install -g @anthropic-ai/codex\n- npm install -g @anthropic-ai/claude-code',
        buttons: ['Run Setup', 'Check Status', 'Skip'],
        defaultId: 0
      });

      if (response === 0) {
        runSetupScript();
      } else if (response === 1) {
        showDependencyStatus();
      }
    }, 1000);
  }
});

/**
 * App lifecycle: Window all closed
 * Don't quit - we're a menu bar app
 */
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

/**
 * App lifecycle: Before quit
 * Clean up all processes
 */
app.on('before-quit', () => {
  console.log('App quitting, cleaning up...');

  // Stop level monitor
  stopLevelMonitor();

  // Stop recording if active
  if (recorder && recorder.isRecording) {
    console.log('Stopping active system recording...');
    recorder.cleanup();
  }

  if (dualRecorder && dualRecorder.isRecording) {
    console.log('Stopping active dual recording...');
    dualRecorder.cleanup();
  }

  // Kill all registered child processes
  activeProcesses.forEach(proc => {
    try {
      proc.kill('SIGTERM');
    } catch (e) {
      // Process already dead
    }
  });
});

/**
 * Prevent multiple instances
 */
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('Another instance is already running. Quitting.');
  app.quit();
} else {
  app.on('second-instance', () => {
    console.log('Attempted to start second instance');
    if (tray) {
      showNotification('Notes4Chris', 'Already running in menu bar');
    }
  });
}
