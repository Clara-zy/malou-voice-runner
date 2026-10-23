'use strict';

/* ================= 可调参数（现场调手感主要改这里） ================= */
const W = 1280, H = 720, GROUND = 600;
const GRAVITY = 2600;
const AUTO_V = 300;                          // 吗喽自动匀速前进速度（玩家只管跳）
const JUMP_V_MIN = 900, JUMP_V_MAX = 1080;  // 起跳初速度：喊得越响跳得越高越远
const PLAYER_W = 64, PLAYER_H = 76;
const PLAYER_X = 320;
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

// URL 参数：?demo 自动演示模式；?goal=3000 缩短赛程（默认 12000px = 1000 行代码）
const qs = new URLSearchParams(location.search);
const DEMO = qs.has('demo');
const _goal = parseInt(qs.get('goal'), 10);
const GOAL_DIST = Number.isFinite(_goal) && _goal >= 2000 ? _goal : 12000;

/* ================= 工具 ================= */
const $ = (id) => document.getElementById(id);
const cvs = $('game'), ctx = cvs.getContext('2d');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hash = (i) => { const s = Math.sin(i * 127.1) * 43758.5453; return s - Math.floor(s); };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const aabb = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fit() {
  const s = Math.min(innerWidth / W, innerHeight / H);
  $('stage').style.transform = `scale(${s})`;
}
addEventListener('resize', fit);
fit();

/* ================= 排行榜（本机 localStorage，够大屏单机场景用） ================= */
const LB_KEY = 'malou.leaderboard', NAME_KEY = 'malou.name';
let lastEntryTs = 0;

function loadLB() {
  try { return JSON.parse(localStorage.getItem(LB_KEY)) || []; } catch (e) { return []; }
}
function addScore(name, score) {
  const lb = loadLB();
  const entry = { name, score, ts: Date.now() };
  lb.push(entry);
  lb.sort((a, b) => b.score - a.score);
  try { localStorage.setItem(LB_KEY, JSON.stringify(lb.slice(0, 10))); } catch (e) {}
  return lb.indexOf(entry);
}
function lbHTML(list, meTs) {
  const top = list.slice(0, 5);
  if (!top.length) return '<p class="lb-empty">还没有吗喽上榜，等你来当第一个 🐵</p>';
  const medals = ['🥇', '🥈', '🥉'];
  return '<ol class="lb">' + top.map((e, i) =>
    `<li class="${e.ts === meTs ? 'me' : ''}"><span class="rk">${medals[i] || i + 1}</span><span class="nm">${esc(e.name)}</span><span class="sc">${e.score} 行</span></li>`
  ).join('') + '</ol>';
}

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

/* ================= 状态 ================= */
const voice = new VoiceInput();
let mode = 'menu';            // menu | calib | ready | play | over
let muted = false;

const player = { x: PLAYER_X, y: GROUND, vy: 0, grounded: true };
let dist = 0, camX = 0, speed = 0, tNow = 0, lastVol = 0;
let obstacles = [], spawnX = 1000;
let countdown = 0, goFlash = 0;
let deadInfo = null, winInfo = false, shake = 0;
let jumpCd = 0, jumpBuf = 0, keyJump = false, spaceHeld = false, spaceHoldT = 0, spaceReleaseVol = 0;
let pendingScore = 0, saved = false;

const curScore = () => Math.min(1000, Math.floor(dist / 12));

/* ================= 障碍 ================= */
const BLOCKERS = [
  { e: '📄', label: '需求变更', color: '#c98a1b' },
  { e: '🚧', label: '404', color: '#7a68c9' },
  { e: '💣', label: 'P0 故障', color: '#c93a3f' },
];

