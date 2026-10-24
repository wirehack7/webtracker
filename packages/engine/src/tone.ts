/**
 * Pulse-wave voice for previewing notes before real instruments exist.
 * A short linear ramp on gate changes keeps note on/off free of clicks.
 */
export class ToneVoice {
  private phase = 0;
  private step = 0;
  private gain = 0;
  private target = 0;
  private readonly rampStep: number;

  constructor(
    private readonly sampleRate: number,
    rampSeconds = 0.005,
    private readonly duty = 0.5,
    private readonly level = 0.2,
  ) {
    this.rampStep = 1 / Math.max(1, Math.round(rampSeconds * sampleRate));
  }

  noteOn(frequency: number): void {
    this.step = frequency / this.sampleRate;
    this.target = 1;
  }

  noteOff(): void {
    this.target = 0;
  }

  get active(): boolean {
    return this.gain > 0 || this.target > 0;
  }

  /** Adds the voice to both channels. */
  mix(left: Float32Array, right: Float32Array, frames: number): void {
    for (let i = 0; i < frames; i++) {
      if (this.gain < this.target) this.gain = Math.min(this.target, this.gain + this.rampStep);
      else if (this.gain > this.target) this.gain = Math.max(this.target, this.gain - this.rampStep);
      if (this.gain === 0) continue;

      const out = (this.phase < this.duty ? 1 : -1) * this.gain * this.level;
      left[i]! += out;
      right[i]! += out;
      this.phase += this.step;
      if (this.phase >= 1) this.phase -= 1;
    }
  }
}
