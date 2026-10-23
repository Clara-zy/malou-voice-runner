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
let jumpCd = 0, jumpBuf = 0, keyJump = false, spaceHeld = false, spaceHoldT = 0;
let touchHeld = false, touchHoldT = 0, touchId = null;
let shoutT = 0, shoutVol = 0; // 松手后的喊声包络：持续一小段时间，期间可给发疯值充电
let armT = 0, armPeak = 0, armTotal = 0, pendingVol = 0; // 麦克风抓峰：过阈值后短窗抓峰值再起跳
let surge = 0; // 大声跳的前冲加速（随时间衰减）
let pendingScore = 0, saved = false;

/* 计分与连躲 */
let lineBase = 0, bonusPts = 0, combo = 0, maxCombo = 0;
/* 发疯值 */
let madness = 0, berserkT = 0, madCd = 0, madFrozen = false, madFlash = 0, madCount = 0, sprintDone = false;
/* 道具与粒子 */
let pickups = [], particles = [], floaties = [];

const curScore = () => Math.min(SCORE.CAP, Math.floor(lineBase) + bonusPts);

/* 速度：难度曲线 300→380 + 终点冲刺 + 发疯加成 + 大声跳的前冲 */
function speedFor() {
  const prog = clamp(dist / GOAL_DIST, 0, 1);
  let v = AUTO_V_START + (AUTO_V_END - AUTO_V_START) * prog;
  if (prog >= SPRINT_FROM) v += SPRINT_BONUS;
  if (berserkT > 0) v *= MAD.SPEED_MUL;
  return v + surge;
}

/* 粒子与浮动文字 */
function spawnBurst(x, y, colors, n, spd = 260, g = 900) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = spd * (0.4 + Math.random() * 0.8);
    particles.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 120, g,
      life: 0.5 + Math.random() * 0.4, max: 0.9, size: 3 + Math.random() * 4,
      color: colors[i % colors.length],
    });
  }
}
function textPop(x, y, str, color = '#ffe9a8', size = 20) {
  floaties.push({ x, y, vy: -70, life: 1.0, max: 1.0, str, color, size });
}
function updateParticles(dt) {
  for (const p of particles) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.g * dt; }
  particles = particles.filter((p) => p.life > 0);
  for (const f of floaties) { f.life -= dt; f.y += f.vy * dt; }
  floaties = floaties.filter((f) => f.life > 0);
}

/* 躲过障碍：连躲计分 */
function addDodge(o) {
  combo++;
  maxCombo = Math.max(maxCombo, combo);
  let pts = SCORE.DODGE_BASE + Math.min(combo, SCORE.COMBO_CAP) * SCORE.DODGE_PER_COMBO;
  if (o.type === 'paper') {
    pts *= SCORE.PLANE_MULT;
    textPop(player.x, GROUND - 260, '躲过需求变更 x2!', '#ffd34d');
  }
  bonusPts += pts;
  if (combo >= 2 && combo % 5 === 0) textPop(player.x, GROUND - 300, `连躲 x${combo}! 🔥`, '#ffd34d', 26);
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
  if (document.activeElement === $('name-input')) return; // 输花名时不响应任何游戏快捷键（含 F/M）
  if (k === 'f' || k === 'F') {
    if (document.fullscreenElement) document.exitFullscreen && document.exitFullscreen();
    else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
    return;
  }
  if (k === 'm' || k === 'M') { muted = !muted; return; }
  if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) e.preventDefault();
  if (mode === 'over') {
    if (k === 'Enter') { if (mode === 'over') resetRun(); }
    else if (k === 'Escape') toMenu();
    return;
  }
  if (mode === 'calib' || mode === 'ready') {
    if (k === 'Escape') toMenu(); // 校准等不下去了也能退出（流程令牌会自动作废）
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
    triggerShout(spaceHoldT); // 松开瞬间喊出来：力度=蓄力深度，持续时长≈蓄力时长
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
    triggerShout(touchHoldT);
    touchHoldT = 0;
  }
}
addEventListener('pointerup', endTouch);
addEventListener('pointercancel', endTouch);
stageEl.addEventListener('contextmenu', (e) => e.preventDefault()); // 长按别弹菜单

