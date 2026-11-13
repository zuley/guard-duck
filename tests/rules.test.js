import { describe, it, expect } from 'vitest';
import {
  WEAPON,
  ENEMY_TYPES,
  LOOT_ITEMS,
  GUNS,
  GEAR,
  mulberry32,
  wavePlan,
  waveIntro,
  damageAtDistance,
  currentSpread,
  scoreFor,
  rollDrop,
  canEngage,
  coinsFor,
  rollLoot,
  computeLoadout,
  shopCatalog,
  skillCenter,
  gearNext,
  xpForLevel,
  xpForKill,
  WAVE_CLEAR_XP,
  TALENT_BRANCHES,
  TALENTS,
  talentNext,
  talentEffects,
  SKILLS,
  applyTalents,
  ELITE,
  eliteHpMul,
  ELITE_SKILL,
  BOSS_SKILL,
  raySphereT,
  marchImpact,
} from '../src/rules.js';

const MELEE_WEAPONS = ['fists', 'club', 'knife'];
const RANGED_WEAPONS = ['pistol', 'rifle', 'shotgun'];
const totalOf = (p) => Object.values(p.counts).reduce((a, b) => a + b, 0);

describe('mulberry32', () => {
  it('同种子产生相同序列', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).toEqual(seqB);
  });
  it('不同种子序列不同且值域 [0,1)', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).not.toEqual(seqB);
    for (const v of [...seqA, ...seqB]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('wavePlan 武器递进', () => {
  it('第 1 波全部空手敌人（另含 1 精英）', () => {
    const p = wavePlan(1);
    expect(p.counts.brawler).toBeGreaterThanOrEqual(4);
    for (const [type, n] of Object.entries(p.counts)) {
      if (type !== 'brawler' && type !== 'elite') expect(n).toBe(0);
    }
    expect(p.counts.elite).toBe(1);
    expect(ENEMY_TYPES.brawler.weapon).toBe('fists');
  });
  it('第 2 波混入棍棒与小刀近战，仍无枪械', () => {
    const p = wavePlan(2);
    expect(p.counts.clubber).toBeGreaterThan(0);
    expect(p.counts.knifer).toBeGreaterThan(0);
    expect(p.counts.pistol).toBe(0);
    expect(p.counts.rifle).toBe(0);
    expect(p.counts.heavy).toBe(0);
    expect(ENEMY_TYPES.clubber.weapon).toBe('club');
    expect(ENEMY_TYPES.knifer.weapon).toBe('knife');
  });
  it('第 3 波混入手枪，尚无步枪与霰弹', () => {
    const p = wavePlan(3);
    expect(p.counts.pistol).toBeGreaterThan(0);
    expect(p.counts.rifle).toBe(0);
    expect(p.counts.heavy).toBe(0);
  });
  it('第 4 波混入步枪，尚无霰弹重装', () => {
    const p = wavePlan(4);
    expect(p.counts.rifle).toBeGreaterThan(0);
    expect(p.counts.heavy).toBe(0);
  });
  it('第 5 波混入霰弹重装，第 6 波常规兵种全员齐备', () => {
    expect(wavePlan(5).counts.heavy).toBeGreaterThan(0);
    const p6 = wavePlan(6);
    for (const [type, n] of Object.entries(p6.counts)) {
      if (type !== 'boss') expect(n).toBeGreaterThan(0);
    }
  });
  it('波次越高敌人越多', () => {
    const totals = [];
    for (let w = 1; w <= 12; w++) totals.push(totalOf(wavePlan(w)));
    for (let i = 1; i < totals.length; i++) {
      expect(totals[i]).toBeGreaterThanOrEqual(totals[i - 1]);
    }
  });
  it('单波敌人数量有上限，保证迷你关卡性能', () => {
    for (let w = 1; w <= 60; w++) {
      expect(totalOf(wavePlan(w))).toBeLessThanOrEqual(42);
    }
  });
  it('血量与速度随波次成长但有封顶', () => {
    const p1 = wavePlan(1);
    const p10 = wavePlan(10);
    const p60 = wavePlan(60);
    expect(p10.hpScale).toBeGreaterThan(p1.hpScale);
    expect(p60.hpScale).toBeLessThanOrEqual(4);
    expect(p60.speedScale).toBeLessThanOrEqual(1.4);
  });
});

describe('敌人武器定义', () => {
  it('每个类型都有武器与外观底盘', () => {
    for (const t of Object.values(ENEMY_TYPES)) {
      expect([...MELEE_WEAPONS, ...RANGED_WEAPONS]).toContain(t.weapon);
      expect(['grunt', 'runner', 'tank']).toContain(t.palette);
    }
  });
  it('近战类型有攻击距离/前摇/冷却，远程类型有射程/射速/弹速', () => {
    for (const t of Object.values(ENEMY_TYPES)) {
      if (MELEE_WEAPONS.includes(t.weapon)) {
        expect(t.reach).toBeGreaterThan(0);
        expect(t.windup).toBeGreaterThan(0);
        expect(t.attackInterval).toBeGreaterThan(0);
      } else {
        expect(t.range).toBeGreaterThan(0);
        expect(t.fireInterval).toBeGreaterThan(0);
        expect(t.bulletSpeed).toBeGreaterThan(0);
      }
    }
  });
  it('武器越先进威胁越大：伤害或射程递增', () => {
    expect(ENEMY_TYPES.clubber.damage).toBeGreaterThan(ENEMY_TYPES.brawler.damage);
    expect(ENEMY_TYPES.rifle.bulletSpeed).toBeGreaterThan(ENEMY_TYPES.pistol.bulletSpeed);
    expect(ENEMY_TYPES.heavy.pellets).toBeGreaterThan(1);
  });
});

describe('waveIntro 波次预告', () => {
  it('前 5 波预告各自的新武器且互不相同', () => {
    const intros = [1, 2, 3, 4, 5].map(waveIntro);
    expect(new Set(intros).size).toBe(5);
    expect(intros[1]).toMatch(/棍|刀/);
    expect(intros[2]).toMatch(/手枪/);
    expect(intros[3]).toMatch(/步枪/);
    expect(intros[4]).toMatch(/霰弹|重装/);
  });
  it('后续波次也有可用文案', () => {
    expect(waveIntro(9).length).toBeGreaterThan(0);
  });
});

describe('damageAtDistance', () => {
  it('近距离满伤害，远距离衰减到下限', () => {
    expect(damageAtDistance(WEAPON.damage, 2)).toBe(WEAPON.damage);
    expect(damageAtDistance(WEAPON.damage, 100)).toBeCloseTo(
      WEAPON.damage * WEAPON.falloffMin,
      5
    );
  });
  it('衰减单调不增', () => {
    let prev = Infinity;
    for (let d = 0; d <= 60; d += 2) {
      const v = damageAtDistance(WEAPON.damage, d);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('currentSpread', () => {
  it('静止冷枪最准，移动与连射扩大散布', () => {
    const idle = currentSpread(0, false);
    const moving = currentSpread(0, true);
    const hot = currentSpread(1, false);
    expect(idle).toBeCloseTo(WEAPON.spreadBase, 6);
    expect(moving).toBeGreaterThan(idle);
    expect(hot).toBeGreaterThan(idle);
    expect(currentSpread(1, true)).toBeGreaterThan(hot);
  });
});

describe('scoreFor', () => {
  it('武器越高级分数越高，且随波次加成', () => {
    expect(scoreFor('heavy', 1)).toBeGreaterThan(scoreFor('rifle', 1));
    expect(scoreFor('rifle', 1)).toBeGreaterThan(scoreFor('brawler', 1));
    expect(scoreFor('brawler', 5)).toBeGreaterThan(scoreFor('brawler', 1));
  });
  it('未知类型返回 0 而不是 NaN', () => {
    expect(scoreFor('dragon', 3)).toBe(0);
  });
});

describe('精英强化单位', () => {
  it('每波固定 1 精英，每 5 波另有 Boss', () => {
    for (const w of [1, 2, 7, 10, 25]) expect(wavePlan(w).counts.elite).toBe(1);
    expect(wavePlan(10).counts.boss).toBe(1);
    expect(wavePlan(7).counts.boss).toBe(0);
  });
  it('精英不挤占 42 性能上限', () => {
    for (let w = 1; w <= 60; w++) expect(totalOf(wavePlan(w))).toBeLessThanOrEqual(42);
  });
  it('精英体型介于重装与鸭王之间', () => {
    expect(ELITE.scale).toBeGreaterThan(ENEMY_TYPES.heavy.scale);
    expect(ELITE.scale).toBeLessThan(ENEMY_TYPES.boss.scale);
  });
  it('精英血量倍率随波次成长且封顶', () => {
    expect(eliteHpMul(1)).toBeGreaterThanOrEqual(2);
    expect(eliteHpMul(10)).toBeGreaterThan(eliteHpMul(1));
    expect(eliteHpMul(60)).toBeLessThanOrEqual(4);
  });
  it('精英分值 / 金币 / 经验三倍', () => {
    expect(scoreFor('brawler', 1, true)).toBe(3 * scoreFor('brawler', 1));
    expect(coinsFor('rifle', true)).toBe(3 * coinsFor('rifle'));
    expect(xpForKill('heavy', true)).toBe(3 * xpForKill('heavy'));
  });
  it('精英必掉补给箱', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 20; i++) expect(['ammo', 'health']).toContain(rollDrop(rng, 'brawler', false, true));
  });
});

describe('rollDrop', () => {
  it('只返回 ammo / health / null', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 300; i++) {
      const d = rollDrop(rng, 'brawler');
      expect(['ammo', 'health', null]).toContain(d);
    }
  });
  it('掉落概率在合理区间（10%~45%）', () => {
    const rng = mulberry32(99);
    let drops = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) if (rollDrop(rng, 'brawler')) drops++;
    const rate = drops / n;
    expect(rate).toBeGreaterThan(0.1);
    expect(rate).toBeLessThan(0.45);
  });
  it('所有敌人类型定义完整', () => {
    for (const key of Object.keys(ENEMY_TYPES)) {
      const t = ENEMY_TYPES[key];
      expect(t.hp).toBeGreaterThan(0);
      expect(t.speed).toBeGreaterThan(0);
      expect(t.radius).toBeGreaterThan(0);
      expect(t.score).toBeGreaterThan(0);
    }
  });
});

describe('canEngage 开火规则', () => {
  it('超出射程绝不开火', () => {
    expect(canEngage(11, 10, true)).toBe(false);
    expect(canEngage(11, 10, false)).toBe(false);
  });
  it('射程内且进入视野才开火', () => {
    expect(canEngage(9, 10, true)).toBe(true);
  });
  it('视野外仅贴脸（<=5）开火', () => {
    expect(canEngage(8, 10, false)).toBe(false);
    expect(canEngage(5, 10, false)).toBe(true);
  });
  it('射击型敌人射程不超过可见范围', () => {
    for (const t of Object.values(ENEMY_TYPES)) {
      if (RANGED_WEAPONS.includes(t.weapon)) expect(t.range).toBeLessThanOrEqual(10);
    }
  });
});

describe('金币与鸭杂掉落', () => {
  it('击杀金币随敌人阶层递增', () => {
    expect(coinsFor('brawler')).toBeGreaterThan(0);
    expect(coinsFor('heavy')).toBeGreaterThan(coinsFor('rifle'));
    expect(coinsFor('rifle')).toBeGreaterThan(coinsFor('brawler'));
    expect(coinsFor('dragon')).toBe(0);
  });
  it('rollLoot 只返回合法物品且每次 0~2 个', () => {
    const rng = mulberry32(5);
    const ids = new Set(LOOT_ITEMS.map((i) => i.id));
    for (let i = 0; i < 500; i++) {
      const drop = rollLoot(rng);
      expect(drop.length).toBeLessThanOrEqual(2);
      for (const id of drop) expect(ids.has(id)).toBe(true);
    }
  });
  it('长期掉落覆盖全部 11 种鸭杂', () => {
    const rng = mulberry32(11);
    const seen = new Set();
    for (let i = 0; i < 4000; i++) rollLoot(rng).forEach((id) => seen.add(id));
    expect(LOOT_ITEMS.length).toBe(11);
    expect(seen.size).toBe(LOOT_ITEMS.length);
  });
});

describe('商店与装备', () => {
  it('目录覆盖枪支/子弹/四类护具且定价为正', () => {
    const cat = shopCatalog();
    const kinds = new Set(cat.map((g) => g.kind));
    expect(kinds.has('gun')).toBe(true);
    expect(kinds.has('ammo')).toBe(true);
    for (const k of Object.keys(GEAR)) expect(cat.some((g) => g.id === k)).toBe(true);
    for (const g of cat) expect(g.price).toBeGreaterThan(0);
    expect(GUNS.carbine.price).toBe(0);
  });
  it('默认卡宾枪与 WEAPON 数值一致', () => {
    const l = computeLoadout('carbine', {});
    expect(l.damage).toBe(WEAPON.damage);
    expect(l.rpm).toBe(WEAPON.rpm);
    expect(l.magSize).toBe(WEAPON.magSize);
    expect(l.maxHp).toBe(100);
    expect(l.dmgMul).toBe(1);
  });
  it('护具效果：盔甲减伤/头盔加血/鞋子加速/手套换弹与散布', () => {
    const l = computeLoadout('carbine', { armor: true, helmet: true, shoes: true, gloves: true });
    expect(l.dmgMul).toBeCloseTo(0.7, 6);
    expect(l.maxHp).toBe(130);
    expect(l.speedMul).toBeCloseTo(1.15, 6);
    expect(l.reloadTime).toBeCloseTo(WEAPON.reloadTime * 0.7, 6);
    expect(l.spreadMul).toBeCloseTo(0.75, 6);
  });
  it('霰弹枪多弹丸、重步枪高伤低射速', () => {
    const s = computeLoadout('shotgun', {});
    const r = computeLoadout('longrifle', {});
    expect(s.pellets).toBeGreaterThan(1);
    expect(r.damage).toBeGreaterThan(s.damage);
    expect(r.rpm).toBeLessThan(computeLoadout('carbine', {}).rpm);
  });
});

describe('每枪距离衰减', () => {
  it('每把枪定义独立衰减参数', () => {
    for (const g of Object.values(GUNS)) {
      expect(g.falloffStart).toBeGreaterThan(0);
      expect(g.falloffEnd).toBeGreaterThan(g.falloffStart);
      expect(g.falloffMin).toBeGreaterThan(0);
      expect(g.falloffMin).toBeLessThan(1);
    }
  });
  it('重步枪远战保留伤害比例高于卡宾枪', () => {
    const lr = damageAtDistance(46, 40, GUNS.longrifle);
    const cb = damageAtDistance(26, 40, GUNS.carbine);
    expect(lr / 46).toBeGreaterThan(cb / 26);
    expect(lr / 46).toBeGreaterThanOrEqual(0.7);
  });
  it('霰弹枪衰减更快，定位近距爆发', () => {
    const sg = damageAtDistance(15, 15, GUNS.shotgun);
    const cb = damageAtDistance(26, 15, GUNS.carbine);
    expect(sg / 15).toBeLessThan(cb / 26);
  });
  it('缺省参数仍用卡宾枪衰减（兼容旧调用）', () => {
    expect(damageAtDistance(26, 25)).toBeCloseTo(damageAtDistance(26, 25, GUNS.carbine), 6);
  });
});

describe('霰弹枪重做', () => {
  it('近距爆发：6 弹丸 × 15 伤害，售价下调到 400', () => {
    const s = GUNS.shotgun;
    expect(s.pellets).toBe(6);
    expect(s.damage).toBe(15);
    expect(s.price).toBe(400);
    expect(s.damage * s.pellets).toBeGreaterThanOrEqual(80);
  });
  it('散布收紧且定义弹丸扩散角', () => {
    expect(GUNS.shotgun.spreadBase).toBeLessThanOrEqual(0.04);
    expect(GUNS.shotgun.pelletSpread).toBeLessThanOrEqual(0.12);
  });
  it('持续 DPS 仍低于连发枪（定位区分）', () => {
    const dps = (g) => g.damage * g.pellets * g.rpm / 60;
    expect(dps(GUNS.shotgun)).toBeLessThan(dps(GUNS.repeater));
  });
});

describe('低弹药兜底', () => {
  it('ammoLow 时任何敌人必掉弹药箱', () => {
    const rng = mulberry32(3);
    for (const type of Object.keys(ENEMY_TYPES))
      for (let i = 0; i < 50; i++)
        expect(rollDrop(rng, type, true)).toBe('ammo');
  });
  it('默认行为不变（ammo/health/null）', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 200; i++)
      expect(['ammo', 'health', null]).toContain(rollDrop(rng, 'brawler'));
  });
});