function spawnOne(x, prog) {
  const r = Math.random();
  let type;
  if (prog < 0.06) type = 'bug';
  else if (prog > 0.28 && r < 0.2) type = 'paper';
  else if (prog > 0.2 && r < 0.42) type = 'pit';
  else type = r < 0.72 ? 'bug' : 'blocker';

  if (type === 'bug') {
    obstacles.push({ type, x, w: 56, h: 56, e: '🐛', label: 'NullPointerException', color: '#c93a3f' });
  } else if (type === 'blocker') {
    const b = BLOCKERS[Math.floor(Math.random() * BLOCKERS.length)];
    obstacles.push({ type, x, w: 64, h: 92, e: b.e, label: b.label, color: b.color });
  } else if (type === 'paper') {
    obstacles.push({ type, x, w: 84, h: 64, top: 392 + Math.random() * 26, e: '✈️', label: '需求变更变更', color: '#b8860b' });
  } else {
    obstacles.push({ type: 'pit', x, w: 110 + Math.random() * 40 + prog * 40 });
  }
}

function fillObstacles() {
  while (spawnX < camX + W + 500) {
    if (spawnX > GOAL_DIST - 500) { spawnX = camX + W + 600; break; } // 终点前留一段净土
    spawnOne(spawnX, spawnX / GOAL_DIST);
    spawnX += 260 + 300 * (0.9 + Math.random() * 0.9);
  }
}

function playerBox(inset) {
  return { x: player.x - PLAYER_W / 2 + inset, y: player.y - PLAYER_H + inset, w: PLAYER_W - inset * 2, h: PLAYER_H - inset * 2 };
}
function obBox(o, inset) {
  const y = o.type === 'paper' ? o.top : GROUND - o.h;
  return { x: o.x + inset, y: y + inset, w: o.w - inset * 2, h: o.h - inset * 2 };
}
function isOverPit() {
  for (const o of obstacles) {
    if (o.type === 'pit' && player.x > o.x + 12 && player.x < o.x + o.w - 12) return true;
  }
  return false;
}

/* ================= 输入 ================= */
addEventListener('keydown', (e) => {
  const k = e.key;
  if (k === 'f' || k === 'F') {
    if (document.fullscreenElement) document.exitFullscreen && document.exitFullscreen();
    else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
    return;
  }
  if (k === 'm' || k === 'M') { muted = !muted; return; }
  if (document.activeElement === $('name-input')) return;
  if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) e.preventDefault();
  if (mode === 'over') {
    if (k === 'Enter') { if (mode === 'over') resetRun(); }
    else if (k === 'Escape') toMenu();
    return;
  }
  if (mode !== 'play') return;
  // 空格 = 模拟语音输入（开发调试）：按住蓄力，按得越久"嗓门"越大，松开才喊出来
  if (k === ' ') { if (!e.repeat) spaceHeld = true; }
  if (k === 'ArrowUp' || k === 'w' || k === 'W') { if (!e.repeat) keyJump = true; }
});
addEventListener('keyup', (e) => {
  const k = e.key;
  if (k === ' ' && spaceHeld) {
    spaceHeld = false;
    spaceReleaseVol = Math.min(0.45, spaceHoldT * 1.2); // 松开瞬间：把蓄的力当成一次喊声
    spaceHoldT = 0;
  }
});

function currentVol(dt) {
  if (DEMO) return demoVol(dt);
  let v = voice.active ? voice.update() : 0;
  if (spaceReleaseVol > 0) v = Math.max(v, spaceReleaseVol); // 松开空格的那一帧喊声
  return v;
}

/* 演示模式：一个简单的自动玩 AI，也用来验证全套机制 */
let demoPulse = 0;
function nearestHazard() {
  let best = null;
  for (const o of obstacles) {
    const nd = o.x - (player.x + 26);
    if (nd > -30 && (!best || nd < best.nd)) best = { o, nd };
  }
  return best;
}
function demoVol(dt) {
  demoPulse = Math.max(0, demoPulse - dt);
  if (demoPulse > 0) return 0.3;
  const n = nearestHazard();
  if (n && player.grounded) {
    if (n.o.type === 'paper') return 0;                            // 纸飞机：闭嘴
    const trig = n.o.type === 'bug' ? 80 : n.o.type === 'blocker' ? 100 : 30;
    if (n.nd <= trig) { demoPulse = 0.09; return 0.3; }            // 喊一嗓子
  }
  return 0;                                                         // 平时安静
}

