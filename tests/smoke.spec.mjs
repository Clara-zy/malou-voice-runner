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
  await page.waitForTimeout(2800); // 等倒计时结束
}

async function maxAirOf(page, holdMs) {
  return page.evaluate(async (ms) => {
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
  await page.waitForTimeout(2800);
  const small = await maxAirOf(page, 180);
  const big = await maxAirOf(page, 500);
  check('空格蓄力跳高随蓄力增长', small >= 120 && small <= 205 && big >= 200 && big <= 245 && big > small, `180ms=${small}px / 500ms=${big}px`);

  // ---- 4. 触摸长按蓄力 = 满力跳（移动端入口） ----
  await page.reload();
  await page.getByRole('button', { name: /空格调试模式/ }).click();
  await page.waitForTimeout(2800);
  const touchAir = await page.evaluate(async () => {
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
  check('触摸长按满力跳', touchAir >= 195 && touchAir <= 245, `${touchAir}px`);

  // ---- 5. 道具收集计分（清空赛道做纯道具断言） ----
  await startKeyboardRun(page);
  const pickup = await page.evaluate(async () => {
    obstacles.length = 0; spawnX = GOAL_DIST + 9999; // 纯净跑道
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