describe('护具三阶升级', () => {
  it('每件护具 3 级且价格递增', () => {
    for (const g of Object.values(GEAR)) {
      expect(g.levels.length).toBe(3);
      expect(g.levels[1].price).toBeGreaterThan(g.levels[0].price);
      expect(g.levels[2].price).toBeGreaterThan(g.levels[1].price);
    }
  });
  it('gearNext 返回下一级，满级或未知返回 null', () => {
    expect(gearNext('armor', 0).level).toBe(1);
    expect(gearNext('armor', 0).price).toBe(GEAR.armor.levels[0].price);
    expect(gearNext('armor', 2).level).toBe(3);
    expect(gearNext('armor', 3)).toBeNull();
    expect(gearNext('dragon', 0)).toBeNull();
  });
  it('等级效果：盔甲/头盔/鞋子/手套逐级增强', () => {
    expect(computeLoadout('carbine', { armor: 2 }).dmgMul).toBeCloseTo(0.55, 6);
    expect(computeLoadout('carbine', { armor: 3 }).dmgMul).toBeCloseTo(0.4, 6);
    expect(computeLoadout('carbine', { helmet: 2 }).maxHp).toBe(160);
    expect(computeLoadout('carbine', { helmet: 3 }).maxHp).toBe(200);
    expect(computeLoadout('carbine', { shoes: 2 }).speedMul).toBeCloseTo(1.25, 6);
    expect(computeLoadout('carbine', { shoes: 3 }).speedMul).toBeCloseTo(1.35, 6);
    expect(computeLoadout('carbine', { gloves: 2 }).reloadTime).toBeCloseTo(1.6 * 0.55, 6);
    expect(computeLoadout('carbine', { gloves: 2 }).spreadMul).toBeCloseTo(0.6, 6);
    expect(computeLoadout('carbine', { gloves: 3 }).reloadTime).toBeCloseTo(1.6 * 0.4, 6);
    expect(computeLoadout('carbine', { gloves: 3 }).spreadMul).toBeCloseTo(0.5, 6);
  });
  it('布尔 true 兼容为 1 级', () => {
    expect(computeLoadout('carbine', { armor: true }).dmgMul).toBeCloseTo(0.7, 6);
  });
});

