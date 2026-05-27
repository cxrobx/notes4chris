/**
 * SilenceWatcher
 *
 * A small, timer-free state machine that tracks a continuous silence streak
 * across the per-poll audio levels produced by `LevelMonitor`. When silence has
 * persisted for `requiredSilenceMs`, it fires `onTrigger` once (the caller then
 * shows the "still recording?" prompt and owns the grace timer). If audio
 * resumes while the prompt is up, it fires `onResume` so the caller can cancel
 * the auto-stop.
 *
 * It owns NO timers of its own — it is driven entirely by `update()` calls from
 * the existing 150ms level-monitor poll, using the wall clock to measure the
 * streak. This keeps it trivially unit-testable.
 *
 * Health gating (hazard #4): `LevelMonitor._readLevel` returns 0 on a missing,
 * empty, or unreadable file — indistinguishable from genuine silence. The caller
 * passes a `healthy` flag (the track files are present and *growing*). When a
 * track is not healthy we treat the moment as *unknown*, never as silence, so a
 * stalled recorder/capture failure cannot masquerade as a finished meeting and
 * auto-stop a recording that never really captured anything.
 *
 * Known limitation (gotchas.md #5 / SCK zero-fill): if Rogue Amoeba's ARK.driver
 * zero-fills system.wav, the file still *grows* (passes the health check) but
 * reads as silence. In dual mode this only reaches the trigger if the mic track
 * is *also* silent (the user is only listening, not speaking) — and even then we
 * prompt rather than stop, so the user sees "still recording?" and can keep it
 * alive. The prompt-then-grace design is the deliberate safety net for exactly
 * this case; never change it to a silent auto-stop.
 *
 * Threshold: `thresholdLevel` is the 0..1 normalised level (0 ≈ -60dB, 1 ≈ 0dB)
 * below which a track counts as silent. The default ~0.12 (≈ -53dB) sits above
 * ambient room hiss but well below spoken words. Empirically tunable — lower it
 * if the prompt fires during quiet-but-active calls.
 */

const DEFAULT_THRESHOLD_LEVEL = 0.12;

class SilenceWatcher {
  /**
   * @param {object} opts
   * @param {number} opts.requiredSilenceMs - Continuous silence before triggering.
   * @param {'dual'|'system'} [opts.mode='dual'] - Which tracks must be silent.
   * @param {number} [opts.thresholdLevel=0.12] - 0..1 level below which a track is silent.
   * @param {Function} opts.onTrigger - Fired once when the silence streak completes.
   * @param {Function} [opts.onResume] - Fired when audio resumes during the 'prompted' state.
   */
  constructor({ requiredSilenceMs, mode = 'dual', thresholdLevel = DEFAULT_THRESHOLD_LEVEL, onTrigger, onResume } = {}) {
    this.requiredSilenceMs = requiredSilenceMs;
    this.mode = mode;
    this.thresholdLevel = thresholdLevel;
    this.onTrigger = onTrigger || (() => {});
    this.onResume = onResume || (() => {});

    // 'active'   — counting toward (or idle below) the silence threshold.
    // 'prompted' — onTrigger already fired, prompt is up, grace timer running.
    this.state = 'active';
    this.streakStart = null;
  }

  /**
   * Feed one poll of levels plus a health flag.
   *
   * @param {{system?: number, mic?: number}} levels - Normalised 0..1 levels.
   * @param {{healthy: boolean}} [health] - Whether the active track files are
   *   present and growing this poll. When false, the poll is treated as unknown.
   */
  update(levels, { healthy } = { healthy: true }) {
    const now = Date.now();

    // Unknown state (read failure / stalled track): pause accumulation, never
    // trigger. Do not touch the 'prompted' state — a stalled read shouldn't be
    // mistaken for resumed audio either.
    if (!healthy) {
      if (this.state === 'active') {
        this.streakStart = null;
      }
      return;
    }

    const silent = this._isSilent(levels);

    if (this.state === 'prompted') {
      // Prompt is up and the grace timer is running. The first genuinely
      // non-silent healthy poll means someone started talking again — cancel.
      if (!silent) {
        this.onResume();
        this.reset();
      }
      return;
    }

    // state === 'active'
    if (!silent) {
      this.streakStart = null;
      return;
    }

    if (this.streakStart == null) {
      this.streakStart = now;
      return;
    }

    if (now - this.streakStart >= this.requiredSilenceMs) {
      this.state = 'prompted';
      this.onTrigger();
    }
  }

  /** Re-arm for the next silent window. */
  reset() {
    this.state = 'active';
    this.streakStart = null;
  }

  /** @private */
  _isSilent(levels) {
    const system = levels.system || 0;
    const mic = levels.mic || 0;
    if (this.mode === 'dual') {
      // Any speech on EITHER side keeps the recording alive.
      return system < this.thresholdLevel && mic < this.thresholdLevel;
    }
    return system < this.thresholdLevel;
  }
}

module.exports = { SilenceWatcher, DEFAULT_THRESHOLD_LEVEL };