/* ================= 流程 ================= */
function resetRun() {
  dist = 0; camX = 0; speed = 0; lastVol = 0;
  obstacles = []; spawnX = 1000;
  player.x = PLAYER_X;
  player.y = GROUND; player.vy = 0; player.grounded = true;
  countdown = 2.4; goFlash = 0;
  deadInfo = null; winInfo = false; shake = 0;
  jumpCd = 0; jumpBuf = 0; demoPulse = 0; spaceHoldT = 0; spaceReleaseVol = 0;
  pendingScore = 0; saved = false;
  mode = 'play';
  $('screen-over').classList.add('hidden');
  $('screen-start').classList.add('hidden');
}

function toMenu() {
  mode = 'menu';
  $('screen-over').classList.add('hidden');
  $('screen-start').classList.remove('hidden');
  $('lb-start').innerHTML = lbHTML(loadLB(), lastEntryTs);
}

function die(o) {
  if (deadInfo || winInfo) return;
  deadInfo = o; shake = 0.5;
  window.__lastDeath = { label: o.label || o.type, dist: Math.round(dist), speed: Math.round(speed), px: Math.round(player.x), py: Math.round(player.y), vy: Math.round(player.vy), ox: Math.round(o.x || 0), ow: Math.round(o.w || 0), vol: +lastVol.toFixed(3) };
  SFX.die();
  setTimeout(showOver, 800);
}

function winRun() {
  if (deadInfo || winInfo) return;
  winInfo = true;
  dist = GOAL_DIST;
  SFX.win();
  setTimeout(showOver, 900);
}

const DEATHS = {
  'NullPointerException': ['💀', '吗喽已卒', '你被 NullPointerException 当场砸中：引用指着一指，就指到了天堂。', '小技巧：小障碍小声喊就够，不用吼那么用力。'],
  '需求变更': ['📄', '吗喽裂开', '需求又双叒叕变了，吗喽被拍进了变更单里。', '小技巧：落地站稳再起跳，别贪连跳。'],
  '404': ['🚧', '此路不通', '404 Not Found：需求文档里的这条路，现实中不存在。', '小技巧：提前一点喊，跳得更高更远。'],
  'P0 故障': ['💣', '本迭代结束', 'P0 告警：全群都在 @你，包括老板。', '小技巧：提前一点喊，跳得更高更远。'],
  '需求变更变更': ['✈️', '低空遇袭', '纸飞机（第 N 版需求变更）从头顶飞过——谁让你在它下面乱喊的？', '小技巧：看到纸飞机就闭嘴快走，千万别跳。'],
  'pit': ['🕳️', '掉进技术债', '这个坑是三年前的前人埋的，今天正好轮到吗喽来填。', '小技巧：坑越宽越要喊得响，起跳别太早。'],
};
function deathKey(o) {
  if (!o || o.type === 'pit') return 'pit';
  return o.label;
}

function showOver() {
  if (mode !== 'play') return;
  mode = 'over';
  pendingScore = curScore();
  if (winInfo) {
    $('over-emoji').textContent = '🎉';
    $('over-title').textContent = '上线成功！';
    $('over-msg').textContent = `本次发布 ${pendingScore} 行代码 · 0 回滚 · 建议全组喝奶茶庆祝`;
    $('over-tip').textContent = '';
  } else {
    const [em, ti, ms, tp] = DEATHS[deathKey(deadInfo)] || DEATHS.pit;
    $('over-emoji').textContent = em;
    $('over-title').textContent = ti;
    $('over-msg').textContent = ms;
    $('over-tip').textContent = tp;
  }
  $('over-score').textContent = `本次成绩：${pendingScore} 行代码`;
  try { $('name-input').value = localStorage.getItem(NAME_KEY) || ('吗喽' + (10 + Math.floor(Math.random() * 90))); } catch (e) {}
  saved = false;
  $('btn-save').disabled = false;
  $('btn-save').textContent = '上排行榜';
  $('over-save').classList.toggle('hidden', DEMO);
  $('lb-over').innerHTML = lbHTML(loadLB(), lastEntryTs);
  $('screen-over').classList.remove('hidden');
  if (!DEMO) $('name-input').focus();
  if (!DEMO && window.linx) window.linx.speakResult(overSpeech());
  if (DEMO) setTimeout(() => { if (mode === 'over') resetRun(); }, 4000);
}

