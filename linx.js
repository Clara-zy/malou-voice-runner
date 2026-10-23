'use strict';

/**
 * 灵矽（Linx）语音助手：浏览器扮演一台「设备」接入七牛灵矽 AI 平台，
 * 把游戏操作注册成端侧 MCP 工具，玩家说「开始游戏」「灵敏度调低点」就能驱动菜单。
 *
 * 只在主页 / 结算界面收音：对局中的吼叫不上传（ASR 往返太慢，跳跃仍走 audio.js 的音量判断）。
 * 协议文档：https://linx.qiniu.com/docs/xrobot/platform/websocket
 *           https://linx.qiniu.com/docs/xrobot/mcp/hardware-mcp
 */
const LINX_INTRO = '欢迎来玩“别让吗喽掉进 Bug”。吗喽自己跑，你负责喊，喊得越响跳得越高。纸飞机飞来时别出声。跑满一千行就上线成功。跟我说：开始游戏。';
const LINX_OTA = 'https://xrobo.qiniuapi.com/v1/ota/';
const LINX_CONSOLE = 'https://xrobo.qiniu.com/';
const LINX_RATE = 16000, LINX_FRAME = 320; // 上行 PCM16 单声道 20ms 一帧
// 服务端不做断句，要设备端自己判断一句话的起止（下面帧数都按 20ms 一帧算）
const LINX_VAD_MIN = 0.02;    // 开口音量下限（RMS），实际门槛 = max(下限, 噪音底 × 3)
const LINX_PREROLL = 15;      // 开口前补发 300ms，免得吞掉第一个字
const LINX_END_FRAMES = 35;   // 安静 700ms 算一句说完
const LINX_MAX_FRAMES = 400;  // 一句最长 8 秒，现场持续嘈杂也能收尾

// 麦克风采样率（通常 48k）→ 16k：按窗口取平均降采样，攒满一帧发给主线程
const LINX_WORKLET = `
class LinxPcm16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${LINX_RATE};
    this.pos = 0; this.acc = 0; this.cnt = 0;
    this.buf = new Int16Array(${LINX_FRAME}); this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.cnt++; this.pos++;
      if (this.pos < this.ratio) continue;
      this.pos -= this.ratio;
      const s = Math.max(-1, Math.min(1, this.acc / this.cnt));
      this.acc = 0; this.cnt = 0;
      this.buf[this.n++] = s * 0x7fff;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(${LINX_FRAME}); this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('linx-pcm16k', LinxPcm16k);
`;

function linxIdentity() {
  let id = localStorage.getItem('linx.deviceId');
  let cid = localStorage.getItem('linx.clientId');
  if (!id) {
    const b = crypto.getRandomValues(new Uint8Array(6));
    b[0] = (b[0] & 0xfe) | 0x02; // 本地管理的单播 MAC，不会和真实网卡撞号
    id = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(':').toUpperCase();
    localStorage.setItem('linx.deviceId', id);
  }
  if (!cid) {
    cid = crypto.randomUUID();
    localStorage.setItem('linx.clientId', cid);
  }
  return { id, cid };
}

class LinxClient {
  constructor(game) {
    this.game = game;
    this.gen = 0;          // 每次连接/断开 +1，用来作废还在路上的异步流程
    this.ws = null;
    this.ac = null;        // 收音和播放共用一个 AudioContext
    this.ready = false;    // hello 握手完成
    this.listening = false; // 正在上传一句话
    this.floor = 0.005;    // 环境噪音底（RMS），安静时自适应
    this.preroll = [];
    this.loud = 0;
    this.quiet = 0;
    this.uttFrames = 0;
    this.speaking = false; // 正在播 TTS：期间不上传音频，免得 AI 听见自己
    this.playAt = 0;
    this.sources = new Set();
    this.subTs = 0;
    this.tools = this.buildTools();
    setInterval(() => this.tick(), 200);
  }

