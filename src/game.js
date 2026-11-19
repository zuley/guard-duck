import * as THREE from 'three';
import { Duck, PALETTES } from './duck.js';
import { ClaudeMissileVisual } from './claude-missile.js';
import { FIRST_EMBER_LANDING, LAST_EMBER_LANDING, GroundFireVisual } from './ground-fire.js';
import { FX } from './fx.js';
import { WEAPON, ENEMY_TYPES, wavePlan, waveIntro, damageAtDistance, scoreFor, rollDrop, mulberry32, canEngage, computeLoadout, coinsFor, rollLoot, LOOT_ITEMS, xpForLevel, xpForKill, WAVE_CLEAR_XP, CARD_BY_ID, CARD_RARITIES, rollCards, cardEffects, SKILLS, SKILL_TUNING, SKILL_SHOUTS, applyCards, ELITE, eliteHpMul, ELITE_SKILL, BOSS_SKILL, raySphereT, marchImpact, segmentTouchesCircle, enemyName, skillCountForLevel } from './rules.js';
import { PLANS, STARTING_COINS, getPlan, coinsToMicros, microsToCoins, quoteSubscription, quoteUsage, settleInvocation, banChance, PROTECTION_ITEMS, PROTECTION_DURATION, getProtection, rollProtection } from './subscriptions.js';
import { ARENA, GATES, GATE_LANE_HALF, groundHeight, waterSurfaceAt, resolveColliders } from './world.js';
import { bubbleTexture, textTexture } from './textures.js';
import { makePickupVisual } from './pickups.js';
import {
  QWEN_BLADE_HALF_WIDTH, QWEN_BLADE_HEIGHT_PAD, QWEN_BLADE_DEPTH_SCALE,
  bladeTouchesEnemy, segBlocked, pointBlocked, blockerTime,
} from './collision.js';
import { menuFocusables, menuNavigate, pollGamepad, botControl } from './gamepad.js';

const LOOT_BY_ID = Object.fromEntries(LOOT_ITEMS.map((i) => [i.id, i]));
// 转向角速度与弹速匹配，避免提速后明显增大转弯半径
const MISSILE_TURN_RATE = 24;
const MISSILE_BLAST_RADIUS = 5;
const MISSILE_FIRE_LIFETIME = LAST_EMBER_LANDING + 4;

const BUBBLE_RADIUS = 0.34;
const DS_TRACER_LENGTH = 1.3;

// 模块级复用向量/四元数，消除 60 FPS 热路径每帧数千次临时对象分配与 GC 抖动
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _ndc = new THREE.Vector2();
const _up = new THREE.Vector3(0, 1, 0);
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

function qwenBladeGeometry(innerDepth) {
  const shape = new THREE.Shape();
  const width = QWEN_BLADE_HALF_WIDTH;
  shape.moveTo(-width, -0.14);
  shape.quadraticCurveTo(0, 0.57, width, -0.14);
  shape.quadraticCurveTo(0, innerDepth, -width, -0.14);
  return new THREE.ShapeGeometry(shape, 20).scale(1, QWEN_BLADE_DEPTH_SCALE, 1).rotateX(Math.PI / 2);
}