// 读给灵矽的口播稿：和结算页同一套文案，只把不好念的词换成说法
function overSpeech() {
  const title = $('over-title').textContent;
  const score = $('over-score').textContent;
  const msg = $('over-msg').textContent
    .replace(/NullPointerException/g, '空指针异常')
    .replace(/404/g, '四零四')
    .replace(/P0/g, 'P零');
  const tip = $('over-tip').textContent;
  return [title, score, msg, tip].filter(Boolean).join('。');
}

function doSave() {
  if (saved) return -1;
  const name = $('name-input').value.trim() || '匿名吗喽';
  try { localStorage.setItem(NAME_KEY, name); } catch (e) {}
  const rank = addScore(name, pendingScore);
  lastEntryTs = Date.now();
  saved = true;
  $('btn-save').disabled = true;
  $('btn-save').textContent = '已上榜 ✓';
  $('lb-over').innerHTML = lbHTML(loadLB(), lastEntryTs);
  $('name-input').blur(); // 让 Enter 重开不再被输入框拦下
  return rank;
}
$('btn-save').addEventListener('click', doSave);
$('name-input').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') doSave(); });
$('btn-retry').addEventListener('click', () => { if (mode === 'over') resetRun(); });

/* ================= 麦克风流程 ================= */
async function startMic() {
  SFX.ensure();
  const btn = $('btn-mic');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = '🎤 正在开启麦克风…';
  $('mic-error').classList.add('hidden');
  try {
    // 权限弹窗被忽略时会一直挂起，8 秒无响应就提示去看弹窗
    await Promise.race([
      voice.start(),
      sleep(8000).then(() => { throw new Error('8 秒内没有响应——请检查浏览器顶部的麦克风权限弹窗'); }),
    ]);
  } catch (err) {
    const why = err && err.name === 'NotAllowedError'
      ? '麦克风权限被拒绝：请在地址栏允许麦克风后刷新页面'
      : (err && err.message) || '未知错误';
    $('mic-error').textContent = '麦克风开启失败：' + why + '。可先用键盘模式试玩。';
    $('mic-error').classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = '🎤 开麦上班';
    return;
  }
  btn.textContent = '🎤 麦克风已就绪';
  $('meter-box').classList.remove('hidden');
  $('calib-tip').classList.remove('hidden');
  mode = 'calib';
  await voice.calibrate(1600);
  $('calib-tip').textContent = '✅ 校准完成！试着一嗓子——冲进红区就会起跳，马上开始…';
  mode = 'ready';
  await sleep(3000);
  resetRun();
}
$('btn-mic').addEventListener('click', startMic);

$('btn-keyboard').addEventListener('click', () => {
  SFX.ensure();
  resetRun(); // 不开麦，直接用空格模拟喊声
});

$('sens').addEventListener('input', (e) => {
  voice.sens = parseFloat(e.target.value);
  $('sens-val').textContent = voice.sens.toFixed(1);
});

function updateMeterDOM() {
  if (!voice.active) return;
  const maxV = voice.Tjump * 1.7;
  $('meter-fill').style.width = clamp(voice.level / maxV * 100, 0, 100) + '%';
  $('mark-jump').style.left = (100 / 1.7) + '%';
}

