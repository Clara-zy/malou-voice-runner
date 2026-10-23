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
  stage() { this.beep(784, 0.12, 'triangle', 0.06); setTimeout(() => this.beep(1047, 0.18, 'triangle', 0.06), 110); },
  win() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.beep(f, 0.16, 'triangle', 0.07), i * 130)); },
  pickup() { this.beep(988, 0.09, 'triangle', 0.06); setTimeout(() => this.beep(1319, 0.12, 'triangle', 0.06), 70); },
  destroy() { this.beep(180, 0.3, 'sawtooth', 0.09, -120); this.beep(90, 0.25, 'square', 0.08, -40); },
  mad() { [330, 392, 494, 587, 698].forEach((f, i) => setTimeout(() => this.beep(f, 0.1, 'square', 0.06), i * 60)); },
};

/* ================= BGM：WebAudio 合成的 8 小节循环（低音+节奏镲+旋律） =================
 * Music.rate 由游戏进度/发疯状态动态调整，跑得越快音乐越嗨。 */
const Music = {
  playing: false, step: 0, nextT: 0, timer: null, rate: 1, BPM: 132,
  bass: [36, 36, 43, 43, 45, 45, 41, 43],                                  // 每小节根音
  lead: [60, 64, 67, 64, 72, 67, 64, 60, 65, 69, 72, 69, 64, 60, 62, 64], // 每 4 步一个旋律音
  f(n) { return 440 * Math.pow(2, (n - 69) / 12); },
  start() {
    SFX.ensure();
    if (!SFX.ctx) return;
    this.playing = true; this.step = 0;
    this.nextT = SFX.ctx.currentTime + 0.1;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.schedule(), 60);
  },
  stop() {
    this.playing = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  },
  schedule() {
    if (!this.playing || !SFX.ctx) return;
    // 后台节流/上下文挂起恢复后，不补排落下的音符（否则切回标签页瞬间齐鸣）
    this.nextT = Math.max(this.nextT, SFX.ctx.currentTime + 0.05);
    if (muted) return;
    const spb = 60 / this.BPM / 2 / this.rate; // 八分音符时长，rate 越大节奏越快
    while (this.nextT < SFX.ctx.currentTime + 0.18) {
      const t = this.nextT, s = this.step;
      const bar = Math.floor(s / 8) % 8;
      this.note(this.f(this.bass[bar]), t, spb * 0.9, 'square', 0.042);
      this.note(6500 + Math.random() * 500, t, 0.03, 'square', 0.011);
      if (s % 4 === 0) this.note(this.f(this.lead[(s / 4) % 16]), t, spb * 1.6, 'triangle', 0.032);
      this.step++;
      this.nextT += spb;
    }
  },
  note(freq, t, dur, type, vol) {
    const ctx = SFX.ctx;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  },
};
