import { describe, it, expect, vi } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { Game } from '../src/game.js';
import * as rules from '../src/rules.js';
import {
  WEAPON,
  ENEMY_TYPES,
  LOOT_ITEMS,
  GUNS,
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
  gunCatalog,
  xpForLevel,
  xpForKill,
  WAVE_CLEAR_XP,
  CARDS,
  CARD_BY_ID,
  CARD_RARITIES,
  cardAvailable,
  rollCardRarity,
  rollCards,
  cardEffects,
  SKILLS,
  applyCards,
  ELITE,
  eliteHpMul,
  ELITE_SKILL,
  BOSS_SKILL,
  raySphereT,
  marchImpact,
  enemyName,
  NAME_PREFIXES,
  BOSS_NAMES,
  skillsForLevel,
  skillCountForLevel,
  SKILL_EVERY_LEVELS,
} from '../src/rules.js';

const MELEE_WEAPONS = ['fists', 'club', 'knife'];
const RANGED_WEAPONS = ['pistol', 'rifle', 'shotgun'];
const totalOf = (p) => Object.values(p.counts).reduce((a, b) => a + b, 0);

// 绕过 WebGL/DOM 构造器，直接测试真实 Game 方法；只替换音画输出。
function makeGameHarness() {
  const game = Object.create(Game.prototype);
  Object.assign(game, {
    state: 'playing', t: 0, keys: new Set(), mouse: { down: false }, mouseFire: false,
    padAim: { x: 0, z: -1 }, rng: mulberry32(42), enemies: [], pickups: [], orbitals: [],
    aimPoint: new Vector3(), impactPoint: new Vector3(), impactMarker: new Object3D(),
    world: { colliders: [], update: vi.fn() },
    engine: { scene: { add: vi.fn(), remove: vi.fn() }, addShake: vi.fn(), updateCamera: vi.fn() },
    hud: { weaponsOpen: vi.fn(), renderWeapons: vi.fn(), toast: vi.fn(), banner: vi.fn(), damage: vi.fn() },
    audio: { uiClick: vi.fn(), reload: vi.fn(), pickup: vi.fn(), skillCast: vi.fn(), hit: vi.fn(), hurt: vi.fn(), waveHorn: vi.fn(), levelUp: vi.fn() },
    fx: { ring: vi.fn(), number: vi.fn(), feathers: vi.fn(), update: vi.fn() },
    playerDuck: {
      group: new Object3D(), update: vi.fn(),
      muzzleWorld: (out) => out.copy(game.p.pos).setY(0.75),
    },
    playerHpBar: { group: new Object3D(), fill: new Object3D(), reload: { group: new Object3D(), fill: new Object3D() } },
    rebuildPlayerDuck: vi.fn(),
  });
  game.resetStats();
  return game;
}