/* ================= 游戏主逻辑 ================= */
function handleJump(vol, dt) {
  jumpCd = Math.max(0, jumpCd - dt);
  jumpBuf = Math.max(0, jumpBuf - dt);
  let want = 0;
  if (keyJump) { want = 1; keyJump = false; } // ↑ 等效满力度喊声
  else if (vol > voice.Tjump) want = clamp((vol - voice.Tjump) / 0.12, 0, 1); // 喊得越响跳得越高
  if (want > 0 && jumpCd <= 0) {
    jumpCd = 0.3;
    if (player.grounded && countdown <= 0) {
      player.vy = -(JUMP_V_MIN + (JUMP_V_MAX - JUMP_V_MIN) * want);
      player.grounded = false;
      jumpBuf = 0;
      SFX.jump();
    } else {
      jumpBuf = 0.12; // 落地前 0.12s 内的喊声会被缓存，落地立刻起跳
    }
  }
  if (jumpBuf > 0 && player.grounded && countdown <= 0) {
    player.vy = -JUMP_V_MIN;
    player.grounded = false;
    jumpBuf = 0;
    SFX.jump();
  }
}

function step(dt) {
  shake = Math.max(0, shake - dt * 1.4);
  goFlash = Math.max(0, goFlash - dt);
  if (deadInfo || winInfo) return; // 定格画面，等结算面板

  if (countdown > 0) {
    const prev = Math.ceil(countdown);
    countdown -= dt;
    const now = Math.ceil(countdown);
    if (now !== prev && now > 0) SFX.tick();
    if (countdown <= 0) { goFlash = 0.7; SFX.go(); }
    return;
  }

  spaceHoldT = spaceHeld ? spaceHoldT + dt : 0;
  const vol = currentVol(dt);
  lastVol = vol;
  if (spaceHeld) lastVol = Math.max(lastVol, Math.min(0.45, spaceHoldT * 1.2)); // 蓄力时音量条同步上升
  handleJump(vol, dt);
  spaceReleaseVol = 0; // 喊声是瞬时脉冲，只作用于这一帧

  // 吗喽自动匀速上班，音量只影响跳跃
  speed = AUTO_V;
  dist += speed * dt;
  camX = dist;
  player.x = PLAYER_X + dist; // 玩家世界坐标前进，屏幕位置保持固定

  // 竖直物理
  player.vy += GRAVITY * dt;
  player.y += player.vy * dt;
  const overPit = isOverPit();
  if (!overPit && player.y >= GROUND && player.vy >= 0) {
    if (!player.grounded && player.vy > 400) SFX.land();
    player.y = GROUND;
    player.vy = 0;
    player.grounded = true;
  } else {
    player.grounded = false;
  }
  if (player.y - PLAYER_H > H + 80) { die({ type: 'pit' }); return; }

  // 障碍推进 + 碰撞
  fillObstacles();
  for (const o of obstacles) {
    if (o.type === 'paper') o.x -= 130 * dt;
    if (o.type !== 'pit' && aabb(playerBox(10), obBox(o, 8))) { die(o); return; }
  }
  obstacles = obstacles.filter((o) => o.x + (o.w || 0) > camX - 240);

  if (dist >= GOAL_DIST) winRun();
}

/* ================= 渲染 ================= */
function draw() {
  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake * 26, (Math.random() - 0.5) * shake * 26);

  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#0d1631');
  sky.addColorStop(0.55, '#22345f');
  sky.addColorStop(1, '#3a517f');
  ctx.fillStyle = sky;
  ctx.fillRect(-40, -40, W + 80, H + 80);

  drawClouds();
  drawBuildings();
  drawGround();
  drawObstacles();
  drawGoal();
  drawPlayer();

  ctx.restore();

  if (mode === 'play') drawHUD();
  if (mode === 'play' && countdown > 0) drawCountdown();
  if (mode === 'play' && goFlash > 0) drawGo();
}

