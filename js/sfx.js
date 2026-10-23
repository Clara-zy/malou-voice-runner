'use strict';

/* ================= 音效（WebAudio 现场合成，无音频文件） ================= */
const SFX = {
  ctx: null,
  ensure() {
    if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  beep(freq, dur, type = 'square', vol = 0.07, slide = 0) {
    if (muted || !this.ctx) return;
    const t0 = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  },
  jump() { this.beep(300, 0.16, 'square', 0.06, 500); },
  land() { this.beep(150, 0.05, 'triangle', 0.045); },
  die() { this.beep(220, 0.5, 'sawtooth', 0.08, -160); },
  tick() { this.beep(880, 0.06, 'square', 0.045); },
  go() { this.beep(1320, 0.2, 'square', 0.06); },
  win() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.beep(f, 0.16, 'triangle', 0.07), i * 130)); },
};
