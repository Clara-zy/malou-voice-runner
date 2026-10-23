'use strict';

/* ================= 障碍与生成 ================= */
const BLOCKERS = [
  { e: '📄', label: '需求变更', color: '#c98a1b' },
  { e: '🚧', label: '404', color: '#7a68c9' },
  { e: '💣', label: 'P0 故障', color: '#c93a3f' },
];

function spawnOne(x, prog) {
  const r = Math.random();
  let type;
  if (prog < 0.06) type = 'bug';
  else if (prog > 0.28 && r < 0.2) type = 'paper';
  else if (prog > 0.2 && r < 0.42) type = 'pit';
  else type = r < 0.72 ? 'bug' : 'blocker';

  if (type === 'bug') {
    obstacles.push({ type, x, w: 56, h: 56, e: '🐛', label: 'NullPointerException', color: '#c93a3f' });
  } else if (type === 'blocker') {
    const b = BLOCKERS[Math.floor(Math.random() * BLOCKERS.length)];
    obstacles.push({ type, x, w: 64, h: 92, e: b.e, label: b.label, color: b.color });
  } else if (type === 'paper') {
    obstacles.push({ type, x, w: 84, h: 64, top: 392 + Math.random() * 26, e: '✈️', label: '需求变更变更', color: '#b8860b' });
  } else {
    obstacles.push({ type: 'pit', x, w: 110 + Math.random() * 40 + prog * DIFF.PIT_PROG });
  }
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
    spawnOne(spawnX, spawnX / GOAL_DIST);
    const gap = 260 + 300 * (0.9 + Math.random() * 0.9) + (spawnX / GOAL_DIST) * DIFF.GAP_PROG;
    spawnX += gap;
    spawnPickup(spawnX - gap * 0.5 + Math.random() * 60); // 空档中部偏后一点
  }
}
