'use strict';

/* ================= 游戏状态 ================= */
const voice = new VoiceInput();
let mode = 'menu';            // menu | calib | ready | play | over
let muted = false;

const player = { x: PLAYER_X, y: GROUND, vy: 0, grounded: true };
let dist = 0, camX = 0, speed = 0, tNow = 0, lastVol = 0;
let obstacles = [], spawnX = 1000;
let countdown = 0, goFlash = 0;
let deadInfo = null, winInfo = false, shake = 0;
let jumpCd = 0, jumpBuf = 0, keyJump = false, spaceHeld = false, spaceHoldT = 0, spaceReleaseVol = 0;
let touchHeld = false, touchHoldT = 0, touchReleaseVol = 0, touchId = null;
let pendingScore = 0, saved = false;

const curScore = () => Math.min(1000, Math.floor(dist / 12));

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
    spaceReleaseVol = chargeVol(spaceHoldT); // 松开瞬间：把蓄的力当成一次喊声
    spaceHoldT = 0;
  }
});

/* 触摸/鼠标：按住画布蓄力，松开起跳（与空格同一套蓄力模型，手机可玩） */
const stageEl = $('stage');
stageEl.addEventListener('pointerdown', (e) => {
  if (mode !== 'play' || deadInfo || winInfo) return;
  if (e.target.closest && e.target.closest('.overlay')) return; // 面板按钮不触发蓄力
  e.preventDefault();
  if (touchId !== null) return; // 只认第一根手指
  touchId = e.pointerId;
  touchHeld = true;
});
function endTouch(e) {
  if (e.pointerId !== touchId) return;
  touchId = null;
  if (touchHeld) {
    touchHeld = false;
    touchReleaseVol = chargeVol(touchHoldT);
    touchHoldT = 0;
  }
}
addEventListener('pointerup', endTouch);
addEventListener('pointercancel', endTouch);
stageEl.addEventListener('contextmenu', (e) => e.preventDefault()); // 长按别弹菜单

function currentVol(dt) {
  if (DEMO) return demoVol(dt);
  let v = voice.active ? voice.update() : 0;
  v = Math.max(v, spaceReleaseVol, touchReleaseVol); // 松开空格/手指那一帧的喊声脉冲
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
  touchHeld = false; touchHoldT = 0; touchReleaseVol = 0; touchId = null;
  pendingScore = 0; saved = false;
  mode = 'play';
  $('screen-over').classList.add('hidden');
  $('screen-start').classList.add('hidden');
}

function toMenu() {
  mode = 'menu';
  $('screen-over').classList.add('hidden');
  $('screen-start').classList.remove('hidden');
  lbRefreshStart();
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

/* ================= 跳跃 ================= */
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

/* ================= 主逻辑 ================= */
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
  touchHoldT = touchHeld ? touchHoldT + dt : 0;
  const vol = currentVol(dt);
  lastVol = vol;
  // 蓄力时音量条同步上升（还没到喊出来的程度）
  const holdT = spaceHeld ? spaceHoldT : touchHeld ? touchHoldT : 0;
  if (holdT > 0) lastVol = Math.max(lastVol, voice.Tjump * 1.6 * Math.min(1, holdT / CHARGE_FULL_T));
  handleJump(vol, dt);
  spaceReleaseVol = 0; touchReleaseVol = 0; // 喊声是瞬时脉冲，只作用于这一帧

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
