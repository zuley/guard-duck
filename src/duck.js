import * as THREE from 'three';

export const PALETTES = {
  player: { body: 0xffd95e, wing: 0xf2c53a, beak: 0xf08c1e, feet: 0xf08c1e, brow: 0x20180a, eye: 0x20180a, rim: 0xffb45e },
  grunt: { body: 0x9aa0a8, wing: 0x848a92, beak: 0xd07828, feet: 0xd07828, brow: 0x141414, eye: 0xff4030, rim: 0x8fb0ff, accessory: 'bandana' },
  runner: { body: 0x86a84a, wing: 0x74943e, beak: 0xe09030, feet: 0xe09030, brow: 0x141414, eye: 0xff5020, rim: 0xa0ff80, accessory: 'headband' },
  tank: { body: 0xa8763e, wing: 0x96662e, beak: 0xc07020, feet: 0xc07020, brow: 0x141414, eye: 0xff3020, rim: 0xffa060, accessory: 'helmet' },
};

// 几何体 / 材质全局缓存：同参数的部件跨鸭子共享，避免刷怪 / 切枪 / 重开时
// GPU 资源只增不减（无尽波次下显存持续上涨）。共享资源不随单只鸭子销毁。
const geoCache = new Map();
function geo(Ctor, ...args) {
  const key = Ctor.name + ':' + args.join(',');
  let g = geoCache.get(key);
  if (!g) { g = new Ctor(...args); geoCache.set(key, g); }
  return g;
}
const matCache = new Map();
function stdMat(params) {
  const key = JSON.stringify(params);
  let m = matCache.get(key);
  if (!m) { m = new THREE.MeshStandardMaterial(params); matCache.set(key, m); }
  return m;
}
const rimCache = new Map();
function duckMaterial(color, rim) {
  const key = color + ':' + rim;
  let m = rimCache.get(key);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRim = { value: new THREE.Color(rim) };
    sh.fragmentShader = 'uniform vec3 uRim;\n' + sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       float rimF = pow(1.0 - saturate(dot(normalize(vNormal), normalize(vViewPosition))), 2.6);
       totalEmissiveRadiance += uRim * rimF * 0.32;`);
  };
  rimCache.set(key, m);
  return m;
}
const glintMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

const lerpAngle = (a, b, t) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

export class Duck {
  constructor(palette = 'player', scale = 1, weapon = null, opts = {}) {
    const p = PALETTES[palette];
    this.palette = palette;
    this.weapon = weapon || (palette === 'tank' ? 'shotgun' : palette === 'runner' ? 'fists' : 'rifle');
    this.group = new THREE.Group();
    this.root = new THREE.Group();
    this.group.add(this.root);
    this.group.scale.setScalar(scale);

    const bodyMat = duckMaterial(p.body, p.rim);
    const wingMat = duckMaterial(p.wing, p.rim);
    const beakMat = duckMaterial(p.beak, p.rim);
    const darkMat = stdMat({ color: p.brow, roughness: 0.5 });
    const eyeMat = stdMat({
      color: p.eye, roughness: 0.25,
      emissive: palette === 'player' ? 0x000000 : p.eye, emissiveIntensity: 0.7,
    });

    this.body = new THREE.Group();
    this.body.position.y = 0.42;
    this.root.add(this.body);
    const torso = new THREE.Mesh(geo(THREE.SphereGeometry,0.42, 24, 18), bodyMat);
    torso.scale.set(1, 0.92, 1.12);
    torso.castShadow = true;
    this.body.add(torso);
    const tail = new THREE.Mesh(geo(THREE.SphereGeometry,0.16, 12, 10), bodyMat);
    tail.scale.set(0.8, 0.7, 1.2);
    tail.position.set(0, 0.14, -0.44);
    tail.rotation.x = -0.5;
    tail.castShadow = true;
    this.body.add(tail);

    this.wings = [];
    for (const side of [-1, 1]) {
      const w = new THREE.Group();
      w.position.set(side * 0.38, 0.06, 0.02);
      const wm = new THREE.Mesh(geo(THREE.SphereGeometry,0.2, 14, 12), wingMat);
      wm.scale.set(0.45, 0.85, 1.05);
      wm.position.set(side * 0.06, -0.06, 0);
      wm.castShadow = true;
      w.add(wm);
      this.body.add(w);
      this.wings.push(w);
    }

    this.head = new THREE.Group();
    this.head.position.set(0, 0.86, 0.1);
    this.root.add(this.head);
    const skull = new THREE.Mesh(geo(THREE.SphereGeometry,0.34, 24, 18), bodyMat);
    skull.scale.set(1, 0.95, 1);
    skull.castShadow = true;
    this.head.add(skull);
    const tuftPos = [[-0.11, 0.3, 0, 0.085], [0.01, 0.35, 0, 0.1], [0.12, 0.29, 0, 0.075]];
    for (const [x, y, z, r] of tuftPos) {
      const t = new THREE.Mesh(geo(THREE.SphereGeometry,r, 10, 8), bodyMat);
      t.position.set(x, y, z);
      t.castShadow = true;
      this.head.add(t);
    }
    this.eyes = [];
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(geo(THREE.SphereGeometry,0.048, 10, 8), eyeMat);
      eye.position.set(side * 0.13, 0.05, 0.3);
      this.head.add(eye);
      this.eyes.push(eye);
      const glint = new THREE.Mesh(geo(THREE.SphereGeometry,0.015, 6, 5), glintMat);
      glint.position.set(side * 0.13 + 0.016, 0.068, 0.34);
      this.head.add(glint);
      const brow = new THREE.Mesh(geo(THREE.BoxGeometry,0.17, 0.05, 0.05), darkMat);
      brow.position.set(side * 0.13, 0.165, 0.31);
      brow.rotation.z = side * 0.38;
      this.head.add(brow);
    }
    const beak = new THREE.Mesh(geo(THREE.SphereGeometry,0.16, 16, 12), beakMat);
    beak.scale.set(1.25, 0.62, 1.0);
    beak.position.set(0, -0.07, 0.33);
    beak.castShadow = true;
    this.head.add(beak);
    const beakTop = new THREE.Mesh(geo(THREE.SphereGeometry,0.15, 14, 10), duckMaterial(0xffab4a, p.rim));
    beakTop.scale.set(1.05, 0.4, 0.82);
    beakTop.position.set(0, -0.02, 0.35);
    this.head.add(beakTop);
    for (const side of [-1, 1]) {
      const n = new THREE.Mesh(geo(THREE.SphereGeometry,0.014, 6, 5), darkMat);
      n.position.set(side * 0.05, -0.005, 0.475);
      this.head.add(n);
    }

    if (p.accessory === 'bandana') {
      const band = new THREE.Mesh(geo(THREE.SphereGeometry,0.35, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.42),
        stdMat({ color: 0xb03028, roughness: 0.8 }));
      band.position.y = 0.06;
      band.castShadow = true;
      this.head.add(band);
      const knot = new THREE.Mesh(geo(THREE.SphereGeometry,0.07, 8, 6),
        stdMat({ color: 0x8a2018, roughness: 0.8 }));
      knot.position.set(0.3, 0.12, -0.12);
      this.head.add(knot);
    } else if (p.accessory === 'headband') {
      const band = new THREE.Mesh(geo(THREE.TorusGeometry,0.33, 0.045, 8, 20),
        stdMat({ color: 0xe8e4d8, roughness: 0.85 }));
      band.rotation.x = Math.PI / 2 - 0.25;
      band.position.y = 0.12;
      this.head.add(band);
    } else if (p.accessory === 'helmet') {
      const helm = new THREE.Mesh(geo(THREE.SphereGeometry,0.37, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.5),
        stdMat({ color: 0x6a6f76, roughness: 0.4, metalness: 0.8 }));
      helm.position.y = 0.08;
      helm.castShadow = true;
      this.head.add(helm);
      const rim = new THREE.Mesh(geo(THREE.TorusGeometry,0.36, 0.03, 6, 20),
        stdMat({ color: 0x565b62, roughness: 0.4, metalness: 0.8 }));
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 0.09;
      this.head.add(rim);
    }

    if (opts.boss) {
      const gold = stdMat({ color: 0xffd24a, roughness: 0.25, metalness: 0.9, emissive: 0x604000, emissiveIntensity: 0.4 });
      const ring = new THREE.Mesh(geo(THREE.TorusGeometry,0.22, 0.05, 8, 20), gold);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.44;
      ring.castShadow = true;
      this.head.add(ring);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const spike = new THREE.Mesh(geo(THREE.ConeGeometry,0.05, 0.18, 6), gold);
        spike.position.set(Math.cos(a) * 0.2, 0.55, Math.sin(a) * 0.2);
        spike.castShadow = true;
        this.head.add(spike);
      }
    }

    if (opts.elite) {
      const red = stdMat({ color: 0xd03028, roughness: 0.6, emissive: 0x501008, emissiveIntensity: 0.5 });
      for (let i = 0; i < 4; i++) {
        const spike = new THREE.Mesh(geo(THREE.ConeGeometry,0.06, 0.3 - i * 0.05, 6), red);
        spike.position.set(0, 0.42, 0.18 - i * 0.12);
        spike.castShadow = true;
        this.head.add(spike);
      }
    }

    this.feet = [];
    for (const side of [-1, 1]) {
      const f = new THREE.Group();
      f.position.set(side * 0.16, 0.07, 0.04);
      const fm = new THREE.Mesh(geo(THREE.SphereGeometry,0.12, 12, 8), beakMat);
      fm.scale.set(0.9, 0.42, 1.4);
      fm.position.z = 0.05;
      fm.castShadow = true;
      f.add(fm);
      for (let t = -1; t <= 1; t++) {
        const toe = new THREE.Mesh(geo(THREE.SphereGeometry,0.045, 8, 6), beakMat);
        toe.scale.set(0.8, 0.4, 1.2);
        toe.position.set(t * 0.07, -0.01, 0.2);
        f.add(toe);
      }
      this.root.add(f);
      this.feet.push(f);
    }

    this.gun = null;
    this.magMesh = null;
    this.muzzle = null;
    this.melee = this.weapon === 'fists' || this.weapon === 'club' || this.weapon === 'knife';
    const gunMetal = stdMat({ color: 0x3a3f46, roughness: 0.42, metalness: 0.8 });
    const gunWood = stdMat({ color: 0x7a4a26, roughness: 0.7 });
    if (this.weapon === 'pistol' || this.weapon === 'rifle' || this.weapon === 'shotgun') {
      this.gun = new THREE.Group();
      if (this.weapon === 'pistol') {
        const receiver = new THREE.Mesh(geo(THREE.BoxGeometry,0.08, 0.11, 0.24), gunMetal);
        receiver.castShadow = true;
        this.gun.add(receiver);
        const barrel = new THREE.Mesh(geo(THREE.CylinderGeometry,0.024, 0.024, 0.14, 10), gunMetal);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, 0.03, 0.18);
        this.gun.add(barrel);
        const grip = new THREE.Mesh(geo(THREE.BoxGeometry,0.07, 0.16, 0.09), gunWood);
        grip.position.set(0, -0.11, -0.08);
        grip.rotation.x = 0.3;
        this.gun.add(grip);
      } else {
        const receiver = new THREE.Mesh(geo(THREE.BoxGeometry,0.09, 0.13, 0.46), gunMetal);
        receiver.castShadow = true;
        this.gun.add(receiver);
        const barrel = new THREE.Mesh(geo(THREE.CylinderGeometry,
          this.weapon === 'shotgun' ? 0.042 : 0.028,
          this.weapon === 'shotgun' ? 0.042 : 0.028, 0.36, 10), gunMetal);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, 0.02, 0.4);
        this.gun.add(barrel);
        const hand = new THREE.Mesh(geo(THREE.BoxGeometry,0.1, 0.09, 0.2), gunWood);
        hand.position.set(0, -0.01, 0.24);
        this.gun.add(hand);
        if (this.weapon === 'shotgun') {
          const pump = new THREE.Mesh(geo(THREE.BoxGeometry,0.11, 0.1, 0.16), gunWood);
          pump.position.set(0, -0.03, 0.32);
          this.gun.add(pump);
        } else {
          const mag = new THREE.Mesh(geo(THREE.BoxGeometry,0.07, 0.18, 0.1), gunMetal);
          mag.position.set(0, -0.14, 0.02);
          mag.rotation.x = 0.18;
          this.gun.add(mag);
          this.magMesh = mag;
          const sight = new THREE.Mesh(geo(THREE.BoxGeometry,0.02, 0.05, 0.02), gunMetal);
          sight.position.set(0, 0.09, 0.3);
          this.gun.add(sight);
        }
        const stock = new THREE.Mesh(geo(THREE.BoxGeometry,0.08, 0.11, 0.2), gunWood);
        stock.position.set(0, -0.02, -0.3);
        this.gun.add(stock);
      }
      const gripF = new THREE.Mesh(geo(THREE.SphereGeometry,0.1, 12, 10), wingMat);
      gripF.scale.set(0.7, 0.9, 1.2);
      gripF.position.set(0, -0.04, this.weapon === 'pistol' ? -0.06 : 0.24);
      this.gun.add(gripF);
      const gripR = new THREE.Mesh(geo(THREE.SphereGeometry,0.09, 12, 10), wingMat);
      gripR.scale.set(0.7, 0.9, 1.1);
      gripR.position.set(0.02, -0.06, -0.1);
      this.gun.add(gripR);
      this.muzzle = new THREE.Object3D();
      this.muzzle.position.set(0, 0.02, this.weapon === 'pistol' ? 0.28 : 0.6);
      this.gun.add(this.muzzle);
      this.gun.position.set(0.3, 0.44, 0.26);
      this.gun.rotation.y = -0.06;
      this.root.add(this.gun);
      this.gunBaseZ = 0.26;
      this.wings[1].children[0].position.set(0.0, -0.1, 0.16);
    } else if (this.weapon === 'club' || this.weapon === 'knife') {
      const w = new THREE.Group();
      if (this.weapon === 'club') {
        const clubWood = stdMat({ color: 0x8a5a2e, roughness: 0.75 });
        const shaft = new THREE.Mesh(geo(THREE.CylinderGeometry,0.035, 0.05, 0.62, 8), clubWood);
        shaft.rotation.x = Math.PI / 2;
        shaft.position.z = 0.32;
        shaft.castShadow = true;
        w.add(shaft);
        const knob = new THREE.Mesh(geo(THREE.SphereGeometry,0.075, 10, 8), clubWood);
        knob.scale.set(1, 1, 1.25);
        knob.position.z = 0.64;
        knob.castShadow = true;
        w.add(knob);
      } else {
        const steel = stdMat({ color: 0xc8ccd4, roughness: 0.25, metalness: 0.9 });
        const grip = new THREE.Mesh(geo(THREE.BoxGeometry,0.035, 0.035, 0.12), gunWood);
        grip.position.z = 0.06;
        w.add(grip);
        const guard = new THREE.Mesh(geo(THREE.BoxGeometry,0.07, 0.02, 0.02), gunMetal);
        guard.position.z = 0.12;
        w.add(guard);
        const blade = new THREE.Mesh(geo(THREE.BoxGeometry,0.016, 0.05, 0.24), steel);
        blade.position.z = 0.25;
        blade.castShadow = true;
        w.add(blade);
        const tip = new THREE.Mesh(geo(THREE.ConeGeometry,0.025, 0.07, 6), steel);
        tip.rotation.x = Math.PI / 2;
        tip.position.z = 0.4;
        w.add(tip);
      }
      w.position.set(0.02, -0.1, 0.14);
      this.wings[1].add(w);
      this.wings[1].children[0].position.set(0, -0.08, 0.1);
    }

    const blob = new THREE.Mesh(
      geo(THREE.CircleGeometry,0.5, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.26, depthWrite: false }));
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.02;
    this.group.add(blob);
    this.blob = blob;

    this.gearMeshes = {};
    if (palette === 'player') {
      const steel = stdMat({ color: 0x6a6f76, roughness: 0.4, metalness: 0.8 });
      const helm = new THREE.Mesh(geo(THREE.SphereGeometry,0.37, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), steel);
      helm.position.y = 0.08;
      helm.castShadow = true;
      helm.visible = false;
      this.head.add(helm);
      const vest = new THREE.Mesh(
        geo(THREE.SphereGeometry,0.45, 20, 14, 0, Math.PI * 2, Math.PI * 0.28, Math.PI * 0.46),
        stdMat({ color: 0x6a7a5a, roughness: 0.6 }));
      vest.scale.set(1, 0.92, 1.12);
      vest.position.y = 0.42;
      vest.castShadow = true;
      vest.visible = false;
      this.root.add(vest);
      const bootMat = stdMat({ color: 0x7a4a26, roughness: 0.7 });
      const gloveMat = stdMat({ color: 0xb03028, roughness: 0.6 });
      const shoes = [];
      for (const f of this.feet) {
        const b = new THREE.Mesh(geo(THREE.BoxGeometry,0.22, 0.14, 0.26), bootMat);
        b.position.set(0, 0.03, -0.02);
        b.castShadow = true;
        b.visible = false;
        f.add(b);
        shoes.push(b);
      }
      const gloves = [];
      this.wings.forEach((w, i) => {
        const side = i === 0 ? -1 : 1;
        const gl = new THREE.Mesh(geo(THREE.SphereGeometry,0.1, 10, 8), gloveMat);
        gl.position.set(side * 0.06, -0.18, 0.16);
        gl.visible = false;
        w.add(gl);
        gloves.push(gl);
      });
      this.gearMeshes = { helmet: [helm], armor: [vest], shoes, gloves };
    }

    this.walkPhase = 0;
    this.blinkT = 1 + Math.random() * 3;
    this.recoil = 0;
    this.reload = 0;
    this.deathT = -1;
    this.yaw = 0;
    this.t = Math.random() * 10;
  }

  kick() { this.recoil = 1; }

  setGear(g = {}) {
    for (const [key, meshes] of Object.entries(this.gearMeshes)) {
      for (const m of meshes) m.visible = !!g[key];
    }
  }

  die() { this.deathT = 0; }

  // 几何体与常规材质为全局共享缓存，不随单只鸭子销毁；
  // blob 阴影材质每只鸭独立（死亡动画单独调透明度），移除时释放。
  dispose() {
    if (this.blob) this.blob.material.dispose();
  }

  update(dt, st = {}) {
    this.t += dt;
    const moving = st.moving || false;
    const speed = st.speed || 0;
    if (st.aimYaw !== undefined) {
      this.yaw = lerpAngle(this.yaw, st.aimYaw, 1 - Math.exp(-dt * 14));
      this.root.rotation.y = this.yaw;
    }
    this.recoil = Math.max(0, this.recoil - dt * 7);
    this.reload = st.reload || 0;
    const rl = this.reload > 0 ? Math.sin(Math.PI * Math.min(1, this.reload)) : 0;

    if (this.deathT >= 0) {
      this.deathT += dt;
      const k = Math.min(1, this.deathT * 2.6);
      this.root.rotation.x = -k * k * Math.PI / 2;
      this.root.position.y = -k * 0.12;
      const s = Math.max(0.001, 1 - Math.max(0, this.deathT - 0.9) * 1.6);
      this.root.scale.setScalar(s);
      this.blob.material.opacity = 0.26 * s;
      return;
    }

    this.walkPhase += dt * (moving ? 4.5 + speed * 2.2 : 0);
    const ph = this.walkPhase;
    const m = moving ? 1 : 0;
    const bob = Math.abs(Math.sin(ph)) * 0.055 * m;
    this.body.position.y = 0.42 + bob + Math.sin(this.t * 2.2) * 0.012;
    this.body.rotation.z = Math.sin(ph) * 0.07 * m;
    this.body.rotation.x = m * 0.07 - this.recoil * 0.06;
    this.head.position.y = 0.86 + bob * 1.25 + Math.sin(this.t * 2.2) * 0.012;
    this.head.rotation.z = -Math.sin(ph) * 0.05 * m;
    this.head.rotation.x = -this.recoil * 0.1 + (st.aimPitch || 0) + rl * 0.3;

    this.feet[0].rotation.x = Math.sin(ph) * 0.75 * m;
    this.feet[1].rotation.x = -Math.sin(ph) * 0.75 * m;
    this.feet[0].position.y = 0.07 + Math.max(0, Math.sin(ph)) * 0.09 * m;
    this.feet[1].position.y = 0.07 + Math.max(0, -Math.sin(ph)) * 0.09 * m;

    const flap = Math.sin(this.t * 2.4) * 0.06;
    this.wings[0].rotation.z = 0.12 + flap + Math.sin(ph) * 0.22 * m;
    this.wings[1].rotation.z = -0.12 - flap - Math.sin(ph) * 0.22 * m;
    if (this.gun) {
      this.wings[1].rotation.z = -0.3;
      this.wings[1].rotation.x = -0.85;
      this.gun.position.z = this.gunBaseZ - this.recoil * 0.1;
      this.gun.rotation.x = -this.recoil * 0.12 + rl * 0.55;
      this.wings[0].rotation.x = -rl * 1.1;
      if (this.magMesh) {
        const drop = this.reload < 0.5 ? this.reload * 2 : (1 - this.reload) * 2;
        this.magMesh.position.y = -0.14 - drop * 0.38;
        this.magMesh.visible = !(this.reload > 0.42 && this.reload < 0.58);
      }
    } else if (this.melee) {
      const w = st.windup || 0;
      this.wings[1].rotation.z = -0.25;
      this.wings[1].rotation.x = -0.5 - w * 1.5 + this.recoil * 2.0;
    }

    this.blinkT -= dt;
    if (this.blinkT < -0.13) this.blinkT = 1.6 + Math.random() * 3.4;
    const blink = this.blinkT < 0 ? 0.12 : 1;
    for (const e of this.eyes) e.scale.y = blink;

    const dash = st.dash || 0;
    const sq = 1 + dash * 0.16;
    this.root.scale.set(sq, 1 - dash * 0.18, sq);
    this.blob.scale.setScalar(1 + bob * 2);
  }

  muzzleWorld(out) {
    if (this.muzzle) return this.muzzle.getWorldPosition(out);
    return out.copy(this.group.position).add(new THREE.Vector3(0, 0.6, 0));
  }
}