function drawClouds() {
  const par = 0.12, tile = 340;
  const off = camX * par;
  ctx.font = '54px ' + EMOJI_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = Math.floor(off / tile) - 1; i * tile - off < W + 240; i++) {
    ctx.globalAlpha = 0.5;
    ctx.fillText('☁️', i * tile - off + hash(i) * 120, 80 + hash(i * 3 + 7) * 140);
  }
  ctx.globalAlpha = 1;
}

function drawBuildings() {
  const par = 0.3, tile = 230;
  const off = camX * par;
  for (let i = Math.floor(off / tile) - 1; i * tile - off < W + 40; i++) {
    const bx = i * tile - off;
    const bh = 120 + hash(i * 7 + 1) * 190;
    const bw = 130 + hash(i * 11 + 2) * 70;
    const by = GROUND - bh;
    ctx.fillStyle = '#141f3d';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#0e1730';
    ctx.fillRect(bx + bw * 0.4, by - 26, 8, 26);
    for (let wy = by + 18; wy < GROUND - 24; wy += 30) {
      for (let wx = bx + 14; wx < bx + bw - 18; wx += 26) {
        ctx.fillStyle = hash(i * 131 + wx * 0.7 + wy * 1.3) > 0.72 ? 'rgba(255,214,110,.75)' : 'rgba(90,120,200,.14)';
        ctx.fillRect(wx, wy, 12, 14);
      }
    }
  }
}

function drawGround() {
  const pits = obstacles.filter((o) => o.type === 'pit');
  let segs = [[camX - 60, camX + W + 60]];
  for (const p of pits) {
    const out = [];
    for (const [a, b] of segs) {
      if (p.x > b || p.x + p.w < a) { out.push([a, b]); continue; }
      if (p.x > a) out.push([a, p.x]);
      if (p.x + p.w < b) out.push([p.x + p.w, b]);
    }
    segs = out;
  }
  for (const [a, b] of segs) {
    const sa = a - camX, sb = b - camX;
    ctx.fillStyle = '#253d2c';
    ctx.fillRect(sa, GROUND, sb - sa, H - GROUND);
    ctx.fillStyle = '#3f7a4a';
    ctx.fillRect(sa, GROUND, sb - sa, 12);
    ctx.fillStyle = 'rgba(255,255,255,.05)';
    for (let wx = Math.ceil(a / 46) * 46; wx < b; wx += 46) ctx.fillRect(wx - camX, GROUND + 30, 22, 4);
  }
  for (const p of pits) {
    const sx = p.x - camX;
    ctx.fillStyle = '#05070d';
    ctx.fillRect(sx, GROUND, p.w, H - GROUND);
    ctx.font = '600 17px system-ui';
    ctx.fillStyle = '#ff7a7a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('⚠️ 技术债', sx + p.w / 2, GROUND - 12);
  }
}