/* 喊声包络：蓄得越久喊得越响（chargeVol）、也喊得越久（发疯值按时间充电）
 * 最短按 0.06s 兜底：亚帧极速轻点也至少是一次小跳，不会完全不跳 */
function triggerShout(t) {
  t = Math.max(t, 0.06);
  shoutVol = chargeVol(t);
  shoutT = 0.15 + t * 1.2;
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
    // 触发距离按当前速度等比缩放：提速后提前量也要加大
    const sc = speed / AUTO_V_START;
    const trig = (n.o.type === 'bug' ? 80 : n.o.type === 'blocker' ? 100 : 30) * sc;
    if (n.nd <= trig) { demoPulse = 0.09; return 0.3; }            // 喊一嗓子
  }
  return 0;                                                         // 平时安静
}

/* ================= 流程 ================= */
function resetRun() {
  dist = 0; camX = 0; speed = 0; lastVol = 0;
  obstacles = []; spawnX = 1000; pickups = [];
  particles = []; floaties = [];
  player.x = PLAYER_X;
  player.y = GROUND; player.vy = 0; player.grounded = true;
  countdown = 2.4; goFlash = 0;
  deadInfo = null; winInfo = false; shake = 0;
  jumpCd = 0; jumpBuf = 0; demoPulse = 0; spaceHoldT = 0;
  touchHeld = false; touchHoldT = 0; touchId = null; shoutT = 0; shoutVol = 0;
  armT = 0; armPeak = 0; armTotal = 0; pendingVol = 0; surge = 0;
  lineBase = 0; bonusPts = 0; combo = 0; maxCombo = 0;
  madness = 0; berserkT = 0; madCd = 0; madFrozen = false; madFlash = 0; madCount = 0; sprintDone = false;
  pendingScore = 0; saved = false;
  mode = 'play';
  Music.start();
  $('screen-over').classList.add('hidden');
  $('screen-start').classList.add('hidden');
}

function toMenu() {
  mode = 'menu';
  Music.stop();
  resetMicUI(); // 复位开麦按钮/音量条，支持「Esc 回来 → 重新校准」
  $('screen-over').classList.add('hidden');
  $('screen-start').classList.remove('hidden');
  lbRefreshStart();
}