describe('鸭王 Boss 波', () => {
  it('Boss 属性：高血高分多弹丸大型', () => {
    const b = ENEMY_TYPES.boss;
    expect(b.boss).toBe(true);
    expect(b.hp).toBeGreaterThanOrEqual(600);
    expect(b.score).toBeGreaterThanOrEqual(1000);
    expect(b.pellets).toBeGreaterThanOrEqual(6);
    expect(b.scale).toBeGreaterThanOrEqual(1.8);
    expect(coinsFor('boss')).toBeGreaterThanOrEqual(100);
  });
  it('每 5 波一只 Boss，其余波次为 0', () => {
    for (const w of [5, 10, 15, 20, 50]) expect(wavePlan(w).counts.boss).toBe(1);
    for (const w of [1, 2, 3, 4, 6, 7, 9, 11]) expect(wavePlan(w).counts.boss).toBe(0);
  });
  it('Boss 不被 42 总量上限挤掉', () => {
    for (let w = 5; w <= 60; w += 5) {
      const p = wavePlan(w);
      expect(p.counts.boss).toBe(1);
      expect(totalOf(p)).toBeLessThanOrEqual(42);
    }
  });
  it('Boss 独立成长曲线突破血量平台期', () => {
    expect(wavePlan(5).bossScale).toBe(1);
    expect(wavePlan(25).bossScale).toBeGreaterThan(wavePlan(10).bossScale);
    expect(wavePlan(60).bossScale).toBeLessThanOrEqual(6);
    expect(wavePlan(60).bossScale).toBeGreaterThan(4);
  });
  it('Boss 波预告文案提及鸭王', () => {
    expect(waveIntro(5)).toMatch(/鸭王/);
    expect(waveIntro(10)).toMatch(/鸭王/);
  });
});