  /* ---------- UI ---------- */
  setStatus(html, err, alert = err) {
    const el = document.getElementById('linx-status');
    el.innerHTML = html;
    el.classList.toggle('err', !!err);
    document.getElementById('btn-settings').classList.toggle('alert', !!alert);
  }
  setButton(text) { document.getElementById('btn-linx').textContent = text; }
  voiceNote(text) {
    const el = document.getElementById('over-voice');
    if (el) el.textContent = text || '';
  }
  subtitle(html) {
    document.getElementById('linx-sub').innerHTML = html;
    this.subTs = performance.now();
  }

  /* ---------- 连接流程：OTA 激活 → WebSocket 握手 → 开麦 ---------- */
  toggle() {
    if (this.ws || this.busy) this.disconnect('已断开');
    else this.connect();
  }

  async connect() {
    const gen = ++this.gen;
    this.busy = true;
    this.setButton('🗣️ 连接中…（点击取消）');
    try {
      if (!this.ac) this.ac = new (window.AudioContext || window.webkitAudioContext)();
      // 页面加载时自动连接没有用户手势，resume 会一直挂起：不等它，首次点击/按键时再恢复（见 linxWake）
      this.ac.resume().catch(() => {});
      const cfg = await this.activate(gen);
      if (gen !== this.gen) return;
      this.setStatus('正在连接灵矽…');
      await this.openSocket(cfg, gen);
      if (gen !== this.gen) return;
      await this.startMic();
      if (gen !== this.gen) return;
      this.busy = false;
      this.setButton('🗣️ 断开灵矽');
      if (this.ac.state === 'running') this.speak(LINX_INTRO, false);
      else this.introPending = true; // 音频还没解锁，开场白留到首次交互再念
      this.setStatus(`✅ 已连接：结算时会自动读出结果。也可以说「开始游戏」「灵敏度调低点」「帮我上榜，花名小王」<br>
        设备 ID <code>${linxIdentity().id}</code>（不是你的智能体在回答？到 <a href="${LINX_CONSOLE}" target="_blank" rel="noopener">智控台</a> → 设备管理 → 批量导入，填这个 MAC 后重连）`);
    } catch (e) {
      if (gen !== this.gen) return;
      this.disconnect('连接失败：' + (e && e.message || e), true);
    }
  }

