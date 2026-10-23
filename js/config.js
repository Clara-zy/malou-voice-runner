'use strict';

/* ================= 可调参数（现场调手感主要改这里） ================= */
const W = 1280, H = 720, GROUND = 600;
const GRAVITY = 2600;
const AUTO_V_START = 300, AUTO_V_END = 380;  // 难度曲线：全程从 300 渐进提速到 380
const SPRINT_FROM = 0.92, SPRINT_BONUS = 40; // 终点前"上线冲刺"段额外加速
const JUMP_V_MIN = 720, JUMP_V_MAX = 1150;   // 起跳初速度：小喊≈100px 大跳≈254px（2.5 倍高度差，一眼可辨）
const PLAYER_W = 64, PLAYER_H = 76;
const PLAYER_X = 320;
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

/* 前冲：大声跳获得随力度衰减的临时加速，让"越喊跳得越远"在距离上可见 */
const SURGE_MAX = 200, SURGE_DECAY = 220;

/* 障碍难度随进度变化 */
const DIFF = { GAP_PROG: 70, PIT_PROG: 55 };

/* 计分：跑动里程 + 连躲奖励 + 道具 + 捶爆奖励 */
const SCORE = {
  PX_PER_LINE: 12,
  DODGE_BASE: 5, DODGE_PER_COMBO: 2, COMBO_CAP: 10, // 每躲一个 = 5 + min(连躲数,10)×2 行
  PLANE_MULT: 2,                                     // 躲过纸飞机双倍
  DESTROY: 30,                                       // 发疯状态捶爆地面障碍
  CAP: 9999,
};

/* 道具：咖啡低空小跳可得，奶茶高空要满力喊 */
const PICK = { CHANCE: 0.34, BOBA_CHANCE: 0.3, COFFEE_PTS: 20, BOBA_PTS: 50 };

/* 发疯值：喊=充电 安静=衰减；纸飞机靠近时冻结（闭嘴区规则） */
const MAD = {
  RATE: 45, DECAY: 10,
  FREEZE_DIST: 320,
  BERSERK_T: 5, COOLDOWN: 3,
  SPEED_MUL: 1.3, SCORE_MUL: 2,
};

/* URL 参数：?demo 自动演示模式；?goal=3000 缩短赛程（默认 12000px = 1000 行代码） */
const qs = new URLSearchParams(location.search);
const DEMO = qs.has('demo');
const _goal = parseInt(qs.get('goal'), 10);
const GOAL_DIST = Number.isFinite(_goal) && _goal >= 2000 ? _goal : 12000;

/* 蓄力参数（空格 / 触摸长按共用）：按满 0.38s 等效一次满嗓门喊声
 * 功率沿整个蓄力期线性上升，映射到「起跳线→满力线」的个人动态区间 */
const CHARGE_FULL_T = 0.38;
function chargeVol(t) { return voice.Tjump + (voice.fullVol - voice.Tjump) * clamp(t / CHARGE_FULL_T, 0, 1); }

/* 排行榜存储键 */
const LB_KEY = 'malou.leaderboard', NAME_KEY = 'malou.name';