describe('经验与等级曲线', () => {
  it('升级所需经验随等级线性递增', () => {
    expect(xpForLevel(1)).toBe(30);
    expect(xpForLevel(2)).toBe(48);
    expect(xpForLevel(3)).toBe(66);
    for (let lv = 1; lv < 40; lv++) {
      expect(xpForLevel(lv + 1)).toBeGreaterThan(xpForLevel(lv));
    }
  });
  it('击杀经验按分值折算且保底', () => {
    expect(xpForKill('brawler')).toBe(8);
    expect(xpForKill('boss')).toBe(150);
    expect(xpForKill('unknown')).toBeGreaterThanOrEqual(2);
  });
  it('通关整波奖励固定经验', () => {
    expect(WAVE_CLEAR_XP).toBe(25);
  });
});

describe('天赋树结构', () => {
  it('三条分支各四层共 12 个节点', () => {
    expect(TALENT_BRANCHES.map((b) => b.id)).toEqual(['fire', 'guard', 'swift']);
    expect(TALENTS).toHaveLength(12);
    for (const br of TALENT_BRANCHES) {
      const nodes = TALENTS.filter((t) => t.branch === br.id);
      expect(nodes).toHaveLength(4);
      expect(nodes.map((t) => t.tier).sort()).toEqual([1, 2, 3, 4]);
    }
  });
  it('第 2 层解锁技能，前置为上一层至少 1 点', () => {
    const byId = Object.fromEntries(TALENTS.map((t) => [t.id, t]));
    for (const t of TALENTS) {
      if (t.tier === 1) expect(t.req).toBeNull();
      else {
        const prev = TALENTS.find((x) => x.branch === t.branch && x.tier === t.tier - 1);
        expect(t.req).toBe(prev.id);
      }
    }
    expect(byId.t_storm.skill).toBe('storm');
    expect(byId.t_shield.skill).toBe('shield');
    expect(byId.t_rage.skill).toBe('rage');
    expect(byId.t_slow.skill).toBe('slow');
  });
});

