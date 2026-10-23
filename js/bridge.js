'use strict';

/* ================= 对外接口（linx.js 语音助手把它们注册成 MCP 工具） =================
 * 自 main 合并移植：原实现在单文件 game.js 尾部，模块化后独立成桥接层。
 * goal 从赛程参数推导（?goal= 缩短赛程时语音播报的行数保持一致）。 */
window.Game = {
  get mode() { return mode; },
  status() {
    return {
      screen: mode, // menu 主页 | calib/ready 开麦校准中 | play 对局中 | over 结算
      score: mode === 'over' ? pendingScore : curScore(),
      goal: Math.floor(GOAL_DIST / SCORE.PX_PER_LINE),
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
