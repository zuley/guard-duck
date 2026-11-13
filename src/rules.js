export const WEAPON = {
  name: '「谷仓」卡宾枪',
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
    label: '空手灰鸭',
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
    label: '棍棒灰鸭',
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
    label: '小刀绿鸭',
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
    label: '手枪灰鸭',
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
    label: '步枪灰鸭',
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
    label: '霰弹重装胖鸭',
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
    label: '鸭王「暴君」',
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
    brawler: wave === 1 ? 6 : Math.max(2, 10 - wave * 2),
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
    return wave === 5 ? '霰弹重装压阵，鸭王亲自出马！' : '鸭王驾到！集中火力，击败它赢取重赏！';
  }
  switch (wave) {
    case 1: return '空手鸭群扑来，先热热身！';
    case 2: return '棍棒与小刀登场，小心近身挥击！';
    case 3: return '手枪出现，利用干草垛掩体！';
    case 4: return '步枪火力压制，别在开阔地停留！';
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

export const LOOT_ITEMS = [
  { id: 'head', label: '鸭头', price: 20, weight: 4, color: 0xe8a05c },
  { id: 'neck', label: '鸭脖', price: 16, weight: 6, color: 0xd08850 },
  { id: 'clavicle', label: '鸭锁骨', price: 14, weight: 6, color: 0xc87840 },
  { id: 'wing', label: '鸭翅', price: 12, weight: 8, color: 0xe0b070 },
  { id: 'foot', label: '鸭掌', price: 10, weight: 8, color: 0xf08c1e },
  { id: 'gizzard', label: '鸭胗', price: 8, weight: 9, color: 0xa05038 },
  { id: 'liver', label: '鸭肝', price: 8, weight: 9, color: 0x8a4030 },
  { id: 'intestine', label: '鸭肠', price: 6, weight: 10, color: 0xe8c090 },
  { id: 'esophagus', label: '鸭食管', price: 6, weight: 8, color: 0xd8b080 },
  { id: 'blood', label: '鸭血', price: 4, weight: 10, color: 0xa02828 },
  { id: 'feather', label: '鸭毛', price: 3, weight: 12, color: 0xf0e6d0 },
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

export const GUNS = {
  carbine: { label: '「谷仓」卡宾枪', price: 0, model: 'rifle', damage: 26, rpm: 540, magSize: 24, reloadTime: 1.6, bulletSpeed: 70, spreadBase: 0.012, pellets: 1, falloffStart: 18, falloffEnd: 34, falloffMin: 0.55 },
  repeater: { label: '「牧群」连发枪', price: 320, model: 'rifle', damage: 20, rpm: 780, magSize: 36, reloadTime: 1.7, bulletSpeed: 74, spreadBase: 0.016, pellets: 1, falloffStart: 16, falloffEnd: 30, falloffMin: 0.5 },
  shotgun: { label: '「干草」霰弹枪', price: 400, model: 'shotgun', damage: 15, rpm: 150, magSize: 6, reloadTime: 2.0, bulletSpeed: 55, spreadBase: 0.035, pellets: 6, pelletSpread: 0.1, falloffStart: 9, falloffEnd: 18, falloffMin: 0.3 },
  longrifle: { label: '「守夜」重步枪', price: 620, model: 'rifle', damage: 46, rpm: 300, magSize: 16, reloadTime: 1.9, bulletSpeed: 90, spreadBase: 0.006, pellets: 1, falloffStart: 30, falloffEnd: 55, falloffMin: 0.75 },
};

export const GEAR = {
  armor: {
    label: '盔甲',
    levels: [
      { price: 260, desc: '受到伤害 -30%' },
      { price: 520, desc: '受到伤害 -45%' },
      { price: 880, desc: '受到伤害 -60%' },
    ],
  },
  helmet: {
    label: '头盔',
    levels: [
      { price: 200, desc: '生命上限 +30' },
      { price: 420, desc: '生命上限 +60' },
      { price: 760, desc: '生命上限 +100' },
    ],
  },
  shoes: {
    label: '鞋子',
    levels: [
      { price: 150, desc: '移动速度 +15%' },
      { price: 320, desc: '移动速度 +25%' },
      { price: 560, desc: '移动速度 +35%' },
    ],
  },
  gloves: {
    label: '手套',
    levels: [
      { price: 120, desc: '换弹 -30% · 散布 -25%' },
      { price: 280, desc: '换弹 -45% · 散布 -40%' },
      { price: 500, desc: '换弹 -60% · 散布 -50%' },
    ],
  },
};

export function gearNext(id, level = 0) {
  const g = GEAR[id];
  if (!g || level >= g.levels.length) return null;
  const l = g.levels[level];
  return { level: level + 1, price: l.price, desc: l.desc };
}

const gearLevel = (v) => (v === true ? 1 : (v || 0));

export function computeLoadout(gunId, gear = {}) {
  const g = GUNS[gunId] || GUNS.carbine;
  const armor = gearLevel(gear.armor);
  const helmet = gearLevel(gear.helmet);
  const shoes = gearLevel(gear.shoes);
  const gloves = gearLevel(gear.gloves);
  return {
    gun: g,
    damage: g.damage,
    rpm: g.rpm,
    magSize: g.magSize,
    reloadTime: g.reloadTime * [1, 0.7, 0.55, 0.4][gloves],
    bulletSpeed: g.bulletSpeed,
    pellets: g.pellets,
    spreadMul: [1, 0.75, 0.6, 0.5][gloves],
    speedMul: [1, 1.15, 1.25, 1.35][shoes],
    dmgMul: [1, 0.7, 0.55, 0.4][armor],
    maxHp: 100 + [0, 30, 60, 100][helmet],
  };
}

export function shopCatalog() {
  const guns = Object.entries(GUNS)
    .filter(([, g]) => g.price > 0)
    .map(([id, g]) => ({
      id, kind: 'gun', label: g.label, price: g.price,
      desc: `${g.damage} 伤害 · ${g.rpm} 射速 · ${g.magSize} 弹匣${g.pellets > 1 ? ` · ${g.pellets} 弹丸` : ''}`,
    }));
  const ammo = [{ id: 'ammo', kind: 'ammo', label: '子弹箱', price: 60, desc: '备弹 +48' }];
  const gear = Object.entries(GEAR).map(([id, g]) => ({ id, kind: 'gear', label: g.label, price: g.levels[0].price, desc: g.levels[0].desc }));
  return [...guns, ...ammo, ...gear];
}

export const WAVE_CLEAR_XP = 25;

export function xpForLevel(level) {
  return 30 + (level - 1) * 18;
}

export function xpForKill(type, elite = false) {
  const t = ENEMY_TYPES[type];
  return Math.max(2, Math.round(((t ? t.score : 0) / 10) * (elite ? ELITE.scoreMul : 1)));
}

export const TALENT_BRANCHES = [
  { id: 'fire', label: '火力', color: 0xff5346, desc: '输出拉满，嘎嘎乱杀' },
  { id: 'guard', label: '守护', color: 0x7ee06a, desc: '苟住别浪，活着才有输出' },
  { id: 'swift', label: '迅捷', color: 0x6fd6ff, desc: '打不过就跑，跑得快' },
];

export const TALENTS = [
  { id: 't_dmg', branch: 'fire', tier: 1, label: '嘴强王者', name: '嘴强王者', max: 3, req: null, desc: (r) => `子弹伤害 +${8 * (r + 1)}%` },
  { id: 't_storm', branch: 'fire', tier: 2, label: '嘎嘎乱杀', name: '嘎嘎乱杀', max: 1, req: 't_dmg', skill: 'storm', desc: () => '解锁主动技能「嘎嘎乱杀」(键1)' },
  { id: 't_storm2', branch: 'fire', tier: 3, label: '杀疯了', name: '杀疯了', max: 2, req: 't_storm', desc: (r) => `乱杀伤害 +${25 * (r + 1)} · 半径 +${(0.8 * (r + 1)).toFixed(1)}` },
  { id: 't_rage', branch: 'fire', tier: 4, label: '红温暴走', name: '红温暴走', max: 1, req: 't_storm2', skill: 'rage', desc: () => '解锁主动技能「红温暴走」(键3)' },
  { id: 't_hp', branch: 'guard', tier: 1, label: '贴秋膘', name: '贴秋膘', max: 3, req: null, desc: (r) => `生命上限 +${20 * (r + 1)}` },
  { id: 't_shield', branch: 'guard', tier: 2, label: '抱头蹲防', name: '抱头蹲防', max: 1, req: 't_hp', skill: 'shield', desc: () => '解锁主动技能「抱头蹲防」(键2)' },
  { id: 't_shield2', branch: 'guard', tier: 3, label: '加厚羽绒', name: '加厚羽绒', max: 2, req: 't_shield', desc: (r) => `蹲防护盾 +${40 * (r + 1)} · 持续 +${2 * (r + 1)}s` },
  { id: 't_regen', branch: 'guard', tier: 4, label: '吃鸭补鸭', name: '吃鸭补鸭', max: 2, req: 't_shield2', desc: (r) => `每次击杀回复 ${4 * (r + 1)} 生命` },
  { id: 't_speed', branch: 'swift', tier: 1, label: '冲鸭', name: '冲鸭', max: 3, req: null, desc: (r) => `移动速度 +${6 * (r + 1)}%` },
  { id: 't_slow', branch: 'swift', tier: 2, label: '嘎瓦鲁多', name: '嘎瓦鲁多', max: 1, req: 't_speed', skill: 'slow', desc: () => '解锁主动技能「嘎瓦鲁多」(键4)' },
  { id: 't_slow2', branch: 'swift', tier: 3, label: '时停续杯', name: '时停续杯', max: 2, req: 't_slow', desc: (r) => `减速持续 +${1.5 * (r + 1)}s · 敌人更慢` },
  { id: 't_dash', branch: 'swift', tier: 4, label: '溜了溜了', name: '溜了溜了', max: 2, req: 't_slow2', desc: (r) => `冲刺冷却 -${20 * (r + 1)}%` },
];

export function talentNext(id, ranks = 0) {
  const t = TALENTS.find((x) => x.id === id);
  if (!t || ranks >= t.max) return null;
  return { rank: ranks + 1, cost: 1 };
}

export function talentEffects(ranks = {}) {
  const r = (id) => ranks[id] || 0;
  return {
    dmgBonus: 1 + 0.08 * r('t_dmg'),
    maxHpBonus: 20 * r('t_hp'),
    speedBonus: 1 + 0.06 * r('t_speed'),
    killHeal: 4 * r('t_regen'),
    dashCdMul: 1 - 0.2 * r('t_dash'),
    skills: {
      storm: r('t_storm') > 0,
      shield: r('t_shield') > 0,
      rage: r('t_rage') > 0,
      slow: r('t_slow') > 0,
    },
    storm: { damage: 60 + 25 * r('t_storm2'), radius: 4.5 + 0.8 * r('t_storm2'), knock: 6 },
    shield: { pool: 80 + 40 * r('t_shield2'), duration: 6 + 2 * r('t_shield2') },
    rage: { duration: 6, rpmMul: 1.45, dmgMul: 1.35 },
    slow: { duration: 5 + 1.5 * r('t_slow2'), factor: 0.35 - 0.1 * r('t_slow2') },
  };
}

export const SKILLS = [
  { id: 'storm', key: 1, label: '嘎嘎乱杀', icon: '嘎', cd: 12 },
  { id: 'shield', key: 2, label: '抱头蹲防', icon: '蹲', cd: 18 },
  { id: 'rage', key: 3, label: '红温暴走', icon: '温', cd: 20 },
  { id: 'slow', key: 4, label: '嘎瓦鲁多', icon: '停', cd: 22 },
];

export function applyTalents(lo, ef) {
  return {
    ...lo,
    damage: lo.damage * ef.dmgBonus,
    maxHp: lo.maxHp + ef.maxHpBonus,
    speedMul: lo.speedMul * ef.speedBonus,
    dashCdMul: ef.dashCdMul,
    killHeal: ef.killHeal,
    skills: ef.skills,
    storm: ef.storm,
    shield: ef.shield,
    rage: ef.rage,
    slow: ef.slow,
  };
}