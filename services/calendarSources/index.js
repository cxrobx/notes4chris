/**
 * Calendar source selector.
 *
 * Today this returns the macOS source whenever calendar suggestions are
 * enabled. When the Gmail/Google integration ships in v2, this is where the
 * "which source should I use?" decision will live.
 */

const { MacOSCalendarSource } = require('./macOSCalendarSource');
const { GmailCalendarSource } = require('./gmailCalendarSource');

/**
 * @param {object} store - electron-store instance
 * @param {object} deps - injection bag for the source
 * @param {string} deps.helperPath
 * @param {Function} deps.spawn
 * @param {Function} deps.registerProcess
 * @returns {object | null} - active source, or null if calendar suggestions are off
 */
function getActiveSource(store, deps) {
  if (!store.get('calendarSuggestionsEnabled')) return null;
  // v2 hook: a `calendarSourcePreference` setting would select between
  // 'macos' and 'gmail' here. For v1, we only ship the macOS source.
  return new MacOSCalendarSource(deps);
}

module.exports = {
  getActiveSource,
  MacOSCalendarSource,
  GmailCalendarSource
};
