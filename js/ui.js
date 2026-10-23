'use strict';

/* ================= DOM 界面：排行榜、麦克风流程、缩放 ================= */

/* 缩放适配：保持 1280×720 逻辑分辨率等比铺满窗口 */
function fit() {
  const s = Math.min(innerWidth / W, innerHeight / H);
  $('stage').style.transform = `scale(${s})`;
}
addEventListener('resize', fit);
fit();

/* 排行榜（本机 localStorage，够大屏单机场景用） */
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
  return { ts: entry.ts, rank: lb.indexOf(entry) };
}
function lbHTML(list, meTs) {
  const top = list.slice(0, 5);
  if (!top.length) return '<p class="lb-empty">还没有吗喽上榜，等你来当第一个 🐵</p>';
  const medals = ['🥇', '🥈', '🥉'];
  return '<ol class="lb">' + top.map((e, i) =>
    `<li class="${e.ts === meTs ? 'me' : ''}"><span class="rk">${medals[i] || i + 1}</span><span class="nm">${esc(e.name)}</span><span class="sc">${e.score} 行</span></li>`
  ).join('') + '</ol>';
}
function lbRefreshStart() {
  $('lb-start').innerHTML = lbHTML(loadLB(), lastEntryTs);
}

function showOver() {
  if (mode !== 'play') return;
  mode = 'over';
  Music.stop();
  pendingScore = curScore();
  const stats = [];
  if (maxCombo >= 2) stats.push(`最高连躲 x${maxCombo}`);
  if (madCount > 0) stats.push(`发疯 ${madCount} 次`);
  const statsStr = stats.length ? `（${stats.join(' · ')}）` : '';
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
  $('over-score').textContent = `本次成绩：${pendingScore} 行代码${statsStr}`;
  try { $('name-input').value = localStorage.getItem(NAME_KEY) || ('吗喽' + (10 + Math.floor(Math.random() * 90))); } catch (e) {}
  saved = false;
  $('btn-save').disabled = false;
  $('btn-save').textContent = '上排行榜';
  $('over-save').classList.toggle('hidden', DEMO);
  $('lb-over').innerHTML = lbHTML(loadLB(), lastEntryTs);
  $('screen-over').classList.remove('hidden');
  $('over-voice').textContent = '';
  if (!DEMO && window.linx) window.linx.speakResult(overSpeech()); // 连接灵矽时口播结算
  if (!DEMO) $('name-input').focus();
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
  const { ts, rank } = addScore(name, pendingScore);
  lastEntryTs = ts; // 复用同一次写入的时间戳，榜单高亮不会因跨毫秒偶发失效
  saved = true;
  $('btn-save').disabled = true;
  $('btn-save').textContent = '已上榜 ✓';
  $('lb-over').innerHTML = lbHTML(loadLB(), lastEntryTs);
  $('name-input').blur(); // 让 Enter 重开不再被输入框拦下
  return rank;
}
$('btn-save').addEventListener('click', doSave);
$('name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'Esc') return; // 留给页面：回主页
  e.stopPropagation();
  if (e.key === 'Enter') doSave();
});
$('btn-retry').addEventListener('click', () => { if (mode === 'over') resetRun(); });

/* ================= 麦克风流程 ================= */
let micFlow = 0; // 流程令牌：Esc 打断/回菜单后，旧流程在下一个 await 点自动作废

// 回到菜单时复位开麦控件，让「手感不对 → Esc → 重新校准」成为完整闭环
function resetMicUI() {
  micFlow++;
  const btn = $('btn-mic');
  btn.disabled = false;
  btn.textContent = '🎤 开麦上班';
  $('meter-box').classList.add('hidden');
  $('calib-tip').classList.add('hidden');
  $('mic-error').classList.add('hidden');
}

async function startMic() {
  SFX.ensure();
  const btn = $('btn-mic');
  if (btn.disabled) return;
  const myFlow = ++micFlow;
  btn.disabled = true;
  $('mic-error').classList.add('hidden');
  if (!voice.active) {
    btn.textContent = '🎤 正在开启麦克风…';
    try {
      // 权限弹窗被忽略时会一直挂起，8 秒无响应就提示去看弹窗
      let late = false;
      await Promise.race([
        voice.start().then(() => { if (late) voice.stop(); }), // 超时后才成功：迟到的流立即关掉，不留挂起的麦克风
        sleep(8000).then(() => { late = true; throw new Error('8 秒内没有响应——请检查浏览器顶部的麦克风权限弹窗'); }),
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
  } // 已激活（Esc 回来重校准）：跳过权限环节直接重走校准
  if (myFlow !== micFlow) return;
  btn.textContent = '🎤 麦克风已就绪';
  $('meter-box').classList.remove('hidden');
  $('calib-tip').classList.remove('hidden');
  mode = 'calib';
  $('calib-tip').textContent = '🤫 请保持安静，正在测量环境噪音…';
  await voice.calibrate(1600);
  if (myFlow !== micFlow) return;
  // 试喊校准：按玩家自己的嗓门定起跳线，比全局阈值可靠得多
  $('calib-tip').textContent = '👉 现在用你最大的声音——喊一嗓子！（测量你的嗓门基线）';
  const peak = await voice.calibrateShout(1500);
  if (myFlow !== micFlow) return;
  // 有效性直接对照最终起跳线（含 clamp/噪音底/灵敏度），和 Tjump 公式天然闭环
  if (peak > voice.Tjump * 1.15) {
    $('calib-tip').textContent = '✅ 起跳线已按你的嗓门校准！试着冲进红区就会起跳，马上开始…';
  } else {
    voice.shoutPeak = 0; // 喊声没明显高于环境音，退回默认阈值
    $('calib-tip').textContent = '🤔 没太听到你喊？先用默认灵敏度开局，手感不对按 Esc 回来把灵敏度调高再试';
  }
  mode = 'ready';
  await sleep(2600);
  if (myFlow !== micFlow) return;
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
  const maxV = voice.fullVol * 1.2;
  const markPct = clamp(voice.Tjump / maxV * 100, 0, 100);
  $('meter').style.setProperty('--jump-mark', markPct + '%'); // 红区起点与刻度线同源，避免写死脱节
  $('meter-fill').style.width = clamp(voice.level / maxV * 100, 0, 100) + '%';
  $('mark-jump').style.left = markPct + '%';
}
