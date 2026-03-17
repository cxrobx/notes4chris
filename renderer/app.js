/**
 * Notes4Chris - Renderer Process
 *
 * UI logic for settings window
 * Communicates with main process via IPC bridge (preload.js)
 */

// API is exposed via preload.js
const api = window.meetingRecorder;

// State
let currentSettings = {};
let recordings = [];
let currentProcessingPath = null; // Path of the recording/session currently being processed

/**
 * ============================================
 * Initialization
 * ============================================
 */

document.addEventListener('DOMContentLoaded', async () => {
  console.log('Settings UI loaded');

  // Load initial data
  await loadSettings();
  await loadDependencies();
  await loadMicDevices();
  await loadRecordings();
  await loadStorageStats();
  await loadVersion();

  // Setup event listeners
  setupEventListeners();

  // Setup IPC event listeners
  setupIPCListeners();

  // Setup keyboard shortcuts
  setupKeyboardShortcuts();

  // Check if a recording is already in progress
  await checkRecordingStatus();

  // Check if processing is already in progress (catch up with background work)
  await checkProcessingStatus();
});

/**
 * ============================================
 * Data Loading
 * ============================================
 */

async function loadSettings() {
  try {
    currentSettings = await api.getSettings();
    console.log('Settings loaded:', currentSettings);

    // Update UI
    document.getElementById('output-directory').value = currentSettings.outputDirectory;
    document.getElementById('retention-days').value = currentSettings.retentionDays;
    document.getElementById('auto-process').checked = currentSettings.autoProcess;

    updateRetentionLabel(currentSettings.retentionDays);

    // Update recording mode toggle
    const mode = currentSettings.recordingMode || 'dual';
    setModeToggle(mode);

    // Update speaker labels
    if (currentSettings.systemLabel) {
      document.getElementById('system-label').value = currentSettings.systemLabel;
    }
    if (currentSettings.micLabel) {
      document.getElementById('mic-label').value = currentSettings.micLabel;
    }

    // Select mic device if saved
    if (currentSettings.micDevice) {
      const micSelect = document.getElementById('mic-device');
      // Will be set after devices load
      micSelect.dataset.savedDevice = currentSettings.micDevice;
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
    showError('Failed to load settings');
  }
}

async function loadDependencies() {
  try {
    const deps = await api.checkDependencies();
    console.log('Dependencies:', deps);

    updateStatusIcon('status-sox', deps.sox);
    updateStatusIcon('status-whisper', deps.whisper);
    updateStatusIcon('status-codex', deps.codex);
    updateStatusIcon('status-system-audio', deps.systemAudio);
    updateStatusIcon('status-mic', deps.mic);
  } catch (err) {
    console.error('Failed to check dependencies:', err);
  }
}

async function loadMicDevices() {
  const select = document.getElementById('mic-device');
  try {
    const devices = await api.listInputDevices();
    console.log('Input devices:', devices);

    select.innerHTML = '';

    if (devices.length === 0) {
      select.innerHTML = '<option value="">No input devices found</option>';
      return;
    }

    // Filter out virtual/clutter devices
    const hiddenDevices = [
      'muse audio share', 'muse daw bridge', 'muse recording',
      'pro tools aggregate', 'pro tools audio bridge',
      'microsoft teams audio', 'zoomaudiodevice',
      'loopback audio'
    ];
    const visibleDevices = devices.filter(d =>
      !hiddenDevices.some(h => d.name.toLowerCase().includes(h))
    );

    // Add auto-detect option
    const autoOption = document.createElement('option');
    autoOption.value = '';
    autoOption.textContent = 'Auto-detect (default microphone)';
    select.appendChild(autoOption);

    // Add each visible device
    visibleDevices.forEach(device => {
      const option = document.createElement('option');
      option.value = device.name;
      option.textContent = `${device.name} (${device.channels}ch${device.isDefault ? ', default' : ''})`;
      select.appendChild(option);
    });

    // Restore saved selection
    const savedDevice = select.dataset.savedDevice || currentSettings.micDevice;
    if (savedDevice) {
      select.value = savedDevice;
    }
  } catch (err) {
    console.error('Failed to load mic devices:', err);
    select.innerHTML = '<option value="">Failed to load devices</option>';
  }
}

async function loadRecordings() {
  const list = document.getElementById('recordings-list');

  try {
    list.innerHTML = '<div class="loading">Loading recordings...</div>';

    recordings = await api.listRecordings();
    console.log(`Loaded ${recordings.length} recordings`);

    if (recordings.length === 0) {
      list.innerHTML = '<div class="empty-state">No recordings yet.<br>Start recording from the menu bar!</div>';
      return;
    }

    // Render recordings
    list.innerHTML = recordings.map(rec => renderRecordingItem(rec)).join('');

    // Add event listeners
    recordings.forEach((rec, index) => {
      const deleteBtn = document.getElementById(`delete-${index}`);
      const openBtn = document.getElementById(`open-${index}`);
      const processBtn = document.getElementById(`process-${index}`);
      const reprocessBtn = document.getElementById(`reprocess-${index}`);

      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => handleDeleteRecording(rec.filename));
      }

      if (openBtn) {
        openBtn.addEventListener('click', () => handleOpenFile(rec.filepath));
      }

      if (processBtn && !rec.transcribed) {
        processBtn.addEventListener('click', () => handleProcessRecording(rec.filepath));
      }

      if (reprocessBtn) {
        reprocessBtn.addEventListener('click', () => handleReprocessSession(rec.filepath));
      }
    });
  } catch (err) {
    console.error('Failed to load recordings:', err);
    list.innerHTML = `
      <div class="empty-state">
        Failed to load recordings<br>
        <button class="btn btn-secondary" onclick="loadRecordings()">Retry</button>
      </div>
    `;
    showError('Failed to load recordings');
  }
}

