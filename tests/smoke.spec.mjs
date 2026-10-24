'use strict';
/**
 * 吗喽声控跑酷 · 冒烟测试
 *
 * 运行：
 *   cd tests && npm install && npm test
 *
 * 自带 HTTP 服务器（python3），无需外部依赖；已有服务器可用 BASE_URL 环境变量覆盖。
 * 断言基于游戏内部全局状态（dist/player/madness 等），不依赖像素截图，稳定且快。
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const BASE = process.env.BASE_URL || 'http://localhost:8123';
let server = null;

async function ensureServer() {
  if (process.env.BASE_URL) return;
  server = spawn('python3', ['-m', 'http.server', '8123'], { cwd: '..', stdio: 'ignore' });
  for (let i = 0; i < 20; i++) {
    await delay(250);
    try {
      const r = await fetch(BASE + '/index.html');
      if (r.ok) return;
    } catch (e) { /* retry */ }
  }
  throw new Error('本地服务器启动失败');
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  (' + detail + ')' : ''}`);
}

async function poll(page, fn, timeoutMs = 15000, everyMs = 250) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate(fn);
    if (last) return last;
    await delay(everyMs);
  }
  return last;
}

// 不开麦直接开局（首页已无键盘模式入口），对局中空格/触摸蓄力仍可模拟喊声
async function startKeyboardRun(page) {
  await page.goto(BASE + '/?nolinx');
  await page.evaluate(() => { SFX.ensure(); resetRun(); });
  // poll 到倒计时真正结束再返回（固定 sleep 在慢机上只有 400ms 余量）
  await poll(page, () => mode === 'play' && countdown <= 0, 6000, 100);
}

// 注入清场函数到页面：力度/道具类测量不被随机生成的障碍干扰
async function injectClearTrack(page) {
  await page.evaluate(() => {
    window.__clearTrack = () => {
      obstacles.length = 0;
      pickups.length = 0;
      spawnX = GOAL_DIST + 9999;
    };
  });
}

