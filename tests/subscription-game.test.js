import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Game } from '../src/game.js';
import * as rules from '../src/rules.js';
import { PLANS, PROTECTION_ITEMS, coinsToMicros, banChance } from '../src/subscriptions.js';

// 只替换模型工厂；交易、战斗、拾取、波次和终局调用真实 Game.prototype。
vi.mock('../src/pickups.js', async () => {
  const { Group } = await import('three');
  const { LOOT_ITEMS } = await import('../src/rules.js');
  const { getProtection } = await import('../src/subscriptions.js');
  return { makePickupVisual: vi.fn((kind, item) => {
    const valid = kind === 'health' || (kind === 'loot' && LOOT_ITEMS.some((it) => it.id === item))
      || (kind === 'protection' && getProtection(item));
    return valid ? new Group() : null;
  }) };
});

const spies = (names) => Object.fromEntries(names.split(' ').map((name) => [name, vi.fn()]));
function duck() {
  const d = {
    group: new THREE.Group(), root: new THREE.Group(), yaw: 0, deathT: -1,
    update: vi.fn(), kick: vi.fn(), dispose: vi.fn(),
    muzzleWorld: (out) => out.set(0, 0.8, 3),
  };
  d.die = vi.fn(() => { d.deathT = 0; });
  return d;
}
function enemy(type = 'brawler', hp = 100) {
  return {
    type, name: '测试需求鸭', elite: false, dead: false,
    hp, maxHp: hp, pos: new THREE.Vector3(0, 0, 4), vel: new THREE.Vector3(),
    radius: 0.5, scale: 1, damage: 10, speed: 1, reach: 1.5,
    fireT: 1, windup: 0, attackT: 1, seed: 0,
    skillKind: null, skillCd: 1, skillT: 0, duck: duck(),
  };
}
function makeGame() {
  const g = Object.create(Game.prototype);
  const camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 100);
  camera.position.set(0, 15, 22); camera.lookAt(0, 0, 3); camera.updateMatrixWorld();
  g.engine = { scene: new THREE.Scene(), camera, addShake: vi.fn(), updateCamera: vi.fn() };
  g.world = { colliders: [], update: vi.fn() };
  g.hud = spies('toast weaponsOpen renderWeapons subscription coins cardOpen cardBookOpen cardBook renderCards renderCardBook hitmarker feed banner results screen hudOn alert damage syncVolume');
  g.audio = spies('uiClick emptyClick shoot pickup hit hurt kill waveClear waveHorn cardDeal cardPick levelUp skillCast dash gameOver stopMusic startMusic boom swing enemyShoot zap');
  g.fx = spies('ring number feathers spark flash smoke update zone decal bolt');
  g.state = 'playing'; g.fragile = false; g.bot = false; g.best = null;
  g.keys = new Set(); g.mouse = { x: 400, y: 300, down: false };
  g.mouseFire = false; g.padFire = false; g.padAim = null; g.padPrev = [];
  g.t = 0; g.rng = rules.mulberry32(123); g.banRng = vi.fn(() => 1);
  g.playerDuck = duck();
  g.playerHpBar = { group: new THREE.Group(), fill: new THREE.Object3D() };
  g.impactMarker = new THREE.Object3D(); g.impactPoint = new THREE.Vector3();
  g.aimPoint = new THREE.Vector3(0, 0.8, 20); g.ray = new THREE.Raycaster();
  g._frustum = new THREE.Frustum(); g._projMat = new THREE.Matrix4();
  g.enemies = []; g.bullets = []; g.ebullets = []; g.pickups = []; g.orbitals = [];
  g.rebuildPlayerDuck = vi.fn(); // 只隔离 GPU 外观重建，不替换数值重算
  g.makeBulletVis = vi.fn(() => new THREE.Group());
  g.pollGamepad = vi.fn(); g.updateHud = vi.fn();
  g.resetStats();
  return g;
}
function subscribed(id = 'ds') {
  const g = makeGame();
  g.state = 'weapons';
  expect(g.subscribe(id)).toBe(true);
  return g;
}
function selectCard(g, id) {
  g.state = 'card'; g.cardDraft = [{ id }]; g.pickCard(id);
}
function installGamepad(g) {
  const pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false })) };
  vi.stubGlobal('navigator', { getGamepads: () => [pad] });
  g.pollGamepad = Game.prototype.pollGamepad;
  return (...buttons) => {
    pad.buttons.forEach((button, index) => { button.pressed = buttons.includes(index); });
    g.pollGamepad();
  };
}
const balances = (g) => ({
  wallet: g.walletMicros, earned: g.earnedMicros, tokens: g.tokens, quota: g.quotaGranted,
  calls: g.calls, tokensUsed: g.tokensUsed, wave: g.wave, kills: g.kills, score: g.score,
  xp: g.xp, xpEarned: g.xpEarned, hp: g.p.hp, shield: g.p.shield,
  protections: { ...g.protections }, subscription: { ...g.subscription },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('innerWidth', 800); vi.stubGlobal('innerHeight', 600);
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('开局与单一订阅账本', () => {
  it('180预算不计入收入；没有弹药/永久武器兼容状态或免费切换入口', () => {
    const g = makeGame();
    expect(g.coins).toBe(180); expect(g.coinsEarned).toBe(0);
    expect(g.planId).toBeNull(); expect(g.tokens).toBe(0);
    for (const key of ['ownedGuns', 'gunId', 'mags', 'dryT', 'rescued', 'runEnded', 'endReason', 'subscriptionSpendMicros', 'meteredSpendMicros']) expect(g).not.toHaveProperty(key);
    for (const key of ['mag', 'reserve', 'reloadT']) expect(g.p).not.toHaveProperty(key);
    for (const key of ['buyGun', 'equipGun', 'cycleGun', 'startReload']) expect(typeof g[key]).toBe('undefined');
    expect(g.fire()).toBe(false); expect(g.calls).toBe(0);
  });

  it('start先进入冻结选择；首次确认扣费后才开始计时，首波不重复收费/补额度', () => {
    const g = makeGame();
    g.start();
    expect(g.state).toBe('weapons'); expect(g.planId).toBeNull();
    g.update(0.5);
    expect(g.time).toBe(0); expect(g.wave).toBe(0);
    expect(g.subscribe('ds')).toBe(true);
    expect(g.state).toBe('playing'); expect(g.coins).toBe(165);
    expect(g.subscription).toEqual({ paidWave: 1, processedWave: 1 });
    g.fire();
    expect(g.tokens).toBe(1968);
    g.nextWave();
    expect(g.wave).toBe(1); expect(g.coins).toBe(165); expect(g.tokens).toBe(1968);
  });

  it('未选择时关闭回标题，不能无订阅绕过', () => {
    const g = makeGame(); g.start(); g.closeWeapons();
    expect(g.state).toBe('title'); expect(g.planId).toBeNull();
    expect(g.coins).toBe(180); expect(g.coinsEarned).toBe(0);
    expect(g.fire()).toBe(false);
    g.nextWave(); expect(g.wave).toBe(0);
  });

  it('演示鸭自动选择也通过实际付费交易，不凭空获取套餐', () => {
    const g = makeGame(); g.bot = true; g.start();
    expect(g.state).toBe('playing'); expect(g.planId).toBe('ds');
    expect(g.coins).toBe(165); expect(g.tokens).toBe(2000); expect(g.coinsEarned).toBe(0);
  });

  it.each(Object.keys(PLANS))('%s 首次订阅精准扣费并发放额度，纯重算不承担交易', (id) => {
    const g = subscribed(id);
    expect(g.coins).toBe(180 - PLANS[id].fee);
    expect(g.tokens).toBe(PLANS[id].quota); expect(g.quotaGranted).toBe(PLANS[id].quota);
    expect(g.coinsEarned).toBe(0);
    expect(g.rebuildPlayerDuck).toHaveBeenCalledTimes(1);
    const before = balances(g);
    g.recomputeLoadout(); g.recomputeLoadout();
    expect(balances(g)).toEqual(before);
  });

  it('未知/原型ID及错误状态不触发交易；当前计划不收费、不补额度', () => {
    const g = subscribed(); g.tokens = 17;
    const before = balances(g);
    expect(g.subscribe('glm')).toBe(false);
    g.openWeapons();
    for (const id of ['ds', 'codex', 'toString', 'constructor', '__proto__', null, undefined, {}, []]) expect(g.subscribe(id)).toBe(false);
    expect(balances(g)).toEqual(before);
    expect(g.rebuildPlayerDuck).toHaveBeenCalledTimes(1);
  });

  it('切换与切回均付全费/丢旧额度，不能保有多个计划；冷却不被切换重置', () => {
    const g = subscribed(); g.nextWave(); g.tokens = 40; g.p.fireT = 0.2;
    g.protections.us_phone = 2;
    g.openWeapons(); expect(g.subscribe('glm')).toBe(true);
    expect(g.state).toBe('weapons'); expect(g.tokens).toBe(1600); expect(g.coins).toBe(121);
    expect(g.subscribe('ds')).toBe(true);
    expect(g.planId).toBe('ds'); expect(g.tokens).toBe(2000); expect(g.coins).toBe(106);
    expect(g.protections.us_phone).toBe(2); expect(g.p.fireT).toBe(0.2);
    expect(g.coinsEarned).toBe(0);
  });

  it('切换余额不足完全保留原计划、额度、属性和保护计数', () => {
    const g = subscribed(); g.coins = 43; g.tokens = 19; g.protections.kyc = 3;
    g.openWeapons(); const before = balances(g), lo = g.loadout;
    expect(g.subscribe('glm')).toBe(false);
    expect(balances(g)).toEqual(before); expect(g.loadout).toBe(lo); expect(g.planId).toBe('ds');
  });

  it('所有收支入口拒绝畸形金额与透支，累计收入不因消费减少', () => {
    const g = subscribed();
    const before = balances(g);
    for (const n of [-1, NaN, Infinity, '1', undefined, Number.MAX_SAFE_INTEGER]) expect(g.creditCoins(n)).toBe(false);
    for (const n of [-1, NaN, Infinity, 0.1, '1', g.walletMicros + 1]) expect(g.debitMicros(n)).toBe(false);
    expect(balances(g)).toEqual(before);
    expect(g.creditCoins(20)).toBe(true);
    expect(g.coinsEarned).toBe(20); expect(g.coins).toBe(185);
    g.tokens = 0; expect(g.fire()).toBe(true);
    expect(g.walletMicros).toBe(184_688_000); expect(g.coinsEarned).toBe(20);
  });
});

describe('波次续订 / 预付 / 经济卡', () => {
  it('旧额度到期不累计，同波只续订一次且不能回退重算', () => {
    const g = subscribed(); g.nextWave(); g.tokens = 1999;
    g.nextWave();
    expect(g.wave).toBe(2); expect(g.coins).toBe(150); expect(g.tokens).toBe(2000);
    g.fire(); const before = balances(g);
    expect(g.renewSubscription(2)).toBe(true);
    expect(g.renewSubscription(1)).toBe(false);
    expect(balances(g)).toEqual(before);
  });

  it('波间切换预付下一波，提前使用的额度不会在下波重复发放', () => {
    const g = subscribed(); g.nextWave();
    g.waveState = 'inter'; g.openWeapons(); expect(g.subscribe('gpt')).toBe(true);
    expect(g.subscription.paidWave).toBe(2); expect(g.coins).toBe(105);
    g.closeWeapons(); expect(g.fire()).toBe(true); expect(g.tokens).toBe(968);
    g.nextWave();
    expect(g.wave).toBe(2); expect(g.tokens).toBe(968); expect(g.coins).toBe(105);
  });

  it('失败续订不扣部分费用、不发额度，本波后来进账也不自动重试', () => {
    const g = subscribed(); g.nextWave(); g.coins = 14; g.tokens = 120;
    g.nextWave();
    expect(g.tokens).toBe(0); expect(g.quotaGranted).toBe(0); expect(g.coins).toBe(14);
    expect(g.planId).toBe('ds'); expect(g.subscription).toEqual({ paidWave: 1, processedWave: 2 });
    g.creditCoins(50);
    expect(g.renewSubscription(2)).toBe(false);
    expect(g.coins).toBe(64); expect(g.tokens).toBe(0);
    g.openWeapons(); expect(g.subscribe('ds')).toBe(false); g.closeWeapons();
    g.nextWave();
    expect(g.wave).toBe(3); expect(g.coins).toBe(49); expect(g.tokens).toBe(2000);
    expect(g.subscriptionStatus).toBe('active'); expect(g.coinsEarned).toBe(50);
  });

  it('配额卡在真实选卡后只影响下次发放，开关面板和重算不补当前额度', () => {
    const g = subscribed(); g.nextWave(); g.tokens = 101;
    selectCard(g, 'c_mag');
    expect(g.tokens).toBe(101); expect(g.quotaGranted).toBe(2000);
    for (let i = 0; i < 8; i++) { g.openWeapons(); g.closeWeapons(); g.recomputeLoadout(); }
    expect(g.tokens).toBe(101); expect(g.coins).toBe(165);
    g.nextWave(); expect(g.tokens).toBe(2500); expect(g.coins).toBe(150);
  });

  it('预算补贴选一次只加30金币，折扣只作用按量价不减订阅费', () => {
    const g = subscribed(); const before = g.walletMicros;
    selectCard(g, 'c_ammo');
    expect(g.walletMicros).toBe(before + coinsToMicros(30)); expect(g.coinsEarned).toBe(30);
    g.pickCard('c_ammo'); expect(g.walletMicros).toBe(before + coinsToMicros(30));
    expect(g.usageQuote().rateMicros).toBe(8775);
    g.openWeapons(); expect(g.subscribe('glm')).toBe(true);
    expect(g.walletMicros).toBe(before + coinsToMicros(30) - coinsToMicros(44));
    expect(g.usageQuote().rateMicros).toBe(32850);
  });

  it('真实击杀返现4金币且只结算一次，不回收虚假弹药', () => {
    const g = subscribed(); g.cards.r_ammoBack = 1; g.recomputeLoadout(); g.rng = () => 0;
    const e = enemy(), before = g.coins;
    g.killEnemy(e);
    const income = rules.coinsFor('brawler') + 4;
    expect(g.coins).toBe(before + income); expect(g.coinsEarned).toBe(income);
    g.killEnemy(e); expect(g.coins).toBe(before + income); expect(g.kills).toBe(1);
    expect(g.p).not.toHaveProperty('reserve');
  });
});

describe('武器调用计费与封号', () => {
  it('GLM散射+多重射击7发只计32 Token、一次调用，安全计划不访问风险 RNG', () => {
    const g = subscribed('glm'); g.cards.g_multishot = 2; g.recomputeLoadout();
    const before = g.walletMicros;
    expect(g.fire()).toBe(true);
    expect(g.tokens).toBe(1568); expect(g.walletMicros).toBe(before);
    expect(g.calls).toBe(1); expect(g.tokensUsed).toBe(32);
    expect(g.shots).toBe(7); expect(g.bullets).toHaveLength(7);
    expect(g.banRng).not.toHaveBeenCalled();
  });

  it('混合扣款整笔提交，一微金币不够时不吞额度也不生成攻击/抽封号', () => {
    const g = subscribed('gpt'); g.tokens = 20; g.walletMicros = 959999;
    const before = balances(g);
    expect(g.fire()).toBe(false); expect(balances(g)).toEqual(before);
    expect(g.bullets).toHaveLength(0); expect(g.banRng).not.toHaveBeenCalled();
    g.walletMicros++;
    expect(g.fire()).toBe(true); expect(g.tokens).toBe(0); expect(g.walletMicros).toBe(0);
    expect(g.calls).toBe(1); expect(g.tokensUsed).toBe(32); expect(g.banRng).toHaveBeenCalledTimes(1);
  });

  it('暂停/菜单/冷却调用不收费，也不抽封号；每次被接受的整轮只抽一次', () => {
    const g = subscribed('claude'); g.cards.g_multishot = 2; g.recomputeLoadout();
    expect(g.fire()).toBe(true); expect(g.banRng).toHaveBeenCalledTimes(1);
    const before = balances(g);
    expect(g.fire()).toBe(false);
    g.p.fireT = 0;
    for (const state of ['paused', 'weapons', 'card', 'cardbook', 'title']) { g.state = state; expect(g.fire()).toBe(false); }
    expect(balances(g)).toEqual(before); expect(g.banRng).toHaveBeenCalledTimes(1);
    expect(g.bullets).toHaveLength(3);
  });

  it.each(['claude', 'gpt'])('%s 风险阈值使用严格小于，只在成功扣费后抽取', (id) => {
    const boundary = subscribed(id); const risk = PLANS[id].banChance;
    boundary.banRng.mockReturnValue(risk);
    expect(boundary.fire()).toBe(true); expect(boundary.state).toBe('playing');
    const below = subscribed(id); below.banRng.mockReturnValue(risk - 1e-10);
    expect(below.fire()).toBe(false); expect(below.state).toBe('over'); expect(below.result.reason).toBe('ban');
    expect(below.tokens).toBe(968); expect(below.calls).toBe(1); expect(below.tokensUsed).toBe(32);
    expect(below.shots).toBe(0); expect(below.bullets).toHaveLength(0);
    expect(below.result).toMatchObject({ reason: 'ban', provider: id, providerLabel: PLANS[id].label });
  });

  it.each(['qwen', 'glm', 'ds'])('%s 无封号快路径，不能误应用正概率地板', (id) => {
    const g = subscribed(id); g.protections.us_phone = 99999;
    g.banRng.mockImplementation(() => { throw new Error('安全计划不应抽封号'); });
    expect(g.currentBanChance()).toBe(0); expect(g.fire()).toBe(true); expect(g.state).toBe('playing');
  });

  it('封号无视无敌/护盾/守护/不死鸟；最低风险仍可触发且已付混合用量不退款', () => {
    const g = subscribed('claude');
    g.cards = { g_phoenix: 1, g_guardian: 1 }; g.recomputeLoadout();
    g.protections.us_phone = 10000; expect(g.currentBanChance()).toBe(0.00025);
    g.p.iframes = 9999; g.p.shield = 9999; g.p.skillShield = 80; g.p.shieldSkillT = 6;
    g.tokens = 20; const before = g.walletMicros; g.banRng.mockReturnValue(0);
    expect(g.fire()).toBe(false);
    expect(g.state).toBe('over'); expect(g.p.hp).toBe(0);
    expect(g.p.shield).toBe(9999); expect(g.guardianCd).toBe(0); expect(g.phoenixUsed).toBe(false);
    expect(g.tokens).toBe(0); expect(g.walletMicros).toBe(before - coinsToMicros(1.92));
    expect(g.calls).toBe(1); expect(g.shots).toBe(0);
    expect(g.playerDuck.die).toHaveBeenCalledTimes(1); expect(g.playerHpBar.group.visible).toBe(false);
  });

  it('0余额/0额度仍能释放冷却技能、击杀恢复收入，不产生调用费/封号抽取', () => {
    const g = subscribed('gpt'); g.tokens = 0; g.coins = 0;
    const e = enemy('brawler', 1); g.enemies = [e];
    expect(g.fire()).toBe(false); g.castSkill(1);
    expect(g.skillCd.storm).toBeGreaterThan(0); expect(e.dead).toBe(true);
    expect(g.coins).toBeGreaterThan(0); expect(g.calls).toBe(0); expect(g.tokensUsed).toBe(0);
    expect(g.banRng).not.toHaveBeenCalled(); expect(g.state).toBe('playing');
  });

  it('在途弹道保存原计划衰减/穿透/特效，付费切换不改变旧调用伤害', () => {
    const g = subscribed('claude'); g.cards = { r_pierce: 2, r_frost: 1 }; g.recomputeLoadout();
    const oldMods = g.loadout.mods;
    expect(g.fire()).toBe(true);
    const b = g.bullets[0], attack = b.attack;
    expect(b.pierce).toBe(3); expect(attack.provider).toBe('claude');
    expect(attack.mods).not.toBe(oldMods); expect(attack.mods.frost).not.toBe(oldMods.frost);
    oldMods.frost.factor = 0.99; expect(attack.mods.frost.factor).toBe(0.5);
    g.openWeapons(); g.subscribe('glm'); g.closeWeapons();
    const e = enemy('brawler', 10000); e.pos.set(0, 0, 10); g.enemies = [e];
    b.pos.set(0, 0.8, 9.8); b.vel.set(0, 0, 60); b.traveled = 40;
    g.applyHitMods = vi.fn();
    g.updateBullets(0.01);
    const expected = rules.damageAtDistance(68, 40.3, attack);
    expect(e.hp).toBeCloseTo(10000 - expected);
    expect(expected).not.toBeCloseTo(rules.damageAtDistance(68, 40.3, g.loadout));
    expect(g.applyHitMods).toHaveBeenCalledWith(e, expect.any(THREE.Vector3), expect.closeTo(expected), attack.mods);
    expect(g.hits).toBe(1); expect(b.pierce).toBe(2);
  });
});

describe('保护掉落、结算幂等与死亡帧', () => {
  it('普通战斗伤害仍遵守无敌/结界/护盾/不死鸟，第二次致死才结算战斗阵亡', () => {
    const g = subscribed(); g.cards = { g_guardian: 1, g_phoenix: 1 }; g.recomputeLoadout();
    g.p.iframes = 1; g.p.shield = 100;
    g.damagePlayer(9999);
    expect(g.p.hp).toBe(100); expect(g.p.shield).toBe(100); expect(g.guardianCd).toBe(0);
    g.p.iframes = 0; g.damagePlayer(40);
    expect(g.guardianCd).toBe(9); expect(g.p.shield).toBe(100);
    g.damagePlayer(40); expect(g.p.shield).toBe(60); expect(g.p.hp).toBe(100);
    g.p.shield = 0; g.damagePlayer(9999);
    expect(g.state).toBe('playing'); expect(g.phoenixUsed).toBe(true); expect(g.p.hp).toBe(60);
    expect(g.hud.results).not.toHaveBeenCalled();
    g.p.iframes = 0; g.damagePlayer(9999);
    expect(g.state).toBe('over'); expect(g.p.hp).toBe(0); expect(g.result.reason).toBe('combat');
    expect(g.result).toMatchObject({ reason: 'combat', calls: 0, tokensUsed: 0 });
    expect(g.hud.results).toHaveBeenCalledTimes(1);
  });

  it('四类可重复拾取且只各结算一次，跨波/切换/清场保留，重开清零', () => {
    const g = subscribed();
    for (let n = 0; n < 2; n++) for (const item of PROTECTION_ITEMS) g.spawnPickup(g.p.pos, 'protection', item.id);
    g.updatePickups(0.01); g.updatePickups(0.01);
    expect(Object.values(g.protections)).toEqual([2, 2, 2, 2]); expect(g.pickups).toHaveLength(0);
    expect(g.coins).toBe(165); expect(g.coinsEarned).toBe(0);
    g.nextWave(); g.openWeapons(); g.subscribe('gpt'); g.closeWeapons(); g.clearField();
    expect(Object.values(g.protections)).toEqual([2, 2, 2, 2]);
    expect(g.currentBanChance()).toBeCloseTo(banChance('gpt', { us_phone: 8 }));
    g.start(); expect(Object.values(g.protections)).toEqual([0, 0, 0, 0]); expect(g.planId).toBeNull();
  });

  it('额外保护掉落不挤占正常福利和回血分支', () => {
    const g = subscribed(); g.rng = () => 0;
    vi.spyOn(rules, 'rollLoot').mockReturnValue(['salary']);
    vi.spyOn(rules, 'rollDrop').mockReturnValue('health');
    g.killEnemy(enemy());
    expect(g.pickups.map((pk) => [pk.kind, pk.item])).toEqual([
      ['loot', 'salary'], ['health', undefined], ['protection', 'us_phone'],
    ]);
  });

  it('未知/原型拾取不能变成回血或磁铁收益', () => {
    const g = subscribed(); g.cards.r_magnet = 1; g.recomputeLoadout(); g.p.hp = 20;
    for (const [kind, item] of [['unknown'], ['ammo'], ['loot', 'constructor'], ['protection', '__proto__']]) {
      const mesh = new THREE.Group(); mesh.position.copy(g.p.pos);
      g.pickups.push({ kind, item, mesh, t: 0, life: 10 });
    }
    const before = balances(g);
    g.updatePickups(0.01);
    expect(balances(g)).toEqual(before); expect(g.pickups).toHaveLength(0);
    expect(g.audio.pickup).not.toHaveBeenCalled();
    expect(g.spawnPickup(g.p.pos, 'ammo')).toBe(false);
  });

  it('终局/纪录/计时器只结算一次，保留第一次死亡原因', () => {
    const g = subscribed('gpt'); g.score = 100;
    expect(g.endRun('ban')).toBe(true);
    expect(g.endRun('combat')).toBe(false); expect(g.endRun('ban')).toBe(false);
    g.damagePlayer(99999);
    expect(g.result.reason).toBe('ban'); expect(g.hud.results).toHaveBeenCalledTimes(1);
    expect(localStorage.setItem).toHaveBeenCalledTimes(1);
    expect(g.audio.gameOver).toHaveBeenCalledTimes(1); expect(g.playerDuck.die).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(g.hud.screen).toHaveBeenCalledTimes(1); expect(g.hud.screen).toHaveBeenLastCalledWith('over');
    expect(g.overTimer).toBeNull();
  });

  it('终局后 XP/回血/收入/拾取/击杀/续费/出怪不能改变结算数据', () => {
    const g = subscribed('claude'); const e = enemy(); g.enemies = [e];
    g.spawnPickup(g.p.pos, 'loot', 'stock'); g.banRng.mockReturnValue(0); g.fire();
    const before = balances(g), result = { ...g.result }, pkCount = g.pickups.length;
    g.addXp(999); g.creditCoins(100); g.addShield(100); g.applyLootEffect({ kind: 'fullheal' });
    g.damageEnemy(e, 9999); g.killEnemy(e); g.castSkill(1); g.spawnEnemy('brawler');
    g.spawnPickup(g.p.pos, 'protection', 'kyc'); g.updatePickups(1); g.updateEnemies(1); g.updateBullets(1);
    g.nextWave(); g.renewSubscription(2); g.offerCards(); g.fire();
    expect(balances(g)).toEqual(before); expect(g.result).toEqual(result);
    expect(g.pickups).toHaveLength(pkCount); expect(g.enemies).toHaveLength(1); expect(e.dead).toBe(false);
    expect(g.hud.results).toHaveBeenCalledTimes(1);
  });

  it('updatePlayer开火封号后同帧停止波次与后续系统，不能自愈或重现血条', () => {
    const g = subscribed('claude'); g.banRng.mockReturnValue(0);
    g.mouse.down = true; g.time = 20; g.interT = 0.001;
    const waves = vi.spyOn(g, 'updateWaves'), enemies = vi.spyOn(g, 'updateEnemies');
    const pickups = vi.spyOn(g, 'updatePickups');
    g.update(0.05);
    expect(g.state).toBe('over'); expect(g.p.hp).toBe(0); expect(g.wave).toBe(0);
    expect(g.interT).toBe(0.001); expect(g.playerHpBar.group.visible).toBe(false);
    expect(waves).not.toHaveBeenCalled(); expect(enemies).not.toHaveBeenCalled(); expect(pickups).not.toHaveBeenCalled();
  });

  it('敌人循环中死亡立即返回，后续燃烧击杀不能升级回血/挣钱', () => {
    const g = subscribed(); g.nextWave();
    const killer = enemy('boss'); killer.skillKind = 'nova'; killer.skillT = 0.01; killer.damage = 9999;
    const burning = enemy('brawler', 1); burning.burnT = 1; burning.burnDps = 1000;
    g.enemies = [killer, burning];
    const beforeCoins = g.walletMicros;
    g.updateEnemies(0.02);
    expect(g.state).toBe('over'); expect(g.p.hp).toBe(0); expect(g.kills).toBe(0);
    expect(g.walletMicros).toBe(beforeCoins); expect(g.xpEarned).toBe(0);
    expect(burning.hp).toBe(1); expect(burning.burnT).toBe(1); expect(burning.dead).toBe(false);
  });

  it('敌方弹道循环中死亡立即返回，不再推进后续攻击', () => {
    const g = subscribed();
    const later = { pos: g.p.pos.clone().setY(0.8).add(new THREE.Vector3(5, 0, 0)), vel: new THREE.Vector3(1, 0, 0), life: 1, dmg: 10 };
    const lethal = { pos: g.p.pos.clone().setY(0.8), vel: new THREE.Vector3(), life: 1, dmg: 9999 };
    g.ebullets = [later, lethal]; const pos = later.pos.clone();
    g.updateBullets(0.01);
    expect(g.state).toBe('over'); expect(later.life).toBe(1); expect(later.pos.equals(pos)).toBe(true);
    expect(g.hud.results).toHaveBeenCalledTimes(1);
  });
});

describe('审查回归：集中结算与派生状态', () => {
  it('直接提交结算器的余额和额度，不再次经 debitMicros 重复计费', () => {
    const g = subscribed(); g.coins = 1; g.tokens = 16;
    const debit = vi.spyOn(g, 'debitMicros');
    const payment = g.payInvocation();
    expect(payment).toMatchObject({ walletMicros: 844000, remainingTokens: 0, costMicros: 156000 });
    expect(g.walletMicros).toBe(payment.walletMicros); expect(g.tokens).toBe(payment.remainingTokens);
    expect(g.calls).toBe(1); expect(g.tokensUsed).toBe(32);
    expect(debit).not.toHaveBeenCalled();
    g.coins = 0; g.tokens = 31;
    const before = balances(g);
    expect(g.payInvocation()).toBeNull(); expect(balances(g)).toEqual(before);
    expect(debit).not.toHaveBeenCalled();
  });

  it('订阅状态只由计划与付费波次派生，配额耗尽/预付/续费失败语义不变', () => {
    const g = makeGame();
    expect(g.subscriptionStatus).toBe('metered');
    expect(g.subscription).toEqual({ paidWave: 0, processedWave: 0 });
    g.state = 'weapons'; g.subscribe('ds'); g.nextWave(); g.tokens = 0;
    expect(g.subscriptionStatus).toBe('active');
    g.waveState = 'inter'; g.openWeapons(); g.coins = 100; g.subscribe('gpt'); g.closeWeapons();
    expect(g.subscriptionStatus).toBe('active');
    expect(g.subscription).toEqual({ paidWave: 2, processedWave: 2 });
    g.nextWave(); expect(g.coins).toBe(40); expect(g.subscriptionStatus).toBe('active');
    g.nextWave(); expect(g.subscriptionStatus).toBe('metered');
    expect(g.subscription).toEqual({ paidWave: 2, processedWave: 3 });
    g.creditCoins(100);
    expect(g.renewSubscription(3)).toBe(false); expect(g.subscriptionStatus).toBe('metered');
    g.nextWave(); expect(g.subscriptionStatus).toBe('active');
    expect(g.subscription).toEqual({ paidWave: 4, processedWave: 4 });
    g.toTitle(); expect(g.subscriptionStatus).toBe('metered'); expect(g.result).toBeNull();
  });
});

describe('审查回归：纯手柄免费技能', () => {
  it.each([[12, 1, 'storm'], [15, 2, 'shield'], [13, 3, 'rage'], [14, 4, 'slow']])(
    '十字键 %s 以按下边沿释放技能 %s，按住经过冷却也不连发', (button, skill, id) => {
      const g = subscribed(); g.level = 9; g.recomputeLoadout();
      const poll = installGamepad(g), cast = vi.spyOn(g, 'castSkill');
      const wallet = g.walletMicros, tokens = g.tokens;
      poll(button);
      expect(cast).toHaveBeenCalledExactlyOnceWith(skill); expect(g.skillCd[id]).toBeGreaterThan(0);
      g.skillCd[id] = 0; poll(button); poll(button);
      expect(cast).toHaveBeenCalledTimes(1); expect(g.skillCd[id]).toBe(0);
      poll(); poll(button);
      expect(cast).toHaveBeenCalledTimes(2); expect(g.skillCd[id]).toBeGreaterThan(0);
      expect(g.walletMicros).toBe(wallet); expect(g.tokens).toBe(tokens);
      expect(g.calls).toBe(0); expect(g.tokensUsed).toBe(0); expect(g.banRng).not.toHaveBeenCalled();
    },
  );

  it('手柄沿用技能等级和冷却限制，不因输入来源绕过', () => {
    const g = subscribed(), poll = installGamepad(g);
    for (const button of [15, 13, 14]) { poll(button); poll(); }
    expect(g.skillCd).toEqual({ storm: 0, shield: 0, rage: 0, slow: 0 });
    g.skillCd.storm = 5; poll(12); poll(); expect(g.skillCd.storm).toBe(5);
    g.level = 3; g.recomputeLoadout(); poll(15);
    expect(g.skillCd.shield).toBeGreaterThan(0); expect(g.p.skillShield).toBeGreaterThan(0);
    expect(g.tokens).toBe(2000); expect(g.coins).toBe(165);
  });

  it.each(['weapons', 'paused', 'cardbook', 'card'])('%s 十字键只导航，不释放技能', (state) => {
    const g = subscribed(), poll = installGamepad(g), cast = vi.spyOn(g, 'castSkill');
    vi.stubGlobal('document', { activeElement: null });
    g.state = state; g.t = 1; g.menuNavigate = vi.fn();
    poll(12);
    expect(g.menuNavigate).toHaveBeenCalledExactlyOnceWith(0, -1);
    expect(cast).not.toHaveBeenCalled(); expect(g.skillCd.storm).toBe(0);
  });

  it('关闭菜单的同次轮询和仍按住的方向都不泄漏成技能，松开重按才释放', () => {
    const g = subscribed(), poll = installGamepad(g), cast = vi.spyOn(g, 'castSkill');
    vi.stubGlobal('document', { activeElement: null });
    g.menuNavigate = vi.fn(); g.menuFocusables = vi.fn(() => []); g.t = 1;
    g.openWeapons(); poll(12); poll(12, 1);
    expect(g.state).toBe('playing'); expect(cast).not.toHaveBeenCalled();
    poll(12); expect(cast).not.toHaveBeenCalled();
    poll(); poll(12);
    expect(cast).toHaveBeenCalledExactlyOnceWith(1); expect(g.skillCd.storm).toBeGreaterThan(0);
  });

  it.each(['title', 'over'])('%s 十字键不释放战斗技能', (state) => {
    const g = subscribed(), poll = installGamepad(g), cast = vi.spyOn(g, 'castSkill');
    g.state = state; poll(12);
    expect(cast).not.toHaveBeenCalled(); expect(g.skillCd.storm).toBe(0);
  });

  it('真实42次Claude调用耗尽预算后，纯手柄免费击杀能恢复射击', () => {
    const g = subscribed('claude'), poll = installGamepad(g);
    for (let i = 0; i < 42; i++) { g.p.fireT = 0; expect(g.fire()).toBe(true); }
    expect(g.tokens).toBe(0); expect(g.coins).toBe(4.96); expect(g.calls).toBe(42);
    g.p.fireT = 0; expect(g.fire()).toBe(false);
    const e = enemy('brawler', 1); g.enemies = [e];
    const calls = g.calls, used = g.tokensUsed, draws = g.banRng.mock.calls.length;
    poll(12);
    expect(e.dead).toBe(true); expect(g.coins).toBeGreaterThan(4.96);
    expect(g.skillCd.storm).toBeGreaterThan(0);
    expect(g.calls).toBe(calls); expect(g.tokensUsed).toBe(used);
    expect(g.banRng).toHaveBeenCalledTimes(draws);
    const wallet = g.walletMicros;
    expect(g.fire()).toBe(true); expect(g.calls).toBe(calls + 1);
    expect(g.walletMicros).toBe(wallet - coinsToMicros(5.12));
    expect(g.banRng).toHaveBeenCalledTimes(draws + 1); expect(g.state).toBe('playing');
  });
});
