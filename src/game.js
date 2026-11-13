import * as THREE from 'three';
import { Duck, PALETTES } from './duck.js';
import { FX } from './fx.js';
import { WEAPON, ENEMY_TYPES, wavePlan, waveIntro, damageAtDistance, scoreFor, rollDrop, mulberry32, canEngage, computeLoadout, coinsFor, rollLoot, LOOT_ITEMS, GEAR, GUNS, gearNext, xpForLevel, xpForKill, WAVE_CLEAR_XP, TALENTS, talentNext, talentEffects, SKILLS, applyTalents, ELITE, eliteHpMul, ELITE_SKILL, BOSS_SKILL } from './rules.js';
import { ARENA, GATES, groundHeight, resolveColliders } from './world.js';
import { glowSprite } from './textures.js';

const LOOT_BY_ID = Object.fromEntries(LOOT_ITEMS.map((i) => [i.id, i]));

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
    this.ray = new THREE.Raycaster();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._frustum = new THREE.Frustum();
    this._projMat = new THREE.Matrix4();
    this.rng = mulberry32(Date.now() & 0xffff);
    this.t = 0;
    this.showFps = false;
    this.fragile = false;
    this.padAim = null;
    this.padPrev = [];
    this.best = this.loadBest();

    this.playerDuck = new Duck('player', 1);
    engine.scene.add(this.playerDuck.group);
    this.playerDuck.group.position.set(0, 0, 3);
    this.playerHpBar = this.makeHpBar(0x7ee06a);
    this.playerHpBar.group.visible = false;
    const rbg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x1a1208, transparent: true, opacity: 0.75, depthWrite: false }));
    rbg.scale.set(1.5, 0.09, 1);
    const rfill = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffc040, transparent: true, opacity: 0.95, depthWrite: false }));
    rfill.scale.set(0.001, 0.05, 1);
    const rbar = new THREE.Group();
    rbar.add(rbg, rfill);
    rbar.position.y = -0.17;
    rbar.visible = false;
    this.playerHpBar.group.add(rbar);
    this.playerHpBar.reload = { group: rbar, fill: rfill };
    this._bulletGeo = new THREE.CapsuleGeometry(0.03, 0.12, 3, 6);
    this._bulletGeo.rotateX(Math.PI / 2);
    this._bulletMat = new THREE.MeshStandardMaterial({ color: 0xd8b060, roughness: 0.35, metalness: 0.85, emissive: 0x201004 });
    this._tailGeo = new THREE.BoxGeometry(0.05, 0.05, 1);
    this.enemies = [];
    this.bullets = [];
    this.ebullets = [];
    this.pickups = [];
    this.resetStats();
  }

  loadBest() {
    try { return JSON.parse(localStorage.getItem('swyy_best')) || null; } catch { return null; }
  }

  resetStats() {
    this.p = {
      pos: new THREE.Vector3(0, 0, 3), vel: new THREE.Vector3(),
      hp: 100, maxHp: 100, mag: WEAPON.magSize, reserve: WEAPON.reserveStart,
      heat: 0, fireT: 0, reloadT: 0, dashT: 0, dashCd: 0, iframes: 0,
      lastHurt: -99, aimYaw: 0, moving: false, dashDir: new THREE.Vector3(0, 0, -1),
      shield: 0, shieldT: 0, rageT: 0,
    };
    this.wave = 0;
    this.waveState = 'inter';
    this.interT = 2.2;
    this.spawnQueue = [];
    this.spawnT = 0;
    this.kills = 0; this.shots = 0; this.hits = 0; this.score = 0; this.time = 0;
    this.coins = 0; this.coinsEarned = 0;
    this.inv = {};
    this.gear = {};
    this.ownedGuns = ['carbine'];
    this.gunId = 'carbine';
    this.mags = { carbine: WEAPON.magSize };
    this.level = 1; this.xp = 0; this.points = 0; this.xpEarned = 0;
    this.talents = {};
    this.skillCd = { storm: 0, shield: 0, rage: 0, slow: 0 };
    this.slowT = 0; this.slowFactor = 1;
    this.recomputeLoadout();
    this.p.hp = this.p.maxHp;
    if (this.fragile) { this.p.hp = 1; this.p.maxHp = 1; }
  }

  recomputeLoadout() {
    const oldMax = this.loadout ? this.loadout.maxHp : this.p.maxHp;
    this.loadout = applyTalents(computeLoadout(this.gunId, this.gear), talentEffects(this.talents));
    const delta = this.loadout.maxHp - oldMax;
    this.p.maxHp = this.loadout.maxHp;
    this.p.hp = Math.min(this.p.maxHp, this.p.hp + Math.max(0, delta));
    if (this.fragile) { this.p.maxHp = 1; this.p.hp = Math.min(this.p.hp, 1); }
  }

  start() {
    for (const e of this.enemies) { this.engine.scene.remove(e.duck.group); if (e.hpBar) this.engine.scene.remove(e.hpBar.group); }
    for (const pk of this.pickups) this.engine.scene.remove(pk.mesh);
    for (const b of this.bullets) if (b.vis) this.engine.scene.remove(b.vis);
    for (const b of this.ebullets) if (b.spr) this.engine.scene.remove(b.spr);
    this.enemies = []; this.pickups = []; this.bullets = []; this.ebullets = [];
    this.resetStats();
    this.rebuildPlayerDuck();
    this.playerDuck.deathT = -1;
    this.playerDuck.root.rotation.set(0, 0, 0);
    this.playerDuck.root.scale.setScalar(1);
    this.playerDuck.group.position.copy(this.p.pos);
    this.state = 'playing';
    this.hud.screen(null);
    this.hud.hudOn(true);
    this.hud.toast('守卫农场！掠夺者即将来袭…');
    this.audio.startMusic();
  }

  toTitle() {
    this.state = 'title';
    for (const e of this.enemies) { this.engine.scene.remove(e.duck.group); if (e.hpBar) this.engine.scene.remove(e.hpBar.group); }
    for (const pk of this.pickups) this.engine.scene.remove(pk.mesh);
    for (const b of this.bullets) if (b.vis) this.engine.scene.remove(b.vis);
    for (const b of this.ebullets) if (b.spr) this.engine.scene.remove(b.spr);
    this.enemies = []; this.pickups = []; this.bullets = []; this.ebullets = [];
    this.resetStats();
    this.rebuildPlayerDuck();
    this.playerDuck.deathT = -1;
    this.playerDuck.root.rotation.set(0, 0, 0);
    this.playerDuck.root.scale.setScalar(1);
    this.playerDuck.group.position.set(0, 0, 3);
    this.playerHpBar.group.visible = false;
    this.hud.screen('start');
    this.hud.hudOn(false);
    this.audio.stopMusic();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.hud.screen('pause');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.hud.screen(null);
  }

  /* ---------------- 商店 ---------------- */

  openShop() {
    if (this.state !== 'playing') return;
    this.state = 'shop';
    this.mouse.down = false;
    this.hud.shopOpen(true);
    this.hud.renderShop(this);
    this.audio.uiClick();
  }

  closeShop() {
    if (this.state !== 'shop') return;
    this.state = 'playing';
    this.hud.shopOpen(false);
    this.audio.uiClick();
  }

  buyGood(id) {
    const p = this.p;
    if (id === 'ammo') {
      if (this.coins < 60) { this.hud.toast('金币不足！'); return; }
      this.coins -= 60;
      p.reserve += 48;
      this.hud.toast('购入子弹箱 · 备弹 +48');
      this.audio.pickup();
    } else if (GEAR[id]) {
      const cur = this.gear[id] || 0;
      const next = gearNext(id, cur);
      if (!next) return;
      if (this.coins < next.price) { this.hud.toast('金币不足！'); return; }
      this.coins -= next.price;
      this.gear[id] = next.level;
      this.recomputeLoadout();
      this.playerDuck.setGear(this.gear);
      this.hud.toast(`${cur ? '升级' : '装备'} ${GEAR[id].label} ${['Ⅰ', 'Ⅱ', 'Ⅲ'][next.level - 1]} · ${next.desc}`);
      this.audio.pickup();
    } else if (GUNS[id]) {
      if (!this.ownedGuns.includes(id)) {
        const g = GUNS[id];
        if (this.coins < g.price) { this.hud.toast('金币不足！'); return; }
        this.coins -= g.price;
        this.ownedGuns.push(id);
        this.mags[id] = g.magSize;
        this.hud.toast(`购入 ${g.label}！`);
      }
      this.equipGun(id);
    }
    this.hud.renderShop(this);
  }

  equipGun(id) {
    if (!this.ownedGuns.includes(id)) return;
    this.mags[this.gunId] = this.p.mag;
    this.gunId = id;
    this.recomputeLoadout();
    this.p.mag = this.mags[id] ?? this.loadout.magSize;
    this.p.reloadT = 0;
    this.rebuildPlayerDuck();
    this.audio.reload();
  }

  cycleGun(dir) {
    const order = Object.keys(GUNS).filter((id) => this.ownedGuns.includes(id));
    if (order.length < 2) return;
    const i = order.indexOf(this.gunId);
    this.equipGun(order[(i + dir + order.length) % order.length]);
    this.hud.toast(`切换 ${this.loadout.gun.label}`);
  }

  sellItem(id, all) {
    const it = LOOT_BY_ID[id];
    const have = this.inv[id] || 0;
    if (!it || have <= 0) return;
    const n = all ? have : 1;
    this.inv[id] = have - n;
    const gain = it.price * n;
    this.coins += gain; this.coinsEarned += gain;
    this.hud.toast(`售出 ${it.label} ×${n} · +${gain} 金币`);
    this.audio.pickup();
    this.hud.renderShop(this);
  }

  /* ---------------- 等级 / 天赋 / 技能 ---------------- */

  addXp(n) {
    this.xp += n; this.xpEarned += n;
    let leveled = false;
    while (this.xp >= xpForLevel(this.level)) {
      this.xp -= xpForLevel(this.level);
      this.level++;
      this.points++;
      leveled = true;
    }
    if (leveled) {
      const p = this.p;
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.3);
      this.hud.toast(`升级！Lv.${this.level} · 获得天赋点（T 键加点）`);
      this.fx.ring(p.pos.clone().setY(0.5), 0x7ee06a, 3);
      this.fx.number(p.pos.clone().setY(p.pos.y + 1.6), `Lv.${this.level}`, '#7ee06a');
      this.audio.levelUp();
    }
  }

  openTalents() {
    if (this.state !== 'playing') return;
    this.state = 'talent';
    this.mouse.down = false;
    this.hud.talentOpen(true);
    this.hud.renderTalents(this);
    this.audio.uiClick();
  }

  closeTalents() {
    if (this.state !== 'talent') return;
    this.state = 'playing';
    this.hud.talentOpen(false);
    this.audio.uiClick();
  }

  buyTalent(id) {
    const t = TALENTS.find((x) => x.id === id);
    if (!t) return;
    const ranks = this.talents[id] || 0;
    const next = talentNext(id, ranks);
    if (!next) { this.hud.toast('该天赋已满级'); return; }
    if (t.req && !(this.talents[t.req] > 0)) { this.hud.toast('需先点亮前置天赋'); return; }
    if (this.points < next.cost) { this.hud.toast('天赋点不足 · 升级可获得'); return; }
    this.points -= next.cost;
    this.talents[id] = next.rank;
    this.recomputeLoadout();
    if (t.skill) {
      const sk = SKILLS.find((s) => s.id === t.skill);
      this.hud.toast(`解锁主动技能「${sk.label}」· 按 ${sk.key} 释放`);
      this.audio.levelUp();
    } else {
      this.hud.toast(`${t.name} 提升至 ${next.rank} 级`);
      this.audio.pickup();
    }
    this.hud.renderTalents(this);
  }

  castSkill(n) {
    if (this.state !== 'playing') return;
    const sk = SKILLS.find((s) => s.key === n);
    if (!sk) return;
    if (!this.loadout.skills[sk.id]) { this.hud.toast(`「${sk.label}」尚未解锁 · T 键点天赋`); return; }
    if (this.skillCd[sk.id] > 0) { this.hud.toast(`「${sk.label}」冷却中 ${this.skillCd[sk.id].toFixed(1)}s`); return; }
    this.skillCd[sk.id] = sk.cd;
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
          e.hp -= damage;
          const away = e.pos.clone().sub(p.pos).setY(0).normalize();
          e.vel.addScaledVector(away, knock);
          this.fx.feathers(e.pos, PALETTES[ENEMY_TYPES[e.type].palette].body, 8, 3);
          this.fx.number(e.pos, String(Math.round(damage)), '#ff8060');
          if (e.hp <= 0) this.killEnemy(e);
        }
      }
      this.hud.toast('嘎嘎乱杀！寸草不生');
    } else if (sk.id === 'shield') {
      p.shield = lo.shield.pool;
      p.shieldT = lo.shield.duration;
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
    const duck = new Duck('player', 1, this.loadout.gun.model);
    duck.group.position.copy(old.group.position);
    duck.yaw = old.yaw;
    duck.setGear(this.gear);
    this.engine.scene.remove(old.group);
    this.engine.scene.add(duck.group);
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
      this.hud.crosshair(0, 0, 0, false);
      return;
    }
    if (this.state === 'paused' || this.state === 'shop' || this.state === 'talent') return;

    if (this.state === 'playing') {
      this.time += dt;
      this.updatePlayer(dt);
      this.updateWaves(dt);
      this.updateEnemies(dt);
      this.updateBullets(dt);
      this.updatePickups(dt);
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
    this.hud.ammo(p.mag, p.reserve, p.reloadT, this.loadout.reloadTime);
    this.hud.stats(Math.max(1, this.wave), this.kills, this.score, this.time);
    this.hud.remain(this.spawnQueue.length + this.enemies.reduce((a, e) => a + (e.dead ? 0 : 1), 0));
    this.hud.coins(this.coins);
    this.hud.setWeapon(this.loadout.gun.label, this.gunId);
    this.hud.growth(this.level, this.xp, xpForLevel(this.level), this.points);
    this.hud.skills(this.loadout.skills, this.skillCd, { rage: p.rageT, shield: p.shieldT, slow: this.slowT });
    this.hud.shield(p.shield, this.loadout.shield.pool, p.shieldT);
    const spread = this.spreadNow();
    this.hud.crosshair(this.mouse.x, this.mouse.y, 7 + spread * 520, this.state === 'playing');
    this.hud.fps(this.engine.fps, this.showFps);
  }

  spreadNow() {
    const p = this.p;
    return (this.loadout.gun.spreadBase + (p.moving ? WEAPON.spreadMove : 0) + p.heat * WEAPON.spreadHeat) * this.loadout.spreadMul;
  }

  /* ---------------- 玩家 ---------------- */

  updatePlayer(dt) {
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
    p.rageT = Math.max(0, p.rageT - dt);
    if (p.shieldT > 0) { p.shieldT = Math.max(0, p.shieldT - dt); if (p.shieldT <= 0) p.shield = 0; }
    if (this.slowT > 0) { this.slowT = Math.max(0, this.slowT - dt); if (this.slowT <= 0) this.slowFactor = 1; }
    if (k.has('Space') && p.dashCd <= 0) {
      p.dashDir.copy(dir.lengthSq() > 0 ? dir : new THREE.Vector3(Math.sin(p.aimYaw), 0, Math.cos(p.aimYaw)));
      p.dashT = 0.22; p.dashCd = 1.1 * (this.loadout.dashCdMul ?? 1); p.iframes = 0.34;
      this.audio.dash();
      this.fx.ring(p.pos.clone().setY(0.3), 0xb7f0ff, 1.6);
      this.fx.smoke(p.pos.clone().setY(0.2), 4, 0xcbb896, 0.4, 1.4, 0.5);
      k.delete('Space');
    }

    const sm = this.loadout.speedMul;
    const target = p.dashT > 0 ? p.dashDir.clone().multiplyScalar(13.5 * sm) : dir.clone().multiplyScalar(6.2 * sm);
    p.vel.lerp(target, 1 - Math.exp(-dt * (p.dashT > 0 ? 30 : 11)));
    p.pos.addScaledVector(p.vel, dt);
    p.pos.x = Math.max(-ARENA, Math.min(ARENA, p.pos.x));
    p.pos.z = Math.max(-ARENA, Math.min(ARENA, p.pos.z));
    resolveColliders(p.pos, 0.45, this.world.colliders);
    p.pos.y = 0;
    p.moving = p.vel.length() > 0.6;

    // 瞄准（手柄右摇杆优先）
    if (this.padAim) {
      this.aimPoint.set(p.pos.x + this.padAim.x * 10, 0.7, p.pos.z + this.padAim.z * 10);
    } else {
      const ndc = new THREE.Vector2(
        (this.mouse.x / innerWidth) * 2 - 1, -(this.mouse.y / innerHeight) * 2 + 1);
      this.ray.setFromCamera(ndc, this.engine.camera);
      const hit = this.ray.ray.intersectPlane(this.plane, this.aimPoint);
      if (!hit) this.aimPoint.set(p.pos.x, 0, p.pos.z - 12);
    }
    p.aimYaw = Math.atan2(this.aimPoint.x - p.pos.x, this.aimPoint.z - p.pos.z);

    // 射击 / 换弹
    p.fireT = Math.max(0, p.fireT - dt);
    p.heat = Math.max(0, p.heat - dt * 1.1);
    if (p.reloadT > 0) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) {
        const need = this.loadout.magSize - p.mag;
        const take = Math.min(need, p.reserve);
        p.mag += take; p.reserve -= take;
      }
    } else if (this.mouse.down && p.fireT <= 0) {
      if (p.mag > 0) this.fire();
      else { this.audio.emptyClick(); this.startReload(); }
    }
    if (k.has('KeyR')) { this.startReload(); k.delete('KeyR'); }

    // 缓慢自愈
    if (this.time - p.lastHurt > 6 && p.hp > 0) p.hp = Math.min(p.maxHp, p.hp + 4 * dt);

    this.playerDuck.group.position.copy(p.pos);
    this.playerDuck.update(dt, {
      moving: p.moving, speed: p.vel.length(), aimYaw: p.aimYaw,
      dash: p.dashT > 0 ? 1 : 0,
      reload: p.reloadT > 0 ? 1 - p.reloadT / this.loadout.reloadTime : 0,
    });

    const ratio = Math.max(0, p.hp / p.maxHp);
    this.playerHpBar.group.visible = true;
    this.playerHpBar.group.position.set(p.pos.x, p.pos.y + 1.9, p.pos.z);
    this.playerHpBar.fill.scale.x = 1.42 * ratio;
    this.playerHpBar.fill.position.x = -(1.42 * (1 - ratio)) / 2;
    const rl = this.playerHpBar.reload;
    if (p.reloadT > 0) {
      const prog = Math.min(1, Math.max(0, 1 - p.reloadT / this.loadout.reloadTime));
      rl.group.visible = true;
      rl.fill.scale.x = Math.max(0.001, 1.42 * prog);
      rl.fill.position.x = -(1.42 * (1 - prog)) / 2;
    } else {
      rl.group.visible = false;
    }
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
    if (p.mag === 0) k.add('KeyR');
  }

  startReload() {
    const p = this.p;
    if (p.reloadT > 0 || p.mag >= this.loadout.magSize || p.reserve <= 0) return;
    p.reloadT = this.loadout.reloadTime;
    this.audio.reload();
  }

  fire() {
    const p = this.p;
    const lo = this.loadout;
    const raging = p.rageT > 0;
    p.mag--;
    p.fireT = 60 / (lo.rpm * (raging ? lo.rage.rpmMul : 1));
    p.heat = Math.min(1, p.heat + 0.11);
    this.shots += lo.pellets;
    const origin = this.playerDuck.muzzleWorld(new THREE.Vector3());
    const base = this.aimPoint.clone().sub(origin).normalize();
    const spread = this.spreadNow();
    const up = new THREE.Vector3(0, 1, 0);
    const dmg = lo.damage * (raging ? lo.rage.dmgMul : 1);
    for (let i = 0; i < lo.pellets; i++) {
      const d = base.clone();
      d.applyAxisAngle(up, (Math.random() - 0.5) * (spread * 2 + (lo.pellets > 1 ? (lo.gun.pelletSpread ?? 0.14) : 0)));
      d.y += (Math.random() - 0.5) * spread;
      d.normalize();
      const b = { pos: origin.clone(), vel: d.multiplyScalar(lo.bulletSpeed), life: 1.1, traveled: 0, dmg };
      b.vis = this.makeBulletVis(raging ? 0xffb040 : 0xffd080, 1.6);
      b.vis.position.copy(b.pos);
      b.vis.lookAt(b.pos.clone().add(b.vel));
      this.bullets.push(b);
    }
    this.fx.flash(origin, 0.22);
    this.fx.casing(origin, base);
    this.fx.smoke(origin, 1, 0x8a8078, 0.22, 1.6, 0.45);
    this.playerDuck.kick();
    this.engine.addShake(lo.pellets > 1 ? 0.16 : 0.09);
    this.audio.shoot();
  }

  damagePlayer(dmg) {
    const p = this.p;
    if (p.iframes > 0 || this.state !== 'playing') return;
    p.lastHurt = this.time;
    let amount = dmg * this.loadout.dmgMul;
    if (p.shieldT > 0 && p.shield > 0) {
      const absorbed = Math.min(p.shield, amount);
      p.shield -= absorbed; amount -= absorbed;
      this.fx.ring(p.pos.clone().setY(0.6), 0x7ee06a, 1.3);
      this.audio.hit();
      if (p.shield <= 0) { p.shieldT = 0; this.hud.toast('蹲防被破！快溜'); }
      if (amount <= 0) return;
    }
    p.hp -= amount;
    this.audio.hurt();
    this.hud.damage();
    this.engine.damageFlash = 1;
    this.engine.addShake(0.32);
    this.fx.feathers(p.pos, 0xffd95e, 6, 2.2);
    if (p.hp <= 0) {
      p.hp = 0;
      this.state = 'over';
      this.playerDuck.die();
      this.playerHpBar.group.visible = false;
      this.fx.feathers(p.pos, 0xffd95e, 26, 4);
      this.fx.ring(p.pos.clone().setY(0.5), 0xff8060, 3);
      this.audio.gameOver();
      this.audio.stopMusic();
      const isRecord = !this.best || this.score > this.best.score;
      if (isRecord) {
        this.best = { score: this.score, wave: this.wave, kills: this.kills };
        try { localStorage.setItem('swyy_best', JSON.stringify(this.best)); } catch { /* 存储不可用时忽略 */ }
      }
      this.hud.results({
        wave: this.wave, kills: this.kills, score: this.score,
        acc: this.shots ? this.hits / this.shots : 0,
        time: this.time, coins: this.coinsEarned,
        best: this.best.score, isRecord,
      });
      setTimeout(() => { if (this.state === 'over') this.hud.screen('over'); }, 1100);
    }
  }

  /* ---------------- 波次 ---------------- */

  updateWaves(dt) {
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
      this.addXp(WAVE_CLEAR_XP);
      this.hud.toast(`第 ${this.wave} 波肃清！奖励 +${bonus}`);
      this.audio.waveClear();
      this.waveState = 'inter';
      this.interT = 4;
    }
  }

  nextWave() {
    this.wave++;
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
    this.hud.banner(this.wave, waveIntro(this.wave));
    this.audio.waveHorn();
  }

  spawnEnemy(entry) {
    const type = typeof entry === 'string' ? entry : entry.type;
    const elite = typeof entry === 'object' && !!entry.elite;
    const t = ENEMY_TYPES[type];
    const gate = GATES[Math.floor(this.rng() * GATES.length)];
    const tangent = new THREE.Vector3(-gate.z, 0, gate.x).normalize();
    const pos = new THREE.Vector3(gate.x, 0, gate.z).addScaledVector(tangent, (this.rng() - 0.5) * 5);
    pos.y = groundHeight(pos.x, pos.z);
    const scale = t.scale * (elite ? ELITE.scale : 1);
    const duck = new Duck(t.palette, scale, t.weapon, { boss: !!t.boss, elite });
    duck.group.position.copy(pos);
    this.engine.scene.add(duck.group);
    const hpScale = t.boss ? this.plan.bossScale : this.plan.hpScale * (elite ? eliteHpMul(this.wave) : 1);
    const e = {
      type, elite, duck, pos, vel: new THREE.Vector3(),
      scale,
      radius: t.radius * (elite ? ELITE.scale : 1),
      reach: (t.reach || 0) * (elite ? ELITE.reachMul : 1),
      damage: t.damage * (elite ? ELITE.dmgMul : 1),
      speed: t.speed * (elite ? ELITE.speedMul : 1),
      hp: t.hp * hpScale, maxHp: t.hp * hpScale,
      fireT: 1 + this.rng() * 1.5, windup: 0, attackT: 0.6 + this.rng() * 0.8,
      skillKind: t.boss ? 'nova' : elite ? 'stomp' : null,
      skillCd: 2.5 + this.rng() * 2, skillT: 0,
      seed: this.rng() * 10, dead: false,
    };
    e.hpBar = this.makeHpBar(elite ? 0xffb030 : 0xff5346);
    this.enemies.push(e);
    this.fx.smoke(pos.clone().setY(pos.y + 0.3), 3, 0x6a5a4a, 0.5, 1.5, 0.7);
    this.warnGate(pos);
    if (elite) this.hud.toast(`精英${t.label}来袭！三倍赏金`);
  }

  makeBulletVis(tailColor, tailLen) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(this._bulletGeo, this._bulletMat));
    const tail = new THREE.Mesh(this._tailGeo, new THREE.MeshBasicMaterial({
      color: tailColor, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    tail.scale.z = tailLen;
    tail.position.z = -tailLen / 2 - 0.1;
    g.add(tail);
    this.engine.scene.add(g);
    return g;
  }

  makeHpBar(color = 0xff5346) {
    const group = new THREE.Group();
    const bg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x1a1208, transparent: true, opacity: 0.75, depthWrite: false }));
    bg.scale.set(1.5, 0.16, 1);
    const fill = new THREE.Sprite(new THREE.SpriteMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false }));
    fill.scale.set(1.42, 0.1, 1);
    group.add(bg, fill);
    group.visible = false;
    this.engine.scene.add(group);
    return { group, fill };
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

  pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && pads[0];
    if (!gp) { this.padAim = null; return; }
    const prev = this.padPrev;
    const btn = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const edge = (i) => btn(i) && !prev[i];
    const dead = (v) => (Math.abs(v) > 0.22 ? v : 0);
    const lx = dead(gp.axes[0] || 0), ly = dead(gp.axes[1] || 0);
    const rx = dead(gp.axes[2] || 0), ry = dead(gp.axes[3] || 0);

    if (this.state === 'title' || this.state === 'over') {
      if (edge(0)) { this.audio.init(); this.start(); }
    } else if (this.state === 'playing') {
      const k = this.keys;
      for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) k.delete(c);
      if (lx > 0.35) k.add('KeyD'); else if (lx < -0.35) k.add('KeyA');
      if (ly > 0.35) k.add('KeyS'); else if (ly < -0.35) k.add('KeyW');
      this.padAim = (rx || ry) ? { x: rx, z: ry } : null;
      this.mouse.down = btn(7) || btn(6);
      if (edge(0)) k.add('Space');
      if (edge(2)) k.add('KeyR');
      if (edge(1)) this.openShop();
      if (edge(3)) this.openTalents();
      if (edge(9)) this.pause();
      if (edge(4)) this.cycleGun(-1);
      if (edge(5)) this.cycleGun(1);
    } else if (this.state === 'shop') {
      if (edge(1) || edge(9)) this.closeShop();
    } else if (this.state === 'talent') {
      if (edge(3) || edge(1) || edge(9)) this.closeTalents();
    } else if (this.state === 'paused') {
      if (edge(9) || edge(0)) this.resume();
    }
    this.padPrev = gp.buttons.map((b) => b.pressed);
  }

  /* ---------------- 敌人 ---------------- */

  updateEnemies(dt) {
    const p = this.p;
    const cam = this.engine.camera;
    const frustum = this._frustum.setFromProjectionMatrix(
      this._projMat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const visPoint = new THREE.Vector3();
    for (const e of this.enemies) {
      if (e.dead) { e.duck.update(dt, { moving: false }); continue; }
      const t = ENEMY_TYPES[e.type];
      const to = p.pos.clone().sub(e.pos); to.y = 0;
      const dist = to.length();
      const dirN = to.clone().normalize();
      let want = new THREE.Vector3();
      const speed = e.speed * this.plan.speedScale * (this.slowT > 0 ? this.slowFactor : 1);

      if (e.skillKind) {
        e.skillCd = Math.max(0, e.skillCd - dt);
        if (e.skillT > 0) {
          e.skillT -= dt;
          if (e.skillT <= 0) this.castEnemySkill(e);
        } else if (e.skillCd <= 0 && (e.skillKind === 'nova' || dist < ELITE_SKILL.range)) {
          const sk = e.skillKind === 'nova' ? BOSS_SKILL : ELITE_SKILL;
          e.skillT = sk.windup; e.skillCd = sk.cd;
          this.fx.zone(e.pos.clone(), sk.radius, e.skillKind === 'nova' ? 0xff4646 : 0xffa040, sk.windup);
          this.audio.skillCast();
          this.hud.toast(e.skillKind === 'nova' ? '鸭王蓄力全图冲击波！看准时机冲刺闪避' : '精英蓄力战争践踏！快出圈');
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
            if (dist < e.reach + 0.35) {
              this.damagePlayer(e.damage);
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
        if (e.hpBar) this.engine.scene.remove(e.hpBar.group);
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

  killEnemy(e) {
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
    this.hud.feed([{ text: (e.elite ? '精英·' : '') + ENEMY_TYPES[e.type].label, em: true }, { text: ' 被击倒 ' }, { text: `+${sc}`, em: true }]);
    const c = coinsFor(e.type, e.elite);
    this.coins += c; this.coinsEarned += c;
    this.fx.number(e.pos.clone().setY(e.pos.y + 1.3), `+${c} 金币`, '#ffd95e');
    this.addXp(xpForKill(e.type, e.elite));
    if (this.loadout.killHeal > 0 && this.p.hp > 0) {
      this.p.hp = Math.min(this.p.maxHp, this.p.hp + this.loadout.killHeal);
      this.fx.number(this.p.pos.clone().setY(this.p.pos.y + 1.2), `+${this.loadout.killHeal}`, '#7ee06a');
    }
    const isBoss = !!ENEMY_TYPES[e.type].boss;
    for (let r = 0; r < (isBoss ? 4 : e.elite ? 2 : 1); r++) {
      for (const id of rollLoot(this.rng)) {
        const off = new THREE.Vector3((this.rng() - 0.5) * 1.6, 0, (this.rng() - 0.5) * 1.6);
        this.spawnPickup(e.pos.clone().add(off), 'loot', id);
      }
    }
    if (isBoss) {
      this.hud.toast('鸭王被击败！缴获大量鸭杂');
      this.audio.waveClear();
      this.fx.ring(e.pos.clone().setY(e.pos.y + 1), 0xffd24a, 4);
    }
    const drop = rollDrop(this.rng, e.type, this.p.mag + this.p.reserve < 30, e.elite);
    if (drop) this.spawnPickup(e.pos, drop);
  }

  /* ---------------- 子弹 ---------------- */

  updateBullets(dt) {
    const p = this.p;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.life -= dt;
      let gone = b.life <= 0;
      if (!gone) {
        const step = b.vel.clone().multiplyScalar(dt);
        const n = Math.min(12, Math.max(1, Math.ceil(step.length() / 0.3)));
        step.divideScalar(n);
        for (let s = 0; s < n && !gone; s++) {
          b.pos.add(step);
          b.traveled += step.length();
          for (const e of this.enemies) {
            if (e.dead) continue;
            const r = e.radius + 0.22;
            if (Math.hypot(b.pos.x - e.pos.x, b.pos.z - e.pos.z) < r && b.pos.y < 1.7 * e.scale) {
              const dmg = damageAtDistance(b.dmg, b.traveled, this.loadout.gun);
              e.hp -= dmg;
              this.hits++;
              this.fx.spark(b.pos, b.vel.clone().normalize().multiplyScalar(-0.4), 7, 0xffd080, 6);
              this.fx.feathers(b.pos, PALETTES[ENEMY_TYPES[e.type].palette].body, 4, 2);
              this.fx.number(e.pos, String(Math.round(dmg)), '#ffe28a');
              this.audio.hit();
              this.hud.hitmarker(false);
              e.duck.kick();
              if (e.hp <= 0) this.killEnemy(e);
              gone = true;
              break;
            }
          }
          if (!gone && b.pos.y < 1.8 && pointBlocked(b.pos.x, b.pos.z, this.world.colliders)) {
            this.fx.spark(b.pos, b.vel.clone().normalize().multiplyScalar(-0.5), 6, 0xffc060, 5);
            this.fx.smoke(b.pos, 1, 0x8a8078, 0.25, 1.4, 0.4);
            gone = true;
          }
          if (!gone && b.pos.y <= groundHeight(b.pos.x, b.pos.z) + 0.04) {
            this.fx.smoke(b.pos, 2, 0xa08a68, 0.3, 1.5, 0.5);
            this.fx.spark(b.pos, new THREE.Vector3(0, 1, 0), 4, 0xc8b080, 3);
            this.fx.decal(b.pos, 0.28);
            gone = true;
          }
        }
      }
      if (gone) {
        if (b.vis) this.engine.scene.remove(b.vis);
        this.bullets.splice(i, 1);
      } else if (b.vis) {
        b.vis.position.copy(b.pos);
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
            this.fx.spark(b.pos, b.vel.clone().normalize().multiplyScalar(-0.4), 5, 0xff8060, 4);
            gone = true;
          }
          if (!gone && b.pos.y < 1.8 && pointBlocked(b.pos.x, b.pos.z, this.world.colliders)) {
            this.fx.spark(b.pos, b.vel.clone().normalize().multiplyScalar(-0.5), 4, 0xffa060, 4);
            gone = true;
          }
          if (!gone && b.pos.y <= groundHeight(b.pos.x, b.pos.z) + 0.04) {
            this.fx.smoke(b.pos, 1, 0xa08a68, 0.22, 1.4, 0.4);
            gone = true;
          }
        }
      }
      if (gone) {
        if (b.spr) this.engine.scene.remove(b.spr);
        this.ebullets.splice(i, 1);
      } else {
        if (!b.spr) {
          b.spr = this.makeBulletVis(0xff7040, 0.7);
          b.spr.lookAt(b.pos.clone().add(b.vel));
        }
        b.spr.position.copy(b.pos);
      }
    }
  }

  /* ---------------- 拾取 ---------------- */

  spawnPickup(pos, kind, item) {
    const g = new THREE.Group();
    let glowColor = 0xff8070;
    if (kind === 'ammo') {
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.3, 0.32),
        new THREE.MeshStandardMaterial({ color: 0x6a5a3a, roughness: 0.8 }));
      box.castShadow = true;
      g.add(box);
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.1, 0.34),
        new THREE.MeshStandardMaterial({ color: 0x3a3010, emissive: 0xffd95e, emissiveIntensity: 1.6 }));
      g.add(band);
      glowColor = 0xffd95e;
    } else if (kind === 'loot') {
      const it = LOOT_BY_ID[item];
      const bundle = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10),
        new THREE.MeshStandardMaterial({ color: it.color, roughness: 0.7 }));
      bundle.scale.set(1.2, 0.85, 1);
      bundle.castShadow = true;
      g.add(bundle);
      const knot = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0xf0e6d0, roughness: 0.9 }));
      knot.position.y = 0.14;
      g.add(knot);
      glowColor = it.color;
    } else {
      const bread = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10),
        new THREE.MeshStandardMaterial({ color: 0xe8b464, roughness: 0.75 }));
      bread.scale.set(1.3, 0.8, 0.9);
      bread.castShadow = true;
      g.add(bread);
      const cross1 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.06),
        new THREE.MeshStandardMaterial({ color: 0xd03028, emissive: 0xd03028, emissiveIntensity: 0.8 }));
      cross1.position.y = 0.18;
      const cross2 = cross1.clone();
      cross2.rotation.y = Math.PI / 2;
      g.add(cross1, cross2);
    }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowSprite(), color: glowColor,
      transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.set(1.3, 1.3, 1);
    g.add(glow);
    g.position.copy(pos).setY(pos.y + 0.35);
    this.engine.scene.add(g);
    this.pickups.push({ mesh: g, kind, item, t: 0, life: kind === 'loot' ? 26 : 22 });
  }

  updatePickups(dt) {
    const p = this.p;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pk = this.pickups[i];
      pk.t += dt; pk.life -= dt;
      pk.mesh.rotation.y += dt * 1.6;
      pk.mesh.position.y = groundHeight(pk.mesh.position.x, pk.mesh.position.z) + 0.35 + Math.sin(pk.t * 2.4) * 0.08;
      pk.mesh.visible = pk.life > 3 || Math.sin(pk.t * 12) > -0.3;
      let gone = pk.life <= 0;
      if (!gone && Math.hypot(pk.mesh.position.x - p.pos.x, pk.mesh.position.z - p.pos.z) < 1.1) {
        if (pk.kind === 'ammo') {
          p.reserve += 48;
          this.hud.toast('拾取弹药箱 +48');
        } else if (pk.kind === 'loot') {
          const it = LOOT_BY_ID[pk.item];
          this.inv[pk.item] = (this.inv[pk.item] || 0) + 1;
          this.hud.toast(`拾取 ${it.label} ×1 · B 键商店出售`);
          this.fx.number(pk.mesh.position.clone().setY(pk.mesh.position.y + 0.4), it.label, '#ffe28a');
        } else {
          p.hp = Math.min(p.maxHp, p.hp + 35);
          this.hud.toast('拾取面包 +35 生命');
        }
        this.audio.pickup();
        this.fx.ring(pk.mesh.position, pk.kind === 'ammo' ? 0xffd95e : pk.kind === 'loot' ? LOOT_BY_ID[pk.item].color : 0xff9080, 1.6);
        gone = true;
      }
      if (gone) {
        this.engine.scene.remove(pk.mesh);
        this.pickups.splice(i, 1);
      }
    }
  }
}