describe('talentNext 加点规则', () => {
  it('未满级返回下一点花费 1', () => {
    expect(talentNext('t_dmg', 0)).toEqual({ rank: 1, cost: 1 });
    expect(talentNext('t_dmg', 2)).toEqual({ rank: 3, cost: 1 });
  });
  it('满级返回 null', () => {
    expect(talentNext('t_dmg', 3)).toBeNull();
    expect(talentNext('t_storm', 1)).toBeNull();
    expect(talentNext('unknown', 0)).toBeNull();
  });
});

describe('talentEffects 数值叠加', () => {
  it('空天赋为基准值且不解锁任何技能', () => {
    const ef = talentEffects({});
    expect(ef.dmgBonus).toBe(1);
    expect(ef.maxHpBonus).toBe(0);
    expect(ef.speedBonus).toBe(1);
    expect(ef.killHeal).toBe(0);
    expect(ef.dashCdMul).toBe(1);
    expect(Object.values(ef.skills).every((v) => !v)).toBe(true);
  });
  it('火力伤害每点 +8%', () => {
    expect(talentEffects({ t_dmg: 3 }).dmgBonus).toBeCloseTo(1.24);
  });
  it('守护血量每点 +20 且击杀回血每点 +4', () => {
    const ef = talentEffects({ t_hp: 3, t_regen: 2 });
    expect(ef.maxHpBonus).toBe(60);
    expect(ef.killHeal).toBe(8);
  });
  it('迅捷移速每点 +6% 冲刺冷却每点 -20%', () => {
    const ef = talentEffects({ t_speed: 3, t_dash: 2 });
    expect(ef.speedBonus).toBeCloseTo(1.18);
    expect(ef.dashCdMul).toBeCloseTo(0.6);
  });
  it('技能层数强化嘎嘎乱杀/抱头蹲防/嘎瓦鲁多', () => {
    const ef = talentEffects({ t_storm: 1, t_storm2: 2, t_shield: 1, t_shield2: 2, t_slow: 1, t_slow2: 2 });
    expect(ef.skills.storm).toBe(true);
    expect(ef.storm.damage).toBe(110);
    expect(ef.storm.radius).toBeCloseTo(6.1);
    expect(ef.shield.pool).toBe(160);
    expect(ef.shield.duration).toBe(10);
    expect(ef.slow.duration).toBe(8);
    expect(ef.slow.factor).toBeCloseTo(0.15);
  });
  it('红温暴走提供固定射速与伤害倍率', () => {
    const ef = talentEffects({ t_rage: 1 });
    expect(ef.skills.rage).toBe(true);
    expect(ef.rage.rpmMul).toBeGreaterThan(1);
    expect(ef.rage.dmgMul).toBeGreaterThan(1);
  });
});

