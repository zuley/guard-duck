export const WEAPON = {
  name: 'Claude 步枪',
  magSize: 24,
  reserveStart: 96,
  rpm: 540,
  reloadTime: 1.6,
  damage: 26,
  bulletSpeed: 70,
  spreadBase: 0.012,
  spreadMove: 0.02,
  spreadHeat: 0.03,
  falloffStart: 18,
  falloffEnd: 34,
  falloffMin: 0.55,
};

export const ENEMY_TYPES = {
  brawler: {
    label: '需求鸭',
    kind: 'task',
    palette: 'grunt',
    weapon: 'fists',
    hp: 40,
    speed: 3.2,
    radius: 0.5,
    damage: 6,
    score: 80,
    reach: 1.4,
    windup: 0.45,
    attackInterval: 1.2,
    scale: 1,
  },
  clubber: {
    label: 'BUG鸭',
    kind: 'task',
    palette: 'grunt',
    weapon: 'club',
    hp: 60,
    speed: 3.0,
    radius: 0.55,
    damage: 12,
    score: 110,
    reach: 1.8,
    windup: 0.55,
    attackInterval: 1.5,
    scale: 1.05,
  },
  knifer: {
    label: '产品鸭',
    kind: 'role',
    palette: 'runner',
    weapon: 'knife',
    hp: 38,
    speed: 4.8,
    radius: 0.48,
    damage: 9,
    score: 120,
    reach: 1.4,
    windup: 0.3,
    attackInterval: 0.8,
    scale: 0.88,
  },
  pistol: {
    label: '前端鸭',
    kind: 'role',
    palette: 'grunt',
    weapon: 'pistol',
    hp: 55,
    speed: 2.8,
    radius: 0.5,
    damage: 7,
    score: 140,
    range: 9,
    fireInterval: 1.7,
    bulletSpeed: 15,
    scale: 1,
  },
  rifle: {
    label: '后端鸭',
    kind: 'role',
    palette: 'grunt',
    weapon: 'rifle',
    hp: 70,
    speed: 3.2,
    radius: 0.55,
    damage: 9,
    score: 180,
    range: 10,
    fireInterval: 1.15,
    bulletSpeed: 18,
    scale: 1,
  },
  heavy: {
    label: '设计鸭',
    kind: 'role',
    palette: 'tank',
    weapon: 'shotgun',
    hp: 220,
    speed: 2.0,
    radius: 0.8,
    damage: 6,
    score: 320,
    range: 7.5,
    fireInterval: 2.4,
    bulletSpeed: 13,
    pellets: 4,
    spread: 0.22,
    scale: 1.35,
  },
  boss: {
    label: 'Leader鸭',
    kind: 'boss',
    palette: 'tank',
    weapon: 'shotgun',
    hp: 600,
    speed: 1.7,
    radius: 1.1,
    damage: 10,
    score: 1500,
    range: 8.5,
    fireInterval: 2.0,
    bulletSpeed: 14,
    pellets: 7,
    spread: 0.26,
    scale: 2.0,
    boss: true,
  },
};

export const ELITE = { scale: 1.45, dmgMul: 1.5, scoreMul: 3, reachMul: 1.25, speedMul: 0.9 };

// 打工人主题命名：任务 / 职位鸭随机带前缀，Boss 是各路领导
export const NAME_PREFIXES = {
  task: ['紧急', '加急', '临时', '生产', '线上', '遗留', '高优', '突发', '跨部门', '反复修改的'],
  role: ['愤怒的', '开心的', '实习的', '开除的', '加班的', '摸鱼的', '甩锅的', '背锅的', '秃头的', '提离职的', '卷王的', '划水的'],
};
export const BOSS_NAMES = ['产品Leader', '前端Leader', '后端Leader', '设计Leader', '测试主管', '研发主管', '项目经理', '产品经理', '技术总监', '部门经理'];

// 约六成概率带前缀；Boss 固定无前缀；rng 传入保证可复现
export function enemyName(type, rng = Math.random) {
  const t = ENEMY_TYPES[type];
  if (t.kind === 'boss') return BOSS_NAMES[Math.floor(rng() * BOSS_NAMES.length)];
  const pool = NAME_PREFIXES[t.kind] || [];
  const prefix = pool.length && rng() < 0.6 ? pool[Math.floor(rng() * pool.length)] : '';
  return prefix + t.label;
}

