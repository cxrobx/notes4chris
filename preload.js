/**
 * Preload Script for Notes4Chris
 *
 * This script runs in the renderer process before the page loads.
 * It provides a secure bridge between the renderer and main process via contextBridge.
 *
 * Security:
 * - Only exposes specific whitelisted APIs
 * - No direct access to Node.js or Electron APIs from renderer
 * - All communication via IPC (Inter-Process Communication)
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Exposed API for renderer process
 *
 * All methods return Promises for async operations
 */
contextBridge.exposeInMainWorld('meetingRecorder', {
  // ============================================
  // Recording Controls
  // ============================================

  startRecording: () => ipcRenderer.invoke('recording:start'),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  getRecordingStatus: () => ipcRenderer.invoke('recording:status'),

  // ============================================
  // File Management
  // ============================================

  listRecordings: () => ipcRenderer.invoke('files:list'),
  getStorageStats: () => ipcRenderer.invoke('files:stats'),
  deleteRecording: (filename) => ipcRenderer.invoke('files:delete', filename),
  cleanupOldRecordings: () => ipcRenderer.invoke('files:cleanup'),
  openFile: (filepath) => ipcRenderer.invoke('files:open', filepath),

  // ============================================
  // Processing
  // ============================================

  transcribeRecording: (wavPath) => ipcRenderer.invoke('process:transcribe', wavPath),
  generateNotes: (transcriptPath) => ipcRenderer.invoke('process:summarise', transcriptPath),
  processRecording: (wavPath) => ipcRenderer.invoke('process:full', wavPath),
  reprocessSession: (sessionDir) => ipcRenderer.invoke('session:reprocess', sessionDir),
  getProcessingStatus: () => ipcRenderer.invoke('processing:status'),

  // ============================================
  // Audio Configuration
  // ============================================

  listInputDevices: () => ipcRenderer.invoke('audio:listInputDevices'),
  runPreflight: () => ipcRenderer.invoke('audio:preflight'),

  // ============================================
  // Settings
  // ============================================

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  // ============================================
  // System Information
  // ============================================

  checkDependencies: () => ipcRenderer.invoke('system:dependencies'),
  getVersion: () => ipcRenderer.invoke('system:version'),
  openOutputDirectory: () => ipcRenderer.invoke('system:openOutputDir'),
  chooseOutputDirectory: () => ipcRenderer.invoke('system:chooseOutputDir'),
  requestScreenCapturePermission: () => ipcRenderer.invoke('system:requestScreenCapturePermission'),
  confirmAction: (options) => ipcRenderer.invoke('dialog:confirm', options),

  // ============================================
  // Event Listeners
  // ============================================

  onRecordingUpdate: (callback) => {
    ipcRenderer.on('recording:update', (event, data) => callback(data));
  },

  onRecordingLevels: (callback) => {
    ipcRenderer.on('recording:levels', (event, data) => callback(data));
  },

  onProcessingProgress: (callback) => {
    ipcRenderer.on('processing:progress', (event, data) => callback(data));
  },

  onProcessingComplete: (callback) => {
    ipcRenderer.on('processing:complete', (event) => callback());
  },

  onError: (callback) => {
    ipcRenderer.on('error', (event, data) => callback(data));
  },

  onNotification: (callback) => {
    ipcRenderer.on('notification', (event, data) => callback(data));
  },

  onRecordingsChanged: (callback) => {
    ipcRenderer.on('recordings:changed', (event, data) => callback(data));
  },

  onCompanionModeStatus: (callback) => {
    ipcRenderer.on('companion-mode-status', (event, data) => callback(data));
  },

  removeListener: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  }
});

console.log('Preload script loaded - API exposed to renderer');