function drawObstacles() {
  for (const o of obstacles) {
    if (o.type === 'pit') continue;
    const sx = o.x - camX;
    if (sx > W + 120 || sx + o.w < -120) continue;
    const y = o.type === 'paper' ? o.top + Math.sin(tNow * 3 + o.x * 0.01) * 7 : GROUND - o.h;

    if (o.type !== 'paper') {
      ctx.fillStyle = 'rgba(0,0,0,.3)';
      ctx.beginPath();
      ctx.ellipse(sx + o.w / 2, GROUND + 8, o.w * 0.55, 7, 0, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 0.96;
    rr(sx, y, o.w, o.h, 10);
    ctx.fillStyle = o.color;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.font = '30px ' + EMOJI_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(o.e, sx + o.w / 2, y + o.h / 2 + 1);

    ctx.font = '600 14px system-ui';
    const tw = ctx.measureText(o.label).width + 14;
    ctx.fillStyle = 'rgba(8,12,26,.8)';
    rr(sx + o.w / 2 - tw / 2, y - 26, tw, 20, 7);
    ctx.fill();
    ctx.fillStyle = '#ffe9a8';
    ctx.fillText(o.label, sx + o.w / 2, y - 16);
  }
}

function drawGoal() {
  const sx = GOAL_DIST - camX;
  if (sx < -100 || sx > W + 200) return;
  ctx.strokeStyle = 'rgba(255,255,255,.55)';
  ctx.lineWidth = 3;
  ctx.setLineDash([14, 12]);
  ctx.beginPath();
  ctx.moveTo(sx, 140);
  ctx.lineTo(sx, GROUND);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '46px ' + EMOJI_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('🏁', sx, GROUND - 56);
  ctx.font = '700 18px system-ui';
  ctx.fillStyle = '#ffe9a8';
  ctx.fillText('成功上线', sx, GROUND - 76);
}

function drawPlayer() {
  const sx = player.x - camX;
  const airH = GROUND - player.y;

  ctx.fillStyle = 'rgba(0,0,0,.35)';
  const sh = clamp(1 - airH / 260, 0.25, 1);
  ctx.beginPath();
  ctx.ellipse(sx, GROUND + 8, 30 * sh, 7 * sh, 0, 0, 7);
  ctx.fill();

  if (speed > 280 && !deadInfo) {
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      const ly = player.y - 58 + i * 22;
      const len = 34 + hash(Math.floor(tNow * 14) + i) * 26;
      ctx.beginPath();
      ctx.moveTo(sx - 52, ly);
      ctx.lineTo(sx - 52 - len, ly);
      ctx.stroke();
    }
  }

  const shouting = lastVol > voice.Tjump;
  const face = deadInfo ? '💀' : winInfo ? '🥳' : shouting ? '😡' : '🐵';
  ctx.font = '62px ' + EMOJI_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(face, sx, player.y - 8);
}

function hudPill(x, y, text, size, color) {
  ctx.font = `700 ${size}px system-ui`;
  const w = ctx.measureText(text).width + 34;
  ctx.fillStyle = 'rgba(10,16,34,.75)';
  rr(x, y, w, 46, 12);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, y + 24);
}

function drawVolMeter(x, y, w, h) {
  const maxV = voice.Tjump * 1.7;
  ctx.fillStyle = 'rgba(10,16,34,.75)';
  rr(x - 8, y - 6, w + 16, h + 30, 12);
  ctx.fill();
  const jx = w / 1.7;
  ctx.fillStyle = 'rgba(255,255,255,.10)';
  rr(x, y, w, h, 7);
  ctx.fill();
  ctx.fillStyle = 'rgba(229,72,77,.32)';
  ctx.fillRect(x + jx, y, w - jx, h);
  const fw = w * clamp(lastVol / maxV, 0, 1);
  ctx.fillStyle = lastVol >= voice.Tjump ? '#ff6b6b' : 'rgba(255,255,255,.6)';
  rr(x, y, Math.max(fw, 4), h, 7);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.fillRect(x + jx - 1, y - 3, 2, h + 6);
  ctx.font = '600 13px system-ui';
  ctx.fillStyle = 'rgba(220,230,255,.7)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('🎤 音量', x, y + h + 18);
  ctx.textAlign = 'right';
  ctx.fillText('🦘 跳', x + w, y + h + 18);
}

