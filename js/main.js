'use strict';

/* ================= 主循环 & 启动 ================= */

// 收集页面运行时错误，供冒烟测试断言（正常游玩不受影响）
window.__errlog = [];
window.addEventListener('error', (e) => { window.__errlog.push(String(e.message)); });

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

toMenu();
if (DEMO) resetRun(); // demo 走声控路径（demoVol），不启用键盘分支

// PWA：仅 http(s) 下注册（file:// 单文件版跳过）
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
