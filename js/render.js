'use strict';

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
  ctx.fillText('🦘 跳（越响越高）', x + w, y + h + 18);
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