export const ELITE_SKILL = { radius: 4.5, windup: 0.9, cd: 7, dmgMul: 1.6, range: 8 };
export const BOSS_SKILL = { radius: 40, windup: 1.6, cd: 9, dmgMul: 2.2 };

export function eliteHpMul(wave) {
  return Math.min(4, 2.5 + (wave - 1) * 0.1);
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function wavePlan(wave) {
  let counts = {
    // 杂兵随波次平滑递减（每 2 波 -1），第 16 波起保底 2 只，避免早期公式骤降钳底
    brawler: wave === 1 ? 6 : Math.max(2, 10 - Math.floor(wave / 2)),
    clubber: wave >= 2 ? Math.min(10, 2 + wave) : 0,
    knifer: wave >= 2 ? Math.min(10, wave) : 0,
    pistol: wave >= 3 ? Math.min(10, (wave - 2) * 2) : 0,
    rifle: wave >= 4 ? Math.min(12, (wave - 3) * 2) : 0,
    heavy: wave >= 5 ? Math.min(6, Math.floor((wave - 3) / 2)) : 0,
  };
  const boss = wave >= 5 && wave % 5 === 0 ? 1 : 0;
  const cap = 42 - boss - 1;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > cap) {
    const k = cap / total;
    const entries = Object.entries(counts).map(([key, n]) => {
      const x = n * k;
      return [key, Math.floor(x), x - Math.floor(x)];
    });
    let rem = cap - entries.reduce((a, e) => a + e[1], 0);
    entries.sort((a, b) => b[2] - a[2]);
    for (const e of entries) {
      if (rem <= 0) break;
      e[1]++; rem--;
    }
    counts = Object.fromEntries(entries.map(([key, n]) => [key, n]));
  }
  counts.boss = boss;
  counts.elite = 1;
  return {
    counts,
    hpScale: Math.min(4, 1 + (wave - 1) * 0.12),
    speedScale: Math.min(1.4, 1 + (wave - 1) * 0.02),
    spawnInterval: Math.max(0.35, 1.4 - wave * 0.06),
    bossScale: Math.min(6, 1 + Math.max(0, wave - 5) * 0.12),
  };
}

export function waveIntro(wave) {
  if (wave >= 5 && wave % 5 === 0) {
    return wave === 5 ? '设计鸭扛着霰弹枪压阵，领导亲自出马！' : '领导驾到！集中火力，击败它赢取重赏！';
  }
  switch (wave) {
    case 1: return '需求鸭空手扑来，先热热身！';
    case 2: return 'BUG鸭抡棍棒、产品鸭持小刀，小心近身挥击！';
    case 3: return '前端鸭掏出手枪，利用干草垛掩体！';
    case 4: return '后端鸭步枪火力压制，别在开阔地停留！';
    default: return '敌群来袭，精英带队，守住农场！';
  }
}

export function damageAtDistance(base, d, falloff = WEAPON) {
  const { falloffStart, falloffEnd, falloffMin } = falloff;
  if (d <= falloffStart) return base;
  if (d >= falloffEnd) return base * falloffMin;
  const t = (d - falloffStart) / (falloffEnd - falloffStart);
  return base * (1 - t * (1 - falloffMin));
}

export function currentSpread(heat, moving) {
  return WEAPON.spreadBase + (moving ? WEAPON.spreadMove : 0) + heat * WEAPON.spreadHeat;
}

export function canEngage(dist, range, visible) {
  if (dist > range) return false;
  return visible || dist <= 5;
}

export function scoreFor(type, wave, elite = false) {
  const t = ENEMY_TYPES[type];
  if (!t) return 0;
  return Math.round(t.score * (1 + (wave - 1) * 0.1) * (elite ? ELITE.scoreMul : 1));
}

export function rollDrop(rng, type, ammoLow = false, elite = false) {
  if (ammoLow) return 'ammo';
  if (elite) return rng() < 0.55 ? 'ammo' : 'health';
  const chance = type === 'heavy' || type === 'boss' ? 0.6 : type === 'knifer' || type === 'brawler' ? 0.25 : 0.3;
  const r = rng();
  if (r >= chance) return null;
  return rng() < 0.55 ? 'ammo' : 'health';
}