describe('SKILLS 主动技能表', () => {
  it('四个技能绑定数字键 1-4 且各有冷却', () => {
    expect(SKILLS.map((s) => s.id)).toEqual(['storm', 'shield', 'rage', 'slow']);
    expect(SKILLS.map((s) => s.key)).toEqual([1, 2, 3, 4]);
    for (const s of SKILLS) expect(s.cd).toBeGreaterThan(0);
  });
});

describe('applyTalents 与装备合成', () => {
  it('把天赋加成并入 computeLoadout 结果', () => {
    const base = computeLoadout('carbine', {});
    const ef = talentEffects({ t_dmg: 3, t_hp: 3, t_speed: 3, t_dash: 2 });
    const merged = applyTalents(base, ef);
    expect(merged.damage).toBeCloseTo(base.damage * 1.24);
    expect(merged.maxHp).toBe(base.maxHp + 60);
    expect(merged.speedMul).toBeCloseTo(base.speedMul * 1.18);
    expect(merged.dashCdMul).toBeCloseTo(0.6);
  });
  it('天赋与护具加成叠乘而非覆盖', () => {
    const geared = computeLoadout('carbine', { helmet: 3, shoes: 3 });
    const merged = applyTalents(geared, talentEffects({ t_hp: 3, t_speed: 3 }));
    expect(merged.maxHp).toBe(geared.maxHp + 60);
    expect(merged.speedMul).toBeCloseTo(geared.speedMul * 1.18);
  });
});

