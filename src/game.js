import * as THREE from 'three';
import { Duck, PALETTES } from './duck.js';
import { FX } from './fx.js';
import { WEAPON, ENEMY_TYPES, wavePlan, waveIntro, damageAtDistance, scoreFor, rollDrop, mulberry32, canEngage, computeLoadout, coinsFor, rollLoot, LOOT_ITEMS, xpForLevel, xpForKill, WAVE_CLEAR_XP, CARD_BY_ID, CARD_RARITIES, rollCards, cardEffects, SKILLS, applyCards, ELITE, eliteHpMul, ELITE_SKILL, BOSS_SKILL, raySphereT, marchImpact, enemyName, skillCountForLevel } from './rules.js';
import { PLANS, STARTING_COINS, getPlan, coinsToMicros, microsToCoins, quoteSubscription, quoteUsage, settleInvocation, banChance, PROTECTION_ITEMS, PROTECTION_DURATION, getProtection, rollProtection } from './subscriptions.js';
import { ARENA, GATES, GATE_LANE_HALF, groundHeight, waterSurfaceAt, resolveColliders } from './world.js';
import { textTexture } from './textures.js';
import { makePickupVisual } from './pickups.js';

const LOOT_BY_ID = Object.fromEntries(LOOT_ITEMS.map((i) => [i.id, i]));
const GAMEPAD_SKILLS = [[12, 1], [15, 2], [13, 3], [14, 4]];
// Claude 追踪导弹最大转向角速度（rad/s）：转弯半径 = 弹速 / 角速度，配合较低弹速得到柔和弧线而非急折线
const MISSILE_TURN_RATE = 13;

// 头顶名字精灵：贴图由 textTexture 内部统一缓存（32px 小栅格），此处不再自建缓存
function makeNameSprite(text, color = '#ffffff', height = 0.3) {
  const tex = textTexture(text, color, 32);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(height * (tex.image.width / tex.image.height), height, 1);
  return s;
}

function segBlocked(a, b, colliders) {
  const steps = 10;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    for (const c of colliders) {
      if (c.hx !== undefined) {
        if (Math.abs(x - c.x) < c.hx && Math.abs(z - c.z) < c.hz) return true;
      } else if (Math.hypot(x - c.x, z - c.z) < c.r) return true;
    }
  }
  return false;
}

function pointBlocked(x, z, colliders) {
  for (const c of colliders) {
    if (c.hx !== undefined) {
      if (Math.abs(x - c.x) < c.hx && Math.abs(z - c.z) < c.hz) return true;
    } else if (Math.hypot(x - c.x, z - c.z) < c.r) return true;
  }
  return false;
}

export class Game {
  constructor(engine, world, hud, audio) {
    this.engine = engine;
    this.world = world;
    this.hud = hud;
    this.audio = audio;
    this.fx = new FX(engine.scene);
    this.state = 'title';
    this.keys = new Set();
    this.mouse = { x: innerWidth / 2, y: innerHeight / 2, down: false };
    this.aimPoint = new THREE.Vector3(0, 0.7, 6);
    this.impactPoint = new THREE.Vector3(0, 0, 6);
    this.ray = new THREE.Raycaster();
    this._frustum = new THREE.Frustum();
    this._projMat = new THREE.Matrix4();
    this.rng = mulberry32(Date.now() & 0xffff);
    this.banRng = mulberry32((Date.now() ^ 0xa57bc97d) >>> 0); // 与出怪/掉落独立，可注入测试 RNG
    this.t = 0;
    this.showFps = false;
    this.fragile = false;
    this.padAim = null;
    this.padPrev = [];
    this.mouseFire = false;
    this.best = this.loadBest();

    this.playerDuck = new Duck('player', 1, 'rifle', { planId: 'ds', accent: PLANS.ds.accent });
    engine.scene.add(this.playerDuck.group);
    this.playerDuck.group.position.set(0, 0, 3);
    this.playerHpBar = this.makeHpBar(0x7ee06a, '打工鸭鸭', '#ffe9a8');
    this.playerHpBar.group.visible = false;
    const imGeo = new THREE.RingGeometry(0.22, 0.34, 24);
    imGeo.rotateX(-Math.PI / 2);
    this.impactMarker = new THREE.Mesh(imGeo, new THREE.MeshBasicMaterial({ color: 0xffd080, transparent: true, opacity: 0.85, depthWrite: false }));
    this.impactMarker.visible = false;
    engine.scene.add(this.impactMarker);
    this._bulletGeo = new THREE.CapsuleGeometry(0.03, 0.12, 3, 6);
    this._bulletGeo.rotateX(Math.PI / 2);
    this._bulletMat = new THREE.MeshStandardMaterial({ color: 0xd8b060, roughness: 0.35, metalness: 0.85, emissive: 0x201004 });
    this._tailGeo = new THREE.BoxGeometry(0.05, 0.05, 1);
    // 差异化子弹几何体：按价格梯度递增视觉复杂度
    this._bulletGeoOrb = new THREE.SphereGeometry(0.06, 8, 6);
    this._bulletGeoTracer = new THREE.CapsuleGeometry(0.02, 0.22, 3, 6);
    this._bulletGeoTracer.rotateX(Math.PI / 2);
    this._bulletGeoEnergy = new THREE.CapsuleGeometry(0.04, 0.18, 4, 8);
    this._bulletGeoEnergy.rotateX(Math.PI / 2);
    this._tailGeoWide = new THREE.BoxGeometry(0.09, 0.09, 1);
    this._tailGeoThin = new THREE.BoxGeometry(0.03, 0.03, 1);
    // Claude 追踪导弹：弹体 / 鼻锥 / 尾翼 / 尾焰，均沿 z 轴（鼻锥朝 +z，尾焰朝 -z）
    this._missileBodyGeo = new THREE.CylinderGeometry(0.055, 0.062, 0.42, 10);
    this._missileBodyGeo.rotateX(Math.PI / 2);
    this._missileNoseGeo = new THREE.ConeGeometry(0.055, 0.2, 10);
    this._missileNoseGeo.rotateX(Math.PI / 2);
    this._missileFinGeo = new THREE.BoxGeometry(0.018, 0.17, 0.15);
    this._missileFlameGeo = new THREE.ConeGeometry(0.05, 0.28, 8);
    this._missileFlameGeo.rotateX(-Math.PI / 2);
    this._bulletMatCache = new Map();
    this.enemies = [];
    this.bullets = [];
    this.ebullets = [];
    this.pickups = [];
    this.orbitals = [];
    this.resetStats();
  }

  // 演示(bot)与挑战(fragile)模式成绩与正常模式分档存储，互不污染
  bestKey() {
    return this.bot ? 'swyy_best_bot' : this.fragile ? 'swyy_best_fragile' : 'swyy_best';
  }

  loadBest() {
    try { return JSON.parse(localStorage.getItem(this.bestKey())) || null; } catch { return null; }
  }

  resetStats() {
    this.p = {
      pos: new THREE.Vector3(0, 0, 3), vel: new THREE.Vector3(),
      hp: 100, maxHp: 100,
      heat: 0, fireT: 0, dashT: 0, dashCd: 0, iframes: 0,
      lastHurt: -99, aimYaw: 0, moving: false, dashDir: new THREE.Vector3(0, 0, -1),
      shield: 0, shieldMax: 0, skillShield: 0, shieldSkillT: 0, rageT: 0, hasteT: 0,
    };
    this.wave = 0;
    this.waveState = 'inter';
    this.interT = 2.2;
    this.spawnQueue = [];
    this.spawnT = 0;
    this.kills = 0; this.shots = 0; this.hits = 0; this.score = 0; this.time = 0;
    this.walletMicros = coinsToMicros(STARTING_COINS);
    this.earnedMicros = 0; // 启动预算不计入本局挣得的收入
    this.planId = null;
    this.tokens = 0;
    this.quotaGranted = 0;
    this.subscription = { paidWave: 0, processedWave: 0 };
    this.protections = Object.fromEntries(PROTECTION_ITEMS.map((it) => [it.id, []]));
    this.calls = 0; this.tokensUsed = 0;
    this.result = null;
    this.lastFundsHint = -Infinity;
    this.level = 1; this.xp = 0; this.xpEarned = 0;
    this.cards = {};        // 卡牌 id → 已叠层数
    this.cardDraft = null;  // 当前三选一候选
    this.cardHistory = [];  // 选取顺序，供已获列表展示
    this.phoenixUsed = false;
    this.guardianCd = 0;
    this.orbitT = 0;
    this.overTimer = null;
    this.skillCd = { storm: 0, shield: 0, rage: 0, slow: 0 };
    this.slowT = 0; this.slowFactor = 1;
    this.recomputeLoadout();
    this.p.hp = this.p.maxHp;
    if (this.fragile) { this.p.hp = 1; this.p.maxHp = 1; }
  }

  recomputeLoadout() {
    const oldMax = this.loadout ? this.loadout.maxHp : this.p.maxHp;
    this.loadout = applyCards(computeLoadout(this.planId), cardEffects(this.cards, this.level));
    const delta = this.loadout.maxHp - oldMax;
    this.p.maxHp = this.loadout.maxHp;
    this.p.hp = Math.min(this.p.maxHp, this.p.hp + Math.max(0, delta));
    if (this.fragile) { this.p.maxHp = 1; this.p.hp = Math.min(this.p.hp, 1); }
  }

  clearField() {
    for (const e of this.enemies) {
      this.engine.scene.remove(e.duck.group); e.duck.dispose();
      if (e.hpBar) this.removeHpBar(e.hpBar);
    }
    for (const pk of this.pickups) this.engine.scene.remove(pk.mesh);
    for (const b of this.bullets) if (b.vis) this.engine.scene.remove(b.vis);
    for (const b of this.ebullets) if (b.spr) this.engine.scene.remove(b.spr);
    for (const m of this.orbitals) this.engine.scene.remove(m);
    this.orbitals = [];
    this.enemies = []; this.pickups = []; this.bullets = []; this.ebullets = [];
    this.cardDraft = null;
    this.hud.cardOpen(false);
    this.hud.cardBookOpen(false);
  }

  start() {
    if (this.overTimer) { clearTimeout(this.overTimer); this.overTimer = null; }
    this.clearField();
    this.keys.clear(); this.mouse.down = false; this.mouseFire = false;
    this.best = this.loadBest();
    this.resetStats();
    this.rebuildPlayerDuck();
    this.playerDuck.deathT = -1;
    this.playerDuck.root.rotation.set(0, 0, 0);
    this.playerDuck.root.scale.setScalar(1);
    this.playerDuck.group.position.copy(this.p.pos);
    this.state = 'playing';
    this.hud.screen(null);
    this.hud.hudOn(true);
    this.hud.toast('180 金币启动预算 · 先选择一项订阅再开工');
    this.audio.startMusic();
    this.updateHud();
    this.openWeapons();
    if (this.bot) this.subscribe('ds'); // 演示鸭也通过真实扣费入口选择低价计划
  }

  toTitle() {
    if (this.overTimer) { clearTimeout(this.overTimer); this.overTimer = null; }
    this.state = 'title';
    this.clearField();
    this.keys.clear(); this.mouse.down = false; this.mouseFire = false;
    this.best = this.loadBest();
    this.resetStats();
    this.rebuildPlayerDuck();
    this.playerDuck.deathT = -1;
    this.playerDuck.root.rotation.set(0, 0, 0);
    this.playerDuck.root.scale.setScalar(1);
    this.playerDuck.group.position.set(0, 0, 3);
    this.playerHpBar.group.visible = false;
    this.hud.weaponsOpen(false);
    this.hud.screen('start');
    this.hud.hudOn(false);
    this.audio.stopMusic();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    // 清输入状态：切窗后窗外的 keyup/mouseup 到不了页面，避免恢复时自动走火/走路
    this.keys.clear();
    this.mouse.down = false;
    this.mouseFire = false;
    this.hud.screen('pause');
    this.hud.syncVolume(this.audio);
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.hud.screen(null);
  }

  /* ---------------- 单一订阅 / 整数微金币账本 ---------------- */

  get coins() { return microsToCoins(this.walletMicros); }
  set coins(value) { this.walletMicros = coinsToMicros(value); }
  get coinsEarned() { return microsToCoins(this.earnedMicros); }
  set coinsEarned(value) { this.earnedMicros = coinsToMicros(value); }

  creditCoins(amount) {
    if (this.state === 'over') return false;
    let micros;
    try { micros = coinsToMicros(amount); } catch { return false; }
    if (!Number.isSafeInteger(this.walletMicros + micros) || !Number.isSafeInteger(this.earnedMicros + micros)) return false;
    this.walletMicros += micros;
    this.earnedMicros += micros;
    return true;
  }