// 打工人战利品：拾取即结算金币 + 一个即时效果（effect 字段供 game.js 派发）。
// 稀有度越高金币越多、效果越强；weight 是掉落权重（越稀有越低）。
export const LOOT_ITEMS = [
  { id: 'subsidy', label: '高温补贴', coins: 6, weight: 14, color: 0xffb070, effect: { kind: 'heal', amount: 10 }, desc: '+6 金币 · 回血 10' },
  { id: 'welfare', label: '节日福利', coins: 10, weight: 12, color: 0xff7ab8, effect: { kind: 'shield', amount: 20, cap: 120 }, desc: '+10 金币 · 护盾 +20（上限 120）' },
  { id: 'salary', label: '本月工资', coins: 14, weight: 11, color: 0x7ee06a, effect: { kind: 'heal', amount: 25 }, desc: '+14 金币 · 回血 25' },
  { id: 'coffee', label: '下午茶', coins: 8, weight: 12, color: 0xc89060, effect: { kind: 'haste', duration: 5 }, desc: '+8 金币 · 移速 +25% 5s' },
  { id: 'overtime', label: '加班费', coins: 18, weight: 9, color: 0x9fe8ff, effect: { kind: 'ammo', amount: 16 }, desc: '+18 金币 · 备弹 +16' },
  { id: 'performance', label: '季度绩效', coins: 24, weight: 7, color: 0x6fd6ff, effect: { kind: 'xp', amount: 30 }, desc: '+24 金币 · 经验 +30' },
  { id: 'bonus', label: '项目奖金', coins: 32, weight: 5, color: 0xffd95e, effect: { kind: 'rage', duration: 4 }, desc: '+32 金币 · 红温 4s' },
  { id: 'yearbonus', label: '年终奖', coins: 60, weight: 2, color: 0xffc63a, effect: { kind: 'heal', amount: 60 }, desc: '+60 金币 · 回血 60' },
  { id: 'stock', label: '期权激励', coins: 88, weight: 1, color: 0xffe9a8, effect: { kind: 'fullheal' }, desc: '+88 金币 · 生命全满' },
];

export function coinsFor(type, elite = false) {
  const t = ENEMY_TYPES[type];
  return t ? Math.max(1, Math.round((t.score / 10) * (elite ? ELITE.scoreMul : 1))) : 0;
}

export function rollLoot(rng) {
  const r = rng();
  const n = r < 0.12 ? 0 : r < 0.8 ? 1 : 2;
  const total = LOOT_ITEMS.reduce((a, i) => a + i.weight, 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    let x = rng() * total;
    for (const it of LOOT_ITEMS) {
      x -= it.weight;
      if (x <= 0) { out.push(it.id); break; }
    }
  }
  return out;
}

// AI 模型主题武器：初始 Claude 免费，其余用金币在武器面板购买。
// accent 用于图标 / 曳光配色，tag 是风味标语。
export const GUNS = {
  claude: { label: 'Claude 步枪', tag: '深思熟虑 · 稳定输出', accent: 0xd97757, price: 0, model: 'rifle', damage: 26, rpm: 540, magSize: 24, reloadTime: 1.6, bulletSpeed: 70, spreadBase: 0.012, pellets: 1, range: 34, falloffStart: 18, falloffEnd: 34, falloffMin: 0.55 },
  qwen: { label: 'Qwen 连发枪', tag: '千问千答 · 火力压制', accent: 0x615ced, price: 320, model: 'rifle', damage: 20, rpm: 780, magSize: 36, reloadTime: 1.7, bulletSpeed: 74, spreadBase: 0.016, pellets: 1, range: 30, falloffStart: 16, falloffEnd: 30, falloffMin: 0.5 },
  glm: { label: 'GLM 霰弹枪', tag: '智谱清言 · 近距爆发', accent: 0x3b82f6, price: 400, model: 'shotgun', damage: 15, rpm: 150, magSize: 6, reloadTime: 2.0, bulletSpeed: 55, spreadBase: 0.035, pellets: 6, pelletSpread: 0.1, range: 18, falloffStart: 9, falloffEnd: 18, falloffMin: 0.3 },
  codex: { label: 'Codex 重步枪', tag: '代码生成 · 远程狙杀', accent: 0x10a37f, price: 620, model: 'rifle', damage: 46, rpm: 300, magSize: 16, reloadTime: 1.9, bulletSpeed: 90, spreadBase: 0.006, pellets: 1, range: 55, falloffStart: 30, falloffEnd: 55, falloffMin: 0.75 },
};