describe('精英/Boss 技能数值', () => {
  it('精英大范围技能：圈远大于近战、预警可反应、冷却合理', () => {
    expect(ELITE_SKILL.radius).toBeGreaterThanOrEqual(4);
    expect(ELITE_SKILL.radius).toBeGreaterThan(ENEMY_TYPES.brawler.reach * ELITE.reachMul * 2);
    expect(ELITE_SKILL.windup).toBeGreaterThanOrEqual(0.8);
    expect(ELITE_SKILL.cd).toBeGreaterThan(ELITE_SKILL.windup + 3);
    expect(ELITE_SKILL.dmgMul).toBeGreaterThan(1);
  });
  it('Boss 全图技能：覆盖全图、预警够冲刺闪避、冷却合理', () => {
    expect(BOSS_SKILL.radius).toBeGreaterThanOrEqual(Math.hypot(27, 27));
    expect(BOSS_SKILL.windup).toBeGreaterThanOrEqual(1.2);
    expect(BOSS_SKILL.cd).toBeGreaterThan(BOSS_SKILL.windup + 4);
    expect(BOSS_SKILL.dmgMul).toBeGreaterThan(1);
  });
});

describe('准星落点预测', () => {
  const flat = () => 0;
  const open = () => false;
  it('raySphereT 命中球面取近交点', () => {
    const t = raySphereT(0, 0.75, 0, 0, 0, 1, 0, 0.75, 6, 0.8);
    expect(t).toBeCloseTo(5.2, 5);
  });
  it('raySphereT 未命中或背向返回 -1', () => {
    expect(raySphereT(0, 0.75, 0, 0, 0, 1, 0, 3, 6, 0.8)).toBe(-1);
    expect(raySphereT(0, 0.75, 0, 0, 0, -1, 0, 0.75, 6, 0.8)).toBe(-1);
  });
  it('marchImpact 空地弹道落在地面瞄准点', () => {
    const origin = { x: 0, y: 0.75, z: 0 };
    const target = { x: 0, y: 0, z: 8 };
    const d = Math.hypot(target.x - origin.x, target.y - origin.y, target.z - origin.z);
    const dir = { x: 0, y: (target.y - origin.y) / d, z: (target.z - origin.z) / d };
    const hit = marchImpact(origin, dir, 80, [], open, flat, 0.25);
    expect(hit.hit).toBe('ground');
    expect(hit.z).toBeGreaterThan(7.5);
    expect(hit.z).toBeLessThan(8.3);
    expect(hit.y).toBeLessThanOrEqual(0.04);
  });
  it('marchImpact 优先命中路径上的敌人而非更远地面', () => {
    const origin = { x: 0, y: 0.75, z: 0 };
    const dir = { x: 0, y: 0, z: 1 };
    const targets = [{ x: 0, z: 5, radius: 0.72, height: 1.7 }];
    const hit = marchImpact(origin, dir, 80, targets, open, flat, 0.25);
    expect(hit.hit).toBe('enemy');
    expect(hit.z).toBeGreaterThan(4.2);
    expect(hit.z).toBeLessThan(5);
  });
  it('marchImpact 敌人高度之外的弹道越过其头顶', () => {
    const origin = { x: 0, y: 2.2, z: 0 };
    const dir = { x: 0, y: 0, z: 1 };
    const targets = [{ x: 0, z: 5, radius: 0.72, height: 1.7 }];
    const hit = marchImpact(origin, dir, 20, targets, open, flat, 0.25);
    expect(hit.hit).not.toBe('enemy');
  });
  it('marchImpact 掩体先于敌人拦截弹道', () => {
    const origin = { x: 0, y: 0.75, z: 0 };
    const dir = { x: 0, y: 0, z: 1 };
    const targets = [{ x: 0, z: 8, radius: 0.72, height: 1.7 }];
    const blocked = (x, z) => z > 3.9 && z < 4.6;
    const hit = marchImpact(origin, dir, 80, targets, blocked, flat, 0.25);
    expect(hit.hit).toBe('wall');
    expect(hit.z).toBeLessThan(4.7);
  });
  it('marchImpact 无命中时返回射程末端', () => {
    const origin = { x: 0, y: 3, z: 0 };
    const dir = { x: 0, y: 0, z: 1 };
    const hit = marchImpact(origin, dir, 30, [], open, flat, 0.5);
    expect(hit.hit).toBe('none');
    expect(hit.z).toBeCloseTo(30, 5);
  });
});