async function loadStorageStats() {
  try {
    const stats = await api.getStorageStats();
    console.log('Storage stats:', stats);

    document.getElementById('stat-total-size').textContent = stats.totalSizeFormatted;
    document.getElementById('stat-audio-size').textContent = stats.audioSizeFormatted;
    document.getElementById('stat-generated-size').textContent = stats.generatedSizeFormatted;
    document.getElementById('stat-recordings').textContent = stats.recordingsCount;
    document.getElementById('stat-transcripts').textContent = stats.transcriptsCount;
    document.getElementById('stat-notes').textContent = stats.notesCount;
  } catch (err) {
    console.error('Failed to load storage stats:', err);
  }
}

async function loadVersion() {
  try {
    const version = await api.getVersion();
    document.getElementById('version').textContent = `v${version}`;
  } catch (err) {
    console.error('Failed to load version:', err);
  }
}

/**
 * ============================================
 * UI Rendering
 * ============================================
 */

function renderRecordingItem(rec) {
  const date = new Date(rec.created);
  const dateStr = date.toLocaleDateString();
  const timeStr = date.toLocaleTimeString();
  const sizeStr = formatFileSize(rec.size);
  const index = recordings.indexOf(rec);

  const dualBadge = rec.isDualTrack ? '<span class="badge badge-dual">Dual Track</span>' : '';
  const errorBadge = rec.processingError ? `<span class="badge badge-error" title="${rec.processingError}">Failed</span>` : '';
  const showReprocess = rec.isDualTrack && (!rec.summarised || rec.processingError);

  // Check if this recording is currently being processed
  const isProcessing = currentProcessingPath && (
    rec.filepath === currentProcessingPath ||
    (rec.filepath && currentProcessingPath.includes(rec.filename))
  );

  let statusBadge;
  if (isProcessing) {
    statusBadge = '<span class="badge badge-processing"><span class="badge-spinner"></span>Processing\u2026</span>';
  } else if (rec.transcribed) {
    statusBadge = '<span class="badge badge-success">Transcribed</span>';
  } else {
    statusBadge = '<span class="badge badge-warning">Not transcribed</span>';
  }

  return `
    <div class="recording-item${isProcessing ? ' is-processing' : ''}" data-filepath="${rec.filepath || ''}">
      <div class="recording-info">
        <div class="recording-name">${rec.filename}</div>
        <div class="recording-meta">
          <span>${dateStr} ${timeStr}</span>
          <span>${sizeStr}</span>
        </div>
      </div>
      <div class="recording-badges">
        ${dualBadge}
        ${statusBadge}
        ${rec.summarised ? '<span class="badge badge-success">Summarised</span>' : ''}
        ${errorBadge}
      </div>
      <div class="recording-actions">
        <button class="icon-btn" id="open-${index}" title="Open file">&#x1F4C2;</button>
        ${!rec.transcribed ? `<button class="icon-btn" id="process-${index}" title="Process recording">&#x2699;&#xFE0F;</button>` : ''}
        ${showReprocess ? `<button class="icon-btn" id="reprocess-${index}" title="Reprocess session">&#x1F504;</button>` : ''}
        <button class="icon-btn danger" id="delete-${index}" title="Delete">&#x1F5D1;&#xFE0F;</button>
      </div>
    </div>
  `;
}

function updateStatusIcon(elementId, status) {
  const element = document.getElementById(elementId);
  if (!element) return;

  element.textContent = '';
  element.classList.remove('is-loading', 'is-ready', 'is-error');

  if (status === null || status === undefined) {
    element.classList.add('is-loading');
    element.setAttribute('aria-label', 'Checking');
  } else if (status === true) {
    element.classList.add('is-ready');
    element.setAttribute('aria-label', 'Available');
  } else {
    element.classList.add('is-error');
    element.setAttribute('aria-label', 'Unavailable');
  }
}

function updateRetentionLabel(days) {
  const label = document.getElementById('retention-days-value');
  label.textContent = `${days} day${days !== 1 ? 's' : ''}`;
}

function setModeToggle(mode) {
  const systemBtn = document.getElementById('mode-system');
  const dualBtn = document.getElementById('mode-dual');
  const micSettings = document.getElementById('mic-settings');

  if (mode === 'system') {
    systemBtn.classList.add('active');
    dualBtn.classList.remove('active');
    micSettings.classList.add('hidden');
  } else {
    systemBtn.classList.remove('active');
    dualBtn.classList.add('active');
    micSettings.classList.remove('hidden');
  }
}

/**
 * ============================================
 * Event Handlers
 * ============================================
 */

function setupEventListeners() {
  // Retention days slider
  document.getElementById('retention-days').addEventListener('input', (e) => {
    updateRetentionLabel(e.target.value);
  });

  // Refresh dependencies
  document.getElementById('btn-refresh-deps').addEventListener('click', async () => {
    await loadDependencies();
  });

  // Refresh recordings list
  document.getElementById('btn-refresh-list').addEventListener('click', async () => {
    await loadRecordings();
  });

  // Cleanup old files
  document.getElementById('btn-cleanup').addEventListener('click', handleCleanup);

  // Open output directory
  document.getElementById('btn-open-output').addEventListener('click', async () => {
    await api.openOutputDirectory();
  });

  // Change output directory
  document.getElementById('btn-change-dir').addEventListener('click', async () => {
    const result = await api.chooseOutputDirectory();
    if (!result) {
      showError('Failed to open folder chooser');
      return;
    }

    if (result.error) {
      showError('Failed to choose folder: ' + result.error);
      return;
    }

    if (!result || result.canceled) {
      return;
    }

    document.getElementById('output-directory').value = result.path;
  });

  // Reset settings
  document.getElementById('btn-reset-settings').addEventListener('click', handleResetSettings);

  // Save settings
  document.getElementById('btn-save').addEventListener('click', handleSaveSettings);

  // Recording mode toggle
  document.getElementById('mode-system').addEventListener('click', () => {
    setModeToggle('system');
  });
  document.getElementById('mode-dual').addEventListener('click', () => {
    setModeToggle('dual');
  });

  // Refresh mic devices
  document.getElementById('btn-refresh-mics').addEventListener('click', async () => {
    await loadMicDevices();
    showInfo('Mic devices refreshed');
  });

  // Preflight check
  document.getElementById('btn-preflight').addEventListener('click', runPreflightCheck);
}

let recordingTimerInterval = null;
let recordingStartTime = null;

function setupIPCListeners() {
  // Listen for recording state changes
  api.onRecordingUpdate((data) => {
    const indicator = document.getElementById('recording-indicator');
    const micMeter = document.getElementById('meter-mic');

    if (data.state === 'recording') {
      indicator.classList.remove('hidden');
      micMeter.classList.toggle('hidden', data.mode !== 'dual');
      recordingStartTime = data.startTime;
      startRecordingTimer();
    } else {
      indicator.classList.add('hidden');
      stopRecordingTimer();
    }
  });

  // Listen for audio level updates
  api.onRecordingLevels((levels) => {
    updateMeter('system', levels.system || 0);
    if (levels.mic !== undefined) {
      updateMeter('mic', levels.mic || 0);
    }
  });

  // Listen for processing progress
  api.onProcessingProgress((data) => {
    currentProcessingPath = data.path || null;
    showProcessingOverlay(data.stage, data.message, data.progress);
    // Update the badge on the recording item being processed
    updateProcessingBadge();
  });

  // Listen for processing complete
  api.onProcessingComplete(() => {
    currentProcessingPath = null;
    hideProcessingOverlay();
  });

  // Listen for recordings list changes (auto-refresh after processing completes)
  api.onRecordingsChanged(() => {
    loadRecordings();
    loadStorageStats();
  });

  // Listen for errors
  api.onError((data) => {
    console.error('IPC Error:', data);
    showError(data.error);
    hideProcessingOverlay();
  });

  // Listen for notifications
  api.onNotification((data) => {
    console.log('Notification:', data);
    const type = data.type || 'info';
    showToast(data.message, type);
  });

  // Listen for companion mode status
  api.onCompanionModeStatus((data) => {
    const badge = document.getElementById('companion-badge');
    const providerName = document.getElementById('companion-provider-name');
    if (!badge) return;

    if (data.active) {
      if (providerName && data.provider) {
        providerName.textContent = data.provider.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      }
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  });
}

function updateMeter(track, level) {
  const fill = document.getElementById(`meter-fill-${track}`);
  if (!fill) return;

  const percent = Math.round(level * 100);
  fill.style.width = `${percent}%`;

  // Colour thresholds: green < 65%, yellow 65-85%, red > 85%
  fill.classList.remove('level-medium', 'level-hot');
  if (percent > 85) {
    fill.classList.add('level-hot');
  } else if (percent > 65) {
    fill.classList.add('level-medium');
  }
}

function startRecordingTimer() {
  stopRecordingTimer();
  const timerEl = document.getElementById('recording-timer');

  recordingTimerInterval = setInterval(() => {
    if (!recordingStartTime) return;
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const secs = (elapsed % 60).toString().padStart(2, '0');
    timerEl.textContent = `${mins}:${secs}`;
  }, 1000);
}

async function checkRecordingStatus() {
  try {
    const status = await api.getRecordingStatus();
    if (status && status.isRecording) {
      const indicator = document.getElementById('recording-indicator');
      const micMeter = document.getElementById('meter-mic');
      indicator.classList.remove('hidden');
      micMeter.classList.toggle('hidden', status.mode !== 'dual');
      recordingStartTime = status.startTime;
      startRecordingTimer();
    }
  } catch (err) {
    console.error('Failed to check recording status:', err);
  }
}

async function checkProcessingStatus() {
  try {
    const status = await api.getProcessingStatus();
    if (status) {
      currentProcessingPath = status.path;
      showProcessingOverlay(status.stage, status.message, status.progress);
      // Re-render recordings to show "Processing..." badge
      await loadRecordings();
    }
  } catch (err) {
    console.error('Failed to check processing status:', err);
  }
}

function stopRecordingTimer() {
  if (recordingTimerInterval) {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
  }
  recordingStartTime = null;
  const timerEl = document.getElementById('recording-timer');
  if (timerEl) timerEl.textContent = '00:00';
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Cmd/Ctrl + S: Save settings
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      handleSaveSettings();
    }

    // Cmd/Ctrl + R: Refresh recordings
    if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
      e.preventDefault();
      loadRecordings();
      showInfo('Refreshing recordings...');
    }

    // Cmd/Ctrl + D: Check dependencies
    if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
      e.preventDefault();
      loadDependencies();
      showInfo('Checking dependencies...');
    }

    // Escape: Close any overlays
    if (e.key === 'Escape') {
      const overlay = document.getElementById('processing-overlay');
      if (!overlay.classList.contains('hidden')) {
        e.preventDefault();
      }
    }
  });
}

async function handleSaveSettings() {
  try {
    const activeMode = document.getElementById('mode-dual').classList.contains('active') ? 'dual' : 'system';
    const micDevice = document.getElementById('mic-device').value || null;

    const newSettings = {
      outputDirectory: document.getElementById('output-directory').value,
      retentionDays: parseInt(document.getElementById('retention-days').value),
      autoProcess: document.getElementById('auto-process').checked,
      recordingMode: activeMode,
      micDevice: micDevice,
      systemLabel: document.getElementById('system-label').value || 'Remote',
      micLabel: document.getElementById('mic-label').value || 'Me'
    };

    const result = await api.updateSettings(newSettings);

    if (result.success) {
      currentSettings = newSettings;
      showSuccess('Settings saved successfully');
    } else {
      showError('Failed to save settings: ' + result.error);
    }
  } catch (err) {
    console.error('Failed to save settings:', err);
    showError('Failed to save settings');
  }
}

async function handleResetSettings() {
  const confirmation = await api.confirmAction({
    title: 'Reset Settings',
    message: 'Reset all settings to their defaults?',
    detail: 'This will restore the default output folder, retention period, and recording preferences.',
    confirmLabel: 'Reset',
    cancelLabel: 'Cancel',
    destructive: true
  });

  if (!confirmation.confirmed) {
    return;
  }

  try {
    const result = await api.resetSettings();

    if (result.success) {
      await loadSettings();
      await loadMicDevices();
      showSuccess('Settings reset to defaults');
    } else {
      showError('Failed to reset settings');
    }
  } catch (err) {
    console.error('Failed to reset settings:', err);
    showError('Failed to reset settings');
  }
}

async function handleDeleteRecording(filename) {
  const confirmation = await api.confirmAction({
    title: 'Delete Recording',
    message: `Delete "${filename}"?`,
    detail: 'This will also delete the associated transcripts and notes.',
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    destructive: true
  });

  if (!confirmation.confirmed) {
    return;
  }

  try {
    const result = await api.deleteRecording(filename);

    if (result.success) {
      showSuccess(`Deleted ${result.deletedFiles.length} file(s)`);
      await loadRecordings();
      await loadStorageStats();
    } else {
      showError('Failed to delete recording: ' + result.error);
    }
  } catch (err) {
    console.error('Failed to delete recording:', err);
    showError('Failed to delete recording');
  }
}

async function handleOpenFile(filepath) {
  try {
    await api.openFile(filepath);
  } catch (err) {
    console.error('Failed to open file:', err);
    showError('Failed to open file');
  }
}

async function handleProcessRecording(wavPath) {
  try {
    currentProcessingPath = wavPath;
    showProcessingOverlay('Processing', 'Starting transcription...', 0);
    updateProcessingBadge();

    const result = await api.processRecording(wavPath);

    currentProcessingPath = null;
    hideProcessingOverlay();

    if (result.success) {
      showSuccess('Processing complete!');
      await loadRecordings();
    } else {
      showError('Processing failed: ' + result.error);
      await loadRecordings();
    }
  } catch (err) {
    console.error('Failed to process recording:', err);
    currentProcessingPath = null;
    hideProcessingOverlay();
    showError('Processing failed');
  }
}

async function handleReprocessSession(sessionDir) {
  try {
    currentProcessingPath = sessionDir;
    showProcessingOverlay('Reprocessing', 'Starting reprocessing...', 0);
    updateProcessingBadge();

    const result = await api.reprocessSession(sessionDir);

    if (result.success) {
      showInfo('Reprocessing started — this may take a while for large files');
    } else {
      hideProcessingOverlay();
      showError('Reprocessing failed: ' + result.error);
    }
  } catch (err) {
    console.error('Failed to reprocess session:', err);
    hideProcessingOverlay();
    showError('Reprocessing failed');
  }
}

async function handleCleanup() {
  const retentionDays = parseInt(document.getElementById('retention-days').value);

  const confirmation = await api.confirmAction({
    title: 'Cleanup Old Recordings',
    message: `Delete recordings older than ${retentionDays} days?`,
    detail: 'Transcripts and notes will be preserved.',
    confirmLabel: 'Clean Up',
    cancelLabel: 'Cancel',
    destructive: true
  });

  if (!confirmation.confirmed) {
    return;
  }

  try {
    const result = await api.cleanupOldRecordings();

    if (result.success) {
      showSuccess(`Cleaned up ${result.deletedCount} old recording(s)`);
      await loadRecordings();
      await loadStorageStats();
    } else {
      showError('Cleanup failed: ' + result.error);
    }
  } catch (err) {
    console.error('Cleanup failed:', err);
    showError('Cleanup failed');
  }
}

async function runPreflightCheck() {
  const panel = document.getElementById('preflight-panel');
  const results = document.getElementById('preflight-results');

  panel.classList.remove('hidden');
  results.innerHTML = '<div class="loading">Running preflight checks...</div>';

  try {
    const checks = await api.runPreflight();
    console.log('Preflight results:', checks);

    let html = '';
    for (const check of checks) {
      const icon = check.pass ? '\u2705' : '\u274C';
      html += `<div class="preflight-item ${check.pass ? 'pass' : 'fail'}">
        <span>${icon}</span>
        <div>
          <strong>${check.name}</strong>
          <small>${check.message}</small>
        </div>
      </div>`;
    }

    results.innerHTML = html;
  } catch (err) {
    console.error('Preflight check failed:', err);
    results.innerHTML = '<div class="preflight-item fail"><span>\u274C</span><div><strong>Preflight failed</strong><small>' + err.message + '</small></div></div>';
  }
}

/**
 * ============================================
 * UI Helpers
 * ============================================
 */

function updateProcessingBadge() {
  // Update recording items to reflect current processing state without full re-render
  const items = document.querySelectorAll('.recording-item[data-filepath]');
  items.forEach(item => {
    const filepath = item.dataset.filepath;
    const badges = item.querySelector('.recording-badges');
    if (!badges) return;

    const isProcessing = currentProcessingPath && (
      filepath === currentProcessingPath ||
      (filepath && currentProcessingPath.includes(item.querySelector('.recording-name')?.textContent))
    );

    const existingBadge = badges.querySelector('.badge-processing, .badge-warning');
    if (isProcessing && existingBadge && !existingBadge.classList.contains('badge-processing')) {
      // Swap "Not transcribed" for "Processing..."
      existingBadge.outerHTML = '<span class="badge badge-processing"><span class="badge-spinner"></span>Processing\u2026</span>';
      item.classList.add('is-processing');
    }
  });
}

function showProcessingOverlay(stage, message, progress) {
  const overlay = document.getElementById('processing-overlay');
  const stageEl = document.getElementById('processing-stage');
  const messageEl = document.getElementById('processing-message');
  const progressFill = document.getElementById('progress-fill');
  const progressPercent = document.getElementById('processing-percent');

  stageEl.textContent = stage;
  messageEl.textContent = message;
  progressFill.style.width = `${progress}%`;
  progressPercent.textContent = `${progress}%`;

  overlay.classList.remove('hidden');
}

function hideProcessingOverlay() {
  const overlay = document.getElementById('processing-overlay');
  overlay.classList.add('hidden');
}

function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = {
    success: '\u2705',
    error: '\u274C',
    warning: '\u26A0\uFE0F',
    info: '\u2139\uFE0F'
  };

  const titles = {
    success: 'Success',
    error: 'Error',
    warning: 'Warning',
    info: 'Info'
  };

  toast.innerHTML = `
    <span class="toast-icon">${icons[type]}</span>
    <div class="toast-content">
      <div class="toast-title">${titles[type]}</div>
      <div class="toast-message">${message}</div>
    </div>
    <button class="toast-close">&times;</button>
  `;

  container.appendChild(toast);

  const closeBtn = toast.querySelector('.toast-close');
  closeBtn.addEventListener('click', () => {
    removeToast(toast);
  });

  setTimeout(() => {
    removeToast(toast);
  }, duration);
}

function removeToast(toast) {
  toast.classList.add('hiding');
  setTimeout(() => {
    toast.remove();
  }, 300);
}

function showSuccess(message) {
  showToast(message, 'success');
}

function showError(message) {
  showToast(message, 'error', 6000);
}

function showWarning(message) {
  showToast(message, 'warning');
}

function showInfo(message) {
  showToast(message, 'info');
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}
