'use strict';

/* ================= 可调参数（现场调手感主要改这里） ================= */
const W = 1280, H = 720, GROUND = 600;
const GRAVITY = 2600;
const AUTO_V = 300;                          // 吗喽自动匀速前进速度（玩家只管跳）
const JUMP_V_MIN = 900, JUMP_V_MAX = 1080;   // 起跳初速度：喊得越响跳得越高越远
const PLAYER_W = 64, PLAYER_H = 76;
const PLAYER_X = 320;
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

/* URL 参数：?demo 自动演示模式；?goal=3000 缩短赛程（默认 12000px = 1000 行代码） */
const qs = new URLSearchParams(location.search);
const DEMO = qs.has('demo');
const _goal = parseInt(qs.get('goal'), 10);
const GOAL_DIST = Number.isFinite(_goal) && _goal >= 2000 ? _goal : 12000;

/* 蓄力参数（空格 / 触摸长按共用）：按满 0.38s 等效一次满嗓门喊声 */
const CHARGE_FULL_T = 0.38;
function chargeVol(t) { return voice.Tjump + 0.28 * clamp(t / CHARGE_FULL_T, 0, 1); }

/* 排行榜存储键 */
const LB_KEY = 'malou.leaderboard', NAME_KEY = 'malou.name';