describe('枪支射程', () => {
  it('每把枪都有正射程且各不相同', () => {
    const ranges = Object.values(GUNS).map((g) => g.range);
    for (const r of ranges) expect(r).toBeGreaterThan(0);
    expect(new Set(ranges).size).toBe(ranges.length);
    expect(GUNS.shotgun.range).toBeLessThan(GUNS.carbine.range);
    expect(GUNS.carbine.range).toBeLessThan(GUNS.longrifle.range);
  });

  it('computeLoadout 暴露枪支射程', () => {
    expect(computeLoadout('shotgun', {}).range).toBe(GUNS.shotgun.range);
    expect(computeLoadout('longrifle', {}).range).toBe(GUNS.longrifle.range);
  });

  it('射程不短于伤害衰减末端（衰减区间内仍有伤害）', () => {
    for (const g of Object.values(GUNS)) expect(g.range).toBeGreaterThanOrEqual(g.falloffEnd);
  });
});
describe('商店目录与初始枪', () => {
  it('目录不含免费卡宾枪（由商店 UI 单独插入，避免价格断言把 0 当成可购项）', () => {
    const cat = shopCatalog();
    expect(cat.some((g) => g.id === 'carbine')).toBe(false);
    expect(GUNS.carbine.price).toBe(0);
    expect(cat.filter((g) => g.kind === 'gun').map((g) => g.id).sort())
      .toEqual(['longrifle', 'repeater', 'shotgun']);
  });
  it('子弹箱说明标明备弹全枪通用', () => {
    const ammo = shopCatalog().find((g) => g.id === 'ammo');
    expect(ammo.desc).toMatch(/全枪通用/);
    expect(ammo.desc).toMatch(/\+48/);
  });
});

describe('波次体量与经济基线（回归快照，改数值需同步）', () => {
  it('第 1/2/5/7 波敌人构成与上限', () => {
    const w1 = wavePlan(1);
    expect(w1.counts.brawler).toBe(6);
    expect(w1.counts.elite).toBe(1);
    expect(w1.counts.boss).toBe(0);
    expect(totalOf(w1)).toBe(7);

    const w2 = wavePlan(2);
    expect(w2.counts.clubber).toBeGreaterThan(0);
    expect(w2.counts.knifer).toBeGreaterThan(0);

    const w5 = wavePlan(5);
    expect(w5.counts.boss).toBe(1);
    expect(w5.counts.elite).toBe(1);
    expect(w5.counts.heavy).toBe(1);
    expect(totalOf(w5)).toBe(33); // 尚未触顶，精确快照；改 wavePlan 时必须同步

    const w7 = wavePlan(7);
    expect(w7.counts.boss).toBe(0);
    expect(w7.counts.elite).toBe(1);
    expect(totalOf(w7)).toBe(42);
  });

  it('从第 7 波起总量封顶 42（含精英，Boss 波让出 1 个名额）', () => {
    for (let w = 7; w <= 20; w++) {
      const p = wavePlan(w);
      expect(totalOf(p)).toBe(42);
    }
  });

  it('击杀金币能在第 4 波前后攒够第一把付费枪', () => {
    // 按最低兵种（不含随机精英溢价）累加，作为「最早购买窗口」下界
    let coins = 0;
    for (let w = 1; w <= 4; w++) {
      const { counts } = wavePlan(w);
      for (const [type, n] of Object.entries(counts)) {
        if (type === 'elite' || type === 'boss') continue;
        coins += coinsFor(type) * n;
      }
      if (counts.boss) coins += coinsFor('boss');
    }
    expect(coins).toBe(649); // 波次构成 × 基础赏金，不含精英溢价；改经济必须同步
    expect(coins).toBeGreaterThanOrEqual(GUNS.repeater.price); // 320，第 4 波结束已够第一把付费枪
    expect(coins).toBeLessThan(GUNS.longrifle.price + GUNS.shotgun.price);
  });
});

describe('蓄力技能圆心', () => {
  it('优先使用起手冻结的 skillPos，避免圈在 A、伤害打在 B', () => {
    const frozen = { x: 3, y: 0, z: -4 };
    const now = { x: 8, y: 0, z: 2 };
    expect(skillCenter({ skillPos: frozen, pos: now })).toBe(frozen);
    expect(skillCenter({ pos: now })).toBe(now);
    expect(skillCenter({ skillPos: null, pos: now })).toBe(now);
    expect(skillCenter({ skillPos: undefined, pos: now })).toBe(now);
  });
});