// 武器面板目录：只卖枪，无护具、无弹药、无出售。
export function gunCatalog() {
  return Object.entries(GUNS).map(([id, g]) => ({
    id, label: g.label, tag: g.tag, price: g.price, accent: g.accent,
    desc: `${g.damage} 伤害 · ${g.rpm} 射速 · ${g.magSize} 弹匣 · 射程 ${g.range}${g.pellets > 1 ? ` · ${g.pellets} 弹丸` : ''}`,
  }));
}

export function computeLoadout(gunId) {
  const g = GUNS[gunId] || GUNS.claude;
  return {
    gun: g,
    damage: g.damage,
    rpm: g.rpm,
    magSize: g.magSize,
    reloadTime: g.reloadTime,
    bulletSpeed: g.bulletSpeed,
    range: g.range,
    pellets: g.pellets,
    spreadMul: 1,
    speedMul: 1,
    dmgMul: 1,
    maxHp: 100,
  };
}

export const WAVE_CLEAR_XP = 25;

export function xpForLevel(level) {
  return 30 + (level - 1) * 18;
}

export function xpForKill(type, elite = false) {
  const t = ENEMY_TYPES[type];
  return Math.max(2, Math.round(((t ? t.score : 0) / 10) * (elite ? ELITE.scoreMul : 1)));
}

/* ---------------- 波次天赋卡（三选一肉鸽抽卡） ---------------- */

// 三档稀有度：普通=固定数值，稀有(绿)/传说(金)=附带特效，金色最强。
// weight 是抽卡权重（普通 70 / 绿 22 / 金 8），金绿都是低概率惊喜。
export const CARD_RARITIES = {
  common: { id: 'common', label: '普通', weight: 70, color: 0xd8d2c4, css: '#d8d2c4', glow: 'rgba(216,210,196,.45)', order: 0 },
  rare: { id: 'rare', label: '稀有', weight: 22, color: 0x7ee06a, css: '#7ee06a', glow: 'rgba(126,224,106,.6)', order: 1 },
  gold: { id: 'gold', label: '传说', weight: 8, color: 0xffc63a, css: '#ffc63a', glow: 'rgba(255,198,58,.75)', order: 2 },
};