function queuePickup(game, kind, item, { distance = 0, life = 26 } = {}) {
  const mesh = new Object3D();
  mesh.position.copy(game.p.pos);
  mesh.position.x += distance;
  game.pickups.push({ mesh, kind, item, t: 0, life });
  return mesh;
}

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
  it('前 5 波预告各自的敌人且互不相同', () => {
    const intros = [1, 2, 3, 4, 5].map(waveIntro);
    expect(new Set(intros).size).toBe(5);
    expect(intros[0]).toMatch(/需求鸭/);
    expect(intros[1]).toMatch(/BUG鸭/);
    expect(intros[1]).toMatch(/产品鸭/);
    expect(intros[2]).toMatch(/前端鸭/);
    expect(intros[3]).toMatch(/后端鸭/);
    expect(intros[4]).toMatch(/设计鸭|领导/);
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
  it('精英体型介于设计鸭与领导 Boss 之间', () => {
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

describe('金币与打工人福利掉落', () => {
  it('击杀金币随敌人阶层递增', () => {
    expect(coinsFor('brawler')).toBeGreaterThan(0);
    expect(coinsFor('heavy')).toBeGreaterThan(coinsFor('rifle'));
    expect(coinsFor('rifle')).toBeGreaterThan(coinsFor('brawler'));
    expect(coinsFor('dragon')).toBe(0);
  });
  it('9 种福利都有金币、权重、颜色与即时效果，不再有售价', () => {
    expect(LOOT_ITEMS.map((i) => i.id)).toEqual([
      'subsidy', 'welfare', 'salary', 'coffee', 'overtime', 'performance', 'bonus', 'yearbonus', 'stock',
    ]);
    expect(new Set(LOOT_ITEMS.map((i) => i.id)).size).toBe(9);
    for (const item of LOOT_ITEMS) {
      expect(item.coins).toBeGreaterThan(0);
      expect(item.weight).toBeGreaterThan(0);
      expect(Number.isInteger(item.color)).toBe(true);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.desc.length).toBeGreaterThan(0);
      expect(['heal', 'fullheal', 'shield', 'ammo', 'xp', 'haste', 'rage']).toContain(item.effect.kind);
      if (['haste', 'rage'].includes(item.effect.kind)) expect(item.effect.duration).toBeGreaterThan(0);
      else if (item.effect.kind !== 'fullheal') expect(item.effect.amount).toBeGreaterThan(0);
      expect(item).not.toHaveProperty('price');
    }
  });
  it('rollLoot 只返回合法福利且每次 0~2 个', () => {
    const rng = mulberry32(5);
    const ids = new Set(LOOT_ITEMS.map((i) => i.id));
    for (let i = 0; i < 500; i++) {
      const drop = rollLoot(rng);
      expect(drop.length).toBeLessThanOrEqual(2);
      for (const id of drop) expect(ids.has(id)).toBe(true);
    }
  });
  it('掉落数量保留 12% 空、68% 一个、20% 两个的边界', () => {
    for (const [roll, count] of [[0, 0], [0.119999, 0], [0.12, 1], [0.799999, 1], [0.8, 2], [0.999999, 2]]) {
      const rng = vi.fn().mockReturnValue(0).mockReturnValueOnce(roll);
      expect(rollLoot(rng)).toHaveLength(count);
      expect(rng).toHaveBeenCalledTimes(count + 1);
    }
  });
  it('每个福利按自身权重占据随机区间，稀有福利不会被漏掉', () => {
    const total = LOOT_ITEMS.reduce((sum, item) => sum + item.weight, 0);
    let offset = 0;
    for (const item of LOOT_ITEMS) {
      const rng = vi.fn().mockReturnValue((offset + item.weight / 2) / total).mockReturnValueOnce(0.5);
      expect(rollLoot(rng)).toEqual([item.id]);
      offset += item.weight;
    }
  });
  it('固定种子可复现，长期掉落覆盖全部福利且补贴比期权常见', () => {
    const a = mulberry32(11), b = mulberry32(11);
    const count = Object.fromEntries(LOOT_ITEMS.map((i) => [i.id, 0]));
    for (let i = 0; i < 4000; i++) {
      const drop = rollLoot(a);
      expect(drop).toEqual(rollLoot(b));
      drop.forEach((id) => count[id]++);
    }
    expect(Object.values(count).every((n) => n > 0)).toBe(true);
    expect(count.subsidy).toBeGreaterThan(count.stock);
    expect(count.salary).toBeGreaterThan(count.yearbonus);
  });
});

describe('AI 模型武器目录', () => {
  it('只含 4 把枪，Claude 免费，其余保留原有价格', () => {
    const catalog = gunCatalog();
    expect(catalog.map((g) => g.id)).toEqual(['claude', 'qwen', 'glm', 'codex']);
    expect(catalog.map((g) => g.price)).toEqual([0, 320, 400, 620]);
    for (const entry of catalog) {
      const gun = GUNS[entry.id];
      expect(entry.label).toBe(gun.label);
      expect(entry.tag).toBe(gun.tag);
      expect(entry.accent).toBe(gun.accent);
      expect(entry.desc).toContain(String(gun.damage));
      expect(entry.desc).toContain(String(gun.range));
    }
  });
  it('旧商店与护具规则不再导出', () => {
    for (const name of ['GEAR', 'gearNext', 'shopCatalog']) expect(rules).not.toHaveProperty(name);
  });
  it('默认 Claude 步枪与 WEAPON 战斗数值一致', () => {
    const loadout = computeLoadout('claude');
    for (const key of ['damage', 'rpm', 'magSize', 'reloadTime', 'bulletSpeed']) {
      expect(loadout[key]).toBe(WEAPON[key]);
    }
    expect(loadout.gun).toBe(GUNS.claude);
  });
  it('每枪只定义基础武器数值，血量/减伤/移动/散布加成由卡牌负责', () => {
    for (const id of Object.keys(GUNS)) {
      expect(computeLoadout(id)).toMatchObject({ maxHp: 100, dmgMul: 1, speedMul: 1, spreadMul: 1 });
    }
    expect(computeLoadout('missing')).toEqual(computeLoadout('claude'));
  });
  it('GLM 多弹丸、Codex 高伤低射速、Qwen 高频大弹匣', () => {
    const glm = computeLoadout('glm'), codex = computeLoadout('codex');
    expect(glm.pellets).toBeGreaterThan(1);
    expect(codex.damage).toBeGreaterThan(glm.damage);
    expect(codex.rpm).toBeLessThan(computeLoadout('claude').rpm);
    expect(GUNS.qwen.rpm).toBeGreaterThan(GUNS.claude.rpm);
    expect(GUNS.qwen.magSize).toBeGreaterThan(GUNS.claude.magSize);
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
    const lr = damageAtDistance(46, 40, GUNS.codex);
    const cb = damageAtDistance(26, 40, GUNS.claude);
    expect(lr / 46).toBeGreaterThan(cb / 26);
    expect(lr / 46).toBeGreaterThanOrEqual(0.7);
  });
  it('霰弹枪衰减更快，定位近距爆发', () => {
    const sg = damageAtDistance(15, 15, GUNS.glm);
    const cb = damageAtDistance(26, 15, GUNS.claude);
    expect(sg / 15).toBeLessThan(cb / 26);
  });
  it('缺省参数仍用卡宾枪衰减（兼容旧调用）', () => {
    expect(damageAtDistance(26, 25)).toBeCloseTo(damageAtDistance(26, 25, GUNS.claude), 6);
  });
});

describe('霰弹枪重做', () => {
  it('近距爆发：6 弹丸 × 15 伤害，售价下调到 400', () => {
    const s = GUNS.glm;
    expect(s.pellets).toBe(6);
    expect(s.damage).toBe(15);
    expect(s.price).toBe(400);
    expect(s.damage * s.pellets).toBeGreaterThanOrEqual(80);
  });
  it('散布收紧且定义弹丸扩散角', () => {
    expect(GUNS.glm.spreadBase).toBeLessThanOrEqual(0.04);
    expect(GUNS.glm.pelletSpread).toBeLessThanOrEqual(0.12);
  });
  it('持续 DPS 仍低于连发枪（定位区分）', () => {
    const dps = (g) => g.damage * g.pellets * g.rpm / 60;
    expect(dps(GUNS.glm)).toBeLessThan(dps(GUNS.qwen));
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

describe('Game 武器购买与装备', () => {
  it('开局只持有免费 Claude，没有背包、护具或旧交易方法', () => {
    const game = makeGameHarness();
    expect(game.ownedGuns).toEqual(['claude']);
    expect(game.gunId).toBe('claude');
    expect(game.p.mag).toBe(GUNS.claude.magSize);
    expect(game).not.toHaveProperty('gear');
    expect(game).not.toHaveProperty('inv');
    for (const name of ['buyGood', 'openShop', 'closeShop', 'sellItem']) expect(typeof game[name]).toBe('undefined');
  });
  it('打开/关闭武器面板清空输入，且不接受从其他菜单打开', () => {
    const game = makeGameHarness();
    game.keys.add('Space'); game.keys.add('KeyW'); game.mouse.down = true; game.mouseFire = true;
    game.openWeapons();
    expect(game.state).toBe('weapons');
    expect(game.keys.size).toBe(0);
    expect(game.mouse.down || game.mouseFire).toBe(false);
    expect(game.hud.weaponsOpen).toHaveBeenLastCalledWith(true);
    game.keys.add('ArrowDown'); game.mouse.down = true; game.mouseFire = true;
    game.closeWeapons();
    expect(game.state).toBe('playing');
    expect(game.keys.size).toBe(0);
    expect(game.mouse.down || game.mouseFire).toBe(false);
    expect(game.hud.weaponsOpen).toHaveBeenLastCalledWith(false);
    game.state = 'card'; game.openWeapons();
    expect(game.state).toBe('card');
  });
  it('武器面板打开时不推进战斗时间、移动、敌人、子弹或拾取', () => {
    const game = makeGameHarness();
    vi.spyOn(game, 'pollGamepad').mockImplementation(() => {});
    const combat = ['updatePlayer', 'updateWaves', 'updateEnemies', 'updateBullets', 'updatePickups', 'updateOrbit'];
    for (const method of combat) vi.spyOn(game, method).mockImplementation(() => {});
    game.openWeapons(); game.update(0.5);
    expect(game.time).toBe(0);
    for (const method of combat) expect(game[method]).not.toHaveBeenCalled();
  });
  it.each(['playing', 'paused', 'card', 'cardbook', 'title', 'over'])('%s 状态不能直接调用 buyGun 购买', (state) => {
    const game = makeGameHarness(); game.state = state; game.coins = 1000;
    game.buyGun('glm');
    expect(game.coins).toBe(1000);
    expect(game.ownedGuns).toEqual(['claude']);
    expect(game.gunId).toBe('claude');
  });
  it('购买 GLM 只扣一次价格，立即装备且不消耗共享备弹', () => {
    const game = makeGameHarness(); game.openWeapons(); game.coins = 1000;
    const reserve = game.p.reserve;
    game.buyGun('glm');
    expect(game.coins).toBe(600);
    expect(game.ownedGuns).toEqual(['claude', 'glm']);
    expect(game.gunId).toBe('glm');
    expect(game.p.mag).toBe(6);
    expect(game.loadout.pellets).toBe(6);
    expect(game.p.reserve).toBe(reserve);
    expect(game.rebuildPlayerDuck).toHaveBeenCalledOnce();
    expect(game.hud.renderWeapons).toHaveBeenLastCalledWith(game);
  });
  it('金币不足或未知/旧商品 id 不改变金币、持枪与弹匣', () => {
    const game = makeGameHarness(); game.openWeapons(); game.coins = GUNS.glm.price - 1;
    game.p.mag = 7;
    for (const id of ['glm', 'ammo', 'armor', 'helmet', 'shoes', 'gloves', 'missing']) game.buyGun(id);
    expect(game.coins).toBe(GUNS.glm.price - 1);
    expect(game.ownedGuns).toEqual(['claude']);
    expect(game.gunId).toBe('claude');
    expect(game.p.mag).toBe(7);
    expect(game.rebuildPlayerDuck).not.toHaveBeenCalled();
  });
  it('重复购买免费装备，不重复持有、不补满已消耗弹匣', () => {
    const game = makeGameHarness(); game.openWeapons(); game.coins = GUNS.glm.price;
    game.buyGun('glm'); game.p.mag = 2;
    game.buyGun('claude'); game.p.mag = 7;
    game.buyGun('glm'); game.buyGun('glm');
    expect(game.coins).toBe(0);
    expect(game.ownedGuns).toEqual(['claude', 'glm']);
    expect(game.gunId).toBe('glm');
    expect(game.p.mag).toBe(2);
    expect(game.mags.claude).toBe(7);
  });
  it.each(['qwen', 'glm', 'codex'])('新购 %s 只计算一次配装，第一弹匣立即包含卡牌加成', (id) => {
    const game = makeGameHarness(); game.openWeapons(); game.coins = 2000;
    game.cards = { c_mag: 2 }; game.recomputeLoadout();
    const compute = vi.spyOn(rules, 'computeLoadout');
    try {
      game.buyGun(id);
      expect(compute).toHaveBeenCalledExactlyOnceWith(id);
      expect(game.p.mag).toBe(Math.round(GUNS[id].magSize * 1.5));
      expect(game.p.mag).toBe(game.loadout.magSize);
      expect(game.mags[id]).toBe(game.p.mag);
    } finally {
      compute.mockRestore();
    }
  });
  it('切枪只遍历已购武器，菜单里不切枪，弹匣各自保存', () => {
    const game = makeGameHarness(); game.openWeapons(); game.coins = 1000;
    game.buyGun('glm'); game.p.mag = 3;
    game.cycleGun(1);
    expect(game.gunId).toBe('glm');
    game.closeWeapons(); game.cycleGun(1);
    expect(game.gunId).toBe('claude');
    game.p.mag = 8; game.p.reloadT = 0.4; game.cycleGun(-1);
    expect(game.gunId).toBe('glm');
    expect(game.p.mag).toBe(3);
    expect(game.p.reloadT).toBe(0);
    game.equipGun('codex');
    expect(game.gunId).toBe('glm');
    expect(game.mags.claude).toBe(8);
  });
});

describe('Game 福利即时结算', () => {
  it.each([
    ['subsidy', 'hp', 20], ['welfare', 'shield', 20], ['salary', 'hp', 35], ['coffee', 'hasteT', 5],
    ['overtime', 'reserve', 16], ['performance', 'xpEarned', 30], ['bonus', 'rageT', 4],
    ['yearbonus', 'hp', 70], ['stock', 'hp', 100],
  ])('拾取 %s 同时结算金币与 %s 效果，且只结算一次', (id, field, expected) => {
    const game = makeGameHarness(); const item = LOOT_ITEMS.find((i) => i.id === id);
    game.p.hp = 10; game.p.reserve = 0; game.coins = 5; game.coinsEarned = 7;
    const mesh = queuePickup(game, 'loot', id);
    game.updatePickups(0.016); game.updatePickups(0.016);
    expect(game.coins).toBe(5 + item.coins);
    expect(game.coinsEarned).toBe(7 + item.coins);
    expect(field === 'xpEarned' ? game.xpEarned : game.p[field]).toBe(expected);
    expect(game.pickups).toHaveLength(0);
    expect(game.engine.scene.remove).toHaveBeenCalledExactlyOnceWith(mesh);
    expect(game.audio.pickup).toHaveBeenCalledOnce();
    expect(game.fx.number).toHaveBeenCalledWith(expect.any(Vector3), expect.stringContaining(item.label), expect.any(String));
    expect(game).not.toHaveProperty('inv');
  });
  it('过期或远离玩家的福利不提前结算', () => {
    const game = makeGameHarness();
    queuePickup(game, 'loot', 'stock', { distance: 10 });
    queuePickup(game, 'loot', 'stock', { life: 0.001 });
    game.updatePickups(0.016);
    expect(game.coins).toBe(0);
    expect(game.coinsEarned).toBe(0);
    expect(game.pickups).toHaveLength(1);
    expect(game.audio.pickup).not.toHaveBeenCalled();
  });
  it('绩效经验应用经验卡倍率，弹药福利不吃弹药箱卡倍率', () => {
    const game = makeGameHarness(); game.cards = { c_xp: 2, c_ammo: 3 }; game.recomputeLoadout();
    game.p.reserve = 0;
    queuePickup(game, 'loot', 'performance'); queuePickup(game, 'loot', 'overtime');
    game.updatePickups(0.016);
    expect(game.xpEarned).toBe(45);
    expect(game.p.reserve).toBe(16);
    queuePickup(game, 'ammo'); game.updatePickups(0.016);
    expect(game.p.reserve).toBe(16 + Math.round(48 * game.loadout.ammoPickupMul));
  });
  it('普通回血/满血福利均钳在生命上限，fragile 仍为 1 HP', () => {
    const game = makeGameHarness(); game.p.hp = 98;
    game.applyLootEffect({ kind: 'heal', amount: 60 });
    expect(game.p.hp).toBe(100);
    game.fragile = true; game.cards = { c_hp: 3 }; game.recomputeLoadout(); game.p.hp = 0.5;
    game.applyLootEffect({ kind: 'heal', amount: 60 });
    expect(game.p.hp).toBe(1);
    game.p.hp = 0.25; game.applyLootEffect({ kind: 'fullheal' });
    expect(game.p.hp).toBe(1);
    expect(game.p.maxHp).toBe(1);
  });
  it('下午茶与奖金刷新持续时间，不叠加也不缩短已有长效果', () => {
    const game = makeGameHarness();
    for (const [kind, field, duration] of [['haste', 'hasteT', 5], ['rage', 'rageT', 4]]) {
      game.p[field] = 1; game.applyLootEffect({ kind, duration });
      expect(game.p[field]).toBe(duration);
      game.applyLootEffect({ kind, duration });
      expect(game.p[field]).toBe(duration);
      game.p[field] = 12; game.applyLootEffect({ kind, duration });
      expect(game.p[field]).toBe(12);
    }
    expect(game.applyLootEffect(null)).toBe('');
    expect(game.applyLootEffect({ kind: 'missing' })).toBe('');
  });
});

describe('福利/卡牌永久护盾与技能限时护盾', () => {
  it('福利每次 +20，累积到 120，不削减已有更高护盾', () => {
    const game = makeGameHarness(); const effect = LOOT_ITEMS.find((i) => i.id === 'welfare').effect;
    for (let i = 0; i < 8; i++) game.applyLootEffect(effect);
    expect(game.p.shield).toBe(120);
    expect(game.p.shieldSkillT).toBe(0);
    expect(game.p.skillShield).toBe(0);
    game.p.shield = 180; game.p.shieldMax = 180;
    game.applyLootEffect(effect);
    expect(game.p.shield).toBe(180);
  });
  it('addShield 返回实际增加值，可限额但不缩减更高池，默认无上限', () => {
    const game = makeGameHarness();
    expect(game.addShield(115)).toBe(115);
    expect(game.addShield(20, 120)).toBe(5);
    expect(game.addShield(20, 120)).toBe(0);
    expect(game.addShield(80)).toBe(80);
    expect(game.addShield(20, 120)).toBe(0);
    expect(game.p.shield).toBe(200);
    expect(game.p.shieldMax).toBeGreaterThanOrEqual(200);
    expect(game.p.skillShield).toBe(0);
  });
  it('技能到期只移除限时部分，施法前后拾取的福利都保留', () => {
    const game = makeGameHarness(); game.level = 3; game.recomputeLoadout();
    const effect = LOOT_ITEMS.find((i) => i.id === 'welfare').effect;
    game.applyLootEffect(effect); game.castSkill(2); game.applyLootEffect(effect);
    expect(game.p.skillShield).toBeGreaterThan(0);
    expect(game.p.shield - game.p.skillShield).toBe(40);
    game.updatePlayer(game.loadout.shield.duration + 0.1);
    expect(game.p.shield).toBe(40);
    expect(game.p.skillShield).toBe(0);
    expect(game.p.shieldSkillT).toBe(0);
  });
  it.each(['partial', 'spill'])('%s 伤害先消耗限时护盾，到期不重复扣永久部分', (mode) => {
    const game = makeGameHarness(); game.level = 3; game.recomputeLoadout();
    game.addShield(20); game.castSkill(2);
    const timed = game.p.skillShield, damage = mode === 'partial' ? 10 : timed + 10;
    game.damagePlayer(damage);
    expect(game.p.skillShield).toBe(Math.max(0, timed - damage));
    expect(game.p.hp).toBe(100);
    const permanent = game.p.shield - game.p.skillShield;
    game.updatePlayer(game.loadout.shield.duration + 0.1);
    expect(game.p.shield).toBe(permanent);
    expect(game.p.shield).toBeGreaterThan(0);
  });
  it('技能期间获得的开工护盾卡不会随技能倒计时一起清空', () => {
    const game = makeGameHarness(); game.level = 3; game.cards = { r_waveShield: 2 }; game.recomputeLoadout();
    game.castSkill(2); game.nextWave();
    const permanent = game.p.shield - game.p.skillShield;
    expect(permanent).toBeGreaterThanOrEqual(game.loadout.mods.waveShield);
    game.updatePlayer(game.loadout.shield.duration + 0.1);
    expect(game.p.shield).toBe(permanent);
  });
});

describe('领导 Boss 波', () => {
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
  it('Boss 波预告文案提及领导', () => {
    expect(waveIntro(5)).toMatch(/领导/);
    expect(waveIntro(10)).toMatch(/领导/);
  });
});

describe('enemyName 打工人命名', () => {
  it('任务 / 职位鸭以各自基础名结尾', () => {
    const rng = mulberry32(7);
    for (const [type, t] of Object.entries(ENEMY_TYPES)) {
      if (t.kind === 'boss') continue;
      for (let i = 0; i < 30; i++) expect(enemyName(type, rng).endsWith(t.label)).toBe(true);
    }
  });
  it('前缀只取自对应词库，且确实会随机出现', () => {
    const rng = mulberry32(42);
    const seenPrefix = { task: new Set(), role: new Set() };
    for (const [type, t] of Object.entries(ENEMY_TYPES)) {
      if (t.kind === 'boss') continue;
      for (let i = 0; i < 200; i++) {
        const name = enemyName(type, rng);
        const prefix = name.slice(0, name.length - t.label.length);
        if (prefix) {
          expect(NAME_PREFIXES[t.kind]).toContain(prefix);
          seenPrefix[t.kind].add(prefix);
        }
      }
    }
    expect(seenPrefix.task.size).toBeGreaterThanOrEqual(3);
    expect(seenPrefix.role.size).toBeGreaterThanOrEqual(3);
  });
  it('同种子名字序列可复现', () => {
    const a = mulberry32(9), b = mulberry32(9);
    for (const type of ['brawler', 'clubber', 'knifer', 'pistol', 'rifle', 'heavy', 'boss']) {
      expect(enemyName(type, a)).toBe(enemyName(type, b));
    }
  });
  it('Boss 名字是领导头衔且无前缀', () => {
    const rng = mulberry32(3);
    const seen = new Set();
    for (let i = 0; i < 100; i++) {
      const name = enemyName('boss', rng);
      expect(BOSS_NAMES).toContain(name);
      seen.add(name);
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
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

describe('强化卡池结构', () => {
  it('三档稀有度：普通权重最高，金卡最低', () => {
    expect(Object.keys(CARD_RARITIES)).toEqual(['common', 'rare', 'gold']);
    expect(CARD_RARITIES.common.weight).toBeGreaterThan(CARD_RARITIES.rare.weight);
    expect(CARD_RARITIES.rare.weight).toBeGreaterThan(CARD_RARITIES.gold.weight);
    expect(CARD_RARITIES.gold.order).toBeGreaterThan(CARD_RARITIES.rare.order);
  });
  it('每张卡 id 唯一、字段完整、层数上限为正', () => {
    const ids = CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CARDS) {
      expect(CARD_RARITIES[c.rarity]).toBeTruthy();
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.icon.length).toBe(1);
      expect(c.max).toBeGreaterThan(0);
      expect(CARD_BY_ID[c.id]).toBe(c);
      for (let n = 1; n <= c.max; n++) expect(typeof c.desc(n)).toBe('string');
    }
  });
  it('普通卡只给固定属性，绿/金卡才带特效', () => {
    const base = cardEffects({});
    for (const c of CARDS.filter((x) => x.rarity === 'common')) {
      expect(cardEffects({ [c.id]: 1 }).mods).toEqual({});
      expect(cardEffects({ [c.id]: 1 }).storm).toEqual(base.storm);
    }
    for (const c of CARDS.filter((x) => x.rarity !== 'common')) {
      const ef = cardEffects({ [c.id]: 1 });
      // 特效走 mods，技能强化卡（乱杀精通）走 storm 数值，二者都算「有特效」
      const hasEffect = Object.keys(ef.mods).length > 0 || JSON.stringify(ef.storm) !== JSON.stringify(base.storm);
      expect(hasEffect, `${c.id} 应提供特效`).toBe(true);
    }
  });
  it('卡池足够大，普通/稀有/传说都有多张', () => {
    for (const r of ['common', 'rare', 'gold']) {
      expect(CARDS.filter((c) => c.rarity === r).length).toBeGreaterThanOrEqual(8);
    }
  });
});

describe('抽卡规则', () => {
  it('每次抽 3 张互不相同的卡', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 60; i++) {
      const draft = rollCards(rng, {}, 1);
      expect(draft).toHaveLength(3);
      expect(new Set(draft.map((c) => c.id)).size).toBe(3);
    }
  });
  it('金绿是低概率：大样本下普通占多数，金卡明显最少', () => {
    const rng = mulberry32(20260114);
    const count = { common: 0, rare: 0, gold: 0 };
    for (let i = 0; i < 6000; i++) count[rollCardRarity(rng)]++;
    expect(count.common).toBeGreaterThan(count.rare);
    expect(count.rare).toBeGreaterThan(count.gold);
    expect(count.gold / 6000).toBeGreaterThan(0.03);
    expect(count.gold / 6000).toBeLessThan(0.14);
    expect(count.common / 6000).toBeGreaterThan(0.6);
  });
  it('Boss 波（每 5 波）保底一张金卡', () => {
    const rng = mulberry32(99);
    for (const wave of [5, 10, 15, 20]) {
      for (let i = 0; i < 12; i++) {
        expect(rollCards(rng, {}, wave).some((c) => c.rarity === 'gold')).toBe(true);
      }
    }
  });
  it('非 Boss 波不保底金卡', () => {
    const rng = mulberry32(5);
    let goldHands = 0;
    for (let i = 0; i < 200; i++) if (rollCards(rng, {}, 3).some((c) => c.rarity === 'gold')) goldHands++;
    expect(goldHands).toBeLessThan(120);
  });
  it('满层的卡不再出现，候选带当前层数与下一层', () => {
    const owned = { c_dmg: CARD_BY_ID.c_dmg.max };
    expect(cardAvailable(CARD_BY_ID.c_dmg, owned)).toBe(false);
    const rng = mulberry32(3);
    for (let i = 0; i < 40; i++) {
      const draft = rollCards(rng, owned, 1);
      expect(draft.some((c) => c.id === 'c_dmg')).toBe(false);
      for (const c of draft) expect(c.next).toBe((owned[c.id] || 0) + 1);
    }
  });
  it('部分叠层的卡标注 stacks 与 next', () => {
    const rng = mulberry32(11);
    const draft = rollCards(rng, { c_hp: 2 }, 1);
    const hp = draft.find((c) => c.id === 'c_hp');
    if (hp) { expect(hp.stacks).toBe(2); expect(hp.next).toBe(3); }
  });
  it('卡池枯竭时降级凑满，全满则返回空（不卡流程）', () => {
    const allButOne = Object.fromEntries(CARDS.slice(1).map((c) => [c.id, c.max]));
    expect(rollCards(mulberry32(1), allButOne, 5)).toHaveLength(1);
    const all = Object.fromEntries(CARDS.map((c) => [c.id, c.max]));
    expect(rollCards(mulberry32(1), all, 5)).toEqual([]);
  });
  it('同一随机种子抽卡可复现', () => {
    expect(rollCards(mulberry32(42), {}, 3).map((c) => c.id))
      .toEqual(rollCards(mulberry32(42), {}, 3).map((c) => c.id));
  });
});

describe('cardEffects 数值叠加', () => {
  it('无卡为基准值，技能只随等级解锁（开局仅嘎嘎乱杀）', () => {
    const ef = cardEffects({});
    expect(ef.dmgBonus).toBe(1);
    expect(ef.maxHpBonus).toBe(0);
    expect(ef.speedBonus).toBe(1);
    expect(ef.killHeal).toBe(0);
    expect(ef.dashCdMul).toBe(1);
    expect(ef.mods).toEqual({});
    expect(ef.skills).toEqual({ storm: true, shield: false, rage: false, slow: false });
  });
  it('普通卡按层线性叠加', () => {
    const ef = cardEffects({ c_dmg: 3, c_hp: 2, c_speed: 2, c_rate: 2 });
    expect(ef.dmgBonus).toBeCloseTo(1.36);
    expect(ef.maxHpBonus).toBe(50);
    expect(ef.speedBonus).toBeCloseTo(1.16);
    expect(ef.rateMul).toBeCloseTo(1.24);
  });
  it('递减类卡有上限，不会减到 0 或负数', () => {
    const ef = cardEffects({ c_reload: 3, c_dash: 3, c_armor: 3, c_spread: 3 });
    for (const v of [ef.reloadMul, ef.dashCdMul, ef.armorMul, ef.spreadMul]) {
      expect(v).toBeGreaterThan(0.4);
      expect(v).toBeLessThan(1);
    }
  });
  it('稀有卡启用对应特效并随层增强', () => {
    const one = cardEffects({ r_explosive: 1, r_crit: 1, r_frost: 1 }).mods;
    const two = cardEffects({ r_explosive: 2, r_crit: 2, r_frost: 2 }).mods;
    expect(two.explosive.radius).toBeGreaterThan(one.explosive.radius);
    expect(two.explosive.mul).toBeGreaterThan(one.explosive.mul);
    expect(two.crit.chance).toBeGreaterThan(one.crit.chance);
    expect(two.frost.factor).toBeLessThan(one.frost.factor);
    expect(cardEffects({ r_pierce: 2 }).mods.pierce).toBe(2);
    expect(cardEffects({ r_killheal: 3 }).killHeal).toBe(18);
  });
  it('传说卡特效最强：处决/连锁/羽毛/不死鸟', () => {
    const m = cardEffects({ g_chain: 2, g_orbit: 2, g_execute: 2, g_phoenix: 1, g_multishot: 2 }).mods;
    expect(m.chain.count).toBe(3);
    expect(m.orbit.count).toBe(4);
    expect(m.execute).toBeCloseTo(0.29);
    expect(m.phoenix).toBe(true);
    expect(m.multishot).toBe(2);
  });
  it('金卡「乱杀精通」强化技能数值且缩短冷却', () => {
    const base = cardEffects({}, 10);
    expect(base.storm.damage).toBe(60);
    const ef = cardEffects({ g_storm: 3 }, 10);
    expect(ef.storm.damage).toBe(180);
    expect(ef.storm.radius).toBeCloseTo(8.1);
    expect(ef.storm.cdMul).toBeCloseTo(0.55);
  });
  it('卡牌不影响技能解锁等级', () => {
    const ef = cardEffects({ g_storm: 3 }, 1);
    expect(ef.skills).toEqual({ storm: true, shield: false, rage: false, slow: false });
  });
});

describe('SKILLS 主动技能表', () => {
  it('四个技能绑定数字键 1-4 且各有冷却', () => {
    expect(SKILLS.map((s) => s.id)).toEqual(['storm', 'shield', 'rage', 'slow']);
    expect(SKILLS.map((s) => s.key)).toEqual([1, 2, 3, 4]);
    for (const s of SKILLS) expect(s.cd).toBeGreaterThan(0);
  });
});

describe('skillsForLevel 技能随等级解锁', () => {
  it('开局 1 个技能（嘎嘎乱杀）', () => {
    expect(skillsForLevel(1)).toEqual({ storm: true, shield: false, rage: false, slow: false });
    expect(skillsForLevel(2)).toEqual({ storm: true, shield: false, rage: false, slow: false });
  });
  it('每 3 级解锁一个新技能，顺序固定', () => {
    expect(SKILL_EVERY_LEVELS).toBe(3);
    expect(skillsForLevel(3).shield).toBe(true);
    expect(skillsForLevel(3).rage).toBe(false);
    expect(skillsForLevel(6).rage).toBe(true);
    expect(skillsForLevel(6).slow).toBe(false);
    expect(skillsForLevel(9).slow).toBe(true);
  });
  it('Lv.9 起四技能全满，不再增加', () => {
    for (const lv of [9, 10, 15, 30, 99]) {
      expect(Object.values(skillsForLevel(lv)).every(Boolean)).toBe(true);
    }
  });
  it('等级边界：2→3、5→6、8→9 各多一个', () => {
    const count = (lv) => Object.values(skillsForLevel(lv)).filter(Boolean).length;
    expect(count(2)).toBe(1); expect(count(3)).toBe(2);
    expect(count(5)).toBe(2); expect(count(6)).toBe(3);
    expect(count(8)).toBe(3); expect(count(9)).toBe(4);
  });
  it('低等级拿满强化卡也不会提前解锁技能', () => {
    const ef = cardEffects({ g_storm: 3, g_orbit: 2, g_chain: 2 }, 1);
    expect(ef.skills).toEqual({ storm: true, shield: false, rage: false, slow: false });
  });
  it('requiredLevel 是唯一来源：与解锁判定一致（1/3/6/9）', () => {
    expect(SKILLS.map((s) => s.requiredLevel)).toEqual([1, 3, 6, 9]);
    for (const s of SKILLS) {
      expect(skillsForLevel(s.requiredLevel)[s.id]).toBe(true);
      if (s.requiredLevel > 1) expect(skillsForLevel(s.requiredLevel - 1)[s.id]).toBe(false);
    }
  });
  it('skillCountForLevel 计数与解锁 map 一致', () => {
    for (const lv of [1, 2, 3, 5, 6, 8, 9, 12]) {
      const map = skillsForLevel(lv);
      expect(Object.values(map).filter(Boolean).length).toBe(skillCountForLevel(lv));
    }
  });
});

describe('applyCards 与模型枪合成', () => {
  it('把卡牌加成并入 computeLoadout 结果', () => {
    const base = computeLoadout('claude');
    const merged = applyCards(base, cardEffects({ c_dmg: 3, c_hp: 3, c_speed: 3, c_dash: 2 }));
    expect(merged.damage).toBeCloseTo(base.damage * 1.36);
    expect(merged.maxHp).toBe(base.maxHp + 75);
    expect(merged.speedMul).toBeCloseTo(base.speedMul * 1.24);
    expect(merged.dashCdMul).toBeCloseTo(0.68);
  });
  it.each(Object.keys(GUNS))('卡牌与 %s 的基础属性叠乘，替代旧护具成长', (id) => {
    const base = computeLoadout(id);
    const merged = applyCards(base, cardEffects({ c_hp: 3, c_speed: 3, c_armor: 2, c_reload: 2, c_spread: 2 }));
    expect(merged.maxHp).toBe(base.maxHp + 75);
    expect(merged.speedMul).toBeCloseTo(base.speedMul * 1.24);
    expect(merged.dmgMul).toBeCloseTo(base.dmgMul * 0.78);
    expect(merged.reloadTime).toBeCloseTo(base.reloadTime * 0.67);
    expect(merged.spreadMul).toBeCloseTo(base.spreadMul * 0.62);
  });
  it('射速/弹匣卡改写实际武器参数', () => {
    const base = computeLoadout('claude');
    const merged = applyCards(base, cardEffects({ c_rate: 2, c_mag: 2 }));
    expect(merged.rpm).toBeCloseTo(base.rpm * 1.24);
    expect(merged.magSize).toBe(Math.round(base.magSize * 1.5));
  });
  it('射程卡同步后移衰减区间，远处伤害确实提高', () => {
    const base = computeLoadout('claude');
    const merged = applyCards(base, cardEffects({ c_range: 2 }));
    expect(merged.range).toBeGreaterThan(base.range);
    expect(merged.falloffStart).toBeGreaterThan(base.gun.falloffStart);
    const d = base.range * 0.9;
    expect(damageAtDistance(100, d, merged)).toBeGreaterThan(damageAtDistance(100, d, base.gun));
  });
  it('特效集合透传到 loadout.mods 供战斗层读取', () => {
    const merged = applyCards(computeLoadout('claude'), cardEffects({ r_burn: 1, g_orbit: 1 }));
    expect(merged.mods.burn.dps).toBe(8);
    expect(merged.mods.orbit.count).toBe(3);
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
    expect(GUNS.glm.range).toBeLessThan(GUNS.claude.range);
    expect(GUNS.claude.range).toBeLessThan(GUNS.codex.range);
  });

  it('computeLoadout 暴露枪支射程', () => {
    expect(computeLoadout('glm').range).toBe(GUNS.glm.range);
    expect(computeLoadout('codex').range).toBe(GUNS.codex.range);
  });

  it('射程不短于伤害衰减末端（衰减区间内仍有伤害）', () => {
    for (const g of Object.values(GUNS)) expect(g.range).toBeGreaterThanOrEqual(g.falloffEnd);
  });
});