  async ota() {
    const { id, cid } = linxIdentity();
    const res = await fetch(LINX_OTA, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Device-Id': id, 'Client-Id': cid, 'Activation-Version': '1' },
      body: JSON.stringify({
        uuid: cid,
        mac_address: id,
        application: { name: 'malou-voice-runner', version: '1.0.0', elf_sha256: '0'.repeat(64) },
        board: { type: 'malou-web', ssid: 'browser', rssi: 0 },
      }),
    });
    if (!res.ok) throw new Error(`OTA 请求失败（HTTP ${res.status}）`);
    const data = await res.json();
    if (data.error) throw new Error('OTA 返回错误：' + data.error);
    return data;
  }

  // 未绑定的设备会拿到 6 位激活码：在智控台绑定后轮询激活状态，再重新 OTA 拿 token
  async activate(gen) {
    this.setStatus('正在向灵矽上报设备…');
    for (;;) {
      const data = await this.ota();
      if (gen !== this.gen) return null;
      if (data.websocket && data.websocket.token) return data.websocket;
      if (!data.activation) throw new Error('OTA 没有返回连接信息');
      this.setStatus(`激活码 <b>${data.activation.code}</b>：打开 <a href="${LINX_CONSOLE}" target="_blank" rel="noopener">灵矽智控台</a> → 选择智能体 → 添加设备，填入激活码，绑定后自动连接…`, false, true);
      if (this.game.mode === 'menu' && window.openSettings) openSettings(); // 激活码收在设置里，主动弹出来
      await this.waitBound(gen);
      if (gen !== this.gen) return null;
    }
  }

  async waitBound(gen) {
    const { id } = linxIdentity();
    while (gen === this.gen) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch(LINX_OTA + 'activate', { method: 'POST', headers: { 'Device-Id': id } });
        if (res.status === 200 && (await res.text()).trim() === 'success') return;
      } catch (e) { /* 网络抖动，继续轮询 */ }
    }
  }

  // 浏览器 WebSocket 不能自定义请求头，鉴权参数改放到 URL query 里
  openSocket(cfg, gen) {
    const { id, cid } = linxIdentity();
    const url = new URL(cfg.url.replace(/^ws:/, 'wss:'));
    url.searchParams.set('device-id', id);
    url.searchParams.set('client-id', cid);
    url.searchParams.set('authorization', 'Bearer ' + cfg.token);
    url.searchParams.set('protocol-version', '1');

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('10 秒内没有收到 hello 响应')), 10000);
      ws.onopen = () => ws.send(JSON.stringify({
        type: 'hello',
        version: 1,
        features: { mcp: true, notify: { config_updated: true } },
        transport: 'websocket',
        audio_params: {
          format: 'pcm', sample_rate: LINX_RATE, channels: 1, bit_depth: 16, endianness: 'little',
          frame_duration: 20, frame_size: LINX_FRAME, sample_format: 'signed_int16', play_buffer_duration: 1000,
        },
      }));
      ws.onmessage = (e) => {
        if (gen !== this.gen) return;
        if (typeof e.data !== 'string') { this.onAudio(e.data); return; }
        let msg;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        console.debug('[linx]', msg);
        if (msg.type === 'hello' && !this.ready) {
          clearTimeout(timer);
          this.onHello(msg);
          resolve();
        } else {
          this.onMessage(msg);
        }
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        reject(new Error(e.reason || `连接被关闭（${e.code}）`));
        if (gen === this.gen && this.ready) this.disconnect('灵矽连接已断开' + (e.reason ? '：' + e.reason : ''), true);
      };
    });
  }

  async startMic() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (!this.workletLoaded) {
      const url = URL.createObjectURL(new Blob([LINX_WORKLET], { type: 'application/javascript' }));
      await this.ac.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.workletLoaded = true;
    }
    this.src = this.ac.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ac, 'linx-pcm16k', { numberOfOutputs: 0 });
    this.node.port.onmessage = (e) => this.onFrame(e.data);
    this.src.connect(this.node);
  }

  /* ---------- 上行：按音量断句，一句话 = listen start → 音频帧 → 空帧 + listen stop ---------- */
  onFrame(buf) {
    const pcm = new Int16Array(buf);
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
    const rms = Math.sqrt(sum / pcm.length) / 0x8000;

    const open = this.ready && this.idle && !this.speaking && this.ws && this.ws.readyState === WebSocket.OPEN;
    if (!open) {
      if (this.listening) this.endUtterance();
      this.preroll.length = 0;
      this.loud = 0;
      return;
    }

    if (!this.listening) {
      this.floor = rms < this.floor * 3 ? this.floor * 0.95 + rms * 0.05 : this.floor * 0.999 + rms * 0.001;
      this.preroll.push(buf);
      if (this.preroll.length > LINX_PREROLL) this.preroll.shift();
      this.loud = rms > Math.max(LINX_VAD_MIN, this.floor * 3) ? this.loud + 1 : 0;
      if (this.loud >= 3) this.beginUtterance();
      return;
    }

    this.ws.send(buf);
    this.uttFrames++;
    this.quiet = rms > Math.max(LINX_VAD_MIN * 0.6, this.floor * 2) ? 0 : this.quiet + 1;
    if (this.quiet >= LINX_END_FRAMES || this.uttFrames >= LINX_MAX_FRAMES) this.endUtterance();
  }

  beginUtterance() {
    this.send({ session_id: this.sessionId, type: 'listen', state: 'start', mode: 'realtime' });
    this.listening = true;
    this.loud = 0;
    this.quiet = 0;
    this.uttFrames = 0;
    this.preroll.forEach((f) => this.ws.send(f));
    this.preroll = [];
    this.subtitle('<span class="me">🗣️ …</span>');
  }

  endUtterance() {
    this.listening = false;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(new Uint8Array(0));
    this.send({ session_id: this.sessionId, type: 'listen', state: 'stop', mode: 'realtime' });
  }

  disconnect(reason, err) {
    this.gen++;
    this.busy = false;
    this.introPending = false;
    this.ready = false;
    this.listening = false;
    this.speaking = false;
    this.preroll = [];
    this.loud = 0;
    clearTimeout(this.quietTimer);
    clearTimeout(this.speakTimer);
    this.awaitingResultTts = false;
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    if (this.src) { this.src.disconnect(); this.src = null; }
    if (this.node) { this.node.port.onmessage = null; this.node = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    if (this.opus && this.opus.free) { try { this.opus.free(); } catch (e) {} }
    this.opus = null;
    this.opusReady = false;
    this.opusQueue = [];
    this.stopPlayback();
    this.setButton('🗣️ 连接灵矽语音助手');
    this.setStatus(reason || '', err);
  }

  /* ---------- 会话 ---------- */
  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  onHello(msg) {
    this.ready = true;
    this.sessionId = msg.session_id || '';
    const ap = msg.audio_params || {};
    this.down = { format: ap.format || 'opus', rate: ap.sample_rate || 24000, frameMs: ap.frame_duration || 60 };
    if (this.down.format === 'opus') this.setupOpus();
  }

  get idle() { return this.game.mode === 'menu' || this.game.mode === 'over'; }

  // 连上后的开场，以及结算页，都按原文交给灵矽朗读
  speak(text, onOver) {
    if (!text || !this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN || this.playError) return false;
    if (this.ac && this.ac.state === 'suspended') this.ac.resume();
    if (this.listening) this.endUtterance();
    clearTimeout(this.quietTimer);
    this.stopPlayback();
    this.suppressTts = false;
    this.speaking = true; // 先堵住上行，避免现场叫声被当成新的一句话
    this.abortSent = false;
    this.awaitingResultTts = true;
    this.subtitle(`🐵 ${linxEsc(text)}`);
    this.send({
      session_id: this.sessionId,
      type: 'listen',
      state: 'detect',
      text: onOver ? '结算播报' : '开场介绍',
      text_response: text,
    });
    clearTimeout(this.speakTimer);
    this.speakTimer = setTimeout(() => {
      if (!this.awaitingResultTts) return;
      this.awaitingResultTts = false;
      this.speaking = false;
      if (onOver) this.voiceNote('灵矽没有把声音发回来。看一下网络，以及智能体有没有配好声音。');
    }, 8000);
    return true;
  }

  speakResult(text) {
    if (!text) return;
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.voiceNote('还没连上灵矽，所以没有朗读。回主页在右上角 ⚙️ 设置里连接灵矽。');
      return;
    }
    if (this.playError) {
      this.voiceNote(this.playError);
      return;
    }
    if (this.speak(text, true)) this.voiceNote('正在朗读…');
  }

  // 离开结算页时立刻停掉正在念的结果，并丢掉还在路上的语音
  stopSpeaking() {
    clearTimeout(this.quietTimer);
    clearTimeout(this.speakTimer);
    const pending = this.speaking || this.awaitingResultTts;
    this.awaitingResultTts = false;
    this.speaking = false;
    this.suppressTts = true;
    this.opusQueue = [];
    if (pending && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ session_id: this.sessionId, type: 'abort', reason: 'back_to_menu' });
      this.abortSent = true;
    }
    this.stopPlayback();
    this.voiceNote('');
    const sub = document.getElementById('linx-sub');
    if (sub) sub.classList.add('hidden');
  }

  // 只有主页 / 结算界面才收音和说话（收音由 onFrame 判断）；开麦校准、对局期间打断 TTS，
  // 否则 AI 的声音会被校准当成环境噪音、对局中也会被当成喊声触发起跳
  tick() {
    if (!this.idle && this.speaking && !this.abortSent) {
      this.send({ session_id: this.sessionId, type: 'abort', reason: 'game_started' });
      this.abortSent = true;
      this.stopPlayback();
    }
    const sub = document.getElementById('linx-sub');
    const stale = performance.now() - this.subTs > 8000 && !this.speaking;
    sub.classList.toggle('hidden', !this.ready || stale || this.game.mode === 'play');
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'stt':
        this.subtitle(`<span class="me">🗣️ ${linxEsc(msg.text)}</span>`);
        break;
      case 'llm':
        if (msg.text) this.emoji = msg.text;
        break;
      case 'tts':
        if (this.suppressTts) {
          if (msg.state === 'start' && this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.send({ session_id: this.sessionId, type: 'abort', reason: 'back_to_menu' });
          }
          break;
        }
        if (msg.state === 'start') {
          this.speaking = true;
          this.abortSent = false;
          this.awaitingResultTts = false;
          this.voiceNote('正在朗读…');
          clearTimeout(this.speakTimer);
          clearTimeout(this.quietTimer);
        } else if (msg.state === 'sentence_start') {
          this.subtitle(`${this.emoji || '🐵'} ${linxEsc(msg.text)}`);
        } else if (msg.state === 'stop') {
          if (msg.is_aborted) this.stopPlayback();
          const left = this.ac ? Math.max(0, this.playAt - this.ac.currentTime) : 0;
          clearTimeout(this.quietTimer);
          this.quietTimer = setTimeout(() => {
            this.speaking = false;
            if (this.game.mode === 'over') this.voiceNote('');
          }, left * 1000 + 300);
        }
        break;
      case 'mcp':
        this.onMcp(msg.payload || {});
        break;
      case 'notify':
        if (msg.event === 'config_updated') {
          this.disconnect('智能体配置已更新，正在重连…');
          this.connect();
        }
        break;
    }
  }

  /* ---------- 下行音频：PCM 直接播；Opus 用页面里的解码器（不依赖浏览器是否带 WebCodecs） ---------- */
  setupOpus() {
    const Ctor = window['opus-decoder'] && window['opus-decoder'].OpusDecoder;
    if (!Ctor) {
      this.playError = '页面没有加载声音解码器，灵矽的声音播不出来。请刷新后再试。';
      return;
    }
    const rate = [8000, 12000, 16000, 24000, 48000].includes(this.down.rate) ? this.down.rate : 24000;
    this.opusQueue = [];
    this.opusReady = false;
    this.playError = '';
    try {
      this.opus = new Ctor({ sampleRate: rate });
    } catch (e) {
      this.playError = '声音解码器启动失败，灵矽的声音播不出来。';
      return;
    }
    this.opus.ready.then(() => {
      this.opusReady = true;
      const q = this.opusQueue.splice(0);
      q.forEach((b) => this.decodeOpus(b));
    }).catch(() => {
      this.playError = '声音解码器启动失败，灵矽的声音播不出来。';
      this.voiceNote(this.playError);
    });
  }

  onAudio(buf) {
    if (!this.down || !this.ac || !this.idle || this.suppressTts) return;
    if (this.ac.state === 'suspended') this.ac.resume();
    if (this.down.format === 'pcm') {
      const pcm = new Int16Array(buf);
      const f = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 0x8000;
      this.enqueue(f, this.down.rate);
    } else {
      this.decodeOpus(new Uint8Array(buf));
    }
  }

  decodeOpus(packet) {
    if (!this.opusReady) {
      if (this.opusQueue) this.opusQueue.push(packet);
      return;
    }
    if (packet.length >= 16 && packet[0] === 0 && packet[1] === 2 && packet[3] <= 1) {
      const size = (packet[12] << 24) | (packet[13] << 16) | (packet[14] << 8) | packet[15];
      if (size > 0 && 16 + size <= packet.length) packet = packet.subarray(16, 16 + size);
    }
    if (!packet.length) return;
    let result;
    try { result = this.opus.decodeFrame(packet); } catch (e) { return; }
    const samples = result && result.channelData && result.channelData[0];
    if (samples && samples.length) this.enqueue(samples, result.sampleRate || this.down.rate);
  }

  enqueue(samples, rate) {
    if (!samples.length || !this.ac) return;
    if (this.ac.state === 'suspended') this.ac.resume();
    const buf = this.ac.createBuffer(1, samples.length, rate);
    buf.copyToChannel(samples, 0);
    const src = this.ac.createBufferSource();
    src.buffer = buf;
    src.connect(this.ac.destination);
    const t = Math.max(this.playAt, this.ac.currentTime + 0.06);
    src.start(t);
    this.playAt = t + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  stopPlayback() {
    this.sources.forEach((s) => { try { s.stop(); } catch (e) {} });
    this.sources.clear();
    this.playAt = 0;
  }

  /* ---------- 端侧 MCP：把游戏操作暴露成工具 ---------- */
  buildTools() {
    const g = this.game;
    const none = { type: 'object', properties: {}, required: [] };
    return [
      {
        name: 'self.game.get_status',
        description: '获取「别让吗喽掉进 Bug」游戏的当前状态：screen 当前界面（menu 主页 / calib、ready 开麦校准中 / play 对局中 / over 结算）、本局成绩（行代码，满分 1000）、结局、灵敏度、音效开关、排行榜前五',
        inputSchema: none,
        run: () => g.status(),
      },
      {
        name: 'self.game.start',
        description: '开始一局「别让吗喽掉进 Bug」。用户说「开始游戏」「开一局」「再来一局」时调用。首次会开麦并安静校准约 2 秒',
        inputSchema: none,
        run: () => g.start(),
      },
      {
        name: 'self.game.back_to_menu',
        description: '从结算界面回到游戏主页',
        inputSchema: none,
        run: () => g.backToMenu(),
      },
      {
        name: 'self.game.set_sensitivity',
        description: '设置喊声触发跳跃的灵敏度，越大越容易起跳；现场太吵、观众欢呼误触发时调低，喊了跳不起来时调高。调整前可先查询当前值',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'number', minimum: 0.6, maximum: 1.8, description: '灵敏度，范围 0.6~1.8，默认 1.0' } },
          required: ['value'],
        },
        run: (a) => g.setSensitivity(a.value),
      },
      {
        name: 'self.game.set_sound',
        description: '打开或关闭游戏音效',
        inputSchema: {
          type: 'object',
          properties: { on: { type: 'boolean', description: 'true 打开，false 关闭' } },
          required: ['on'],
        },
        run: (a) => g.setSound(!!a.on),
      },
      {
        name: 'self.game.save_score',
        description: '在结算界面把本局成绩登记到排行榜',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: '玩家花名或工号，最多 8 个字；不提供则用默认花名' } },
          required: [],
        },
        run: (a) => g.saveScore(a.name),
      },
    ];
  }

  onMcp(p) {
    const reply = (body) => this.send({ session_id: this.sessionId, type: 'mcp', payload: { jsonrpc: '2.0', id: p.id, ...body } });
    if (p.id === undefined || p.id === null) return; // notification，不需要回复

    if (p.method === 'initialize') {
      reply({
        result: {
          protocolVersion: (p.params && p.params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: '别让吗喽掉进 Bug', version: '1.0.0' },
        },
      });
    } else if (p.method === 'tools/list') {
      reply({ result: { tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, type: 0, inputSchema })), nextCursor: null } });
    } else if (p.method === 'tools/call') {
      const { name, arguments: args } = p.params || {};
      const tool = this.tools.find((t) => t.name === name);
      if (!tool) { reply({ error: { code: -32601, message: '未知工具: ' + name } }); return; }
      try {
        const out = tool.run(args || {});
        const text = typeof out === 'string' ? out : JSON.stringify(out);
        reply({ result: { content: [{ type: 'text', text }], isError: false } });
      } catch (e) {
        reply({ result: { content: [{ type: 'text', text: '执行失败：' + (e && e.message || e) }], isError: true } });
      }
    } else {
      reply({ error: { code: -32601, message: '不支持的方法: ' + p.method } });
    }
  }
}

function linxEsc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.linx = new LinxClient(window.Game);
document.getElementById('btn-linx').addEventListener('click', () => window.linx.toggle());

// 浏览器要等用户手势才放行音频：每次点击/按键都尝试恢复，第一次顺便补念开场白（只在主页/结算页念）
function linxWake() {
  const c = window.linx;
  if (!c.ac) return;
  const intro = c.introPending;
  c.introPending = false;
  c.ac.resume().then(() => { if (intro && c.idle) c.speak(LINX_INTRO, false); }).catch(() => {});
}
addEventListener('pointerdown', linxWake, true);
addEventListener('keydown', linxWake, true);

// 默认自动连接灵矽；?demo 演示与 ?nolinx（测试/离线排查）不连
const linxQs = new URLSearchParams(location.search);
if (!linxQs.has('demo') && !linxQs.has('nolinx')) window.linx.connect();
