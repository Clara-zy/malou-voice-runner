'use strict';

/**
 * 声音输入：只读音量（RMS），不做语音识别 —— 这是整个项目技术上最简单也最稳的部分。
 * 现场嘈杂环境靠两件事兜底：开局 1.6s 校准噪音底 + 灵敏度滑杆。
 */
class VoiceInput {
  constructor() {
    this.active = false;
    this.level = 0;        // 平滑后的音量 0..~0.6
    this.floor = 0.004;    // 环境噪音底（校准得到）
    this.shoutPeak = 0;    // 玩家最大喊声（试喊校准得到；0 = 未校准）
    this.sens = 1.0;       // 灵敏度：>1 更容易触发
  }

  // 「跳」的音量门槛：得真喊；喊得越响跳得越高（力度按超出量计算）
  // 试喊校准过就按玩家自己的嗓门取 45% 分位，否则用保守默认值
  get Tjump() {
    const base = this.shoutPeak > 0 ? clamp(this.shoutPeak * 0.45, 0.09, 0.6) : 0.17;
    return Math.max(base, this.floor * 3) / this.sens;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // 回声消除开着：大屏音箱的声音进了麦克风也不至于误触发跳跃
        echoCancellation: true,
        // 关掉降噪和自动增益，保留真实音量曲线，阈值才稳定
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume(); // 必须在用户点击手势里调用
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.analyser); // 注意：不连 destination，避免啸叫
    this.buf = new Float32Array(this.analyser.fftSize);
    this.bytes = new Uint8Array(this.analyser.fftSize);
    this.active = true;
  }

  // 开局校准：静默采样 1.6s，取 70 分位当噪音底
  calibrate(ms = 1600) {
    return new Promise((resolve) => {
      const samples = [];
      const t0 = performance.now();
      const tick = () => {
        const raw = this.readRaw();
        if (raw != null) samples.push(raw);
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else {
          samples.sort((a, b) => a - b);
          this.floor = Math.max(0.002, samples[Math.floor(samples.length * 0.7)] || 0.004);
          resolve(this.floor);
        }
      };
      tick();
    });
  }

  // 试喊校准：记录窗口内平滑音量的峰值，作为这个玩家的"满嗓门"基线
  calibrateShout(ms = 1500) {
    return new Promise((resolve) => {
      let peak = 0;
      const t0 = performance.now();
      const tick = () => {
        this.update();
        if (this.level > peak) peak = this.level;
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else { this.shoutPeak = peak; resolve(peak); }
      };
      tick();
    });
  }

  readRaw() {
    if (!this.active) return null;
    // Safari 14.1+ 才有 getFloatTimeDomainData，做个降级
    if (this.analyser.getFloatTimeDomainData) {
      this.analyser.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
      return Math.sqrt(sum / this.buf.length);
    }
    this.analyser.getByteTimeDomainData(this.bytes);
    let sum = 0;
    for (let i = 0; i < this.bytes.length; i++) {
      const v = (this.bytes[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this.bytes.length);
  }

  // 每帧调用：快起慢落的平滑，喊声要跟手，安静要稳
  update() {
    const raw = this.readRaw();
    if (raw == null) return this.level;
    this.level = raw > this.level
      ? raw * 0.55 + this.level * 0.45
      : raw * 0.12 + this.level * 0.88;
    return this.level;
  }
}