async function maxAirOf(page, holdMs) {
  return page.evaluate(async (ms) => {
    window.__clearTrack();
    window.__maxAir = 0;
    window.__rec = true;
    const tick = () => {
      window.__maxAir = Math.max(window.__maxAir, GROUND - player.y);
      if (window.__rec) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' })), ms);
    await new Promise((r) => setTimeout(r, ms + 900));
    window.__rec = false;
    return Math.round(window.__maxAir);
  }, holdMs);
}

async function main() {
  await ensureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  // ---- 1. demo 自动模式完整通关（难度曲线/计分/道具全链路） ----
  await page.goto(BASE + '/?demo&goal=2400');
  await page.waitForTimeout(1000);
  const win = await poll(page, () => ({
    over: document.getElementById('over-title').textContent,
    errs: window.__errlog,
    death: window.__lastDeath || null,
  }).over.includes('上线') ? { score: document.getElementById('over-score').textContent, death: window.__lastDeath || null } : null, 20000);
  check('demo 自动模式通关', !!win && !win.death, win ? win.score : '超时');
  check('demo 全程无 JS 错误', !errs.length && !(win && win.errs && win.errs.length), errs.join('; '));
  await page.waitForTimeout(4300); // 等 demo 自动重开

  // ---- 1b. 套路段（同步调用 step 快速模拟，固定随机种子，不依赖真实时间） ----
  await page.goto(BASE + '/?demo&nolinx');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.__seed = (seed) => {
      let s = (seed * 2654435761) >>> 0;
      Math.random = () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), s | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    window.__clearTrack = () => {
      obstacles.length = 0;
      pickups.length = 0;
      spawnX = GOAL_DIST + 9999;
    };
    // 把吗喽放到指定进度、清空赛道，返回可放置套路段的起点
    window.__placeAt = (prog) => {
      resetRun(); countdown = 0;
      dist = prog * GOAL_DIST; camX = dist; player.x = PLAYER_X + dist; speed = speedFor();
      window.__clearTrack();
      return player.x + 900;
    };
  });

  const unlock = await page.evaluate(() => {
    window.__seed(7);
    const first = {};
    let early = 0;
    for (let p = 0; p < 1; p += 0.01) {
      for (let k = 0; k < 200; k++) {
        const pat = pickPattern(p);
        if (!pat) continue;
        if (p < STAGES[1].from) early++;
        if (first[pat.id] === undefined) first[pat.id] = +p.toFixed(2);
      }
    }
    return { early, first };
  });
  const need = { bugChain: 0.15, highLow: 0.15, planeThen: 0.35, bobaPit: 0.35, doublePit: 0.65, wideGlide: 0.65 };
  check('套路段按阶段解锁', unlock.early === 0 && Object.keys(need).every((id) => unlock.first[id] !== undefined && unlock.first[id] >= need[id] - 1e-9),
    JSON.stringify(unlock.first));

  const patRuns = await page.evaluate(() => {
    const out = {};
    for (const pat of PATTERNS) {
      let pass = 0;
      for (let k = 0; k < 20; k++) {
        window.__seed(100 + k);
        const x0 = window.__placeAt(Math.min(STAGES[pat.stage].from + 0.02 + k * 0.025, 0.9));
        const end = pat.build(x0);
        for (let i = 0; i < 900 && !deadInfo && player.x < end + 200; i++) step(1 / 60);
        if (!deadInfo) pass++;
      }
      out[pat.id] = pass;
    }
    return out;
  });
  check('每种套路段演示 AI 各 ≥19/20 通过', Object.values(patRuns).every((n) => n >= 19), JSON.stringify(patRuns));

  const planeTrap = await page.evaluate(() => {
    const pat = PATTERNS.find((p) => p.id === 'planeThen');
    const labels = [];
    for (let k = 0; k < 10; k++) {
      window.__seed(300 + k);
      shield = 0; berserkT = 0; slackT = 0;
      pat.build(window.__placeAt(0.4 + k * 0.05));
      const plane = obstacles.find((o) => o.type === 'paper');
      for (let i = 0; i < 900 && plane.x + plane.w / 2 - player.x > 80; i++) step(1 / 60);
      // 直接塞到重叠位置，避免时序边界漏判
      plane.x = player.x - 10; plane.top = 500;
      player.y = GROUND; player.grounded = true; player.vy = 0;
      keyJump = true;
      for (let i = 0; i < 90 && !deadInfo; i++) step(1 / 60);
      labels.push(deadInfo ? deadInfo.label : 'alive');
    }
    return labels;
  });
  check('闭嘴后起跳：纸飞机在头顶时起跳必死', planeTrap.every((l) => l === '需求变更变更'), planeTrap.join(','));

  const fullRuns = await page.evaluate(() => {
    const deaths = {};
    let wins = 0;
    for (let seed = 1; seed <= 30; seed++) {
      window.__seed(seed);
      resetRun(); countdown = 0;
      for (let i = 0; i < 20000 && !deadInfo && !winInfo; i++) step(1 / 60);
      if (winInfo) wins++;
      else { const k = deadInfo ? deadInfo.label || deadInfo.type : 'timeout'; deaths[k] = (deaths[k] || 0) + 1; }
    }
    return { wins, deaths };
  });
  check('演示 AI 全程 30 局通关率 ≥ 28/30', fullRuns.wins >= 28, `${fullRuns.wins}/30 ${JSON.stringify(fullRuns.deaths)}`);

  // ---- 1b2. 长音滑翔：空中持续喊滞空更久；宽坑可过 / 不滑翔必掉 ----
  const glide = await page.evaluate(() => {
    // fullRuns 结束后 dist 在终点、winInfo 为真；不复位的话 step 会立刻再 winRun 然后冻住
    deadInfo = null; winInfo = false; mode = 'play'; countdown = 0;
    dist = 0.7 * GOAL_DIST; camX = dist; player.x = PLAYER_X + dist;
    const airFrames = (hold) => {
      window.__clearTrack();
      deadInfo = null; winInfo = false;
      player.y = GROUND; player.vy = 0; player.grounded = true; shoutT = 0; gliding = false;
      player.vy = -JUMP_V_MAX; player.grounded = false;
      let frames = 0, leftGround = false;
      for (let i = 0; i < 400; i++) {
        if (hold) { shoutVol = Math.max(voice.fullVol, voice.Tjump + 0.05); shoutT = 1; }
        else shoutT = 0;
        step(1 / 60);
        frames++;
        if (!player.grounded) leftGround = true;
        else if (leftGround) break;
      }
      return frames;
    };
    const withG = airFrames(true), noG = airFrames(false);

    // 宽坑：演示 AI（含滑翔）20 次
    let pass = 0;
    for (let k = 0; k < 20; k++) {
      window.__seed(500 + k);
      const x0 = window.__placeAt(0.7);
      const end = PATTERNS.find((p) => p.id === 'wideGlide').build(x0);
      // 启用 DEMO 音量路径：临时走 demoVol（placeAt 后 DEMO 仍为 URL 决定；用 slack 模拟持续滑翔不够）
      // 直接驱动：满力起跳 + 空中保持喊声
      for (let i = 0; i < 900 && !deadInfo && player.x < end + 200; i++) {
        const pit = obstacles.find((o) => o.type === 'pit');
        if (player.grounded && pit && pit.x - player.x < 100 && pit.x - player.x > 0) {
          shoutVol = voice.fullVol; shoutT = 0.5; // 起跳
        } else if (!player.grounded && pit && player.x < pit.x + pit.w) {
          shoutVol = voice.fullVol; shoutT = 1; // 滑翔
        }
        step(1 / 60);
      }
      if (!deadInfo) pass++;
    }

    // 反例：关掉演示 AI，贴沿满力起跳且空中不喊 → 掉坑
    window.__muteDemo = true;
    let falls = 0;
    for (let k = 0; k < 10; k++) {
      window.__seed(600 + k);
      const x0 = window.__placeAt(0.7);
      PATTERNS.find((p) => p.id === 'wideGlide').build(x0);
      let jumped = false;
      for (let i = 0; i < 500 && !deadInfo; i++) {
        const pit = obstacles.find((o) => o.type === 'pit');
        if (!jumped && player.grounded && pit && pit.x - player.x < 50 && pit.x - player.x > 0) {
          shoutVol = voice.fullVol; shoutT = 0.12; jumped = true;
        } else {
          shoutT = 0;
        }
        step(1 / 60);
      }
      if (deadInfo && (deadInfo.type === 'pit' || deathKey(deadInfo) === 'pit')) falls++;
    }
    window.__muteDemo = false;
    return { withG, noG, pass, falls };
  });
  check('空中长音滑翔滞空更久', glide.withG > glide.noG + 8, `滑翔=${glide.withG}帧 静音=${glide.noG}帧`);
  check('宽坑滑翔可过 / 不滑翔必掉', glide.pass === 20 && glide.falls === 10, JSON.stringify(glide));

  // ---- 1c. 阶段：边界划分、整局依次切换并弹横幅、天色随阶段渐变 ----
  const stages = await page.evaluate(() => {
    const bounds = [0, 0.149, 0.15, 0.5, 0.7, 0.95].map(stageAt).join('');
    window.__seed(9);
    obstacles.length = 0;
    for (let k = 0; k < 300; k++) spawnOne(1000 + k * 2, (k % 15) / 100);
    const warmup = [...new Set(obstacles.map((o) => o.type))].join(',');
    window.__seed(42);
    resetRun(); countdown = 0;
    const seen = [];
    let bannerOk = true;
    for (let i = 0; i < 20000 && !deadInfo && !winInfo; i++) {
      const before = stageIdx;
      step(1 / 60);
      if (stageIdx !== before) {
        seen.push(stageIdx);
        if (!(stageBanner > STAGE_BANNER_T - 0.05)) bannerOk = false;
      }
    }
    const sky = (p) => { const m = stageMix(p); return mixHex(m.cur.sky[0], m.next.sky[0], m.t); };
    const pure2 = sky(0.6), mid = sky(0.635), pure3 = sky(0.7);
    return { bounds, warmup, seen: seen.join(''), bannerOk, won: winInfo, skies: [sky(0.05), sky(0.2), sky(0.45), pure3, sky(0.95)], pure2, mid, pure3 };
  });
  check('阶段边界划分正确', stages.bounds === '001234', stages.bounds);
  check('通勤阶段热身只出小 Bug', stages.warmup === 'bug', stages.warmup);
  check('整局依次经过 5 个阶段且每次切换弹横幅', stages.won && stages.seen === '1234' && stages.bannerOk, `seen=${stages.seen} banner=${stages.bannerOk}`);
  check('天色随阶段不同且交界处渐变', new Set(stages.skies).size === 5 && stages.mid !== stages.pure2 && stages.mid !== stages.pure3,
    `${stages.pure2} → ${stages.mid} → ${stages.pure3}`);

  // ---- 2. 无输入必死（第一个障碍前撞死） ----
  await startKeyboardRun(page);
  const death = await poll(page, () => window.__lastDeath ? { label: window.__lastDeath.label, dist: window.__lastDeath.dist } : null, 8000);
  check('无输入死亡', !!death, death ? `${death.label} @${death.dist}px` : '超时未死');

  // ---- 3. 空格蓄力：小蓄力 vs 满蓄力跳高差异（喊得越响跳得越高） ----
  await startKeyboardRun(page);
  await injectClearTrack(page);
  const small = await maxAirOf(page, 180);
  const big = await maxAirOf(page, 500);
  check('空格蓄力跳高随蓄力增长', small >= 130 && small <= 195 && big >= 235 && big <= 275 && big > small, `180ms=${small}px / 500ms=${big}px`);

  // ---- 4. 触摸长按蓄力 = 满力跳（移动端入口） ----
  await startKeyboardRun(page);
  await injectClearTrack(page);
  const touchAir = await page.evaluate(async () => {
    window.__clearTrack();
    window.__maxAir = 0;
    window.__rec = true;
    const tick = () => {
      window.__maxAir = Math.max(window.__maxAir, GROUND - player.y);
      if (window.__rec) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    document.getElementById('game').dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, bubbles: true }));
    setTimeout(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, bubbles: true })), 500);
    await new Promise((r) => setTimeout(r, 1400));
    window.__rec = false;
    return Math.round(window.__maxAir);
  });
  check('触摸长按满力跳', touchAir >= 235 && touchAir <= 275, `${touchAir}px`);

  // ---- 4b. 麦克风抓峰：快喊、渐强喊声的「首跳」都按峰值出力（力度=峰值而非穿越帧） ----
  // 只量第一跳：量整段最大值会被持续喊声的第二下弹跳掩盖「首跳被锁最小力」的问题
  const micJump = async (rampMs) => page.evaluate(async (ms) => {
    window.__clearTrack();
    shoutT = 0; jumpBuf = 0; // 清掉上个用例残留的喊声包络/缓冲跳，并等落地，否则会把上一跳的落地当成首跳结束
    while (!player.grounded) await new Promise((r) => setTimeout(r, 30));
    voice.active = true;
    voice.shoutPeak = 0.5;           // 模拟已校准：Tjump=0.225，满力线=0.45
    voice.simLevel = 0.05;
    window.__maxAir = 0;
    window.__rec = true;
    let jumped = false;
    const tick = () => {
      if (!player.grounded) jumped = true;
      else if (jumped) window.__rec = false;
      if (window.__rec) {
        window.__maxAir = Math.max(window.__maxAir, GROUND - player.y);
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
    if (ms === 0) {
      await new Promise((r) => setTimeout(r, 100));
      voice.simLevel = 0.48; // 阶跃式快喊：一步冲到顶
    } else {
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        await new Promise((r) => setTimeout(r, ms / steps));
        voice.simLevel = 0.05 + (0.48 - 0.05) * (i / steps); // 从 0.05 爬到 0.48
      }
    }
    await new Promise((r) => setTimeout(r, 1100)); // 抓峰→起跳（→弹跳）→落地
    window.__rec = false;
    voice.simLevel = null; voice.active = false; voice.shoutPeak = 0;
    return Math.round(window.__maxAir);
  }, rampMs);
  const fast = await micJump(0);     // 阶跃快喊：帧内冲顶
  const ramp = await micJump(120);   // 120ms 渐强：真人起音 + 平滑后的典型形态
  check('麦克风快喊抓峰满力跳', fast >= 230 && fast <= 280, `${fast}px`);
  check('麦克风渐强喊声首跳满力', ramp >= 230 && ramp <= 280, `${ramp}px`);

  // ---- 4c. 空中提前喊 → 落地缓冲跳继承喊声力度（不再固定最小力） ----
  await startKeyboardRun(page);
  await injectClearTrack(page);
  const bufJump = await page.evaluate(async () => {
    window.__clearTrack();
    window.__maxAir = 0;
    window.__rec = true;
    const tick = () => {
      window.__maxAir = Math.max(window.__maxAir, GROUND - player.y);
      if (window.__rec) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' })); // 满力起跳
    await new Promise((r) => setTimeout(r, 640)); // 滞空 ~0.885s，此时仍在空中且接近落地
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' })); // 空中再喊（进缓冲）
    await new Promise((r) => setTimeout(r, 1100));
    window.__rec = false;
    return Math.round(window.__maxAir);
  });
  check('落地缓冲跳继承满力（≈254px）', bufJump >= 235 && bufJump <= 280, `${bufJump}px`);

  // ---- 5. 道具收集计分（清空赛道做纯道具断言） ----
  await startKeyboardRun(page);
  await injectClearTrack(page);
  const pickup = await page.evaluate(async () => {
    window.__clearTrack();
    pickups.push({ type: 'coffee', x: player.x + 220, y: 485, w: 44, h: 44, taken: false });
    setTimeout(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
      setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' })), 200);
    }, 280);
    await new Promise((r) => setTimeout(r, 2000));
    return { bonus: bonusPts, dead: !!deadInfo };
  });
  check('道具收集加分', !pickup.dead && pickup.bonus >= 20, `bonus=${pickup.bonus}`);

  // ---- 5b. 道具能力：咖啡回充发疯值、奶茶护盾挡死、狂暴优先不耗盾、香蕉摸鱼自动跳 ----
  await startKeyboardRun(page);
  await injectClearTrack(page);
  const powers = await page.evaluate(() => {
    window.__clearTrack();
    // 咖啡：贴身拾取，madness 40 → 65
    madness = 40; bonusPts = 0;
    pickups.push({ type: 'coffee', x: player.x + 8, y: GROUND - 30, w: 44, h: 44, taken: false });
    step(1 / 60);
    const coffee = { bonus: bonusPts, mad: madness };

    // 奶茶护盾挡一次地面障碍
    window.__clearTrack();
    bonusPts = 0; shield = 0; shieldBlocks = 0;
    pickups.push({ type: 'boba', x: player.x + 8, y: GROUND - 30, w: 44, h: 44, taken: false });
    step(1 / 60);
    const had = shield;
    obstacles.push({ type: 'blocker', x: player.x + 10, w: 64, h: 92, e: '📄', label: '需求变更', color: '#c98a1b' });
    step(1 / 60);
    const shielded = { had, shield, blocks: shieldBlocks, dead: !!deadInfo, obsGone: obstacles.every((o) => o.dead) };

    // 无护盾仍死
    window.__clearTrack();
    deadInfo = null; shield = 0;
    obstacles.push({ type: 'bug', x: player.x + 10, w: 56, h: 56, e: '🐛', label: 'NullPointerException', color: '#c93a3f' });
    step(1 / 60);
    const noShield = { dead: !!deadInfo, label: deadInfo && deadInfo.label };

    // 狂暴捶爆不耗盾
    window.__clearTrack();
    deadInfo = null; shield = 1; shieldBlocks = 0; berserkT = 3; madness = 100; bonusPts = 0;
    obstacles.push({ type: 'blocker', x: player.x + 10, w: 64, h: 92, e: '📄', label: '需求变更', color: '#c98a1b' });
    step(1 / 60);
    const berserk = { shield, blocks: shieldBlocks, destroyed: !deadInfo && bonusPts >= 30 };

    // 3 香蕉摸鱼 + 自动过连环 Bug
    window.__clearTrack();
    deadInfo = null; bananas = 0; slackT = 0; slackCount = 0; shield = 0; berserkT = 0;
    for (let i = 0; i < 3; i++) {
      pickups.push({ type: 'banana', x: player.x + 8, y: GROUND - 30, w: 44, h: 44, taken: false });
      step(1 / 60);
    }
    const triggered = slackT > 3.5 && slackCount === 1 && bananas === 0;
    // 障碍放近一点，保证在 4 秒摸鱼窗内跑完（太远会摸鱼结束还在 Bug 上）
    const x0 = player.x + 350;
    pushBug(x0); pushBug(x0 + 460); pushBug(x0 + 920);
    const end = x0 + 1000;
    for (let i = 0; i < 400 && !deadInfo && player.x < end; i++) step(1 / 60);
    const slack = { triggered, dead: !!deadInfo, passed: player.x >= end - 50, slackLeft: +slackT.toFixed(2) };

    return { coffee, shielded, noShield, berserk, slack };
  });
  check('咖啡回充发疯值', powers.coffee.bonus >= 20 && powers.coffee.mad >= 64.5 && powers.coffee.mad <= 65,
    JSON.stringify(powers.coffee)); // 同帧安静衰减约 10/60，故允许 64.5–65
  check('奶茶护盾挡住地面障碍', powers.shielded.had === 1 && !powers.shielded.dead && powers.shielded.shield === 0 && powers.shielded.blocks === 1 && powers.shielded.obsGone, JSON.stringify(powers.shielded));
  check('无护盾撞障碍仍死', powers.noShield.dead && powers.noShield.label === 'NullPointerException', JSON.stringify(powers.noShield));
  check('狂暴捶爆不消耗护盾', powers.berserk.shield === 1 && powers.berserk.blocks === 0 && powers.berserk.destroyed, JSON.stringify(powers.berserk));
  check('集 3 香蕉摸鱼并可自动过连环 Bug', powers.slack.triggered && !powers.slack.dead && powers.slack.passed, JSON.stringify(powers.slack));

  // ---- 6. 发疯值：触发狂暴 + 捶爆障碍 ----
  await startKeyboardRun(page);
  const mad = await page.evaluate(async () => {
    madness = 99.5;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    await new Promise((r) => setTimeout(r, 350));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));
    await new Promise((r) => setTimeout(r, 300));
    const triggered = berserkT > 0 && madCount === 1;
    obstacles.push({ type: 'blocker', x: player.x + 260, w: 64, h: 92, e: '📄', label: '需求变更', color: '#c98a1b' });
    const before = bonusPts;
    await new Promise((r) => setTimeout(r, 1200));
    return { triggered, destroyed: !deadInfo && bonusPts >= before + 30 };
  });
  check('发疯值触发狂暴', mad.triggered);
  check('狂暴捶爆障碍', mad.destroyed);

  // ---- 7. 狂暴中纸飞机依然致命（闭嘴区规则不被狂暴破坏） ----
  await startKeyboardRun(page);
  const plane = await page.evaluate(async () => {
    madness = 99.5;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    await new Promise((r) => setTimeout(r, 350));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));
    await new Promise((r) => setTimeout(r, 250));
    obstacles.push({ type: 'paper', x: player.x + 420, w: 84, h: 64, top: 500, e: '✈️', label: '需求变更变更', color: '#b8860b' });
    await new Promise((r) => setTimeout(r, 1800));
    return { dead: !!deadInfo, label: deadInfo ? deadInfo.label : null };
  });
  check('狂暴中纸飞机仍致命', plane.dead && plane.label === '需求变更变更');

  // ---- 7a. 结算显示阶段：死亡显示倒在哪个阶段，通关显示熬过全部阶段，口播去掉图标 ----
  const overStage = async (prog, kill) => {
    await startKeyboardRun(page);
    await injectClearTrack(page);
    await page.evaluate(({ prog, kill }) => {
      window.__clearTrack();
      dist = prog * GOAL_DIST; camX = dist; player.x = PLAYER_X + dist;
      // 通关路径会卡在 Boss 软门：直接标记撤兵并清障碍，再冲线
      if (!kill && prog >= BOSS.FROM) {
        boss = { x: GOAL_DIST - 420, age: BOSS.TIMEOUT, throwCd: 99, state: 'fled' };
        bossResult = 'fled';
        obstacles.length = 0;
      }
      if (kill) setTimeout(() => die({ type: 'bug', label: 'NullPointerException' }), 100);
      else {
        dist = GOAL_DIST; camX = dist; player.x = PLAYER_X + dist;
        winRun();
      }
    }, { prog, kill });
    return poll(page, () => (mode === 'over' ? { text: document.getElementById('over-stage').textContent, speech: overSpeech() } : null), 8000, 100);
  };
  const deadStage = await overStage(0.72, true);
  const winStage = await overStage(0.995, false);
  check('结算显示倒在哪个阶段', !!deadStage && deadStage.text === '🌙 倒在了 22:00 深夜加班 · 上线进度 72%' && deadStage.speech.includes('倒在了 22:00 深夜加班') && !deadStage.speech.includes('🌙'),
    deadStage ? deadStage.text : '超时');
  check('通关显示熬过全部阶段', !!winStage && winStage.text.includes('全部 5 个阶段'), winStage ? winStage.text : '超时');

  // ---- 7a2. Boss 战：92% 出场；发疯撞破 +100；纸飞机仍致命；超时撤兵可通关 ----
  await startKeyboardRun(page);
  await injectClearTrack(page);
  const bossFight = await page.evaluate(() => {
    window.__clearTrack();
    // 出场
    dist = BOSS.FROM * GOAL_DIST; camX = dist; player.x = PLAYER_X + dist; speed = speedFor();
    step(1 / 60);
    const spawned = !!(boss && boss.state === 'live');
    const noFill = spawnX > GOAL_DIST;

    // 发疯撞破
    berserkT = 3; madness = 100;
    dist = boss.x - PLAYER_X; camX = dist; player.x = PLAYER_X + dist;
    step(1 / 60);
    const beaten = boss && boss.state === 'beaten' && bossResult === 'beaten' && bonusPts >= BOSS.PTS;

    // 纸飞机仍致命（站立高度即可撞到 top≈500 的飞机）
    window.__clearTrack();
    deadInfo = null; winInfo = false; boss = null; bossResult = null; shield = 0; berserkT = 0;
    dist = BOSS.FROM * GOAL_DIST; camX = dist; player.x = PLAYER_X + dist;
    step(1 / 60);
    obstacles.push({ type: 'paper', x: player.x - 10, w: 84, h: 64, top: 500, e: '✈️', label: '需求变更变更', color: '#b8860b' });
    step(1 / 60);
    const planeKill = !!(deadInfo && deadInfo.label === '需求变更变更');

    // 超时撤兵 → 可通关
    window.__clearTrack();
    deadInfo = null; winInfo = false; boss = null; bossResult = null; shield = 0; berserkT = 0; bonusPts = 0;
    dist = BOSS.FROM * GOAL_DIST; camX = dist; player.x = PLAYER_X + dist;
    step(1 / 60);
    boss.age = BOSS.TIMEOUT - 0.05;
    step(0.1);
    const fled = boss && boss.state === 'fled' && bossResult === 'fled';
    dist = GOAL_DIST; camX = dist; player.x = PLAYER_X + dist;
    step(1 / 60);
    const canWin = !!winInfo;

    return { spawned, noFill, beaten, planeKill, fled, canWin };
  });
  check('Boss 92% 出场且停掉散件', bossFight.spawned && bossFight.noFill, JSON.stringify(bossFight));
  check('发疯撞破 Boss +100', bossFight.beaten, JSON.stringify(bossFight));
  check('Boss 段纸飞机仍致命', bossFight.planeKill, JSON.stringify(bossFight));
  check('Boss 超时撤兵后可通关', bossFight.fled && bossFight.canWin, JSON.stringify(bossFight));

  // ---- 7b. 首页：主题标题、无键盘模式入口、空榜不提示、设置面板收纳灵敏度与灵矽 ----
  await page.goto(BASE + '/?nolinx');
  await page.evaluate(() => { localStorage.removeItem(LB_KEY); toMenu(); });
  const home = await page.evaluate(() => ({
    h1: document.querySelector('#screen-start h1').textContent,
    keyboardBtn: [...document.querySelectorAll('button')].some((b) => /空格调试/.test(b.textContent)),
    lb: document.getElementById('lb-start').innerHTML,
    panelHidden: document.getElementById('settings-panel').classList.contains('hidden'),
    inPanel: !!document.querySelector('#settings-panel #sens') && !!document.querySelector('#settings-panel #btn-linx'),
  }));
  await page.click('#btn-settings');
  const opened = await page.evaluate(() => !document.getElementById('settings-panel').classList.contains('hidden'));
  await page.mouse.click(400, 400);
  const closed = await page.evaluate(() => document.getElementById('settings-panel').classList.contains('hidden'));
  check('首页布局：标题/无键盘入口/空榜无提示/设置面板开合',
    home.h1.includes('别让吗喽掉进 Bug') && !home.h1.includes('声控跑酷') && !home.keyboardBtn && home.lb === '' &&
    home.panelHidden && home.inPanel && opened && closed, JSON.stringify({ ...home, opened, closed }));

  // ---- 7c. 默认自动连接灵矽：拦掉外网请求，连接失败时齿轮亮红点、状态写进设置面板 ----
  await page.route('**/xrobo.qiniuapi.com/**', (r) => r.abort());
  await page.goto(BASE + '/');
  const auto = await poll(page, () => {
    const s = document.getElementById('linx-status').textContent;
    return s.includes('连接失败') ? { alert: document.getElementById('btn-settings').classList.contains('alert'), s } : null;
  }, 8000, 200);
  check('默认自动连接灵矽（失败亮红点）', !!auto && auto.alert, auto ? auto.s.slice(0, 40) : '超时未尝试连接');
  await page.unroute('**/xrobo.qiniuapi.com/**');

  // ---- 8. 假麦克风全链路：开麦→噪音校准→试喊校准→开局（P0 核心路径首次自动化覆盖） ----
  const browser2 = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const page2 = await browser2.newPage({ viewport: { width: 1440, height: 860 } });
  await page2.goto(BASE + '/?nolinx');
  await page2.getByRole('button', { name: '🎤 开麦上班' }).click();
  const micState = await poll(page2, () => (mode === 'play' ? {
    active: voice.active,
    peak: +voice.shoutPeak.toFixed(3),
    floor: +voice.floor.toFixed(3),
    tjump: +voice.Tjump.toFixed(3),
  } : null), 20000, 300);
  check('假麦克风走完开麦→校准→开局全流程', !!micState && micState.active,
    micState ? `peak=${micState.peak} floor=${micState.floor} Tjump=${micState.tjump}` : '超时');
  const matrix = await page2.evaluate(() => {
    const bad = [];
    for (const peak of [0.05, 0.12, 0.3, 0.5, 0.9]) {
      for (const sens of [0.6, 1, 1.8]) {
        voice.shoutPeak = peak; voice.sens = sens;
        if (!(voice.Tjump < peak)) bad.push(`peak=${peak}/sens=${sens}→T=${voice.Tjump.toFixed(3)}`);
      }
    }
    voice.sens = 1;
    return bad;
  });
  check('Tjump 阈值无死区（峰值×灵敏度 15 组矩阵）', matrix.length === 0, matrix.join(' ; ') || '全部 Tjump<peak');
  await browser2.close();

  // ---- 8. 全程无未捕获 JS 错误 ----
  check('页面无 JS 错误', !errs.length, errs.slice(0, 2).join('; '));

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? '🎉 全部通过' : '💥 ' + failed + ' 项失败'}：${results.length - failed}/${results.length}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试脚本自身出错：', e);
  if (server) server.kill();
  process.exit(2);
}).finally(() => { if (server) server.kill(); });
