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

async function startKeyboardRun(page) {
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: /空格调试模式/ }).click();
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

  // ---- 2. 无输入必死（第一个障碍前撞死） ----
  await startKeyboardRun(page);
  const death = await poll(page, () => window.__lastDeath ? { label: window.__lastDeath.label, dist: window.__lastDeath.dist } : null, 8000);
  check('无输入死亡', !!death, death ? `${death.label} @${death.dist}px` : '超时未死');

  // ---- 3. 空格蓄力：小蓄力 vs 满蓄力跳高差异（喊得越响跳得越高） ----
  await page.reload();
  await page.getByRole('button', { name: /空格调试模式/ }).click();
  await poll(page, () => mode === 'play' && countdown <= 0, 6000, 100);
  await injectClearTrack(page);
  const small = await maxAirOf(page, 180);
  const big = await maxAirOf(page, 500);
  check('空格蓄力跳高随蓄力增长', small >= 130 && small <= 195 && big >= 235 && big <= 275 && big > small, `180ms=${small}px / 500ms=${big}px`);

  // ---- 4. 触摸长按蓄力 = 满力跳（移动端入口） ----
  await page.reload();
  await page.getByRole('button', { name: /空格调试模式/ }).click();
  await poll(page, () => mode === 'play' && countdown <= 0, 6000, 100);
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

  // ---- 4b. 麦克风抓峰：快喊立即满力、渐强喊声最终也能到满力（力度=峰值而非穿越帧） ----
  const micJump = async (rampMs) => page.evaluate(async (ms) => {
    window.__clearTrack();
    voice.active = true;
    voice.shoutPeak = 0.5;           // 模拟已校准：Tjump=0.225，满力线=0.45
    voice.simLevel = 0.05;
    window.__maxAir = 0;
    window.__rec = true;
    const tick = () => {
      window.__maxAir = Math.max(window.__maxAir, GROUND - player.y);
      if (window.__rec) requestAnimationFrame(tick);
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
  const slow = await micJump(500);   // 500ms 渐强：首跳中力度，持续喊弹跳到满力
  check('麦克风快喊抓峰满力跳', fast >= 230 && fast <= 280, `${fast}px`);
  check('麦克风渐强喊声最终满力（弹跳）', slow >= 230 && slow <= 280, `${slow}px`);

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

  // ---- 8. 假麦克风全链路：开麦→噪音校准→试喊校准→开局（P0 核心路径首次自动化覆盖） ----
  const browser2 = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const page2 = await browser2.newPage({ viewport: { width: 1440, height: 860 } });
  await page2.goto(BASE + '/');
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