// 每张卡可重复抽取叠层（max 层封顶）。desc(n) 描述「叠到第 n 层」时的效果，
// 抽卡界面预览 desc(当前层数+1)，已获列表展示 desc(当前层数)。
export const CARDS = [
  // ---- 普通：固定属性 ----
  { id: 'c_dmg', rarity: 'common', name: '尖嘴利喙', icon: '喙', max: 5, tag: '火力', desc: (n) => `子弹伤害 +${12 * n}%` },
  { id: 'c_hp', rarity: 'common', name: '贴秋膘', icon: '膘', max: 5, tag: '生存', desc: (n) => `生命上限 +${25 * n}` },
  { id: 'c_speed', rarity: 'common', name: '冲鸭', icon: '冲', max: 4, tag: '机动', desc: (n) => `移动速度 +${8 * n}%` },
  { id: 'c_reload', rarity: 'common', name: '快手换弹', icon: '换', max: 3, tag: '火力', desc: (n) => `换弹速度 +${[0, 18, 33, 45][n]}%` },
  { id: 'c_mag', rarity: 'common', name: '加长弹匣', icon: '匣', max: 3, tag: '火力', desc: (n) => `弹匣容量 +${25 * n}%` },
  { id: 'c_rate', rarity: 'common', name: '狂热扣扳', icon: '速', max: 4, tag: '火力', desc: (n) => `射速 +${12 * n}%` },
  { id: 'c_dash', rarity: 'common', name: '溜了溜了', icon: '溜', max: 3, tag: '机动', desc: (n) => `冲刺冷却 -${[0, 18, 32, 44][n]}%` },
  { id: 'c_armor', rarity: 'common', name: '硬羽绒', icon: '甲', max: 3, tag: '生存', desc: (n) => `受到伤害 -${[0, 12, 22, 30][n]}%` },
  { id: 'c_spread', rarity: 'common', name: '稳如老鸭', icon: '稳', max: 3, tag: '火力', desc: (n) => `子弹散布 -${[0, 22, 38, 50][n]}%` },
  { id: 'c_regen', rarity: 'common', name: '自愈绒毛', icon: '愈', max: 3, tag: '生存', desc: (n) => `脱战回血 ${4 + 3 * n}/秒` },
  { id: 'c_coin', rarity: 'common', name: '财迷鸭', icon: '财', max: 3, tag: '收益', desc: (n) => `击杀金币 +${25 * n}%` },
  { id: 'c_xp', rarity: 'common', name: '好学鸭', icon: '学', max: 3, tag: '收益', desc: (n) => `获得经验 +${25 * n}%` },
  { id: 'c_range', rarity: 'common', name: '加长枪管', icon: '远', max: 3, tag: '火力', desc: (n) => `射程 +${18 * n}% · 衰减后移` },
  { id: 'c_ammo', rarity: 'common', name: '弹药囤积', icon: '囤', max: 3, tag: '续航', desc: (n) => `立即 +48 备弹 · 弹药箱拾取 +${50 * n}%` },

  // ---- 稀有（绿）：附带特效 ----
  { id: 'r_explosive', rarity: 'rare', name: '爆破弹', icon: '爆', max: 3, tag: '特效', desc: (n) => `命中引爆：半径 ${(2 + 0.4 * n).toFixed(1)} 造成 ${35 + 10 * n}% 溅射伤害` },
  { id: 'r_pierce', rarity: 'rare', name: '穿甲弹', icon: '穿', max: 2, tag: '特效', desc: (n) => `子弹穿透 ${n} 个敌人后继续飞行` },
  { id: 'r_frost', rarity: 'rare', name: '霜冻弹', icon: '霜', max: 2, tag: '特效', desc: (n) => `命中减速 ${40 + 10 * n}% 持续 ${(2 + 0.5 * n).toFixed(1)}s` },
  { id: 'r_lifesteal', rarity: 'rare', name: '吸血喙', icon: '吸', max: 3, tag: '特效', desc: (n) => `造成伤害的 ${5 * n}% 转为生命` },
  { id: 'r_crit', rarity: 'rare', name: '致命一击', icon: '暴', max: 3, tag: '特效', desc: (n) => `${15 + 7 * n}% 概率暴击，伤害 ×${(2 + 0.2 * n).toFixed(1)}` },
  { id: 'r_thorns', rarity: 'rare', name: '荆棘羽绒', icon: '棘', max: 2, tag: '特效', desc: (n) => `受击反弹：半径 3 内敌人受 ${25 * n} 伤害` },
  { id: 'r_killheal', rarity: 'rare', name: '吃鸭补鸭', icon: '补', max: 3, tag: '特效', desc: (n) => `击杀回复 ${6 * n} 生命 · 溢出治疗转护盾（上限 ${20 * n}）` },
  { id: 'r_waveShield', rarity: 'rare', name: '开工护盾', icon: '盾', max: 3, tag: '特效', desc: (n) => `每波开始获得 ${60 * n} 点护盾` },
  { id: 'r_dashBlast', rarity: 'rare', name: '铁头冲撞', icon: '撞', max: 2, tag: '特效', desc: (n) => `冲刺撞击造成 ${30 * n} 伤害并强力击退` },
  { id: 'r_burn', rarity: 'rare', name: '燃烧弹', icon: '燃', max: 2, tag: '特效', desc: (n) => `命中点燃：${8 * n} 伤害/秒，持续 3s` },
  { id: 'r_magnet', rarity: 'rare', name: '拾取磁铁', icon: '磁', max: 2, tag: '特效', desc: (n) => `拾取范围 ×${(1 + 1.4 * n).toFixed(1)} · 每次拾取回血 ${4 * n}` },
  { id: 'r_ammoBack', rarity: 'rare', name: '弹药回收', icon: '收', max: 2, tag: '特效', desc: (n) => `击杀有 ${25 * n}% 概率回收 2 发备弹` },

  // ---- 传说（金）：最强特效 ----
  { id: 'g_chain', rarity: 'gold', name: '连锁闪电', icon: '链', max: 2, tag: '传说', desc: (n) => `命中电击弹射 ${n + 1} 个附近敌人，各受 ${60 + 15 * n}% 伤害` },
  { id: 'g_orbit', rarity: 'gold', name: '护卫羽毛', icon: '卫', max: 2, tag: '传说', desc: (n) => `${2 + n} 枚羽毛环绕自身，接触每秒造成 ${30 + 15 * n} 伤害` },
  { id: 'g_execute', rarity: 'gold', name: '处决喙', icon: '决', max: 2, tag: '传说', desc: (n) => `命中血量低于 ${15 + 7 * n}% 的敌人直接处决（Boss 阈值减半）` },
  { id: 'g_phoenix', rarity: 'gold', name: '不死鸟', icon: '凰', max: 1, tag: '传说', desc: () => '本局首次致死伤害时复活，回复 60% 生命并击退全场' },
  { id: 'g_berserk', rarity: 'gold', name: '血怒', icon: '怒', max: 2, tag: '传说', desc: (n) => `生命越低伤害越高，残血时最高 +${50 + 20 * n}%` },
  { id: 'g_multishot', rarity: 'gold', name: '双管齐下', icon: '双', max: 2, tag: '传说', desc: (n) => `每次射击额外发射 ${n} 发平行子弹` },
  { id: 'g_guardian', rarity: 'gold', name: '守护结界', icon: '界', max: 2, tag: '传说', desc: (n) => `每 ${n > 1 ? 6 : 9} 秒自动完全抵挡一次伤害` },
  { id: 'g_goldRush', rarity: 'gold', name: '点金术', icon: '金', max: 2, tag: '传说', desc: (n) => `击杀金币 ×${1 + n} · 击杀额外掉落打工人福利` },
  { id: 'g_timeKill', rarity: 'gold', name: '时停收割', icon: '停', max: 2, tag: '传说', desc: (n) => `击杀有 ${12 + 8 * n}% 概率触发全场减速 ${(1.2 + 0.4 * n).toFixed(1)}s` },
  { id: 'g_storm', rarity: 'gold', name: '乱杀精通', icon: '杀', max: 3, tag: '传说', desc: (n) => `「嘎嘎乱杀」伤害 +${40 * n} · 半径 +${(1.2 * n).toFixed(1)} · 冷却 -${15 * n}%` },
];