// 头顶名字精灵：贴图由 textTexture 内部统一缓存（32px 小栅格），此处不再自建缓存
function makeNameSprite(text, color = '#ffffff', height = 0.3) {
  const tex = textTexture(text, color, 32);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(height * (tex.image.width / tex.image.height), height, 1);
  return s;
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
    this.bulletStop = new THREE.Vector3(0, 0, 6);
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
    const sBg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x1a1208, transparent: true, opacity: 0.75, depthWrite: false }));
    sBg.scale.set(1.5, 0.12, 1); sBg.position.y = 0.17; sBg.visible = false;
    const sFill = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x6fd8ff, transparent: true, opacity: 0.95, depthWrite: false }));
    sFill.scale.set(1.42, 0.07, 1); sFill.position.y = 0.17; sFill.visible = false;
    this.playerHpBar.group.add(sBg, sFill);
    this.playerHpBar.shieldBg = sBg;
    this.playerHpBar.shieldFill = sFill;
    this.playerHpBar.nameBaseY = this.playerHpBar.label ? this.playerHpBar.label.position.y : 0;
    // 调休护盾罩：菲涅尔边缘光的半透明泡，罩住整只鸭鸭
    this.shieldDome = new THREE.Mesh(
      new THREE.SphereGeometry(1.05, 28, 18),
      new THREE.ShaderMaterial({
        transparent: true, depthWrite: false,
        uniforms: { uT: { value: 0 }, uFade: { value: 1 }, uColor: { value: new THREE.Color(0x7fd8ff) } },
        vertexShader: /* glsl */`
          varying vec3 vN; varying vec3 vV;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vN = normalize(mat3(modelMatrix) * normal);
            vV = normalize(cameraPosition - wp.xyz);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */`
          uniform vec3 uColor; uniform float uT; uniform float uFade;
          varying vec3 vN; varying vec3 vV;
          void main() {
            float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
            float pulse = 0.85 + 0.15 * sin(uT * 5.0);
            float a = (0.1 + 0.6 * f) * pulse * uFade;
            gl_FragColor = vec4(uColor + vec3(0.3) * f, a);
          }`,
      }));
    this.shieldDome.visible = false;
    this.domePop = 0;
    engine.scene.add(this.shieldDome);
    const imGeo = new THREE.RingGeometry(0.22, 0.34, 24);
    imGeo.rotateX(-Math.PI / 2);
    this.impactMarker = new THREE.Mesh(imGeo, new THREE.MeshBasicMaterial({ color: 0xffd080, transparent: true, opacity: 0.85, depthWrite: false }));
    this.impactMarker.visible = false;
    engine.scene.add(this.impactMarker);
    // 圆点子弹共享球体几何，颜色区分计划与狂热/霜冻状态
    this._bulletGeoOrb = new THREE.SphereGeometry(0.09, 10, 8);
    this._qwenBladeGeo = qwenBladeGeometry(0.18);
    this._qwenEdgeGeo = qwenBladeGeometry(0.46).translate(0, 0.003, 0);
    this._dsCoreGeo = new THREE.CapsuleGeometry(0.078, 0.19, 4, 10).rotateX(Math.PI / 2);
    this._dsTracerGeo = new THREE.ConeGeometry(0.093, DS_TRACER_LENGTH, 8, 6, true)
      .rotateX(-Math.PI / 2).translate(0, 0, -DS_TRACER_LENGTH / 2);
    const tracerPositions = this._dsTracerGeo.attributes.position;
    const tracerColors = new Float32Array(tracerPositions.count * 4);
    for (let i = 0; i < tracerPositions.count; i++) {
      const fade = Math.max(0, 1 + tracerPositions.getZ(i) / DS_TRACER_LENGTH);
      tracerColors.set([1, 1, 1, fade * fade], i * 4);
    }
    this._dsTracerGeo.setAttribute('color', new THREE.BufferAttribute(tracerColors, 4));
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
      shield: 0, shieldMax: 0, skillShield: 0, shieldSkillT: 0, rageT: 0, rageExtended: 0, hasteT: 0,
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
    this.bombs = [];
    this.missileFires = [];
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
    for (const b of this.bullets) this.removeAttackVisual(b.vis);
    for (const b of this.ebullets) if (b.spr) this.engine.scene.remove(b.spr);
    for (const m of this.orbitals) this.engine.scene.remove(m);
    for (const b of this.bombs) this.engine.scene.remove(b.mesh);
    for (const fire of this.missileFires) this.removeAttackVisual(fire.visual);
    this.missileFires = [];
    this.orbitals = [];
    this.enemies = []; this.pickups = []; this.bullets = []; this.ebullets = []; this.bombs = [];
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
    this.hud.toast('180 刀启动预算 · 先选择一项订阅再开工');
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
      this.hud.toast('余额不足，订阅与原有额度未改变');
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
    this.hud.toast(`订阅 ${plan.label} · -${plan.fee} 刀 · +${quote.quota} Token · 已付第 ${coveredWave} 波`);
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
      this.hud.toast(`${plan.label} 第 ${wave} 波未续费 · 旧额度到期 · 改为按量扣费`);
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

  // 不限时护盾与限时调休盾分开记账，总数仍用 p.shield 供 HUD 显示。
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
      case 'rage': p.rageT = Math.max(p.rageT, eff.duration); return `996 ${eff.duration}s`;
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
      const { damage, radius } = lo.storm;
      this.throwOvertimeBomb(damage, radius);
      this.hud.toast('加班！加班炸弹已扔出，炸到的同事原地加班');
    } else if (sk.id === 'shield') {
      p.shield = Math.max(0, p.shield - p.skillShield) + lo.shield.pool;
      p.skillShield = lo.shield.pool;
      p.shieldMax = Math.max(p.shieldMax, p.shield);
      p.shieldSkillT = lo.shield.duration;
      this.domePop = 0;
      this.fx.ring(p.pos.clone().setY(0.6), 0x7ee06a, 2);
      this.hud.toast(`调休！${lo.shield.pool} 点工作伤害由假期抵扣`);
    } else if (sk.id === 'rage') {
      p.rageT = lo.rage.duration;
      p.rageExtended = 0;
      this.fx.ring(p.pos.clone().setY(0.5), 0xff4040, 2.4);
      this.hud.toast('996 是福报！射速伤害提升，生命燃烧中');
    } else if (sk.id === 'slow') {
      this.slowT = lo.slow.duration;
      this.slowFactor = lo.slow.factor;
      this.fx.ring(p.pos.clone().setY(0.3), 0xb06fff, 8);
      this.hud.toast('卷王模式！我卷得够狠，同事就跟不上');
    }
    const lines = SKILL_SHOUTS[sk.id];
    const roll = this.rng ? this.rng() : Math.random();
    this.fx.shout(lines[Math.floor(roll * lines.length)], p.pos);
  }

  /* ---------------- 加班炸弹 ---------------- */

  throwOvertimeBomb(damage, radius) {
    const p = this.p;
    const target = this.aimPoint.clone();
    target.x = Math.max(-ARENA, Math.min(ARENA, target.x));
    target.z = Math.max(-ARENA, Math.min(ARENA, target.z));
    target.y = groundHeight(target.x, target.z);
    const T = 0.6, g = 30;
    const pos = p.pos.clone().setY(p.pos.y + 1.2);
    const vel = target.clone().sub(pos).divideScalar(T);
    vel.y = (target.y - pos.y) / T + 0.5 * g * T;
    if (!this._bombGeo) {
      this._bombGeo = new THREE.SphereGeometry(0.17, 10, 8);
      this._bombMat = new THREE.MeshStandardMaterial({ color: 0x2b2b33, emissive: 0xffd24a, emissiveIntensity: 0.6 });
    }
    const mesh = new THREE.Mesh(this._bombGeo, this._bombMat);
    mesh.position.copy(pos);
    this.engine.scene.add(mesh);
    this.bombs.push({ pos, vel, t: 0, T, g, target, damage, radius, mesh });
  }

  updateBombs(dt) {
    if (this.state !== 'playing') return;
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.t += dt;
      b.vel.y -= b.g * dt;
      b.pos.addScaledVector(b.vel, dt);
      b.mesh.position.copy(b.pos);
      b.mesh.rotation.x += dt * 9;
      if (b.t >= b.T) {
        b.pos.copy(b.target);
        this.explodeOvertimeBomb(b);
        this.engine.scene.remove(b.mesh);
        this.bombs.splice(i, 1);
      }
    }
  }

  explodeOvertimeBomb(b) {
    const c = b.pos;
    this.fx.ring(c.clone().setY(c.y + 0.3), 0x9fe8ff, b.radius);
    this.fx.spark(c.clone().setY(c.y + 0.5), new THREE.Vector3(0, 1, 0), 14, 0x9fe8ff, 7);
    this.fx.smoke(c.clone().setY(c.y + 0.3), 4, 0xbfeaff, 0.5, 2.4, 0.5);
    this.engine.addShake(0.35);
    this.audio.zap();
    this.audio.boom();
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (e.pos.distanceTo(c) <= b.radius) {
        this.fx.bolt(c.clone().setY(c.y + 1.6), e.pos.clone().setY(e.pos.y + 0.9));
        this.fx.feathers(e.pos, PALETTES[ENEMY_TYPES[e.type].palette].body, 8, 3);
        this.damageEnemy(e, b.damage, { color: '#9fe8ff', source: 'overtime' });
        if (!e.dead) this.rootEnemy(e);
      }
    }
  }

  rootEnemy(e) {
    e.rootT = SKILL_TUNING.overtimeRootSec;
    this.fx.ring(e.pos.clone().setY(e.pos.y + 0.2), 0x9fe8ff, 0.9);
    if (!e.rootLabel && e.hpBar) {
      e.rootLabel = makeNameSprite('加班中', '#9fe8ff', 0.6);
      e.rootLabel.position.y = 1.02;
      e.rootLabel.renderOrder = 2;
      e.hpBar.group.add(e.rootLabel);
    }
    if (e.rootLabel) e.rootLabel.visible = true;
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
    if (this.p && this.p.rageT > 0) duck.setRage(true);
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
      this.shieldDome.visible = false;
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
      // 选卡立即冻结；阵亡当帧也不能再靠工资/福利回血或继续收刀。
      if (this.state === 'playing') this.updateEnemies(dt);
      if (this.state === 'playing') this.updateMissileFires(dt);
      if (this.state === 'playing') this.updateBombs(dt);
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
      const v = _v1.copy(this.aimPoint).project(this.engine.camera);
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
    if (this.planId === 'gpt') return 0; // 激光直射，无散布
    const p = this.p;
    return (this.loadout.gun.spreadBase + (p.moving ? WEAPON.spreadMove : 0) + p.heat * WEAPON.spreadHeat) * this.loadout.spreadMul;
  }

  /* ---------------- 玩家 ---------------- */

  updatePlayer(dt) {
    if (this.state !== 'playing') return;
    const p = this.p;
    if (this.bot) this.botControl();
    const k = this.keys;
    const dir = _v1.set(
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
    this.playerDuck.setRage(p.rageT > 0);
    p.hasteT = Math.max(0, p.hasteT - dt);
    // 调休到期：没用完的假期折现回血（被打破的盾不折现），保留福利 / 开工护盾 / 溢出治疗护盾。
    if (p.shieldSkillT > 0) {
      p.shieldSkillT = Math.max(0, p.shieldSkillT - dt);
      if (p.shieldSkillT <= 0) {
        p.shield = Math.max(0, p.shield - p.skillShield);
        const heal = Math.min(p.maxHp - p.hp, p.skillShield);
        if (heal > 0.5) {
          p.hp += heal;
          this.fx.number(p.pos.clone().setY(p.pos.y + 1.9), `调休折现 +${Math.round(heal)}`, '#7ee06a');
          this.fx.ring(p.pos.clone().setY(0.5), 0x7ee06a, 1.8);
          this.hud.toast(`调休折现：没用完的假期回复 ${Math.round(heal)} 生命`);
        }
        p.skillShield = 0;
      }
    }
    // 996 烧命：持续扣血，属于自我消耗，不走护盾 / 不死鸟
    if (p.rageT > 0) {
      p.hp -= SKILL_TUNING.rageBurnPerSec * dt;
      p.lastHurt = this.time;
      if (p.hp <= 0) { p.hp = 0; this.endRun('combat'); return; }
    }
    if (this.slowT > 0) { this.slowT = Math.max(0, this.slowT - dt); if (this.slowT <= 0) this.slowFactor = 1; }
    if (k.has('Space') && p.dashCd <= 0) {
      p.dashDir.copy(dir.lengthSq() > 0 ? dir : _v2.set(Math.sin(p.aimYaw), 0, Math.cos(p.aimYaw)));
      p.dashT = 0.22; p.dashCd = 1.1 * (this.loadout.dashCdMul ?? 1); p.iframes = 0.34;
      p.dashHit = null; // 每次冲刺重置撞击名单
      this.audio.dash();
      this.fx.ring(p.pos.clone().setY(0.3), 0xb7f0ff, 1.6);
      this.fx.smoke(p.pos.clone().setY(0.2), 4, 0xcbb896, 0.4, 1.4, 0.5);
      k.delete('Space');
    }

    const sm = this.loadout.speedMul * (p.hasteT > 0 ? 1.25 : 1) * (p.rageT > 0 ? SKILL_TUNING.rageMoveMul : 1);
    const target = p.dashT > 0 ? _v2.copy(p.dashDir).multiplyScalar(13.5 * sm) : _v2.copy(dir).multiplyScalar(6.2 * sm);
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
          const away = _v3.subVectors(e.pos, p.pos).setY(0).normalize();
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
      _ndc.set((this.mouse.x / innerWidth) * 2 - 1, -(this.mouse.y / innerHeight) * 2 + 1);
      this.ray.setFromCamera(_ndc, this.engine.camera);
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

    // 沿准星方向预测弹道停止点，散射武器以扇面中线为准
    const muzzle = this.playerDuck.muzzleWorld(_v3);
    const bdir = _v4.subVectors(this.aimPoint, muzzle);
    bdir.y = 0;
    if (bdir.lengthSq() < 1e-8) bdir.set(Math.sin(p.aimYaw), 0, Math.cos(p.aimYaw));
    bdir.normalize();
    const isBubble = this.planId === 'glm';
    const targets = [];
    for (const e of this.enemies) {
      if (e.dead || this.planId === 'qwen') continue; // 半月刀穿过敌人，落点环显示实际停止点
      const target = { x: e.pos.x, z: e.pos.z, radius: e.radius + 0.22, height: 1.7 * e.scale };
      if (isBubble) {
        target.radius = e.radius + BUBBLE_RADIUS;
        target.minY = e.pos.y - BUBBLE_RADIUS;
        target.height += e.pos.y + BUBBLE_RADIUS;
      }
      targets.push(target);
    }
    const range = this.loadout.range;
    const colliders = this.world.colliders;
    const wallT = muzzle.y < 1.8 ? blockerTime(muzzle.x, muzzle.z, bdir.x * range, bdir.z * range, colliders) : Infinity;
    const cap = wallT === Infinity ? range : range * wallT;
    const imp = marchImpact(muzzle, bdir, cap, targets, () => false,
      (x, z) => { const wy = waterSurfaceAt(x, z); return wy !== null ? wy : groundHeight(x, z); },
      isBubble ? 0.25 : 0.5, isBubble,
      (t) => muzzle.y >= 1.8 || blockerTime(muzzle.x, muzzle.z, t.x - muzzle.x, t.z - muzzle.z, colliders) === Infinity);
    if (imp.hit === 'none' && wallT !== Infinity) imp.hit = 'wall';
    this.bulletStop.set(imp.x, groundHeight(imp.x, imp.z), imp.z);
    // Claude 追踪导弹的停止点指向锁定敌人的预测拦截点。
    if (this.planId === 'claude') {
      const lock = this.lockMissileTarget({ pos: muzzle, range: this.loadout.range }, bdir);
      if (lock) {
        const lead = this.missileLeadPoint(muzzle, lock, this.loadout.bulletSpeed);
        this.bulletStop.set(lead.x, groundHeight(lead.x, lead.z), lead.z);
      }
    }
    const markGap = Math.hypot(this.bulletStop.x - this.aimPoint.x, this.bulletStop.z - this.aimPoint.z);
    this.impactMarker.visible = markGap > 0.5 && this.planId !== 'gpt';
    this.impactMarker.position.set(this.bulletStop.x, this.bulletStop.y + 0.03, this.bulletStop.z);

    // 武器调用：一次连发 / 散射只支付一次 Token，失败不吞部分额度。
    p.heat = Math.max(0, p.heat - dt * 1.1);
    if (p.fireT > 0) p.fireT -= dt;
    if (!this.mouse.down) p.fireT = Math.max(0, p.fireT);
    else while (p.fireT <= 1e-9) {
      const carry = Math.min(0, p.fireT);
      p.fireT = 0;
      if (!this.fire()) break;
      p.fireT += carry;
    }
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
    const bar = this.playerHpBar;
    const shOn = p.shield > 0;
    bar.shieldBg.visible = bar.shieldFill.visible = shOn;
    if (shOn) {
      const sr = Math.max(0, Math.min(1, p.shield / Math.max(p.shieldMax, 1)));
      bar.shieldFill.scale.x = 1.42 * sr;
      bar.shieldFill.position.x = -(1.42 * (1 - sr)) / 2;
    }
    if (bar.label) bar.label.position.y = bar.nameBaseY + (shOn ? 0.16 : 0);
    this.shieldDome.visible = p.shieldSkillT > 0;
    if (this.shieldDome.visible) {
      this.domePop = Math.min(0.22, this.domePop + dt);
      const k = 1 - Math.pow(1 - this.domePop / 0.22, 3);
      this.shieldDome.scale.setScalar(0.5 + 0.5 * k);
      this.shieldDome.position.set(p.pos.x, p.pos.y + 0.72, p.pos.z);
      this.shieldDome.material.uniforms.uT.value = this.time;
      this.shieldDome.material.uniforms.uFade.value = Math.min(1, p.shieldSkillT / 0.3);
    }
  }

  botControl() {
    botControl(this);
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
    const extra = this.planId === 'qwen' ? 0 : lo.mods.multishot || 0;
    this.shots += lo.pellets + extra;
    const origin = this.playerDuck.muzzleWorld(new THREE.Vector3());
    // 取枪口到准星的水平瞄准方向
    const base = _v1.subVectors(this.aimPoint, origin);
    base.y = 0;
    if (base.lengthSq() < 1e-8) base.set(Math.sin(p.aimYaw), 0, Math.cos(p.aimYaw));
    base.normalize();
    const spread = this.spreadNow();
    const fanWidth = lo.pellets > 1 ? lo.gun.pelletSpread : 0;
    const fanCenter = fanWidth ? (Math.random() - 0.5) * 2 * spread : 0;
    const dmg = lo.damage * (raging ? lo.rage.dmgMul : 1);
    const baseColor = this.planId === 'gpt' ? 0x40e8a0 : this.planId === 'qwen' ? 0x8661fc : lo.gun.accent;
    const color = raging ? 0xffb040 : lo.mods.frost ? 0x9fe8ff : baseColor;
    const side = _v2.set(base.z, 0, -base.x).normalize();
    const attack = {
      provider: this.planId,
      falloffStart: lo.falloffStart, falloffEnd: lo.falloffEnd, falloffMin: lo.falloffMin,
      mods: Object.fromEntries(Object.entries(lo.mods).map(([key, value]) =>
        [key, value && typeof value === 'object' ? { ...value } : value])),
    };
    if (this.planId === 'gpt') {
      this.fireLaser(origin, base, side, dmg, attack, extra, color);
    } else for (let i = 0; i < lo.pellets + extra; i++) {
      const d = base.clone();
      // 基础气泡均匀铺开，热量和移动一起偏移整个扇面。
      const angle = fanWidth && i < lo.pellets
        ? fanCenter + (i / (lo.pellets - 1) - 0.5) * fanWidth
        : (Math.random() - 0.5) * 2 * spread;
      d.applyAxisAngle(_up, angle);
      d.normalize();
      // 双管齐下：额外弹从枪口两侧平行射出，不共用同一条射线
      const org = origin.clone();
      if (i >= lo.pellets) org.addScaledVector(side, ((i - lo.pellets) % 2 === 0 ? 1 : -1) * 0.28);
      // 慢速弹的寿命覆盖整个射程
      const slow = this.planId === 'claude' || this.planId === 'glm';
      const life = slow ? lo.range / lo.bulletSpeed + 0.4 : 1.1;
      const b = { pos: org, vel: d.multiplyScalar(lo.bulletSpeed), life, traveled: 0, range: lo.range, dmg,
        attack, pierce: this.planId === 'claude' ? 0 : (lo.intrinsicPierce || 0) + (lo.mods.pierce || 0), planId: this.planId, trailT: 0, color };
      b.vis = this.makeBulletVis(this.planId, color);
      b.vis.position.copy(b.pos);
      if (this.planId === 'claude') {
        b.target = this.lockMissileTarget(b, base);
        b.vis.advance?.(b.vel, 0, this.engine.camera);
      } else if (this.planId === 'ds' || this.planId === 'qwen') {
        b.vis.lookAt(b.pos.clone().add(b.vel));
      }
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
        this.engine.addShake(0.1);
        break;
      case 'qwen':
        this.fx.flash(origin, 0.22, color);
        this.engine.addShake(0.05);
        break;
      case 'glm':
        this.fx.flash(origin, 0.18);
        this.engine.addShake(0.06);
        break;
      case 'ds':
        this.fx.flash(origin, 0.3, color);
        this.engine.addShake(0.09);
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

  // GPT 激光：hitscan 直射，无散布 / 无弹体 / 无落点环；穿甲卡沿用逐目标衰减
  fireLaser(origin, base, side, dmg, attack, extra, color) {
    const lo = this.loadout;
    const colliders = this.world.colliders;
    this.impactMarker.visible = false;
    for (let i = 0; i < lo.pellets + extra; i++) {
      const org = origin.clone();
      if (i >= lo.pellets) org.addScaledVector(side, ((i - lo.pellets) % 2 === 0 ? 1 : -1) * 0.28);
      const dir = base;
      const wallT = org.y < 1.8 ? blockerTime(org.x, org.z, dir.x * lo.range, dir.z * lo.range, colliders) : Infinity;
      let blocked = wallT !== Infinity;
      let limit = blocked ? lo.range * wallT : lo.range;
      const end = org.clone();
      for (let d = 0; d < limit;) {
        d = Math.min(d + 0.25, limit);
        end.copy(org).addScaledVector(dir, d);
        const surface = waterSurfaceAt(end.x, end.z) ?? groundHeight(end.x, end.z);
        if (end.y <= surface + 0.04) { limit = d; blocked = true; break; }
      }
      end.copy(org).addScaledVector(dir, limit);
      const contacts = [];
      for (const e of this.enemies) {
        if (e.dead || org.y >= 1.7 * e.scale) continue;
        const dx = e.pos.x - org.x, dz = e.pos.z - org.z;
        const along = dx * dir.x + dz * dir.z;
        const across = dx * dir.z - dz * dir.x;
        const chordSq = (e.radius + 0.22) ** 2 - across ** 2;
        if (chordSq < 0) continue;
        const chord = Math.sqrt(chordSq);
        if (along + chord < 0) continue;
        const distance = Math.max(0, along - chord);
        if (distance > limit || (blocked && distance >= limit)) continue;
        const point = org.clone().addScaledVector(dir, distance);
        if (org.y < 1.8 && blockerTime(point.x, point.z, e.pos.x - point.x, e.pos.z - point.z, colliders) !== Infinity) continue;
        contacts.push({ e, point, distance });
      }
      contacts.sort((a, b) => a.distance - b.distance);
      let pierce = (lo.intrinsicPierce || 0) + (lo.mods.pierce || 0);
      let curDmg = dmg, counted = false, stopped = false;
      for (const { e, point, distance } of contacts) {
        if (e.dead) continue;
        if (!counted) { this.hits++; counted = true; }
        const d = damageAtDistance(curDmg, distance, attack);
        this.fx.spark(point, dir.clone().multiplyScalar(-0.55), 9, color, 7);
        this.fx.ring(point, color, 1.0);
        this.fx.feathers(point, PALETTES[ENEMY_TYPES[e.type].palette].body, 5, 2.5);
        this.audio.hit();
        this.hud.hitmarker(false);
        e.duck.kick();
        this.damageEnemy(e, d, { mods: attack?.mods });
        this.applyHitMods(e, point, d, attack?.mods);
        if (!pierce) {
          end.copy(point);
          stopped = true;
          break;
        }
        pierce--;
        curDmg *= 0.8;
      }
      if (blocked && !stopped) this.fx.spark(end, dir.clone().multiplyScalar(-0.7), 5, color, 4);
      this.fx.beam(org, end, color, stopped || blocked);
    }
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
    this.playerDuck.setRage(false);
    this.playerHpBar.group.visible = false;
    this.shieldDome.visible = false;
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
      rootT: 0,
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

  removeAttackVisual(visual) {
    if (!visual) return;
    this.engine.scene.remove(visual);
    visual.dispose?.();
  }

  makeBulletVis(planId, tailColor) {
    if (planId === 'claude') {
      const missile = new ClaudeMissileVisual(tailColor);
      this.engine.scene.add(missile);
      return missile;
    }
    const g = new THREE.Group();
    // 材质按配置缓存共享：几何体本就共享，避免每发子弹新建材质造成分配与未 dispose 累积
    const cached = (key, make) => {
      let m = this._bulletMatCache.get(key);
      if (!m) { m = make(); this._bulletMatCache.set(key, m); }
      return m;
    };
    switch (planId) {
      case 'qwen': {
        g.rotation.order = 'YXZ';
        const fill = cached(`qwen-fill:${tailColor}`, () => new THREE.MeshBasicMaterial({
          color: tailColor, transparent: true, opacity: 0.63, side: THREE.DoubleSide, depthWrite: false,
          forceSinglePass: true, toneMapped: false }));
        const edge = cached(`qwen-edge:${tailColor}`, () => new THREE.MeshBasicMaterial({
          color: new THREE.Color(tailColor).lerp(new THREE.Color(0xffffff), 0.47),
          side: THREE.DoubleSide, toneMapped: false }));
        g.add(new THREE.Mesh(this._qwenBladeGeo, fill), new THREE.Mesh(this._qwenEdgeGeo, edge));
        break;
      }
      case 'ds': {
        const core = new THREE.Mesh(this._dsCoreGeo, cached(`ds-core:${tailColor}`, () => new THREE.MeshBasicMaterial({
          color: new THREE.Color(tailColor).lerp(new THREE.Color(0xffffff), 0.52), toneMapped: false })));
        const tracer = new THREE.Mesh(this._dsTracerGeo, cached(`ds-tracer:${tailColor}`, () => new THREE.MeshBasicMaterial({
          color: tailColor, vertexColors: true, transparent: true, opacity: 0.8,
          blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })));
        tracer.visible = false;
        g.userData.tracer = tracer;
        g.add(core, tracer);
        break;
      }
      case 'glm': {
        const color = new THREE.Color(tailColor).lerp(new THREE.Color(0xffffff), 0.65);
        const bubble = new THREE.Sprite(cached(`bubble:${tailColor}`, () => new THREE.SpriteMaterial({
          map: bubbleTexture(), color, transparent: true, depthWrite: false })));
        bubble.scale.setScalar(2 * BUBBLE_RADIUS);
        g.add(bubble);
        break;
      }
      default: {
        // 小圆点子弹：无拖尾，颜色随计划主题 / 狂热 / 霜冻 / 敌方橙红
        const dotColor = new THREE.Color(tailColor).lerp(new THREE.Color(0xffffff), 0.35);
        g.add(new THREE.Mesh(this._bulletGeoOrb, cached(`dot:${tailColor}`, () => new THREE.MeshBasicMaterial({ color: dotColor }))));
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
    let label = null;
    if (name) {
      const h = 0.55 * nameScale;
      label = makeNameSprite(name, nameColor, h);
      label.position.y = 0.12 + h / 2;
      label.renderOrder = 1; // 名字压在血条之上，不受贴图透明排序影响
      group.add(label);
    }
    group.visible = false;
    this.engine.scene.add(group);
    return { group, fill, label };
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

  menuFocusables() { return menuFocusables(this); }
  menuNavigate(dx, dy) { menuNavigate(this, dx, dy); }
  pollGamepad() { pollGamepad(this); }

  /* ---------------- 敌人 ---------------- */

  updateEnemies(dt) {
    if (this.state !== 'playing') return;
    const p = this.p;
    const cam = this.engine.camera;
    const frustum = this._frustum.setFromProjectionMatrix(
      this._projMat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const visPoint = _v5;
    for (const e of this.enemies) {
      if (this.state !== 'playing') return;
      if (e.dead) { e.duck.update(dt, { moving: false }); continue; }
      const t = ENEMY_TYPES[e.type];
      const to = _v1.subVectors(p.pos, e.pos); to.y = 0;
      const dist = to.length();
      const dirN = _v2.copy(to).normalize();
      const want = _v3.set(0, 0, 0);
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
      // 加班定身：原地罚站，头顶「加班中」；攻击计时不受影响（区别于卷王的全面暂停）
      if (e.rootT > 0) {
        e.rootT = Math.max(0, e.rootT - dt);
        if (e.rootLabel) e.rootLabel.visible = e.rootT > 0;
      }
      const frost = e.frostT > 0 ? e.frostFactor : 1;
      const speed = e.speed * this.plan.speedScale * frost * (this.slowT > 0 ? this.slowFactor : 1) * (e.rootT > 0 ? 0 : 1);
      // 卷王模式：敌人被卷到干不动，攻击 / 蓄力 / 技能计时全部暂停（移动仍只是减速）
      const adt = this.slowT > 0 ? 0 : dt;

      if (e.skillKind) {
        e.skillCd = Math.max(0, e.skillCd - adt);
        if (e.skillT > 0) {
          e.skillT -= adt;
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
        e.attackT = Math.max(0, e.attackT - adt);
        if (e.windup > 0) {
          e.windup -= adt;
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
        const strafe = _v4.set(-dirN.z, 0, dirN.x).multiplyScalar(Math.sin(this.t * 0.8 + e.seed) * speed * 0.65);
        want.add(strafe);
        e.fireT -= adt;
        visPoint.copy(e.pos); visPoint.y += 0.8;
        if (e.fireT <= 0 && canEngage(dist, t.range, frustum.containsPoint(visPoint)) && !segBlocked(e.pos, p.pos, this.world.colliders)) {
          e.fireT = t.fireInterval * (0.8 + this.rng() * 0.5);
          const origin = e.duck.muzzleWorld(_v4);
          const pellets = t.pellets || 1;
          for (let i = 0; i < pellets; i++) {
            const d = p.pos.clone().setY(0.6).sub(origin).normalize();
            d.applyAxisAngle(_up, (this.rng() - 0.5) * (pellets > 1 ? (t.spread || 0.22) : 0.09));
            d.normalize();
            this.ebullets.push({ pos: origin.clone(), vel: d.multiplyScalar(t.bulletSpeed), life: 3, dmg: e.damage });
          }
          this.fx.flash(origin.clone(), 0.22);
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
        if (d < min && d > 1e-4) {
          const push = ((min - d) * 6) / d;
          want.x += dx * push;
          want.z += dz * push;
        }
      }
      const pdx = e.pos.x - p.pos.x, pdz = e.pos.z - p.pos.z;
      const pd = Math.hypot(pdx, pdz);
      const pmin = e.radius + 0.5;
      if (pd < pmin && pd > 1e-4) {
        const push = ((pmin - pd) * 8) / pd;
        want.x += pdx * push;
        want.z += pdz * push;
      }

      if (e.rootT > 0) want.set(0, 0, 0);
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
    if (e.hp <= 0) this.killEnemy(e, opts);
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

  killEnemy(e, opts = {}) {
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
    this.fx.number(e.pos.clone().setY(e.pos.y + 1.3), `+${c} 刀`, '#ffd95e');
    // 加班：技能范围内击杀按人头结算加班费
    if (opts.source === 'overtime') {
      this.creditCoins(SKILL_TUNING.overtimeCoins);
      this.fx.number(e.pos.clone().setY(e.pos.y + 1.8), `+${SKILL_TUNING.overtimeCoins} 加班费`, '#ffd95e');
    }
    // 996：燃烧期间击杀续命，有上限
    if (this.p.rageT > 0 && this.p.rageExtended < SKILL_TUNING.rageExtendCap) {
      const ext = Math.min(SKILL_TUNING.rageKillExtend, SKILL_TUNING.rageExtendCap - this.p.rageExtended);
      this.p.rageT += ext;
      this.p.rageExtended += ext;
    }
    // 卷王模式：敌人干不动了，经验全归我
    const grind = this.slowT > 0 ? SKILL_TUNING.grindXpMul : 1;
    const xp = Math.round(xpForKill(e.type, e.elite) * this.loadout.xpMul * grind);
    this.addXp(xp);
    if (grind > 1) this.fx.number(e.pos.clone().setY(e.pos.y + 2.2), `卷王经验 ×${grind}`, '#b06fff');
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

  // 只锁定航向左右 60° 内的目标，优先选最贴合航向的敌人。
  lockMissileTarget(b, dir) {
    const remainingRange = b.range - (b.traveled ?? 0);
    let best = null, bestScore = Infinity;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const dx = e.pos.x - b.pos.x, dz = e.pos.z - b.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > remainingRange || dist < 1e-3) continue;
      const dot = (dx * dir.x + dz * dir.z) / dist;
      if (dot < 0.5) continue;
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

  // 目标被击倒时沿当前航向重新锁定，找不到替补就继续直飞。
  steerMissile(b, dt) {
    if (b.target?.dead) b.target = this.lockMissileTarget(b, _v1.copy(b.vel).setY(0).normalize());
    const e = b.target;
    if (!e) return;
    const speed = b.vel.length();
    if (speed < 1e-3) return;
    const cur = _v1.copy(b.vel).divideScalar(speed);
    const desired = this.missileLeadPoint(b.pos, e, speed).sub(b.pos);
    if (desired.lengthSq() < 1e-6) return;
    desired.normalize();
    const { dir: guided, urgency } = this.missileAvoid(b.pos, cur, desired, speed, b);
    const angle = cur.angleTo(guided);
    if (angle < 1e-4) return;
    const rate = MISSILE_TURN_RATE + urgency * 20; // 追踪时柔和弧线；避障时允许更急转弯以绕过障碍
    const t = Math.min(1, (rate * dt) / angle);
    _q1.identity().slerp(_q2.setFromUnitVectors(cur, guided), t);
    b.vel.copy(cur.applyQuaternion(_q1).multiplyScalar(speed));
  }

  missileExplode(b, directTarget, impactDamage = damageAtDistance(b.dmg, b.traveled, b.attack)) {
    const pos = b.pos;
    this.fx.flash(pos, 1.2);
    this.fx.ring(pos, 0xff7040, MISSILE_BLAST_RADIUS);
    this.fx.spark(pos, new THREE.Vector3(0, 0.8, 0), 12, 0xffa050, 12);
    this.fx.smoke(pos, 5, 0x6a5a4a, 0.6, 2.4, 0.9);
    this.audio.boom();
    this.engine.addShake(0.3);
    for (const e of this.enemies) {
      if (e.dead || e === directTarget) continue;
      const distance = Math.hypot(e.pos.x - pos.x, e.pos.z - pos.z);
      if (distance > MISSILE_BLAST_RADIUS) continue;
      if (!b.countedHit) {
        this.hits++;
        b.countedHit = true;
        this.hud.hitmarker(false);
      }
      const splash = impactDamage * (0.65 - 0.35 * distance / MISSILE_BLAST_RADIUS);
      this.damageEnemy(e, splash, { mods: b.attack?.mods, noProc: true, noCrit: true, color: '#ffb070' });
    }
    const visual = new GroundFireVisual(pos, MISSILE_BLAST_RADIUS);
    this.engine.scene.add(visual);
    this.missileFires.push({ pos: pos.clone(), visual, elapsed: 0, dps: impactDamage * 0.2, mods: b.attack?.mods });
  }

  updateMissileFires(dt) {
    if (this.state !== 'playing' || !this.missileFires.length || dt <= 0) return;
    for (const e of this.enemies) {
      if (e.dead) continue;
      let damage = 0, mods;
      for (const fire of this.missileFires) {
        const distance = Math.hypot(e.pos.x - fire.pos.x, e.pos.z - fire.pos.z);
        if (distance > MISSILE_BLAST_RADIUS) continue;
        const ignition = THREE.MathUtils.lerp(FIRST_EMBER_LANDING, LAST_EMBER_LANDING, distance / MISSILE_BLAST_RADIUS);
        const hotTime = Math.min(fire.elapsed + dt, MISSILE_FIRE_LIFETIME) - Math.max(fire.elapsed, ignition);
        const burn = fire.dps * Math.max(0, hotTime);
        // 火区重叠时取本帧最高伤害，连射扩大覆盖范围。
        if (burn > damage) { damage = burn; mods = fire.mods; }
      }
      if (damage > 0) this.damageEnemy(e, damage, { mods, raw: true, noProc: true, silent: true });
    }
    for (let i = this.missileFires.length - 1; i >= 0; i--) {
      const fire = this.missileFires[i];
      fire.elapsed += dt;
      const remaining = MISSILE_FIRE_LIFETIME - fire.elapsed;
      if (remaining <= 0) {
        this.removeAttackVisual(fire.visual);
        this.missileFires.splice(i, 1);
      } else {
        fire.visual.update(fire.elapsed, remaining);
      }
    }
  }

  updateBullets(dt) {
    if (this.state !== 'playing') return;
    const p = this.p;
    const colliders = this.world.colliders;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const isBubble = b.planId === 'glm';
      const isDS = b.planId === 'ds';
      const isBlade = b.planId === 'qwen';
      const sweepRadius = isBubble ? BUBBLE_RADIUS : isBlade ? QWEN_BLADE_HALF_WIDTH : 0;
      const heightPad = isBlade ? QWEN_BLADE_HEIGHT_PAD : sweepRadius;
      const bladeDirection = isBlade ? _v2.copy(b.vel).setY(0).normalize() : null;
      b.life -= dt;
      let gone = b.life <= 0;
      if (!gone) {
        if (b.planId === 'claude') this.steerMissile(b, dt);
        const step = _v3.copy(b.vel).multiplyScalar(dt);
        if (isBubble) step.clampLength(0, Math.max(0, b.range - b.traveled));
        const n = Math.min(12, Math.max(1, Math.ceil(step.length() / 0.3)));
        step.divideScalar(n);
        const stride = step.length();
        for (let s = 0; s < n && !gone; s++) {
          const fromX = b.pos.x, fromZ = b.pos.z;
          const wallT = b.pos.y < 1.8 ? blockerTime(fromX, fromZ, step.x, step.z, colliders) : Infinity;
          const wall = wallT !== Infinity;
          const fraction = wall ? wallT : 1;
          b.pos.addScaledVector(step, fraction);
          b.traveled += stride * fraction;
          for (const e of this.enemies) {
            if (e.dead || (b.hitSet && b.hitSet.has(e))) continue;
            const hit = sweepRadius
              ? b.pos.y >= e.pos.y - heightPad && b.pos.y <= e.pos.y + 1.7 * e.scale + heightPad
                && (isBlade ? bladeTouchesEnemy(b.pos, stride * fraction, bladeDirection, e)
                  : segmentTouchesCircle(b.pos.x, b.pos.z, step.x * fraction, step.z * fraction, e.pos.x, e.pos.z, e.radius + sweepRadius))
              : b.pos.y < 1.7 * e.scale && Math.hypot(b.pos.x - e.pos.x, b.pos.z - e.pos.z) < e.radius + 0.22;
            if (hit) {
              if (b.pos.y < 1.8 && blockerTime(fromX, fromZ, e.pos.x - fromX, e.pos.z - fromZ, colliders) !== Infinity) continue;
              const dmg = damageAtDistance(b.dmg, b.traveled, b.attack);
              if (!b.countedHit) { this.hits++; b.countedHit = true; }
              const hitDir = b.vel.clone().normalize().multiplyScalar(-0.4);
              switch (b.planId) {
                case 'claude':
                  this.fx.feathers(b.pos, PALETTES[ENEMY_TYPES[e.type].palette].body, 7, 3);
                  break;
                case 'gpt':
                  this.fx.spark(b.pos, hitDir, 9, 0x40e8a0, 7);
                  this.fx.ring(b.pos, 0x30d890, 1.2);
                  this.fx.feathers(b.pos, PALETTES[ENEMY_TYPES[e.type].palette].body, 5, 2.5);
                  break;
                case 'qwen':
                  this.fx.bladeShards(b.pos, hitDir, b.color);
                  this.fx.feathers(b.pos, PALETTES[ENEMY_TYPES[e.type].palette].body, 3, 2);
                  break;
                case 'glm':
                  this.fx.feathers(b.pos, PALETTES[ENEMY_TYPES[e.type].palette].body, 5, 2.5);
                  break;
                case 'ds':
                  this.fx.spark(b.pos, hitDir, 6, b.color, 5);
                  this.fx.ring(b.pos, b.color, 0.48);
                  this.fx.feathers(b.pos, PALETTES[ENEMY_TYPES[e.type].palette].body, 4, 2);
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
              if (b.planId === 'claude') this.missileExplode(b, e, dmg);
              if (isBlade) {
                if (!b.hitSet) b.hitSet = new Set();
                b.hitSet.add(e);
                continue;
              }
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
          if (!gone && wall) {
            if (b.planId === 'claude') this.missileExplode(b);
            else if (isBlade) this.fx.bladeShards(b.pos, b.vel.clone().normalize().multiplyScalar(-0.4), b.color);
            else if (isDS) this.fx.spark(b.pos, b.vel.clone().normalize().multiplyScalar(-0.5), 4, b.color, 4);
            else if (!isBubble) {
              this.fx.spark(b.pos, b.vel.clone().normalize().multiplyScalar(-0.5), 6, 0xffc060, 5);
              this.fx.smoke(b.pos, 1, 0x8a8078, 0.25, 1.4, 0.4);
            }
            gone = true;
          }
          if (!gone) {
            const wy = waterSurfaceAt(b.pos.x, b.pos.z);
            if (wy !== null && b.pos.y <= wy + 0.04) {
              // 落水：白色水花，不产生焦痕
              if (!isBubble) {
                this.fx.smoke(b.pos, 2, 0xd8ece8, 0.3, 1.5, 0.5);
                this.fx.spark(b.pos, new THREE.Vector3(0, 1, 0), 5, 0xbfe8e0, 3);
              }
              gone = true;
            } else if (b.pos.y <= groundHeight(b.pos.x, b.pos.z) + 0.04) {
              if (b.planId === 'claude') { this.missileExplode(b); this.fx.decal(b.pos, 0.4); }
              else if (isDS) this.fx.spark(b.pos, new THREE.Vector3(0, 1, 0), 4, b.color, 3);
              else if (!isBubble) {
                this.fx.smoke(b.pos, 2, 0xa08a68, 0.3, 1.5, 0.5);
                this.fx.spark(b.pos, new THREE.Vector3(0, 1, 0), 4, 0xc8b080, 3);
                this.fx.decal(b.pos, 0.28);
              }
              gone = true;
            }
          }
          if (!gone && b.traveled >= b.range - (isBubble ? 1e-6 : 0)) {
            if (!isBubble && !isDS) {
              this.fx.smoke(b.pos, 2, 0xa08a68, 0.3, 1.5, 0.5);
              const wy = waterSurfaceAt(b.pos.x, b.pos.z);
              this.fx.decal(new THREE.Vector3(b.pos.x, wy !== null ? wy : groundHeight(b.pos.x, b.pos.z), b.pos.z), 0.28);
            }
            gone = true;
          }
        }
      }
      if (gone) {
        if (isBubble) this.fx.ring(b.pos, 0xa4ddff, 0.75);
        this.removeAttackVisual(b.vis);
        this.bullets.splice(i, 1);
      } else if (b.vis) {
        b.vis.position.copy(b.pos);
        if (isBlade) b.vis.rotation.z = Math.sin(b.traveled * 2.5) * 0.19;
        const tracer = b.vis.userData.tracer;
        if (tracer) {
          tracer.visible = b.traveled > 0.06;
          tracer.scale.z = Math.min(1, b.traveled / DS_TRACER_LENGTH);
        }
        if (b.planId === 'claude') {
          const nozzle = b.vis.advance?.(b.vel, dt, this.engine.camera);
          b.trailT += dt;
          if (nozzle && b.trailT >= 0.07) {
            b.trailT %= 0.07;
            this.fx.smoke(nozzle, 1, 0xbc9887, 0.23, 1.7, 0.36);
          }
        }
      }
    }

    for (let i = this.ebullets.length - 1; i >= 0; i--) {
      const b = this.ebullets[i];
      b.life -= dt;
      let gone = b.life <= 0;
      if (!gone) {
        const step = _v3.copy(b.vel).multiplyScalar(dt);
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
          b.spr = this.makeBulletVis(null, 0xff7040);
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
          this.hud.toast(`拾取 ${loot.label} · +${loot.coins} 刀${eff ? ' · ' + eff : ''}`);
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
