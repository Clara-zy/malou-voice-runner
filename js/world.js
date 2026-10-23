'use strict';

/* ================= 障碍与生成 ================= */
const BLOCKERS = [
  { e: '📄', label: '需求变更', color: '#c98a1b' },
  { e: '🚧', label: '404', color: '#7a68c9' },
  { e: '💣', label: 'P0 故障', color: '#c93a3f' },
];

const rand = (a, b) => a + Math.random() * (b - a);

function pushBug(x) {
  obstacles.push({ type: 'bug', x, w: 56, h: 56, e: '🐛', label: 'NullPointerException', color: '#c93a3f' });
  return x + 56;
}
function pushBlocker(x) {
  const b = BLOCKERS[Math.floor(Math.random() * BLOCKERS.length)];
  obstacles.push({ type: 'blocker', x, w: 64, h: 92, e: b.e, label: b.label, color: b.color });
  return x + 64;
}
function pushPit(x, w) {
  obstacles.push({ type: 'pit', x, w });
  return x + w;
}
/* 纸飞机迎面飞来：按基础速度反推初始位置，让它恰好在吗喽跑到 meetX 时飞到头顶。
 * 直接放在 meetX 的话，相遇点会提前约 400px，落进上一个障碍的起跳段，形成"不跳撞 Bug、跳了撞飞机"的必死局。 */
function pushPlane(meetX) {
  const w = 84;
  const v = baseSpeed(meetX / GOAL_DIST);
  const x = meetX - w / 2 + Math.max(0, meetX - player.x) * PLANE_V / v;
  obstacles.push({ type: 'paper', x, w, h: 64, top: 392 + Math.random() * 26, e: '✈️', label: '需求变更变更', color: '#b8860b', meetX });
  return meetX;
}

function spawnOne(x, prog) {
  const r = Math.random();
  let type;
  if (prog < STAGES[1].from) type = 'bug'; // 通勤阶段热身：只出小 Bug
  else if (prog > 0.28 && r < 0.2) type = 'paper';
  else if (prog > 0.2 && r < 0.42) type = 'pit';
  else type = r < 0.72 ? 'bug' : 'blocker';

  if (type === 'bug') pushBug(x);
  else if (type === 'blocker') pushBlocker(x);
  else if (type === 'paper') pushPlane(x);
  else pushPit(x, 110 + Math.random() * 40 + prog * DIFF.PIT_PROG);
}

/* 套路段：按阶段解锁的障碍组合。build 返回段尾坐标，len 是最大长度（用于终点净土区检查）。
 * 段内间距按满力跳（演示 AI 每次都是满力）也不会落进下一个障碍来设计。 */
const PATTERNS = [
  {
    id: 'bugChain', name: '连环 Bug', stage: 1, len: 1020,
    build(x) {
      // 满力跳横向约 390px：间距再短，满力跳会正好落在下一个 Bug 跟前来不及再跳
      pushBug(x);
      x += rand(440, 480); pushBug(x);
      x += rand(440, 480); return pushBug(x);
    },
  },
  {
    id: 'highLow', name: '高低交替', stage: 1, len: 490,
    build(x) {
      pushBug(x);
      return pushBlocker(x + rand(380, 420));
    },
  },
  {
    id: 'planeThen', name: '闭嘴后起跳', stage: 2, len: 560,
    build(x) {
      pushPlane(x);
      const hx = x + rand(380, 420);
      return Math.random() < 0.5 ? pushPit(hx, rand(120, 140)) : pushBlocker(hx);
    },
  },
  {
    id: 'bobaPit', name: '奶茶诱惑', stage: 2, len: 150,
    build(x) {
      const w = rand(130, 150);
      pickups.push({ type: 'boba', x: x + w * 0.6, y: rand(335, 355), w: 44, h: 44, taken: false });
      return pushPit(x, w);
    },
  },
  {
    id: 'doublePit', name: '连环坑', stage: 3, len: 580,
    build(x) {
      const end = pushPit(x, rand(110, 125));
      return pushPit(end + rand(300, 330), rand(110, 125));
    },
  },
];

function pickPattern(prog) {
  const si = stageAt(prog);
  if (Math.random() >= STAGES[si].patternChance) return null;
  const pool = PATTERNS.filter((p) => p.stage <= si);
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}

/* 生成一段（套路段或散件），返回段尾坐标；散件返回起点，保持原有"起点到起点"的间距 */
function spawnSegment(x, prog) {
  const pat = pickPattern(prog);
  if (pat && x + pat.len < GOAL_DIST - 500) {
    const n = obstacles.length;
    const end = pat.build(x);
    for (let i = n; i < obstacles.length; i++) obstacles[i].pat = pat.id;
    return end;
  }
  spawnOne(x, prog);
  return x;
}

/* 道具生成：放在两障碍之间的空档。咖啡低空（小跳可得），奶茶高空（满力跳） */
function spawnPickup(x) {
  if (Math.random() > PICK.CHANCE) return;
  const boba = Math.random() < PICK.BOBA_CHANCE;
  // 咖啡 470–500：贴着跑过头顶拿不到，必须小跳；奶茶 330–370：几乎要满力跳
  pickups.push({
    type: boba ? 'boba' : 'coffee',
    x, y: boba ? 330 + Math.random() * 40 : 470 + Math.random() * 30,
    w: 44, h: 44, taken: false,
  });
}

function fillObstacles() {
  while (spawnX < camX + W + 500) {
    if (spawnX > GOAL_DIST - 500) { spawnX = camX + W + 600; break; } // 终点前留一段净土
    const end = spawnSegment(spawnX, spawnX / GOAL_DIST);
    const gap = 260 + 300 * (0.9 + Math.random() * 0.9) + (spawnX / GOAL_DIST) * DIFF.GAP_PROG;
    spawnX = end + gap;
    spawnPickup(spawnX - gap * 0.5 + Math.random() * 60); // 空档中部偏后一点
  }
}