export const CARD_BY_ID = Object.fromEntries(CARDS.map((c) => [c.id, c]));

// 叠到上限的卡不再进入抽卡池
export function cardAvailable(card, owned = {}) {
  return (owned[card.id] || 0) < card.max;
}

export function rollCardRarity(rng) {
  const list = Object.values(CARD_RARITIES);
  const total = list.reduce((a, r) => a + r.weight, 0);
  let roll = rng() * total;
  for (const r of list) { roll -= r.weight; if (roll < 0) return r.id; }
  return 'common';
}

// 抽 count 张互不相同的卡。Boss 波（每 5 波）保底一张金卡作为通关奖励；
// 某档稀有度抽空时降级到其它可用档，保证永远凑满 count 张（卡池枯竭则少于 count）。
export function rollCards(rng, owned = {}, wave = 1, count = 3) {
  const pool = CARDS.filter((c) => cardAvailable(c, owned));
  const picked = [];
  const take = (rarity) => {
    let cand = pool.filter((c) => c.rarity === rarity && !picked.includes(c));
    if (!cand.length) cand = pool.filter((c) => !picked.includes(c));
    if (!cand.length) return null;
    const c = cand[Math.floor(rng() * cand.length) % cand.length];
    picked.push(c);
    return c;
  };
  if (wave > 0 && wave % 5 === 0) take('gold');
  while (picked.length < Math.min(count, pool.length)) take(rollCardRarity(rng));
  return picked.map((c) => ({ ...c, stacks: owned[c.id] || 0, next: (owned[c.id] || 0) + 1 }));
}