  debitMicros(amount) {
    if (this.state === 'over' || !Number.isSafeInteger(amount) || amount < 0 || amount > this.walletMicros) return false;
    this.walletMicros -= amount;
    return true;
  }

  get subscriptionStatus() {
    const { paidWave, processedWave } = this.subscription;
    return getPlan(this.planId) && paidWave > 0 && paidWave === processedWave ? 'active' : 'metered';
  }

  usageQuote() { return quoteUsage(this.planId, this.tokens, this.loadout); }
  currentBanChance() { return banChance(this.planId, this.protections); }

  openWeapons() {
    if (this.state !== 'playing') return;
    this.state = 'weapons';
    this.mouse.down = false;
    this.mouseFire = false;
    this.padFire = false;
    this.keys.clear();
    this.hud.weaponsOpen(true);
    this.hud.renderWeapons(this);
    this.audio.uiClick();
  }

  closeWeapons() {
    if (this.state !== 'weapons') return;
    this.keys.clear();
    this.mouse.down = false;
    this.mouseFire = false;
    this.padFire = false;
    this.hud.weaponsOpen(false);
    if (!this.planId) this.toTitle();
    else this.state = 'playing';
    this.audio.uiClick();
  }

  // 唯一切换入口：明确选择、付目标全费、旧额度作废；没有永久拥有或免费装备路径。
  subscribe(id) {
    if (this.state !== 'weapons') return false;
    const plan = getPlan(id);
    if (!plan || this.planId === id) return false;
    const quote = quoteSubscription(id, this.loadout);
    if (!quote || !this.debitMicros(quote.feeMicros)) {
      this.hud.toast('金币不足，订阅与原有额度未改变');
      return false;
    }
    const first = !this.planId;
    const coveredWave = this.waveState === 'inter' ? this.wave + 1 : Math.max(1, this.wave);
    this.planId = id;
    this.tokens = quote.quota;
    this.quotaGranted = quote.quota;
    this.subscription = { paidWave: coveredWave, processedWave: coveredWave };
    this.recomputeLoadout(); // 只重算一次，不在属性计算内发 Token 或扣费
    this.rebuildPlayerDuck();
    this.hud.toast(`订阅 ${plan.label} · -${plan.fee} 金币 · +${quote.quota} Token · 已付第 ${coveredWave} 波`);
    this.hud.subscription(this);
    this.hud.coins(this.coins);
    this.audio.uiClick();
    if (first) this.closeWeapons();
    else this.hud.renderWeapons(this);
    return true;
  }

  renewSubscription(wave) {
    if (this.state !== 'playing' || !Number.isSafeInteger(wave) || wave < 1) return false;
    const plan = getPlan(this.planId);
    if (!plan) return false;
    // 同波只结算一次，包含首波/波间预付及余额不足的失败结算。
    if (wave <= this.subscription.processedWave) return this.subscription.paidWave === wave;
    const quote = quoteSubscription(this.planId, this.loadout);
    this.subscription.processedWave = wave;
    this.tokens = 0;
    this.quotaGranted = 0;
    if (!quote || !this.debitMicros(quote.feeMicros)) {
      this.hud.toast(`${plan.label} 第 ${wave} 波未续费 · 旧额度到期 · 改为按量扣金币`);
      return false;
    }
    this.subscription.paidWave = wave;
    this.tokens = quote.quota;
    this.quotaGranted = quote.quota;
    return true;
  }

  payInvocation() {
    if (this.state !== 'playing' || !getPlan(this.planId)) return null;
    const payment = settleInvocation(this.walletMicros, this.tokens, this.planId, this.loadout);
    if (!payment) return null;
    this.walletMicros = payment.walletMicros;
    this.tokens = payment.remainingTokens;
    this.calls++;
    this.tokensUsed += payment.tokens;
    return payment;
  }

  // 不限时护盾与限时蹲防盾分开记账，总数仍用 p.shield 供 HUD 显示。
  // cap 只限制本次来源的补充，不得把更大的现有护盾截小。
  addShield(amount, cap = Infinity) {
    if (this.state === 'over') return 0;
    const p = this.p;
    const permanent = Math.max(0, p.shield - (p.skillShield || 0));
    const added = Math.max(0, Math.min(amount, cap - permanent));
    p.shield += added;
    p.shieldMax = Math.max(p.shieldMax, p.shield);
    return added;
  }

  // 打工人福利拾取即生效，反馈显示实际收益（满血/护盾上限不虚报）。
  applyLootEffect(eff) {
    const p = this.p;
    if (!eff || this.state === 'over') return '';
    switch (eff.kind) {
      case 'heal': {
        const before = p.hp;
        p.hp = Math.min(p.maxHp, p.hp + eff.amount);
        const healed = Math.round(p.hp - before);
        return healed ? `回血 ${healed}` : '生命已满';
      }
      case 'fullheal': p.hp = p.maxHp; return '生命全满';
      case 'shield': {
        const added = this.addShield(eff.amount, eff.cap);
        return added ? `护盾 +${Math.round(added)}` : '护盾充足';
      }
      case 'xp': {
        const amount = Math.round(eff.amount * this.loadout.xpMul);
        this.addXp(amount);
        return `经验 +${amount}`;
      }
      case 'rage': p.rageT = Math.max(p.rageT, eff.duration); return `红温 ${eff.duration}s`;
      case 'haste': p.hasteT = Math.max(p.hasteT, eff.duration); return `移速 +25% ${eff.duration}s`;
      default: return '';
    }
  }

  /* ---------------- 等级 / 天赋 / 技能 ---------------- */