function die(o) {
  if (deadInfo || winInfo) return;
  deadInfo = o; shake = 0.5;
  window.__lastDeath = { label: o.label || o.type, dist: Math.round(dist), speed: Math.round(speed), px: Math.round(player.x), py: Math.round(player.y), vy: Math.round(player.vy), ox: Math.round(o.x || 0), ow: Math.round(o.w || 0), vol: +lastVol.toFixed(3) };
  spawnBurst(player.x, player.y - 40, ['#ff6b6b', '#ffb020', '#ffffff'], 20, 340);
  textPop(player.x, player.y - 140, '💥', '#ff6b6b', 44);
  navigator.vibrate && navigator.vibrate([120, 60, 160]);
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

/* ================= 跳跃 =================
 * 力度 V 的映射按「起跳线→满力线」的个人动态区间（voice.fullVol）线性取值，
 * 空格/触摸/↑传入的合成喊声自带力度；麦克风路径由 step 里的抓峰逻辑产出 pendingVol。 */
function handleJump(V, dt) {
  jumpCd = Math.max(0, jumpCd - dt);
  jumpBuf = Math.max(0, jumpBuf - dt);
  let want = 0;
  if (keyJump) { want = 1; keyJump = false; } // ↑ 等效满力度喊声
  else if (V > voice.Tjump) want = clamp((V - voice.Tjump) / Math.max(0.02, voice.fullVol - voice.Tjump), 0, 1);
  if (want > 0 && jumpCd <= 0) {
    jumpCd = 0.3;
    if (player.grounded && countdown <= 0) {
      player.vy = -(JUMP_V_MIN + (JUMP_V_MAX - JUMP_V_MIN) * want);
      player.grounded = false;
      jumpBuf = 0;
      surge = SURGE_MAX * want; // 越是大声跳，前冲越猛 → 跳得明显更远
      spawnBurst(player.x, GROUND - 6, ['#cdd8ff', '#8fa0d8'], 6, 140, 600);
      SFX.jump();
    } else {
      jumpBuf = 0.12; // 落地前 0.12s 内的喊声会被缓存，落地立刻起跳
    }
  }
  if (jumpBuf > 0 && player.grounded && countdown <= 0) {
    player.vy = -JUMP_V_MIN;
    player.grounded = false;
    jumpBuf = 0;
    spawnBurst(player.x, GROUND - 6, ['#cdd8ff', '#8fa0d8'], 6, 140, 600);
    SFX.jump();
  }
}

/* ================= 主逻辑 ================= */
function step(dt) {
  shake = Math.max(0, shake - dt * 1.4);
  goFlash = Math.max(0, goFlash - dt);
  madFlash = Math.max(0, madFlash - dt);
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
  shoutT = Math.max(0, shoutT - dt);
  surge = Math.max(0, surge - SURGE_DECAY * dt);

  // —— 音量管线：麦克风音量（走抓峰）与合成喊声包络（自带力度）分开算 ——
  const micVol = DEMO ? demoVol(dt) : (voice.active ? voice.update() : 0);
  const synthVol = shoutT > 0 ? shoutVol * clamp(shoutT / 0.2, 0, 1) : 0;

  // 抓峰：过阈值不立刻跳，短窗跟踪这口气的峰值，按峰值算力度。
  // 否则力度被锁死在"刚过阈值的那一帧"（≈最小力），渐强喊声永远跳不高。
  // 快喊 80ms 内出结果；还在爬升就续窗（总长封顶 120ms），慢起音也能抓到接近真实的峰。
  if (armT > 0) {
    armT -= dt; armTotal += dt;
    if (micVol > armPeak) {
      armPeak = micVol;
      if (armTotal < 0.12) armT = Math.max(armT, 0.03);
    }
    if (armT <= 0 || armTotal >= 0.12 || micVol < armPeak * 0.85) { // 窗口到期 / 封顶 / 峰值已过
      pendingVol = armPeak;
      armT = 0; armTotal = 0;
    }
  } else if (micVol > voice.Tjump && jumpCd <= 0) {
    armT = 0.08;
    armPeak = micVol;
    armTotal = 0;
  }

  const vol = Math.max(micVol, synthVol, pendingVol);
  lastVol = vol;
  // 蓄力时音量条同步上升（还没到喊出来的程度）
  const holdT = spaceHeld ? spaceHoldT : touchHeld ? touchHoldT : 0;
  if (holdT > 0) lastVol = Math.max(lastVol, voice.Tjump * 1.6 * Math.min(1, holdT / CHARGE_FULL_T));
  handleJump(vol, dt);
  pendingVol = 0; // 抓峰产出只作用于这一帧

  // ===== 发疯值：喊=充电，安静=衰减，纸飞机靠近=冻结（闭嘴区规则） =====
  madFrozen = obstacles.some((o) => o.type === 'paper' && Math.abs(o.x + o.w / 2 - player.x) < MAD.FREEZE_DIST);
  if (madCd > 0) madCd -= dt;
  if (berserkT > 0) {
    berserkT -= dt;
    if (berserkT <= 0) { madness = 0; madCd = MAD.COOLDOWN; }
  } else if (madCd <= 0) {
    if (!madFrozen) {
      if (vol >= voice.Tjump) madness = Math.min(100, madness + MAD.RATE * dt);
      else madness = Math.max(0, madness - MAD.DECAY * dt);
    }
    if (madness >= 100) {
      berserkT = MAD.BERSERK_T; madCount++; madFlash = 1.2;
      textPop(player.x, GROUND - 290, '😤 发疯写码!!', '#ff6b6b', 30);
      navigator.vibrate && navigator.vibrate(80);
      SFX.mad();
    }
  }

  // ===== 前进：难度曲线 + 冲刺段 + 发疯加成；发疯期间写码双倍 =====
  speed = speedFor();
  dist += speed * dt;
  lineBase += (speed * dt / SCORE.PX_PER_LINE) * (berserkT > 0 ? MAD.SCORE_MUL : 1);
  camX = dist;
  player.x = PLAYER_X + dist; // 玩家世界坐标前进，屏幕位置保持固定
  const prog = dist / GOAL_DIST;
  if (!sprintDone && prog >= SPRINT_FROM) {
    sprintDone = true;
    textPop(player.x, GROUND - 300, '🚀 上线冲刺!', '#6be08a', 28);
  }
  Music.rate = 1 + 0.15 * clamp(prog, 0, 1) + (berserkT > 0 ? 0.25 : 0) + (sprintDone ? 0.1 : 0);

  // ===== 竖直物理 =====
  player.vy += GRAVITY * dt;
  player.y += player.vy * dt;
  const overPit = isOverPit();
  if (!overPit && player.y >= GROUND && player.vy >= 0) {
    if (!player.grounded && player.vy > 400) {
      SFX.land();
      spawnBurst(player.x, GROUND - 4, ['#cdd8ff', '#8fa0d8', '#5a7bc9'], 9, 170, 700);
    }
    player.y = GROUND;
    player.vy = 0;
    player.grounded = true;
  } else {
    player.grounded = false;
  }
  if (player.y - PLAYER_H > H + 80) { die({ type: 'pit' }); return; }

  // ===== 障碍推进 + 碰撞（发疯状态可捶爆地面障碍，纸飞机/深坑依然致命） =====
  fillObstacles();
  for (const o of obstacles) {
    if (o.type === 'paper') o.x -= 130 * dt;
    if (o.dead || o.type === 'pit') continue;
    if (aabb(playerBox(10), obBox(o, 8))) {
      if (berserkT > 0 && o.type !== 'paper') {
        o.dead = true;
        bonusPts += SCORE.DESTROY;
        spawnBurst(o.x + o.w / 2, GROUND - o.h / 2, ['#ff6b6b', '#ffb020', '#ffffff'], 18, 320);
        textPop(o.x, GROUND - o.h - 40, `👊 捶爆! +${SCORE.DESTROY}`, '#ff9a3d', 22);
        shake = Math.max(shake, 0.25);
        SFX.destroy();
      } else { die(o); return; }
    }
  }

  // ===== 连躲计分：障碍（或纸飞机）被甩到身后即算躲过 =====
  for (const o of obstacles) {
    if (!o.counted && !o.dead) {
      const behind = o.type === 'paper' ? o.x + o.w < player.x - 40 : o.x + o.w < player.x - PLAYER_W / 2 - 6;
      if (behind) { o.counted = true; addDodge(o); }
    }
  }
  obstacles = obstacles.filter((o) => !o.dead && o.x + (o.w || 0) > camX - 240);

  // ===== 道具收集 =====
  for (const p of pickups) {
    if (!p.taken && aabb(playerBox(4), { x: p.x - 22, y: p.y - 22, w: 44, h: 44 })) {
      p.taken = true;
      const pts = p.type === 'boba' ? PICK.BOBA_PTS : PICK.COFFEE_PTS;
      bonusPts += pts;
      spawnBurst(p.x, p.y, ['#ffd34d', '#fff1b8'], 10, 200, 500);
      textPop(p.x, p.y - 24, `+${pts}行`, '#ffd34d');
      SFX.pickup();
    }
  }
  pickups = pickups.filter((p) => !p.taken && p.x > camX - 200);

  updateParticles(dt);
  if (dist >= GOAL_DIST) winRun();
}