// 卡牌层数 → 战斗数值。mods 是特效描述集合，game.js 按存在与否启用对应机制。
export function cardEffects(owned = {}, level = 1) {
  const r = (id) => owned[id] || 0;
  const mods = {};
  if (r('r_explosive')) mods.explosive = { radius: 2 + 0.4 * r('r_explosive'), mul: 0.35 + 0.1 * r('r_explosive') };
  if (r('r_pierce')) mods.pierce = r('r_pierce');
  if (r('r_frost')) mods.frost = { factor: 1 - (0.4 + 0.1 * r('r_frost')), duration: 2 + 0.5 * r('r_frost') };
  if (r('r_lifesteal')) mods.lifesteal = 0.05 * r('r_lifesteal');
  if (r('r_crit')) mods.crit = { chance: 0.15 + 0.07 * r('r_crit'), mul: 2 + 0.2 * r('r_crit') };
  if (r('r_thorns')) mods.thorns = { radius: 3, damage: 25 * r('r_thorns') };
  if (r('r_waveShield')) mods.waveShield = 60 * r('r_waveShield');
  if (r('r_dashBlast')) mods.dashBlast = { damage: 30 * r('r_dashBlast'), knock: 9 };
  if (r('r_burn')) mods.burn = { dps: 8 * r('r_burn'), duration: 3 };
  if (r('r_magnet')) mods.magnet = { mul: 1 + 1.4 * r('r_magnet'), heal: 4 * r('r_magnet') };
  if (r('r_ammoBack')) mods.ammoBack = 0.25 * r('r_ammoBack');
  // 吃鸭补鸭：击杀回血 + 溢出治疗转护盾，让「回血卡」在满血时也不浪费
  if (r('r_killheal')) mods.overheal = 20 * r('r_killheal');
  if (r('g_chain')) mods.chain = { count: r('g_chain') + 1, mul: 0.6 + 0.15 * r('g_chain') };
  if (r('g_orbit')) mods.orbit = { count: 2 + r('g_orbit'), dps: 30 + 15 * r('g_orbit') };
  if (r('g_execute')) mods.execute = 0.15 + 0.07 * r('g_execute');
  if (r('g_phoenix')) mods.phoenix = true;
  if (r('g_berserk')) mods.berserk = 0.5 + 0.2 * r('g_berserk');
  if (r('g_multishot')) mods.multishot = r('g_multishot');
  if (r('g_guardian')) mods.guardian = r('g_guardian') > 1 ? 6 : 9;
  if (r('g_goldRush')) mods.goldRush = 1 + r('g_goldRush');
  if (r('g_timeKill')) mods.timeKill = { chance: 0.12 + 0.08 * r('g_timeKill'), duration: 1.2 + 0.4 * r('g_timeKill') };
  return {
    dmgBonus: 1 + 0.12 * r('c_dmg'),
    maxHpBonus: 25 * r('c_hp'),
    speedBonus: 1 + 0.08 * r('c_speed'),
    reloadMul: [1, 0.82, 0.67, 0.55][r('c_reload')],
    magMul: 1 + 0.25 * r('c_mag'),
    rateMul: 1 + 0.12 * r('c_rate'),
    dashCdMul: [1, 0.82, 0.68, 0.56][r('c_dash')],
    armorMul: [1, 0.88, 0.78, 0.7][r('c_armor')],
    spreadMul: [1, 0.78, 0.62, 0.5][r('c_spread')],
    regen: 4 + 3 * r('c_regen'),
    coinMul: 1 + 0.25 * r('c_coin'),
    xpMul: 1 + 0.25 * r('c_xp'),
    rangeMul: 1 + 0.18 * r('c_range'),
    ammoPickupMul: 1 + 0.5 * r('c_ammo'),
    killHeal: 6 * r('r_killheal'),
    // 技能解锁只看等级（开局1个，每3级+1）；金卡「乱杀精通」强化乱杀数值
    skills: skillsForLevel(level),
    storm: {
      damage: 60 + 40 * r('g_storm'),
      radius: 4.5 + 1.2 * r('g_storm'),
      knock: 6,
      cdMul: 1 - 0.15 * r('g_storm'),
    },
    shield: { pool: 80, duration: 6 },
    rage: { duration: 6, rpmMul: 1.45, dmgMul: 1.35 },
    slow: { duration: 5, factor: 0.35 },
    mods,
  };
}