function drawHUD() {
  hudPill(24, 20, `📋 ${curScore()} 行代码`, 22, '#ffd34d');

  const px = 330, pw = 440, py = 32, ph = 16;
  ctx.fillStyle = 'rgba(10,16,34,.75)';
  rr(px - 6, py - 6, pw + 12, ph + 12, 12);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.14)';
  rr(px, py, pw, ph, 8);
  ctx.fill();
  const pr = clamp(dist / GOAL_DIST, 0, 1);
  if (pr > 0) {
    ctx.fillStyle = '#58c16b';
    rr(px, py, Math.max(10, pw * pr), ph, 8);
    ctx.fill();
  }
  ctx.font = '16px ' + EMOJI_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('🐵', px + pw * pr, py + ph / 2);
  ctx.fillText('🏁', px + pw + 16, py + ph / 2);
  ctx.font = '600 15px system-ui';
  ctx.fillStyle = '#cdd8ff';
  ctx.fillText(`上线进度 ${Math.floor(pr * 100)}%`, px + pw / 2, py + ph + 20);

  drawVolMeter(W - 324, 20, 300, 26);

  ctx.font = '500 14px system-ui';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(220,230,255,.55)';
  const hint = DEMO ? '演示模式：吗喽自动玩' : '😱 大喊起跳（越响越高） · 空格按住蓄力/松开起跳';
  ctx.fillText(hint + ' · F 全屏 · M 音效' + (muted ? ' 🔇' : ''), W - 24, H - 22);
}

function bigCenter(text, color) {
  ctx.fillStyle = 'rgba(5,8,18,.5)';
  ctx.fillRect(0, H / 2 - 90, W, 180);
  ctx.font = '900 110px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, W / 2, H / 2);
}
function drawCountdown() {
  const n = Math.ceil(countdown);
  if (n > 0) bigCenter(String(n), '#ffd34d');
}
function drawGo() {
  bigCenter('上号！🚀', '#6be08a');
}

/* ================= 主循环 & 启动 ================= */
let lastTs = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  const dt = clamp((ts - lastTs) / 1000, 0, 0.033);
  lastTs = ts;
  tNow = ts / 1000;
  if ((mode === 'menu' || mode === 'calib' || mode === 'ready') && voice.active) {
    voice.update();
    updateMeterDOM();
  }
  if (mode === 'play') step(dt);
  draw();
}
requestAnimationFrame(frame);

/* ================= 对外接口（linx.js 语音助手把它们注册成 MCP 工具） ================= */
window.Game = {
  get mode() { return mode; },
  status() {
    return {
      screen: mode, // menu 主页 | calib/ready 开麦校准中 | play 对局中 | over 结算
      score: mode === 'over' ? pendingScore : curScore(),
      goal: 1000,
      result: mode !== 'over' ? null : winInfo ? '上线成功' : (DEATHS[deathKey(deadInfo)] || DEATHS.pit)[1],
      sensitivity: voice.sens,
      sound: !muted,
      mic: voice.active,
      leaderboard: loadLB().slice(0, 5).map((e) => ({ name: e.name, score: e.score })),
    };
  },
  start() {
    if (mode === 'play') return '已经在对局中了';
    if (mode === 'calib' || mode === 'ready') return '正在开麦校准，马上自动开局';
    if (voice.active || DEMO) { resetRun(); return '开局倒计时开始'; }
    startMic();
    return '正在开麦：先安静 2 秒校准环境噪音，然后自动开局';
  },
  backToMenu() {
    if (mode !== 'over') return '只有结算界面才能回主页，当前界面：' + mode;
    toMenu();
    return '已回到主页';
  },
  setSensitivity(v) {
    v = clamp(Math.round(Number(v) * 10) / 10 || 1, 0.6, 1.8);
    voice.sens = v;
    $('sens').value = v;
    $('sens-val').textContent = v.toFixed(1);
    return `灵敏度已设为 ${v.toFixed(1)}`;
  },
  setSound(on) {
    muted = !on;
    return on ? '音效已打开' : '音效已关闭';
  },
  saveScore(name) {
    if (mode !== 'over' || DEMO) return '只有结算界面才能上排行榜';
    if (saved) return '本局成绩已经上过榜了';
    if (name) $('name-input').value = String(name).trim().slice(0, 8);
    const rank = doSave();
    return rank < 10 ? `已上榜，排第 ${rank + 1} 名，${pendingScore} 行代码` : `已记录，${pendingScore} 行代码，可惜没进前十`;
  },
};

toMenu();
if (DEMO) resetRun(); // demo 走声控路径（demoVol），不启用键盘分支