  addXp(n) {
    if (this.state === 'over' || !Number.isSafeInteger(n) || n <= 0) return;
    this.xp += n; this.xpEarned += n;
    const prevCount = skillCountForLevel(this.level);
    let leveled = false;
    while (this.xp >= xpForLevel(this.level)) {
      this.xp -= xpForLevel(this.level);
      this.level++;
      leveled = true;
    }
    if (leveled) {
      const p = this.p;
      const newCount = skillCountForLevel(this.level);
      if (newCount > prevCount) this.recomputeLoadout(); // 仅在跨越技能解锁阈值时重算
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.3);
      if (newCount > prevCount) {
        const sk = SKILLS[newCount - 1]; // 解锁是严格前缀，新技能即第 newCount 个
        const full = newCount === SKILLS.length;
        this.hud.toast(`升级！Lv.${this.level} · 解锁技能「${sk.label}」按 ${sk.key} 释放${full ? ' · 四技能已满！' : ''}`);
      } else {
        this.hud.toast(`升级！Lv.${this.level} · 回复 30% 生命`);
      }
      this.fx.ring(p.pos.clone().setY(0.5), 0x7ee06a, 3);
      this.fx.number(p.pos.clone().setY(p.pos.y + 1.6), `Lv.${this.level}`, '#7ee06a');
      this.audio.levelUp();
    }
  }

  /* ---------------- 波次天赋卡：每波肃清后三选一 ---------------- */

  // 抽三张卡并进入选卡状态（战斗暂停）。卡池枯竭时直接跳过，不卡流程。
  offerCards() {
    if (this.state !== 'playing') return false;
    const draft = rollCards(this.rng, this.cards, this.wave, 3);
    if (!draft.length) return false;
    this.cardDraft = draft;
    this.state = 'card';
    this.keys.clear();
    this.mouse.down = false;
    this.mouseFire = false;
    this.hud.cardOpen(true);
    this.hud.renderCards(this);
    this.audio.cardDeal();
    return true;
  }

  pickCard(id) {
    if (this.state !== 'card' || !this.cardDraft) return;
    const card = this.cardDraft.find((c) => c.id === id);
    if (!card) return;
    const c = CARD_BY_ID[id];
    const stacks = (this.cards[id] || 0) + 1;
    if (stacks > c.max) return;
    this.cards[id] = stacks;
    this.cardHistory.push(id);
    this.cardDraft = null;
    this.recomputeLoadout();
    // 即时补给类卡：立刻结算，不必等下一波
    if (id === 'c_ammo') this.creditCoins(30);
    if (id === 'c_hp') this.p.hp = Math.min(this.p.maxHp, this.p.hp + 25);
    if (id === 'g_guardian') this.guardianCd = 0;
    this.syncOrbit();
    this.state = 'playing';
    this.keys.clear();
    this.hud.cardOpen(false);
    this.hud.cardBook(this);
    const rar = CARD_RARITIES[c.rarity];
    this.hud.toast(`${rar.label}·${c.name} Lv.${stacks} — ${c.desc(stacks)}`);
    this.audio.cardPick(c.rarity);
    // 选卡特效：稀有度配色的光环 + 羽毛，让每次强化都有仪式感
    this.fx.ring(this.p.pos.clone().setY(0.5), rar.color, c.rarity === 'gold' ? 5 : c.rarity === 'rare' ? 3.6 : 2.4);
    if (c.rarity !== 'common') this.fx.feathers(this.p.pos, rar.color, c.rarity === 'gold' ? 26 : 14, 3.4);
    if (c.rarity === 'gold') { this.engine.addShake(0.18); this.audio.levelUp(); }
  }

  // 已获卡牌总览（T 键 / 手柄 Y），只读查看，随时关闭
  openCardBook() {
    if (this.state !== 'playing') return;
    this.state = 'cardbook';
    this.keys.clear();
    this.mouse.down = false;
    this.mouseFire = false;
    this.hud.cardBookOpen(true);
    this.hud.renderCardBook(this);
    this.audio.uiClick();
  }

  closeCardBook() {
    if (this.state !== 'cardbook') return;
    this.state = 'playing';
    this.keys.clear();
    this.hud.cardBookOpen(false);
    this.audio.uiClick();
  }

  // 护卫羽毛：金卡特效，环绕玩家的实体羽毛，接触持续伤害
  syncOrbit() {
    const want = this.loadout.mods.orbit ? this.loadout.mods.orbit.count : 0;
    if (!this._orbitGeo) {
      this._orbitGeo = new THREE.ConeGeometry(0.1, 0.42, 6);
      this._orbitMat = new THREE.MeshStandardMaterial({
        color: 0xfff0b0, emissive: 0xffc63a, emissiveIntensity: 1.5, roughness: 0.4 });
    }
    while (this.orbitals.length < want) {
      const m = new THREE.Mesh(this._orbitGeo, this._orbitMat);
      this.engine.scene.add(m);
      this.orbitals.push(m);
    }
    while (this.orbitals.length > want) {
      this.engine.scene.remove(this.orbitals.pop());
    }
  }

  updateOrbit(dt) {
    if (this.state !== 'playing') return;
    const mod = this.loadout.mods.orbit;
    if (!mod || !this.orbitals.length) return;
    this.orbitT += dt * 1.9;
    const p = this.p;
    const R = 1.85;
    for (let i = 0; i < this.orbitals.length; i++) {
      const a = this.orbitT + (i / this.orbitals.length) * Math.PI * 2;
      const m = this.orbitals[i];
      m.position.set(p.pos.x + Math.cos(a) * R, p.pos.y + 0.75 + Math.sin(this.orbitT * 2 + i) * 0.12, p.pos.z + Math.sin(a) * R);
      m.rotation.set(Math.PI / 2, 0, -a);
      // 接触判定按每秒 dps × dt 结算，命中反馈节流避免刷爆伤害数字
      for (const e of this.enemies) {
        if (e.dead) continue;
        if (Math.hypot(m.position.x - e.pos.x, m.position.z - e.pos.z) < e.radius + 0.35) {
          this.damageEnemy(e, mod.dps * dt, { silent: true, color: '#ffe28a' });
        }
      }
    }
    this._orbitFxT = (this._orbitFxT || 0) - dt;
    if (this._orbitFxT <= 0) {
      this._orbitFxT = 0.22;
      for (const m of this.orbitals) this.fx.smoke(m.position.clone(), 1, 0xffd98a, 0.16, 0.5, 0.3);
    }
  }

  castSkill(n) {
    if (this.state !== 'playing') return;
    const sk = SKILLS.find((s) => s.key === n);
    if (!sk) return;
    if (!this.loadout.skills[sk.id]) {
      this.hud.toast(`「${sk.label}」Lv.${sk.requiredLevel} 解锁 · 当前 Lv.${this.level}`);
      return;
    }
    if (this.skillCd[sk.id] > 0) { this.hud.toast(`「${sk.label}」冷却中 ${this.skillCd[sk.id].toFixed(1)}s`); return; }
    this.skillCd[sk.id] = sk.cd * (sk.id === 'storm' ? (this.loadout.storm.cdMul ?? 1) : 1);
    const p = this.p;
    const lo = this.loadout;
    this.audio.skillCast();
    if (sk.id === 'storm') {
      const { damage, radius, knock } = lo.storm;
      this.fx.ring(p.pos.clone().setY(0.4), 0xff5346, radius);
      this.fx.feathers(p.pos, 0xff8060, 30, 5);
      this.engine.addShake(0.3);
      for (const e of this.enemies) {
        if (e.dead) continue;
        if (e.pos.distanceTo(p.pos) <= radius) {
          const away = e.pos.clone().sub(p.pos).setY(0).normalize();
          e.vel.addScaledVector(away, knock);
          this.fx.feathers(e.pos, PALETTES[ENEMY_TYPES[e.type].palette].body, 8, 3);
          this.damageEnemy(e, damage, { color: '#ff8060' });
        }
      }
      this.hud.toast('嘎嘎乱杀！寸草不生');
    } else if (sk.id === 'shield') {
      p.shield = Math.max(0, p.shield - p.skillShield) + lo.shield.pool;
      p.skillShield = lo.shield.pool;
      p.shieldMax = Math.max(p.shieldMax, p.shield);
      p.shieldSkillT = lo.shield.duration;
      this.fx.ring(p.pos.clone().setY(0.6), 0x7ee06a, 2);
      this.hud.toast(`抱头蹲防！吸收 ${lo.shield.pool} 伤害`);
    } else if (sk.id === 'rage') {
      p.rageT = lo.rage.duration;
      this.fx.ring(p.pos.clone().setY(0.5), 0xffd24a, 2.4);
      this.hud.toast('红温暴走！射速与伤害提升');
    } else if (sk.id === 'slow') {
      this.slowT = lo.slow.duration;
      this.slowFactor = lo.slow.factor;
      this.fx.ring(p.pos.clone().setY(0.3), 0x6fd6ff, 8);
      this.hud.toast('嘎瓦鲁多！敌人集体慢动作');
    }
  }

  rebuildPlayerDuck() {
    const old = this.playerDuck;
    const duck = new Duck('player', 1, this.loadout.gun.model, { planId: this.planId || 'ds', accent: this.loadout.gun.accent });
    duck.group.position.copy(old.group.position);
    duck.yaw = old.yaw;
    this.engine.scene.remove(old.group);
    this.engine.scene.add(duck.group);
    old.dispose();
    this.playerDuck = duck;
  }

  /* ---------------- 主更新 ---------------- */

  update(dt) {
    this.t += dt;
    this.pollGamepad();
    this.world.update(dt);
    this.fx.update(dt);

    if (this.state === 'title') {
      const a = this.t * 0.06;
      this.engine.camera.position.set(Math.sin(a) * 26, 13 + Math.sin(this.t * 0.2) * 1.5, Math.cos(a) * 26);
      this.engine.camera.lookAt(0, 1.2, 0);
      this.playerDuck.group.position.set(0, 0, 3);
      this.playerDuck.update(dt, { aimYaw: Math.sin(this.t * 0.4) * 0.7, moving: false });
      this.playerHpBar.group.visible = false;
      this.impactMarker.visible = false;
      this.hud.crosshair(0, 0, 0, false);
      return;
    }
    if (this.state === 'paused' || this.state === 'weapons' || this.state === 'card' || this.state === 'cardbook') {
      // 选卡/图鉴时战斗完全冻结，但护卫羽毛仍绕着鸭鸭转，画面不死板
      if (this.orbitals.length) {
        this.orbitT += dt * 1.2;
        const R = 1.85;
        for (let i = 0; i < this.orbitals.length; i++) {
          const a = this.orbitT + (i / this.orbitals.length) * Math.PI * 2;
          this.orbitals[i].position.set(this.p.pos.x + Math.cos(a) * R, this.p.pos.y + 0.75, this.p.pos.z + Math.sin(a) * R);
          this.orbitals[i].rotation.set(Math.PI / 2, 0, -a);
        }
      }
      return;
    }

    if (this.state === 'playing') {
      this.time += dt;
      this.updatePlayer(dt);
      if (this.state === 'playing') this.updateWaves(dt);
      // 选卡立即冻结；阵亡当帧也不能再靠工资/福利回血或继续收金币。
      if (this.state === 'playing') this.updateEnemies(dt);
      if (this.state === 'playing') this.updateBullets(dt);
      if (this.state === 'playing') this.updatePickups(dt);
      if (this.state === 'playing') this.updateOrbit(dt);
    } else if (this.state === 'over') {
      this.playerDuck.update(dt, { moving: false });
      for (const e of this.enemies) e.duck.update(dt, { moving: false, aimYaw: e.duck.yaw });
    }

    this.engine.updateCamera(dt, this.p.pos, this.aimPoint);
    this.updateHud();
  }

  updateHud() {
    const p = this.p;
    this.hud.hp(p.hp, p.maxHp);
    this.hud.dash(1 - p.dashCd / (1.1 * (this.loadout.dashCdMul ?? 1)));
    this.hud.subscription(this);
    this.hud.stats(Math.max(1, this.wave), this.kills, this.score, this.time);
    this.hud.remain(this.spawnQueue.length + this.enemies.reduce((a, e) => a + (e.dead ? 0 : 1), 0));
    this.hud.coins(this.coins);
    this.hud.setWeapon(this.loadout.gun.label, this.planId || 'ds');
    this.hud.growth(this.level, this.xp, xpForLevel(this.level), Object.values(this.cards).reduce((a, b) => a + b, 0));
    this.hud.skills(this.loadout.skills, this.skillCd, { rage: p.rageT, shield: p.shieldSkillT, slow: this.slowT });
    // 护盾条按「本局最大护盾」归一：福利 / 技能盾 / 卡牌共用显示，限时部分独立到期。
    this.hud.shield(p.shield, Math.max(p.shieldMax, 1), p.shield);
    const spread = this.spreadNow();
    // 准星只是方向：鼠标瞄准时钉在指针处、手柄瞄准时取虚拟瞄准点的投影，
    // 绝不吸附到弹道落点。真实落点由地面琥珀环 + 曳光 + 弹着贴花单独传达。
    let cx, cy;
    if (this.padAim) {
      const v = this.aimPoint.clone().project(this.engine.camera);
      cx = (v.x * 0.5 + 0.5) * innerWidth;
      cy = (-v.y * 0.5 + 0.5) * innerHeight;
    } else {
      cx = this.mouse.x;
      cy = this.mouse.y;
    }
    this.hud.crosshair(cx, cy, 7 + spread * 520, this.state === 'playing');
    this.hud.fps(this.engine.fps, this.showFps);
  }

  spreadNow() {
    const p = this.p;
    return (this.loadout.gun.spreadBase + (p.moving ? WEAPON.spreadMove : 0) + p.heat * WEAPON.spreadHeat) * this.loadout.spreadMul;
  }

  /* ---------------- 玩家 ---------------- */

  updatePlayer(dt) {
    if (this.state !== 'playing') return;
    const p = this.p;
    if (this.bot) this.botControl();
    const k = this.keys;
    const dir = new THREE.Vector3(
      (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0),
      0,
      (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0));
    if (dir.lengthSq() > 0) dir.normalize();

    p.dashCd = Math.max(0, p.dashCd - dt);
    p.iframes = Math.max(0, p.iframes - dt);
    p.dashT = Math.max(0, p.dashT - dt);
    for (const id of Object.keys(this.skillCd)) this.skillCd[id] = Math.max(0, this.skillCd[id] - dt);
    this.guardianCd = Math.max(0, this.guardianCd - dt);
    p.rageT = Math.max(0, p.rageT - dt);
    p.hasteT = Math.max(0, p.hasteT - dt);
    // 蹲防到期只撤回尚未消耗的技能盾，保留福利 / 开工护盾 / 溢出治疗护盾。
    if (p.shieldSkillT > 0) {
      p.shieldSkillT = Math.max(0, p.shieldSkillT - dt);
      if (p.shieldSkillT <= 0) {
        p.shield = Math.max(0, p.shield - p.skillShield);
        p.skillShield = 0;
      }
    }
    if (this.slowT > 0) { this.slowT = Math.max(0, this.slowT - dt); if (this.slowT <= 0) this.slowFactor = 1; }
    if (k.has('Space') && p.dashCd <= 0) {
      p.dashDir.copy(dir.lengthSq() > 0 ? dir : new THREE.Vector3(Math.sin(p.aimYaw), 0, Math.cos(p.aimYaw)));
      p.dashT = 0.22; p.dashCd = 1.1 * (this.loadout.dashCdMul ?? 1); p.iframes = 0.34;
      p.dashHit = null; // 每次冲刺重置撞击名单
      this.audio.dash();
      this.fx.ring(p.pos.clone().setY(0.3), 0xb7f0ff, 1.6);
      this.fx.smoke(p.pos.clone().setY(0.2), 4, 0xcbb896, 0.4, 1.4, 0.5);
      k.delete('Space');
    }

    const sm = this.loadout.speedMul * (p.hasteT > 0 ? 1.25 : 1);
    const target = p.dashT > 0 ? p.dashDir.clone().multiplyScalar(13.5 * sm) : dir.clone().multiplyScalar(6.2 * sm);
    p.vel.lerp(target, 1 - Math.exp(-dt * (p.dashT > 0 ? 30 : 11)));
    p.pos.addScaledVector(p.vel, dt);
    p.pos.x = Math.max(-ARENA, Math.min(ARENA, p.pos.x));
    p.pos.z = Math.max(-ARENA, Math.min(ARENA, p.pos.z));
    resolveColliders(p.pos, 0.45, this.world.colliders);
    p.pos.y = 0;
    p.moving = p.vel.length() > 0.6;

    // 铁头冲撞（绿）：冲刺途中撞击敌人，每个敌人每次冲刺只结算一次
    const dashMod = this.loadout.mods.dashBlast;
    if (dashMod && p.dashT > 0) {
      if (!p.dashHit) p.dashHit = new Set();
      for (const e of this.enemies) {
        if (e.dead || p.dashHit.has(e)) continue;
        if (Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z) < e.radius + 0.8) {
          p.dashHit.add(e);
          const away = e.pos.clone().sub(p.pos).setY(0).normalize();
          e.vel.addScaledVector(away, dashMod.knock);
          this.damageEnemy(e, dashMod.damage, { noProc: true, color: '#b7f0ff' });
          this.fx.spark(e.pos.clone().setY(0.8), away, 8, 0xb7f0ff, 6);
          this.engine.addShake(0.12);
          this.audio.hit();
        }
      }
    }

    // 瞄准（手柄右摇杆优先）：鼠标射线取敌人表面，否则取地面；准星只指示方向，真实落点另用标记
    if (this.padAim) {
      this.aimPoint.set(p.pos.x + this.padAim.x * 10, 0.7, p.pos.z + this.padAim.z * 10);
    } else {
      const ndc = new THREE.Vector2(
        (this.mouse.x / innerWidth) * 2 - 1, -(this.mouse.y / innerHeight) * 2 + 1);
      this.ray.setFromCamera(ndc, this.engine.camera);
      const ro = this.ray.ray.origin, rd = this.ray.ray.direction;
      let bestT = Infinity;
      for (const e of this.enemies) {
        if (e.dead) continue;
        const t = raySphereT(ro.x, ro.y, ro.z, rd.x, rd.y, rd.z, e.pos.x, 0.75 * e.scale, e.pos.z, 0.8 * e.scale);
        if (t > 0 && t < bestT) bestT = t;
      }
      if (bestT < Infinity) this.aimPoint.copy(ro).addScaledVector(rd, bestT);
      else if (rd.y < -1e-4) {
        this.aimPoint.copy(ro).addScaledVector(rd, -ro.y / rd.y);
        this.aimPoint.y = groundHeight(this.aimPoint.x, this.aimPoint.z);
      } else {
        // 射线朝天（指向天空）：沿当前朝向延伸，不再硬跳世界正北造成准星瞬移
        this.aimPoint.set(p.pos.x + Math.sin(p.aimYaw) * 12, 0.7, p.pos.z + Math.cos(p.aimYaw) * 12);
      }
    }
    p.aimYaw = Math.atan2(this.aimPoint.x - p.pos.x, this.aimPoint.z - p.pos.z);

    // 弹道落点预测：与子弹判定同规则步进，供准星显示
    const muzzle = this.playerDuck.muzzleWorld(new THREE.Vector3());
    const bdir = this.aimPoint.clone().sub(muzzle);
    if (bdir.lengthSq() < 1e-8) bdir.set(0, 0, 1); else bdir.normalize();
    const targets = [];
    for (const e of this.enemies) {
      if (!e.dead) targets.push({ x: e.pos.x, z: e.pos.z, radius: e.radius + 0.22, height: 1.7 * e.scale });
    }
    const imp = marchImpact(muzzle, bdir, this.loadout.range, targets,
      (x, z) => pointBlocked(x, z, this.world.colliders),
      (x, z) => { const wy = waterSurfaceAt(x, z); return wy !== null ? wy : groundHeight(x, z); }, 0.5);
    // 地面命中时弹道直线恰止于地面瞄准点，消除步进粒度误差，保证准星与鼠标地面点重合
    if (imp.hit === 'ground' && this.aimPoint.y <= groundHeight(this.aimPoint.x, this.aimPoint.z) + 0.05) {
      this.impactPoint.copy(this.aimPoint);
    } else if (imp.hit === 'none') {
      // 超出射程：子弹在射程末端坠地，落点标记显示短落点
      this.impactPoint.set(imp.x, groundHeight(imp.x, imp.z), imp.z);
    } else {
      this.impactPoint.set(imp.x, imp.y, imp.z);
    }
    // Claude 追踪导弹：落点标记指向锁定敌人的预测拦截点；准心只指方向，落点不是准心
    if (this.planId === 'claude') {
      const lock = this.lockMissileTarget({ pos: muzzle, range: this.loadout.range }, bdir);
      if (lock) {
        const lead = this.missileLeadPoint(muzzle, lock, this.loadout.bulletSpeed);
        this.impactPoint.set(lead.x, groundHeight(lead.x, lead.z), lead.z);
      }
    }
    const markGap = Math.hypot(this.impactPoint.x - this.aimPoint.x, this.impactPoint.z - this.aimPoint.z);
    this.impactMarker.visible = markGap > 0.5;
    this.impactMarker.position.set(this.impactPoint.x, groundHeight(this.impactPoint.x, this.impactPoint.z) + 0.03, this.impactPoint.z);

    // 武器调用：一次连发 / 散射只支付一次 Token，失败不吞部分额度。
    p.fireT = Math.max(0, p.fireT - dt);
    p.heat = Math.max(0, p.heat - dt * 1.1);
    if (this.mouse.down && p.fireT <= 0) this.fire();
    if (this.state !== 'playing') return; // 封号时不再自愈或重新显示头顶血条

    // 缓慢自愈（自愈绒毛卡提升回复速率）
    if (this.time - p.lastHurt > 6 && p.hp > 0) p.hp = Math.min(p.maxHp, p.hp + this.loadout.regen * dt);

    this.playerDuck.group.position.copy(p.pos);
    this.playerDuck.update(dt, {
      moving: p.moving, speed: p.vel.length(), aimYaw: p.aimYaw,
      dash: p.dashT > 0 ? 1 : 0,
    });

    const ratio = Math.max(0, p.hp / p.maxHp);
    this.playerHpBar.group.visible = true;
    this.playerHpBar.group.position.set(p.pos.x, p.pos.y + 1.9, p.pos.z);
    this.playerHpBar.fill.scale.x = 1.42 * ratio;
    this.playerHpBar.fill.position.x = -(1.42 * (1 - ratio)) / 2;
  }

  botControl() {
    const p = this.p;
    const k = this.keys;
    for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) k.delete(c);
    let nearest = null, nd = 1e9;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const d = e.pos.distanceTo(p.pos);
      if (d < nd) { nd = d; nearest = e; }
    }
    if (!nearest) {
      this.mouse.down = false;
      if (Math.sin(this.t * 0.4) > 0) k.add('KeyW'); else k.add('KeyS');
      if (Math.cos(this.t * 0.3) > 0) k.add('KeyD'); else k.add('KeyA');
      return;
    }
    const lead = nearest.vel.clone().multiplyScalar(Math.min(0.45, nd / 70));
    const v = nearest.pos.clone().add(lead).setY(0).project(this.engine.camera);
    this.mouse.x = (v.x * 0.5 + 0.5) * innerWidth;
    this.mouse.y = (-v.y * 0.5 + 0.5) * innerHeight;
    this.mouse.down = true;
    const dir = nearest.pos.clone().sub(p.pos).setY(0).normalize();
    const move = nd > 9 ? dir : nd < 5 ? dir.clone().negate() : new THREE.Vector3(-dir.z, 0, dir.x);
    move.x -= p.pos.x / 22; move.z -= p.pos.z / 22;
    if (move.lengthSq() > 1e-6) move.normalize();
    if (move.x > 0.35) k.add('KeyD'); else if (move.x < -0.35) k.add('KeyA');
    if (move.z > 0.35) k.add('KeyS'); else if (move.z < -0.35) k.add('KeyW');
    if (nd < 3.2 && p.dashCd <= 0) k.add('Space');
  }

  fire() {
    const p = this.p;
    if (this.state !== 'playing' || !getPlan(this.planId) || p.fireT > 0) return false;
    const payment = this.payInvocation();
    if (!payment) {
      if (this.time - this.lastFundsHint >= 1.2) {
        this.lastFundsHint = this.time;
        this.hud.toast('额度与余额不足 · 移动拾取福利，或按 1 释放免费冷却技能');
        this.audio.emptyClick();
      }
      return false;
    }
    // 只有真正付费的整次调用才抽一次；被封的这次已付费，但不能产生攻击。
    const risk = this.currentBanChance();
    if (risk > 0 && this.banRng() < risk) {
      this.endRun('ban');
      return false;
    }
    const lo = this.loadout;
    const raging = p.rageT > 0;
    p.fireT = 60 / (lo.rpm * (raging ? lo.rage.rpmMul : 1));
    p.heat = Math.min(1, p.heat + 0.11);
    const extra = lo.mods.multishot || 0;
    this.shots += lo.pellets + extra;
    const origin = this.playerDuck.muzzleWorld(new THREE.Vector3());
    const base = this.aimPoint.clone().sub(origin).normalize();
    const spread = this.spreadNow();
    const up = new THREE.Vector3(0, 1, 0);
    const dmg = lo.damage * (raging ? lo.rage.dmgMul : 1);
    const side = new THREE.Vector3(base.z, 0, -base.x).normalize();
    const attack = {
      provider: this.planId,
      falloffStart: lo.falloffStart, falloffEnd: lo.falloffEnd, falloffMin: lo.falloffMin,
      mods: Object.fromEntries(Object.entries(lo.mods).map(([key, value]) =>
        [key, value && typeof value === 'object' ? { ...value } : value])),
    };
    for (let i = 0; i < lo.pellets + extra; i++) {
      const d = base.clone();
      d.applyAxisAngle(up, (Math.random() - 0.5) * (spread * 2 + (lo.pellets > 1 ? (lo.gun.pelletSpread ?? 0.14) : 0)));
      d.y += (Math.random() - 0.5) * spread;
      d.normalize();
      // 双管齐下：额外弹从枪口两侧平行射出，不共用同一条射线
      const org = origin.clone();
      if (i >= lo.pellets) org.addScaledVector(side, ((i - lo.pellets) % 2 === 0 ? 1 : -1) * 0.28);
      // 导弹寿命覆盖整个射程并留转弯余量，避免低速弹在到达远程目标前提前到期
      const life = this.planId === 'claude' ? lo.range / lo.bulletSpeed + 0.4 : 1.1;
      const b = { pos: org, vel: d.multiplyScalar(lo.bulletSpeed), life, traveled: 0, range: lo.range, dmg,
        attack, pierce: this.planId === 'claude' ? 0 : (lo.intrinsicPierce || 0) + (lo.mods.pierce || 0), planId: this.planId, trailT: 0 };
      const tailLen = this.planId === 'claude' ? 1.5 : this.planId === 'qwen' ? 2.2 : this.planId === 'gpt' ? 1.8 : this.planId === 'glm' ? 0.9 : 1.0;
      b.vis = this.makeBulletVis(this.planId, raging ? 0xffb040 : lo.mods.frost ? 0x9fe8ff : (lo.gun.accent ?? 0xffd080), tailLen);
      b.vis.position.copy(b.pos);
      b.vis.lookAt(b.pos.clone().add(b.vel));
      if (this.planId === 'claude') b.target = this.lockMissileTarget(b, base);
      this.bullets.push(b);
    }
    switch (this.planId) {
      case 'claude':
        this.fx.flash(origin, 0.55);
        this.fx.spark(origin, base.clone().multiplyScalar(0.5), 6, 0xffa060, 4);
        this.fx.smoke(origin, 2, 0x9a8070, 0.3, 1.8, 0.5);
        this.engine.addShake(0.18);
        break;
      case 'gpt':
        this.fx.flash(origin, 0.35);
        this.fx.smoke(origin, 1, 0x70a090, 0.22, 1.6, 0.4);
        this.engine.addShake(0.1);
        break;
      case 'qwen':
        this.fx.flash(origin, 0.18);
        this.engine.addShake(0.05);
        break;
      case 'glm':
        this.fx.flash(origin, 0.45);
        this.fx.smoke(origin, 3, 0x7080a0, 0.35, 2.0, 0.55);
        this.fx.spark(origin, base.clone().multiplyScalar(0.3), 4, 0x60a0ff, 3);
        this.engine.addShake(0.22);
        break;
      default:
        this.fx.flash(origin, 0.22);
        this.fx.smoke(origin, 1, 0x8a8078, 0.22, 1.6, 0.45);
        this.engine.addShake(0.09);
    }
    this.playerDuck.kick();
    this.audio.shoot();
    return true;
  }

  // 荆棘羽绒（绿）：受击对周围敌人反伤
  thornsBlast(mods) {
    if (this.state !== 'playing' || !mods.thorns) return;
    const p = this.p;
    this.fx.ring(p.pos.clone().setY(0.5), 0x7ee06a, mods.thorns.radius);
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z) <= mods.thorns.radius) {
        this.damageEnemy(e, mods.thorns.damage, { noProc: true, color: '#a8f07e' });
        const away = e.pos.clone().sub(p.pos).setY(0).normalize();
        e.vel.addScaledVector(away, 4);
      }
    }
  }

  damagePlayer(dmg) {
    const p = this.p;
    if (p.iframes > 0 || this.state !== 'playing') return;
    const mods = this.loadout.mods;
    // 守护结界（金）：周期性完全抵挡一次伤害
    if (mods.guardian && this.guardianCd <= 0) {
      this.guardianCd = mods.guardian;
      this.fx.ring(p.pos.clone().setY(0.7), 0x9fe8ff, 2.2);
      this.fx.number(p.pos.clone().setY(p.pos.y + 1.7), '结界抵挡', '#9fe8ff');
      this.audio.hit();
      this.thornsBlast(mods);
      return;
    }
    p.lastHurt = this.time;
    let amount = dmg * this.loadout.dmgMul;
    if (p.shield > 0) {
      const absorbed = Math.min(p.shield, amount);
      p.shield -= absorbed; amount -= absorbed;
      p.skillShield = Math.max(0, p.skillShield - absorbed); // 优先消耗有时限的部分
      if (p.skillShield <= 0) p.shieldSkillT = 0;
      this.fx.ring(p.pos.clone().setY(0.6), 0x7ee06a, 1.3);
      this.audio.hit();
      if (p.shield <= 0) this.hud.toast('护盾被破！快溜');
      if (amount <= 0) { this.thornsBlast(mods); return; }
    }
    p.hp -= amount;
    this.thornsBlast(mods);
    // 不死鸟（金）：本局首次致死伤害免死，回血 60% 并击退全场
    if (p.hp <= 0 && mods.phoenix && !this.phoenixUsed) {
      this.phoenixUsed = true;
      p.hp = Math.max(1, p.maxHp * 0.6);
      p.iframes = 2;
      this.fx.ring(p.pos.clone().setY(0.6), 0xffc63a, 7);
      this.fx.feathers(p.pos, 0xffc63a, 34, 5);
      this.engine.addShake(0.5);
      this.audio.levelUp();
      this.hud.alert('🔥 不死鸟复活！短暂无敌', 2600);
      for (const e of this.enemies) {
        if (e.dead) continue;
        const away = e.pos.clone().sub(p.pos).setY(0);
        const d = away.length() || 1;
        e.vel.addScaledVector(away.divideScalar(d), 16);
        this.damageEnemy(e, 40, { noProc: true, color: '#ffc63a' });
      }
      return;
    }
    this.audio.hurt();
    this.hud.damage();
    this.engine.damageFlash = 1;
    this.engine.addShake(0.32);
    this.fx.feathers(p.pos, 0xffd95e, 6, 2.2);
    if (p.hp <= 0) this.endRun('combat');
  }

  // 幂等终局。封号绕过伤害管线，所以无敌、护盾、结界和不死鸟都无法抵挡。
  endRun(reason = 'combat') {
    if (this.state !== 'playing' || !['combat', 'ban'].includes(reason)) return false;
    this.state = 'over';
    const p = this.p;
    p.hp = 0;
    this.keys.clear();
    this.mouse.down = false;
    this.mouseFire = false;
    this.padFire = false;
    this.playerDuck.die();
    this.playerHpBar.group.visible = false;
    this.impactMarker.visible = false;
    this.fx.feathers(p.pos, 0xffd95e, 26, 4);
    this.fx.ring(p.pos.clone().setY(0.5), reason === 'ban' ? 0xc48aff : 0xff8060, 3);
    this.audio.gameOver();
    this.audio.stopMusic();
    // 0 分不写纪录（避免占坑）；平纪录也算新纪录。
    const isRecord = this.score > 0 && (!this.best || this.score >= this.best.score);
    if (isRecord) {
      this.best = { score: this.score, wave: this.wave, kills: this.kills };
      try { localStorage.setItem(this.bestKey(), JSON.stringify(this.best)); } catch { /* 存储不可用时忽略 */ }
    }
    this.result = {
      reason, provider: this.planId, providerLabel: getPlan(this.planId)?.label ?? '',
      wave: this.wave, kills: this.kills, score: this.score,
      acc: this.shots ? this.hits / this.shots : 0,
      time: this.time, coins: this.coinsEarned, calls: this.calls, tokensUsed: this.tokensUsed,
      best: this.best ? this.best.score : 0, isRecord,
    };
    this.hud.results(this.result);
    this.overTimer = setTimeout(() => {
      this.overTimer = null;
      if (this.state === 'over') this.hud.screen('over');
    }, 1100);
    return true;
  }

  /* ---------------- 波次 ---------------- */

  updateWaves(dt) {
    if (this.state !== 'playing' || !getPlan(this.planId)) return;
    if (this.waveState === 'inter') {
      this.interT -= dt;
      if (this.interT <= 0) this.nextWave();
      return;
    }
    if (this.spawnQueue.length) {
      this.spawnT -= dt;
      if (this.spawnT <= 0) {
        this.spawnEnemy(this.spawnQueue.shift());
        this.spawnT = this.plan.spawnInterval;
      }
    } else if (this.enemies.length === 0) {
      const bonus = 200 * this.wave;
      this.score += bonus;
      this.addXp(Math.round(WAVE_CLEAR_XP * this.loadout.xpMul));
      this.audio.waveClear();
      this.waveState = 'inter';
      this.interT = 4;
      // 每波肃清 → 三选一强化卡（卡池抽空则回退为普通提示，不卡流程）
      if (!this.offerCards()) this.hud.toast(`第 ${this.wave} 波肃清！奖励 +${bonus}`);
    }
  }

  nextWave() {
    if (this.state !== 'playing' || !getPlan(this.planId)) return;
    this.wave++;
    let expired = 0;
    for (const it of PROTECTION_ITEMS) {
      const before = this.protections[it.id].length;
      this.protections[it.id] = this.protections[it.id].filter((w) => w > this.wave);
      expired += before - this.protections[it.id].length;
    }
    if (expired) this.hud.toast(`${expired} 件保护道具到期销毁`);
    this.renewSubscription(this.wave);
    this.plan = wavePlan(this.wave);
    const q = [];
    for (const [type, n] of Object.entries(this.plan.counts)) {
      if (type === 'elite') continue;
      for (let i = 0; i < n; i++) q.push(type);
    }
    const pool = Object.entries(this.plan.counts)
      .filter(([k, n]) => n > 0 && k !== 'boss' && k !== 'elite').map(([k]) => k);
    if (this.plan.counts.elite > 0 && pool.length)
      q.push({ type: pool[Math.floor(this.rng() * pool.length)], elite: true });
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
    this.spawnQueue = q;
    this.spawnT = 0.4;
    this.waveState = 'fight';
    // 开工护盾（绿）：每波开始白给一层护盾
    const ws = this.loadout.mods.waveShield;
    if (ws) {
      this.addShield(ws, ws);
      this.fx.ring(this.p.pos.clone().setY(0.6), 0x7ee06a, 2.2);
    }
    this.hud.banner(this.wave, waveIntro(this.wave));
    this.audio.waveHorn();
  }

  spawnEnemy(entry) {
    if (this.state !== 'playing') return;
    const type = typeof entry === 'string' ? entry : entry.type;
    const elite = typeof entry === 'object' && !!entry.elite;
    const t = ENEMY_TYPES[type];
    const gate = GATES[Math.floor(this.rng() * GATES.length)];
    const tangent = new THREE.Vector3(-gate.z, 0, gate.x).normalize();
    const scale = t.scale * (elite ? ELITE.scale : 1);
    const radius = t.radius * (elite ? ELITE.scale : 1);
    // 生点横移上限从门口净空通道推导：半宽 - 敌人半径，任何体型（含精英重装）都不会落进沙袋碰撞体
    const maxLat = Math.max(0, GATE_LANE_HALF - radius - 0.05);
    const pos = new THREE.Vector3(gate.x, 0, gate.z).addScaledVector(tangent, (this.rng() * 2 - 1) * maxLat);
    pos.y = groundHeight(pos.x, pos.z);
    const duck = new Duck(t.palette, scale, t.weapon, { boss: !!t.boss, elite });
    duck.group.position.copy(pos);
    this.engine.scene.add(duck.group);
    const hpScale = t.boss ? this.plan.bossScale : this.plan.hpScale * (elite ? eliteHpMul(this.wave) : 1);
    const e = {
      type, elite, duck, pos, vel: new THREE.Vector3(),
      name: enemyName(type, this.rng),
      scale,
      radius,
      reach: (t.reach || 0) * (elite ? ELITE.reachMul : 1),
      damage: t.damage * (elite ? ELITE.dmgMul : 1),
      speed: t.speed * (elite ? ELITE.speedMul : 1),
      hp: t.hp * hpScale, maxHp: t.hp * hpScale,
      fireT: 1 + this.rng() * 1.5, windup: 0, attackT: 0.6 + this.rng() * 0.8,
      skillKind: t.boss ? 'nova' : elite ? 'stomp' : null,
      skillCd: 2.5 + this.rng() * 2, skillT: 0,
      seed: this.rng() * 10, dead: false,
    };
    e.hpBar = this.makeHpBar(
      t.boss ? 0xff3860 : elite ? 0xffb030 : 0xff5346,
      (elite ? '精英·' : '') + e.name,
      t.boss ? '#ff8a80' : elite ? '#ffcf70' : '#f5f0e6',
      t.boss ? 1.6 : elite ? 1.25 : 1,
    );
    this.enemies.push(e);
    this.fx.smoke(pos.clone().setY(pos.y + 0.3), 3, 0x6a5a4a, 0.5, 1.5, 0.7);
    this.warnGate(pos);
    if (elite) this.hud.toast(`精英${e.name}来袭！三倍赏金`);
  }

  makeBulletVis(planId, tailColor, tailLen) {
    const g = new THREE.Group();
    // 材质按配置缓存共享：几何体本就共享，避免每发子弹新建材质造成分配与未 dispose 累积
    const cached = (key, make) => {
      let m = this._bulletMatCache.get(key);
      if (!m) { m = make(); this._bulletMatCache.set(key, m); }
      return m;
    };
    const addTail = (geo, color, len, opacity = 0.5) => {
      const t = new THREE.Mesh(geo, cached(`tail:${color}:${opacity}`, () => new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false })));
      t.scale.z = len; t.position.z = -len / 2 - 0.1; g.add(t);
    };
    switch (planId) {
      case 'claude': {
        const body = new THREE.Mesh(this._missileBodyGeo, cached('body:claude', () => new THREE.MeshStandardMaterial({
          color: 0xefe6d8, roughness: 0.3, metalness: 0.75, emissive: 0x2a1a10, emissiveIntensity: 0.4 })));
        g.add(body);
        const nose = new THREE.Mesh(this._missileNoseGeo, cached('nose:claude', () => new THREE.MeshStandardMaterial({
          color: 0xd97757, roughness: 0.35, metalness: 0.6, emissive: 0xd97757, emissiveIntensity: 0.5 })));
        nose.position.z = 0.31; g.add(nose);
        const finMat = cached('fin:claude', () => new THREE.MeshStandardMaterial({ color: 0x9a5a42, roughness: 0.5, metalness: 0.5 }));
        for (let k = 0; k < 4; k++) {
          const a = Math.PI / 4 + k * Math.PI / 2;
          const fin = new THREE.Mesh(this._missileFinGeo, finMat);
          fin.position.set(Math.cos(a) * 0.07, Math.sin(a) * 0.07, -0.17);
          fin.rotation.z = a; g.add(fin);
        }
        const flame = new THREE.Mesh(this._missileFlameGeo, cached('flame:claude', () => new THREE.MeshBasicMaterial({
          color: 0xffb060, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })));
        flame.position.z = -0.35; g.add(flame);
        g.userData.flame = flame; // 供 updateBullets 做尾焰抖动
        addTail(this._tailGeoWide, tailColor, tailLen, 0.5);
        break;
      }
      case 'gpt': {
        const core = new THREE.Mesh(this._bulletGeoEnergy, cached('core:gpt', () => new THREE.MeshStandardMaterial({
          color: 0xc0ffd8, roughness: 0.25, metalness: 0.8, emissive: 0x10a37f, emissiveIntensity: 0.9 })));
        g.add(core);
        addTail(this._tailGeo, tailColor, tailLen, 0.6);
        break;
      }
      case 'qwen': {
        const core = new THREE.Mesh(this._bulletGeoTracer, cached('core:qwen', () => new THREE.MeshBasicMaterial({
          color: 0xc8b0ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })));
        g.add(core);
        addTail(this._tailGeoThin, tailColor, tailLen, 0.65);
        break;
      }
      case 'glm': {
        const core = new THREE.Mesh(this._bulletGeoOrb, cached('core:glm', () => new THREE.MeshStandardMaterial({
          color: 0xcfe0ff, roughness: 0.3, metalness: 0.7, emissive: 0x3b82f6, emissiveIntensity: 0.9 })));
        g.add(core);
        addTail(this._tailGeoWide, tailColor, tailLen * 0.5, 0.55);
        break;
      }
      default: {
        g.add(new THREE.Mesh(this._bulletGeo, this._bulletMat));
        addTail(this._tailGeo, tailColor, tailLen, 0.4);
        break;
      }
    }
    this.engine.scene.add(g);
    return g;
  }

  makeHpBar(color = 0xff5346, name = '', nameColor = '#ffffff', nameScale = 1) {
    const group = new THREE.Group();
    const bg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x1a1208, transparent: true, opacity: 0.75, depthWrite: false }));
    bg.scale.set(1.5, 0.16, 1);
    const fill = new THREE.Sprite(new THREE.SpriteMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false }));
    fill.scale.set(1.42, 0.1, 1);
    group.add(bg, fill);
    if (name) {
      const h = 0.55 * nameScale;
      const label = makeNameSprite(name, nameColor, h);
      label.position.y = 0.12 + h / 2;
      label.renderOrder = 1; // 名字压在血条之上，不受贴图透明排序影响
      group.add(label);
    }
    group.visible = false;
    this.engine.scene.add(group);
    return { group, fill };
  }

  // 血条组随敌人销毁/清场调用：释放各自材质，名字贴图是共享缓存不销毁
  removeHpBar(bar) {
    this.engine.scene.remove(bar.group);
    bar.group.traverse((o) => { if (o.material) o.material.dispose(); });
  }

  warnGate(pos) {
    const v = pos.clone(); v.y += 1;
    v.project(this.engine.camera);
    if (v.z <= 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1) return;
    const dx = pos.x - this.p.pos.x, dz = pos.z - this.p.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    const hw = innerWidth / 2 - 46, hh = innerHeight / 2 - 46;
    const k = Math.min(hw / Math.max(1e-6, Math.abs(ux)), hh / Math.max(1e-6, Math.abs(uz)));
    this.hud.threat(innerWidth / 2 + ux * k, innerHeight / 2 + uz * k);
  }

  // 菜单手柄导航：方向键/D-pad 移动焦点，A 确认；焦点环复用 :focus 样式
  menuFocusables() {
    const sel = {
      weapons: '#weaponScreen button, #weaponScreen summary, #weaponScreen a[href]',
      card: '#cardScreen .pickCard',
      cardbook: '#cardBookClose',
      paused: '#pauseScreen button, #pauseScreen input',
      over: '#gameoverScreen button',
    }[this.state];
    if (!sel) return [];
    return [...document.querySelectorAll(sel)].filter((el) => {
      if (el.disabled || el.closest('.hidden')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  menuNavigate(dx, dy) {
    const list = this.menuFocusables();
    if (!list.length) return;
    const cur = list.indexOf(document.activeElement);
    if (cur < 0) { list[0].focus(); return; }
    const cr = list[cur].getBoundingClientRect();
    const cx = cr.x + cr.width / 2, cy = cr.y + cr.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of list) {
      if (el === list[cur]) continue;
      const r = el.getBoundingClientRect();
      const vx = r.x + r.width / 2 - cx, vy = r.y + r.height / 2 - cy;
      const along = vx * dx + vy * dy;
      if (along <= 4) continue;
      const perp = Math.abs(vx * dy - vy * dx);
      const score = along + perp * 2.5;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) best.focus();
  }

  pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && pads[0];
    if (!gp) { this.padAim = null; this.padFire = false; return; }
    const prev = this.padPrev;
    const btn = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const edge = (i) => btn(i) && !prev[i];
    const dead = (v) => (Math.abs(v) > 0.22 ? v : 0);
    const lx = dead(gp.axes[0] || 0), ly = dead(gp.axes[1] || 0);
    const rx = dead(gp.axes[2] || 0), ry = dead(gp.axes[3] || 0);

    if (this.state === 'title' || this.state === 'over') {
      if (edge(0)) { this.audio.init(); this.start(); }
    } else if (this.state === 'playing') {
      // 手柄与键鼠共存：摇杆有输入才接管移动，扳机与鼠标左键并联，互不清零
      const k = this.keys;
      if (lx || ly) {
        for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) k.delete(c);
        if (lx > 0.35) k.add('KeyD'); else if (lx < -0.35) k.add('KeyA');
        if (ly > 0.35) k.add('KeyS'); else if (ly < -0.35) k.add('KeyW');
      }
      this.padAim = (rx || ry) ? { x: rx, z: ry } : null;
      this.padFire = btn(7) || btn(6);
      this.mouse.down = this.mouseFire || this.padFire;
      if (edge(0)) k.add('Space');
      // 战斗十字键顺时针对应技能 1–4；菜单分支只导航，沿用同一份按键边沿。
      for (const [button, skill] of GAMEPAD_SKILLS) {
        if (edge(button)) this.castSkill(skill);
      }
      if (edge(1)) this.openWeapons();
      if (edge(3)) this.openCardBook();
      if (edge(9)) this.pause();
    } else if (this.state === 'weapons' || this.state === 'card' || this.state === 'cardbook' || this.state === 'paused') {
      // 菜单内：方向导航 + A 确认 + B/Start 返回
      const now = this.t;
      const nx = (lx > 0.55 || btn(15)) ? 1 : (lx < -0.55 || btn(14)) ? -1 : 0;
      const ny = (ly > 0.55 || btn(13)) ? 1 : (ly < -0.55 || btn(12)) ? -1 : 0;
      if ((nx || ny) && now - (this.padNavT || 0) > 0.24) {
        this.padNavT = now;
        const ae = document.activeElement;
        if (ae && ae.type === 'range' && nx) {
          // 焦点在音量滑条上：左右直接调音量
          ae.value = String(Math.min(100, Math.max(0, +ae.value + nx * 5)));
          ae.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          this.menuNavigate(nx, ny);
        }
      }
      if (edge(0)) {
        const list = this.menuFocusables();
        const el = list.includes(document.activeElement) ? document.activeElement : list[0];
        if (el) {
          if (el.tagName === 'INPUT') el.focus();
          else el.click();
          // 计划订阅后会重绘并恢复焦点，不要把新焦点清掉。
          if (el.tagName === 'BUTTON' && !el.classList.contains('weaponCard')) el.blur();
        }
      }
      if (this.state === 'weapons' && (edge(1) || edge(9))) this.closeWeapons();
      else if (this.state === 'cardbook' && (edge(3) || edge(1) || edge(9))) this.closeCardBook();
      else if (this.state === 'paused' && (edge(9) || edge(1))) this.resume();
      // 选卡界面必须选一张，B/Start 不能跳过
    }
    this.padPrev = gp.buttons.map((b) => b.pressed);
  }

  /* ---------------- 敌人 ---------------- */

  updateEnemies(dt) {
    if (this.state !== 'playing') return;
    const p = this.p;
    const cam = this.engine.camera;
    const frustum = this._frustum.setFromProjectionMatrix(
      this._projMat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const visPoint = new THREE.Vector3();
    for (const e of this.enemies) {
      if (this.state !== 'playing') return;
      if (e.dead) { e.duck.update(dt, { moving: false }); continue; }
      const t = ENEMY_TYPES[e.type];
      const to = p.pos.clone().sub(e.pos); to.y = 0;
      const dist = to.length();
      const dirN = to.clone().normalize();
      let want = new THREE.Vector3();
      // 燃烧弹：持续伤害，每 0.5s 跳一次数字，避免每帧刷屏
      if (e.burnT > 0) {
        e.burnT -= dt;
        this.damageEnemy(e, e.burnDps * dt, { mods: e.burnMods, noProc: true, raw: true, silent: true });
        e.burnFxT = (e.burnFxT || 0) - dt;
        if (e.burnFxT <= 0 && !e.dead) {
          e.burnFxT = 0.5;
          this.fx.smoke(e.pos.clone().setY(e.pos.y + 0.7), 1, 0xff8a3c, 0.3, 1.2, 0.4);
          this.fx.number(e.pos.clone().setY(e.pos.y + 1.1), String(Math.round(e.burnDps * 0.5)), '#ff9a5c');
        }
        if (e.dead) { e.duck.update(dt, { moving: false }); continue; }
      }
      if (e.frostT > 0) {
        e.frostT -= dt;
        e.frostFxT = (e.frostFxT || 0) - dt;
        if (e.frostFxT <= 0) { e.frostFxT = 0.4; this.fx.smoke(e.pos.clone().setY(e.pos.y + 0.5), 1, 0x9fe8ff, 0.22, 0.8, 0.35); }
      }
      const frost = e.frostT > 0 ? e.frostFactor : 1;
      const speed = e.speed * this.plan.speedScale * frost * (this.slowT > 0 ? this.slowFactor : 1);

      if (e.skillKind) {
        e.skillCd = Math.max(0, e.skillCd - dt);
        if (e.skillT > 0) {
          e.skillT -= dt;
          if (e.skillT <= 0) this.castEnemySkill(e);
          if (this.state !== 'playing') return;
        } else if (e.skillCd <= 0 && (e.skillKind === 'nova' || dist < ELITE_SKILL.range)) {
          const sk = e.skillKind === 'nova' ? BOSS_SKILL : ELITE_SKILL;
          e.skillT = sk.windup; e.skillCd = sk.cd;
          this.fx.zone(e.pos.clone(), sk.radius, e.skillKind === 'nova' ? 0xff4646 : 0xffa040, sk.windup);
          this.audio.skillCast();
          // 保命预警走独立高优先级通道，不被技能/拾取 toast 覆盖
          this.hud.alert(e.skillKind === 'nova' ? `⚠ ${e.name}蓄力全图冲击波！看准时机冲刺闪避` : '⚠ 精英蓄力战争践踏！快出圈', sk.windup * 1000 + 500);
        }
      }

      if (e.reach) {
        e.attackT = Math.max(0, e.attackT - dt);
        if (e.windup > 0) {
          e.windup -= dt;
          want.copy(dirN).multiplyScalar(speed * 0.2);
          if (e.windup <= 0) {
            e.duck.kick();
            this.audio.swing();
            // 挥击需视线畅通：隔着谷仓拐角等掩体不再命中
            if (dist < e.reach + 0.35 && !segBlocked(e.pos, p.pos, this.world.colliders)) {
              this.damagePlayer(e.damage);
              if (this.state !== 'playing') return;
              this.fx.ring(p.pos.clone().setY(0.4), 0xff9060, 1.4);
              this.fx.spark(p.pos.clone().setY(0.7), dirN.clone().multiplyScalar(-0.5), 5, 0xffb080, 4);
            }
          }
        } else {
          want.copy(dirN).multiplyScalar(speed);
          if (dist < e.reach && e.attackT <= 0) {
            e.windup = t.windup;
            e.attackT = t.attackInterval;
          }
        }
      } else {
        const ideal = t.range * 0.75;
        if (dist > ideal + 1.5) want.copy(dirN).multiplyScalar(speed);
        else if (dist < ideal - 2) want.copy(dirN).multiplyScalar(-speed * 0.7);
        const strafe = new THREE.Vector3(-dirN.z, 0, dirN.x).multiplyScalar(Math.sin(this.t * 0.8 + e.seed) * speed * 0.65);
        want.add(strafe);
        e.fireT -= dt;
        visPoint.copy(e.pos); visPoint.y += 0.8;
        if (e.fireT <= 0 && canEngage(dist, t.range, frustum.containsPoint(visPoint)) && !segBlocked(e.pos, p.pos, this.world.colliders)) {
          e.fireT = t.fireInterval * (0.8 + this.rng() * 0.5);
          const origin = e.duck.muzzleWorld(new THREE.Vector3());
          const pellets = t.pellets || 1;
          for (let i = 0; i < pellets; i++) {
            const d = p.pos.clone().setY(0.6).sub(origin).normalize();
            d.applyAxisAngle(new THREE.Vector3(0, 1, 0), (this.rng() - 0.5) * (pellets > 1 ? (t.spread || 0.22) : 0.09));
            d.normalize();
            this.ebullets.push({ pos: origin.clone(), vel: d.multiplyScalar(t.bulletSpeed), life: 3, dmg: e.damage });
          }
          this.fx.flash(origin, 0.22);
          e.duck.kick();
          this.audio.enemyShoot();
        }
      }

      // 分离
      if (e.skillT > 0) want.multiplyScalar(0.15);
      for (const o of this.enemies) {
        if (o === e || o.dead) continue;
        const dx = e.pos.x - o.pos.x, dz = e.pos.z - o.pos.z;
        const d = Math.hypot(dx, dz);
        const min = (e.radius + o.radius) * 1.05;
        if (d < min && d > 1e-4) want.add(new THREE.Vector3(dx / d, 0, dz / d).multiplyScalar((min - d) * 6));
      }
      const pdx = e.pos.x - p.pos.x, pdz = e.pos.z - p.pos.z;
      const pd = Math.hypot(pdx, pdz);
      const pmin = e.radius + 0.5;
      if (pd < pmin && pd > 1e-4) want.add(new THREE.Vector3(pdx / pd, 0, pdz / pd).multiplyScalar((pmin - pd) * 8));

      e.vel.lerp(want, 1 - Math.exp(-dt * 6));
      e.pos.addScaledVector(e.vel, dt);
      e.pos.x = Math.max(-27, Math.min(27, e.pos.x));
      e.pos.z = Math.max(-27, Math.min(27, e.pos.z));
      resolveColliders(e.pos, e.radius, this.world.colliders);
      e.pos.y = groundHeight(e.pos.x, e.pos.z);
      e.duck.group.position.copy(e.pos);
      e.duck.update(dt, {
        moving: e.vel.length() > 0.4, speed: e.vel.length(),
        aimYaw: Math.atan2(dirN.x, dirN.z),
        windup: e.windup > 0 ? e.windup / t.windup : 0,
        dash: e.windup > 0 || e.skillT > 0 ? 0.5 : 0,
      });
      if (e.hpBar) {
        const ratio = Math.max(0, e.hp / e.maxHp);
        e.hpBar.group.visible = true;
        e.hpBar.group.position.set(e.pos.x, e.pos.y + 1.75 * e.scale, e.pos.z);
        e.hpBar.fill.scale.x = 1.42 * ratio;
        e.hpBar.fill.position.x = -(1.42 * (1 - ratio)) / 2;
      }
    }
    // 清理死亡
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.dead && e.duck.deathT > 1.5) {
        this.engine.scene.remove(e.duck.group);
        e.duck.dispose();
        if (e.hpBar) this.removeHpBar(e.hpBar);
        this.enemies.splice(i, 1);
      }
    }
  }

  castEnemySkill(e) {
    const p = this.p;
    if (e.skillKind === 'nova') {
      this.fx.ring(e.pos.clone().setY(0.5), 0xff5040, BOSS_SKILL.radius);
      this.fx.spark(e.pos.clone().setY(1.2), new THREE.Vector3(0, 1, 0), 26, 0xff8060, 8);
      this.engine.addShake(0.5);
      this.audio.boom();
      this.damagePlayer(e.damage * BOSS_SKILL.dmgMul);
    } else {
      this.fx.ring(e.pos.clone().setY(0.4), 0xffa040, ELITE_SKILL.radius);
      this.fx.spark(e.pos.clone().setY(0.8), new THREE.Vector3(0, 1, 0), 14, 0xffc080, 6);
      this.engine.addShake(0.3);
      this.audio.boom();
      if (Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z) < ELITE_SKILL.radius)
        this.damagePlayer(e.damage * ELITE_SKILL.dmgMul);
    }
  }

  /* ---------------- 卡牌特效结算 ---------------- */

  // 所有伤害的唯一入口：暴击 / 血怒加成、吸血、处决、死亡判定都在这里，
  // 保证子弹、爆炸、闪电、羽毛、燃烧走同一套规则，不会各算一套。
  // opts.noProc 用于溅射/连锁等派生伤害，防止无限递归。
  damageEnemy(e, amount, opts = {}) {
    if (this.state !== 'playing' || e.dead || amount <= 0) return 0;
    const mods = opts.mods ?? this.loadout.mods;
    let dmg = amount;
    let crit = false;
    if (!opts.raw) {
      if (mods.berserk) dmg *= 1 + mods.berserk * (1 - Math.max(0, this.p.hp / this.p.maxHp));
      if (mods.crit && !opts.noCrit && Math.random() < mods.crit.chance) { dmg *= mods.crit.mul; crit = true; }
    }
    // 处决：低于阈值直接斩杀，Boss 阈值减半（避免金卡一键秒 Boss）
    if (mods.execute && !opts.noExecute) {
      const th = mods.execute * (ENEMY_TYPES[e.type].boss ? 0.5 : 1);
      if (e.hp / e.maxHp <= th) dmg = Math.max(dmg, e.hp);
    }
    dmg = Math.min(dmg, e.hp);
    e.hp -= dmg;
    if (mods.lifesteal && this.p.hp > 0) {
      this.p.hp = Math.min(this.p.maxHp, this.p.hp + dmg * mods.lifesteal);
    }
    if (!opts.silent) {
      this.fx.number(e.pos.clone().setY(e.pos.y + (crit ? 1.5 : 1.05)),
        crit ? `${Math.round(dmg)}!` : String(Math.round(dmg)),
        crit ? '#ff9a3c' : (opts.color || '#ffe28a'));
      if (crit) { this.fx.spark(e.pos.clone().setY(0.9), new THREE.Vector3(0, 1, 0), 8, 0xffa040, 6); this.engine.addShake(0.07); }
    }
    if (e.hp <= 0) this.killEnemy(e);
    return dmg;
  }

  // 子弹命中后的特效链：点燃 / 减速 / 爆炸 / 闪电。派生伤害一律 noProc 防递归。
  applyHitMods(e, hitPos, baseDmg, mods = this.loadout.mods) {
    if (this.state !== 'playing') return;
    if (mods.burn && !e.dead) { e.burnT = mods.burn.duration; e.burnDps = mods.burn.dps; e.burnMods = mods; }
    if (mods.frost && !e.dead) { e.frostT = mods.frost.duration; e.frostFactor = mods.frost.factor; }
    if (mods.explosive) {
      const { radius, mul } = mods.explosive;
      this.fx.ring(hitPos.clone().setY(hitPos.y), 0xff8a3c, radius);
      this.fx.smoke(hitPos.clone(), 3, 0xffa860, 0.5, 2.2, 0.5);
      this.fx.spark(hitPos.clone(), new THREE.Vector3(0, 1, 0), 8, 0xffb060, 6);
      this.audio.boom();
      for (const o of this.enemies) {
        if (o.dead || o === e) continue;
        if (Math.hypot(o.pos.x - hitPos.x, o.pos.z - hitPos.z) <= radius)
          this.damageEnemy(o, baseDmg * mul, { mods, noProc: true, noCrit: true, color: '#ffb070' });
      }
      if (!e.dead) this.damageEnemy(e, baseDmg * mul, { mods, noProc: true, noCrit: true, silent: true });
    }
    if (mods.chain) {
      let from = e;
      const hitSet = new Set([e]);
      for (let i = 0; i < mods.chain.count; i++) {
        let best = null, bd = 7.5;
        for (const o of this.enemies) {
          if (o.dead || hitSet.has(o)) continue;
          const d = Math.hypot(o.pos.x - from.pos.x, o.pos.z - from.pos.z);
          if (d < bd) { bd = d; best = o; }
        }
        if (!best) break;
        hitSet.add(best);
        this.fx.bolt(from.pos.clone().setY(from.pos.y + 0.8), best.pos.clone().setY(best.pos.y + 0.8));
        this.damageEnemy(best, baseDmg * mods.chain.mul, { mods, noProc: true, color: '#9fe8ff' });
        from = best;
      }
      if (hitSet.size > 1) this.audio.zap();
    }
  }

  killEnemy(e) {
    if (this.state !== 'playing' || e.dead) return;
    e.dead = true;
    e.duck.die();
    if (e.hpBar) e.hpBar.group.visible = false;
    this.kills++;
    const sc = scoreFor(e.type, this.wave, e.elite);
    this.score += sc;
    const color = PALETTES[ENEMY_TYPES[e.type].palette].body;
    this.fx.feathers(e.pos, color, 18, 3.6);
    this.fx.feathers(e.pos, 0xffffff, 6, 2.6);
    this.fx.ring(e.pos.clone().setY(e.pos.y + 0.5), 0xffe28a, 2.2);
    this.fx.smoke(e.pos.clone().setY(e.pos.y + 0.4), 3, 0x9a8a7a, 0.5, 1.6, 0.8);
    this.audio.kill();
    this.hud.hitmarker(true);
    this.hud.feed([{ text: (e.elite ? '精英·' : '') + e.name, em: true }, { text: ' 被击倒 ' }, { text: `+${sc}`, em: true }]);
    const mods = this.loadout.mods;
    const c = Math.round(coinsFor(e.type, e.elite) * this.loadout.coinMul * (mods.goldRush || 1));
    this.creditCoins(c);
    this.fx.number(e.pos.clone().setY(e.pos.y + 1.3), `+${c} 金币`, '#ffd95e');
    this.addXp(Math.round(xpForKill(e.type, e.elite) * this.loadout.xpMul));
    if (this.loadout.killHeal > 0 && this.p.hp > 0) {
      const before = this.p.hp;
      this.p.hp = Math.min(this.p.maxHp, this.p.hp + this.loadout.killHeal);
      const healed = this.p.hp - before;
      if (healed > 0.5) this.fx.number(this.p.pos.clone().setY(this.p.pos.y + 1.2), `+${Math.round(healed)}`, '#7ee06a');
      // 溢出治疗转不限时护盾，不得缩减已有的福利盾或开工护盾。
      const over = this.loadout.killHeal - healed;
      if (mods.overheal && over > 0.5) this.addShield(over, mods.overheal);
    }
    if (mods.cashback && this.rng() < mods.cashback) {
      this.creditCoins(4);
      this.fx.number(this.p.pos.clone().setY(this.p.pos.y + 1.4), '+4 消费返现', '#ffd95e');
    }
    if (mods.timeKill && Math.random() < mods.timeKill.chance) {
      this.slowT = Math.max(this.slowT, mods.timeKill.duration);
      this.slowFactor = Math.min(this.slowFactor, 0.3);
      this.fx.ring(this.p.pos.clone().setY(0.3), 0x9fe8ff, 7);
      this.hud.toast('时停收割！敌人集体慢动作');
      this.audio.skillCast();
    }
    const isBoss = !!ENEMY_TYPES[e.type].boss;
    for (let r = 0; r < (isBoss ? 4 : e.elite ? 2 : 1) + (mods.goldRush ? 1 : 0); r++) {
      for (const id of rollLoot(this.rng)) {
        const off = new THREE.Vector3((this.rng() - 0.5) * 1.6, 0, (this.rng() - 0.5) * 1.6);
        this.spawnPickup(e.pos.clone().add(off), 'loot', id);
      }
    }
    if (isBoss) {
      this.hud.toast(`${e.name}被击败！追回工资和福利`);
      this.audio.waveClear();
      this.fx.ring(e.pos.clone().setY(e.pos.y + 1), 0xffd24a, 4);
    }
    const drop = rollDrop(this.rng, e.type, e.elite);
    if (drop) this.spawnPickup(e.pos, drop);
    const protection = rollProtection(this.rng, e.type, e.elite);
    if (protection) this.spawnPickup(e.pos, 'protection', protection);
  }

  /* ---------------- 子弹 ---------------- */

  // 发射时按枪口指向锁定一个敌人：角度最贴合者优先，距离仅作同级 tie-break；范围内无敌人则不锁定（直线飞行）
  lockMissileTarget(b, dir) {
    let best = null, bestScore = Infinity;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const dx = e.pos.x - b.pos.x, dz = e.pos.z - b.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > b.range || dist < 1e-3) continue;
      const dot = (dx * dir.x + dz * dir.z) / dist;
      const angle = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
      const score = angle * 1000 + dist;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  // 预测拦截点：按敌人当前速度估算提前量（迭代两次收敛），瞄准它将到达的位置而非当前位置
  missileLeadPoint(pos, e, speed) {
    const bx = e.pos.x, by = e.pos.y + 0.8 * e.scale, bz = e.pos.z;
    let t = Math.min(Math.hypot(bx - pos.x, by - pos.y, bz - pos.z) / speed, 2);
    for (let i = 0; i < 2; i++) {
      const px = bx + e.vel.x * t, pz = bz + e.vel.z * t;
      t = Math.min(Math.hypot(px - pos.x, by - pos.y, pz - pos.z) / speed, 2);
    }
    return new THREE.Vector3(bx + e.vel.x * t, by, bz + e.vel.z * t);
  }

  // 沿 dir 步进探测障碍物，返回首次被挡前的净空距离（无障碍返回 maxDist）
  missileClearance(pos, dir, maxDist) {
    const step = 0.4, n = Math.ceil(maxDist / step);
    for (let i = 1; i <= n; i++) {
      const d = i * step;
      if (pointBlocked(pos.x + dir.x * d, pos.z + dir.z * d, this.world.colliders)) return d - step;
    }
    return maxDist;
  }

  // 避障：前方或通往目标的直线被挡时，扫描一大片候选方向选净空最长的一侧绕行，
  // 并记住已选侧避免左右抖动；宁可绕大圈也要绕过障碍，而非直直撞上去引爆。
  missileAvoid(pos, cur, desired, speed, b) {
    const look = 9;
    const aheadClear = this.missileClearance(pos, cur, look);
    const directClear = this.missileClearance(pos, desired, look);
    if (aheadClear >= look && directClear >= look) return { dir: desired, urgency: 0 };
    const side = new THREE.Vector3(cur.z, 0, -cur.x);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    const angles = [0.35, 0.7, 1.05, 1.4];
    let best = desired, bestScore = -Infinity, bestSign = 0;
    for (const sign of [1, -1]) {
      for (const ang of angles) {
        const dir = cur.clone().multiplyScalar(Math.cos(ang)).addScaledVector(side, sign * Math.sin(ang)).normalize();
        let score = this.missileClearance(pos, dir, look) * 2 + dir.dot(desired) * 1.2;
        if (b && b._avoidSign === sign) score += 1.5; // 保持已选绕行侧
        if (score > bestScore) { bestScore = score; best = dir; bestSign = sign; }
      }
    }
    if (b) b._avoidSign = bestSign;
    const urgency = 1 - Math.min(aheadClear, directClear) / look;
    const dir = desired.clone().multiplyScalar((1 - urgency) * 0.35).addScaledVector(best, 0.65 + urgency * 0.9).normalize();
    return { dir, urgency };
  }

  // 追踪转向：只对发射时锁定的目标生效；未锁定或目标死亡则直线飞行。瞄准预测拦截点并自动避障
  steerMissile(b, dt) {
    const e = b.target;
    if (!e) return; // 未锁定敌人 → 直线飞行
    if (e.dead) { b.target = null; return; } // 锁定目标死亡 → 解除锁定，转为直线
    const speed = b.vel.length();
    if (speed < 1e-3) return;
    const cur = b.vel.clone().divideScalar(speed);
    const desired = this.missileLeadPoint(b.pos, e, speed).sub(b.pos);
    if (desired.lengthSq() < 1e-6) return;
    desired.normalize();
    const { dir: guided, urgency } = this.missileAvoid(b.pos, cur, desired, speed, b);
    const angle = cur.angleTo(guided);
    if (angle < 1e-4) return;
    const rate = MISSILE_TURN_RATE + urgency * 20; // 追踪时柔和弧线；避障时允许更急转弯以绕过障碍
    const t = Math.min(1, (rate * dt) / angle);
    const q = new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(cur, guided), t);
    b.vel.copy(cur.applyQuaternion(q).multiplyScalar(speed));
  }

  // 导弹引爆：火球闪光 + 冲击波环 + 四散火星 + 烟团 + 爆炸音 + 震屏
  missileExplode(pos) {
    this.fx.flash(pos, 1.2);
    this.fx.ring(pos, 0xff7040, 2.8);
    this.fx.spark(pos, new THREE.Vector3(0, 0.8, 0), 26, 0xffa050, 12);
    this.fx.smoke(pos, 5, 0x6a5a4a, 0.6, 2.4, 0.9);
    this.audio.boom();
    this.engine.addShake(0.3);
  }

  updateBullets(dt) {
    if (this.state !== 'playing') return;
    const p = this.p;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.life -= dt;
      let gone = b.life <= 0;
      if (!gone) {
        if (b.planId === 'claude') this.steerMissile(b, dt);
        const step = b.vel.clone().multiplyScalar(dt);
        const n = Math.min(12, Math.max(1, Math.ceil(step.length() / 0.3)));
        step.divideScalar(n);
        for (let s = 0; s < n && !gone; s++) {
          b.pos.add(step);
          b.traveled += step.length();
          for (const e of this.enemies) {
            if (e.dead || (b.hitSet && b.hitSet.has(e))) continue;
            const r = e.radius + 0.22;
            if (Math.hypot(b.pos.x - e.pos.x, b.pos.z - e.pos.z) < r && b.pos.y < 1.7 * e.scale) {
              const dmg = damageAtDistance(b.dmg, b.traveled, b.attack);
              if (!b.countedHit) { this.hits++; b.countedHit = true; }
              const hitDir = b.vel.clone().normalize().multiplyScalar(-0.4);
              switch (b.planId) {
                case 'claude':
                  this.missileExplode(b.pos);
                  this.fx.feathers(b.pos, PALETTES[ENEMY_TYPES[e.type].palette].body, 7, 3);
                  break;
                case 'gpt':
                  this.fx.spark(b.pos, hitDir, 9, 0x40e8a0, 7);
                  this.fx.ring(b.pos, 0x30d890, 1.2);
                  this.fx.feathers(b.pos, PALETTES[ENEMY_TYPES[e.type].palette].body, 5, 2.5);
                  break;
                case 'qwen':
                  this.fx.spark(b.pos, hitDir, 5, 0xb090ff, 8);
                  this.fx.feathers(b.pos, PALETTES[ENEMY_TYPES[e.type].palette].body, 3, 2);
                  break;
                case 'glm':
                  this.fx.spark(b.pos, hitDir, 10, 0x70b0ff, 5);
                  this.fx.smoke(b.pos, 1, 0x607090, 0.3, 1.4, 0.35);
                  this.fx.feathers(b.pos, PALETTES[ENEMY_TYPES[e.type].palette].body, 5, 2.5);
                  break;
                default:
                  this.fx.spark(b.pos, hitDir, 7, 0xffd080, 6);
                  this.fx.feathers(b.pos, PALETTES[ENEMY_TYPES[e.type].palette].body, 4, 2);
              }
              this.audio.hit();
              this.hud.hitmarker(false);
              e.duck.kick();
              this.damageEnemy(e, dmg, { mods: b.attack?.mods });
              this.applyHitMods(e, b.pos.clone(), dmg, b.attack?.mods);
              // 穿甲：记录已命中目标避免同一帧重复判定，穿透次数用尽才消失
              if (b.pierce > 0) {
                b.pierce--;
                if (!b.hitSet) b.hitSet = new Set();
                b.hitSet.add(e);
                b.dmg *= 0.8; // 每穿一个衰减 20%，避免无限穿透过强
              } else {
                gone = true;
              }
              break;
            }
          }
          if (!gone && b.pos.y < 1.8 && pointBlocked(b.pos.x, b.pos.z, this.world.colliders)) {
            if (b.planId === 'claude') this.missileExplode(b.pos);
            else {
              this.fx.spark(b.pos, b.vel.clone().normalize().multiplyScalar(-0.5), 6, 0xffc060, 5);
              this.fx.smoke(b.pos, 1, 0x8a8078, 0.25, 1.4, 0.4);
            }
            gone = true;
          }
          if (!gone) {
            const wy = waterSurfaceAt(b.pos.x, b.pos.z);
            if (wy !== null && b.pos.y <= wy + 0.04) {
              // 落水：白色水花，不产生焦痕
              this.fx.smoke(b.pos, 2, 0xd8ece8, 0.3, 1.5, 0.5);
              this.fx.spark(b.pos, new THREE.Vector3(0, 1, 0), 5, 0xbfe8e0, 3);
              gone = true;
            } else if (b.pos.y <= groundHeight(b.pos.x, b.pos.z) + 0.04) {
              if (b.planId === 'claude') { this.missileExplode(b.pos); this.fx.decal(b.pos, 0.4); }
              else {
                this.fx.smoke(b.pos, 2, 0xa08a68, 0.3, 1.5, 0.5);
                this.fx.spark(b.pos, new THREE.Vector3(0, 1, 0), 4, 0xc8b080, 3);
                this.fx.decal(b.pos, 0.28);
              }
              gone = true;
            }
          }
          if (!gone && b.traveled >= b.range) {
            this.fx.smoke(b.pos, 2, 0xa08a68, 0.3, 1.5, 0.5);
            const wy = waterSurfaceAt(b.pos.x, b.pos.z);
            this.fx.decal(new THREE.Vector3(b.pos.x, wy !== null ? wy : groundHeight(b.pos.x, b.pos.z), b.pos.z), 0.28);
            gone = true;
          }
        }
      }
      if (gone) {
        if (b.vis) this.engine.scene.remove(b.vis);
        this.bullets.splice(i, 1);
      } else if (b.vis) {
        b.vis.position.copy(b.pos);
        if (b.planId === 'claude') {
          b.vis.lookAt(b.pos.clone().add(b.vel));
          const flame = b.vis.userData.flame;
          if (flame) { const f = 0.75 + Math.random() * 0.5; flame.scale.set(f, f, 0.7 + Math.random() * 0.7); }
        }
        b.trailT = (b.trailT || 0) + dt;
        if (b.planId === 'claude' && b.trailT > 0.03) {
          b.trailT = 0;
          this.fx.spark(b.pos, new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.2, (Math.random() - 0.5) * 0.3), 2, 0xff8050, 2);
        } else if (b.planId === 'gpt' && b.trailT > 0.06) {
          b.trailT = 0;
          this.fx.spark(b.pos, new THREE.Vector3(0, 0.1, 0), 1, 0x40e8a0, 1.5);
        }
      }
    }

    for (let i = this.ebullets.length - 1; i >= 0; i--) {
      const b = this.ebullets[i];
      b.life -= dt;
      let gone = b.life <= 0;
      if (!gone) {
        const step = b.vel.clone().multiplyScalar(dt);
        const n = Math.min(12, Math.max(1, Math.ceil(step.length() / 0.3)));
        step.divideScalar(n);
        for (let s = 0; s < n && !gone; s++) {
          b.pos.add(step);
          if (Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z) < 0.55 && b.pos.y < 1.4) {
            this.damagePlayer(b.dmg);
            if (this.state !== 'playing') return;
            this.fx.spark(b.pos, b.vel.clone().normalize().multiplyScalar(-0.4), 5, 0xff8060, 4);
            gone = true;
          }
          if (!gone && b.pos.y < 1.8 && pointBlocked(b.pos.x, b.pos.z, this.world.colliders)) {
            this.fx.spark(b.pos, b.vel.clone().normalize().multiplyScalar(-0.5), 4, 0xffa060, 4);
            gone = true;
          }
          if (!gone) {
            const wy = waterSurfaceAt(b.pos.x, b.pos.z);
            if (wy !== null && b.pos.y <= wy + 0.04) {
              this.fx.smoke(b.pos, 1, 0xd8ece8, 0.22, 1.4, 0.4);
              gone = true;
            } else if (b.pos.y <= groundHeight(b.pos.x, b.pos.z) + 0.04) {
              this.fx.smoke(b.pos, 1, 0xa08a68, 0.22, 1.4, 0.4);
              gone = true;
            }
          }
        }
      }
      if (gone) {
        if (b.spr) this.engine.scene.remove(b.spr);
        this.ebullets.splice(i, 1);
      } else {
        if (!b.spr) {
          b.spr = this.makeBulletVis(null, 0xff7040, 0.7);
          b.spr.lookAt(b.pos.clone().add(b.vel));
        }
        b.spr.position.copy(b.pos);
      }
    }
  }

  /* ---------------- 拾取 ---------------- */

  spawnPickup(pos, kind, item) {
    if (this.state === 'over') return false;
    const mesh = makePickupVisual(kind, item);
    if (!mesh) return false;
    mesh.position.copy(pos).setY(groundHeight(pos.x, pos.z) + 0.35);
    this.engine.scene.add(mesh);
    this.pickups.push({ mesh, kind, item, t: 0, life: kind === 'loot' || kind === 'protection' ? 26 : 22 });
    return true;
  }

  updatePickups(dt) {
    if (this.state !== 'playing') return;
    const p = this.p;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pk = this.pickups[i];
      const loot = pk.kind === 'loot' && typeof pk.item === 'string' && Object.hasOwn(LOOT_BY_ID, pk.item) ? LOOT_BY_ID[pk.item] : null;
      const protection = pk.kind === 'protection' ? getProtection(pk.item) : null;
      const valid = !!(loot || protection || pk.kind === 'health');
      pk.t += dt; pk.life -= dt;
      pk.mesh.rotation.y += dt * 1.6;
      pk.mesh.position.y = groundHeight(pk.mesh.position.x, pk.mesh.position.z) + 0.35 + Math.sin(pk.t * 2.4) * 0.08;
      pk.mesh.visible = pk.life > 3 || Math.sin(pk.t * 12) > -0.3;
      let gone = pk.life <= 0 || !valid;
      // 拾取磁铁（绿）：四类保护物品也使用同样的吸取/过期/一次性结算规则。
      const magnet = this.loadout.mods.magnet;
      const reach = 1.1 * (magnet ? magnet.mul : 1);
      const dx = p.pos.x - pk.mesh.position.x, dz = p.pos.z - pk.mesh.position.z;
      const dist = Math.hypot(dx, dz);
      if (!gone && magnet && dist < reach * 2.6 && dist > reach) {
        const pull = Math.min(1, dt * 6);
        pk.mesh.position.x += dx * pull;
        pk.mesh.position.z += dz * pull;
      }
      if (!gone && dist < reach) {
        if (magnet?.heal && p.hp > 0) p.hp = Math.min(p.maxHp, p.hp + magnet.heal);
        if (loot) {
          this.creditCoins(loot.coins);
          const eff = this.applyLootEffect(loot.effect);
          this.hud.toast(`拾取 ${loot.label} · +${loot.coins} 金币${eff ? ' · ' + eff : ''}`);
          this.fx.number(pk.mesh.position.clone().setY(pk.mesh.position.y + 0.4), `${loot.label} +${loot.coins}`, '#ffe28a');
        } else if (protection) {
          this.protections[protection.id].push(this.wave + PROTECTION_DURATION);
          this.hud.toast(`拾取【${protection.label}】×${this.protections[protection.id].length} · 持续 ${PROTECTION_DURATION} 波后销毁`);
          this.fx.number(pk.mesh.position.clone().setY(pk.mesh.position.y + 0.4), `${protection.label} +1`, '#c4a1ff');
        } else if (pk.kind === 'health') {
          p.hp = Math.min(p.maxHp, p.hp + 35);
          this.hud.toast('拾取面包 +35 生命');
        }
        this.audio.pickup();
        this.fx.ring(pk.mesh.position, loot?.color ?? protection?.color ?? 0xff9080, 1.6);
        gone = true;
      }
      if (gone) {
        // 模板的 geometry/material/map 是共享资源，单个实例不得 dispose。
        this.engine.scene.remove(pk.mesh);
        this.pickups.splice(i, 1);
      }
    }
  }
}