export const SKILLS = [
  { id: 'storm', key: 1, label: '嘎嘎乱杀', icon: '嘎', cd: 12 },
  { id: 'shield', key: 2, label: '抱头蹲防', icon: '蹲', cd: 18 },
  { id: 'rage', key: 3, label: '红温暴走', icon: '温', cd: 20 },
  { id: 'slow', key: 4, label: '嘎瓦鲁多', icon: '停', cd: 22 },
];

// 技能随等级解锁：开局 1 个（嘎嘎乱杀），之后每 3 级 +1，Lv.9 四技能齐。
// requiredLevel 是唯一来源：解锁判定、HUD 锁定标签、未解锁提示都从它推导。
export const SKILL_EVERY_LEVELS = 3;
for (let i = 0; i < SKILLS.length; i++) SKILLS[i].requiredLevel = i === 0 ? 1 : i * SKILL_EVERY_LEVELS;
export function skillCountForLevel(level) {
  return Math.min(SKILLS.length, 1 + Math.floor(Math.max(1, level) / SKILL_EVERY_LEVELS));
}
export function skillsForLevel(level) {
  const n = skillCountForLevel(level);
  return Object.fromEntries(SKILLS.map((s, i) => [s.id, i < n]));
}

// 武器数值 × 卡牌加成。射程延长时衰减区间同比后移，避免「加射程却全程最低伤」。
export function applyCards(lo, ef) {
  const rm = ef.rangeMul ?? 1;
  return {
    ...lo,
    damage: lo.damage * ef.dmgBonus,
    maxHp: lo.maxHp + ef.maxHpBonus,
    speedMul: lo.speedMul * ef.speedBonus,
    rpm: lo.rpm * (ef.rateMul ?? 1),
    magSize: Math.round(lo.magSize * (ef.magMul ?? 1)),
    reloadTime: lo.reloadTime * (ef.reloadMul ?? 1),
    spreadMul: lo.spreadMul * (ef.spreadMul ?? 1),
    dmgMul: lo.dmgMul * (ef.armorMul ?? 1),
    range: lo.range * rm,
    falloffStart: lo.gun.falloffStart * rm,
    falloffEnd: lo.gun.falloffEnd * rm,
    falloffMin: lo.gun.falloffMin,
    dashCdMul: ef.dashCdMul,
    killHeal: ef.killHeal,
    regen: ef.regen ?? 4,
    coinMul: ef.coinMul ?? 1,
    xpMul: ef.xpMul ?? 1,
    ammoPickupMul: ef.ammoPickupMul ?? 1,
    skills: ef.skills,
    storm: ef.storm,
    shield: ef.shield,
    rage: ef.rage,
    slow: ef.slow,
    mods: ef.mods || {},
  };
}
/* ---------------- 准星落点预测 ---------------- */

// 射线与球（敌人包围球）近交点距离；未命中或背向返回 -1
export function raySphereT(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = ox - cx, ly = oy - cy, lz = oz - cz;
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - c;
  if (disc <= 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : -1;
}

// 沿单位方向步进模拟弹道，返回首个命中点（敌人 / 掩体 / 地面）或射程末端
export function marchImpact(origin, dir, range, targets, isBlocked, groundAt, step = 0.5) {
  let x = origin.x, y = origin.y, z = origin.z;
  for (let d = 0; d < range; d += step) {
    x += dir.x * step; y += dir.y * step; z += dir.z * step;
    for (const t of targets) {
      if (Math.hypot(x - t.x, z - t.z) < t.radius && y < t.height) return { x, y, z, hit: 'enemy' };
    }
    if (y < 1.8 && isBlocked(x, z)) return { x, y, z, hit: 'wall' };
    if (y <= groundAt(x, z) + 0.04) return { x, y, z, hit: 'ground' };
  }
  return { x, y, z, hit: 'none' };
}
