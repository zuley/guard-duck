import * as THREE from 'three';
import { sparkSprite, puffSprite, featherSprite, bladeShardSprite, flashSprite, glowSprite, laserHaloTexture, ringSprite, scorchSprite, textTexture, shoutTexture } from './textures.js';
import { groundHeight, waterSurfaceAt } from './world.js';

const BILLBOARD_VERT = /* glsl */`
  attribute float aLife;
  attribute float aSize;
  attribute float aRot;
  attribute vec3 aColor;
  varying vec2 vUv;
  varying float vLife;
  varying vec3 vColor;
  void main() {
    vUv = uv; vLife = aLife; vColor = aColor;
    vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float c = cos(aRot), s = sin(aRot);
    vec2 corner = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
    center.xy += corner * aSize;
    gl_Position = projectionMatrix * center;
  }`;

function billboardMat(map, mode) {
  return new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: BILLBOARD_VERT,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap;
      varying vec2 vUv;
      varying float vLife;
      varying vec3 vColor;
      void main() {
        vec4 t = texture2D(uMap, vUv);
        ${mode === 'smoke'
          ? 'float a = t.a * smoothstep(0.0, 0.12, vLife) * vLife * 0.5; gl_FragColor = vec4(vColor, a);'
          : 'float a = t.a * min(1.0, vLife * 3.0); gl_FragColor = vec4(vColor * t.rgb + t.rgb * 0.15, a);'}
      }`,
  });
}

class BillboardPool {
  constructor(scene, count, map, mode) {
    this.count = count;
    this.geo = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.InstancedMesh(this.geo, billboardMat(map, mode), count);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const ident = new THREE.Matrix4();
    for (let i = 0; i < count; i++) this.mesh.setMatrixAt(i, ident);
    this.aLife = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    this.aRot = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    for (const a of [this.aLife, this.aSize, this.aRot, this.aColor]) {
      a.setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute(a === this.aLife ? 'aLife' : a === this.aSize ? 'aSize' : a === this.aRot ? 'aRot' : 'aColor', a);
    }
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.size0 = new Float32Array(count);
    this.grow = new Float32Array(count);
    this.rotV = new Float32Array(count);
    this.grav = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.idx = 0;
    scene.add(this.mesh);
  }

  spawn(x, y, z, vx, vy, vz, { life = 1, size = 0.5, grow = 0, color = 0xffffff, rot = 0, rotV = 0, grav = 0, drag = 0 }) {
    const i = this.idx; this.idx = (this.idx + 1) % this.count;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.life[i] = this.maxLife[i] = life;
    this.size0[i] = size; this.grow[i] = grow;
    this.aRot.array[i] = rot; this.rotV[i] = rotV;
    this.grav[i] = grav; this.drag[i] = drag;
    const c = new THREE.Color(color);
    this.aColor.array.set([c.r, c.g, c.b], i * 3);
  }

  update(dt) {
    const m = this.mesh.instanceMatrix.array;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) { this.aLife.array[i] = 0; continue; }
      this.life[i] -= dt;
      const i3 = i * 3;
      const dr = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= dr; this.vel[i3 + 1] = this.vel[i3 + 1] * dr - this.grav[i] * dt; this.vel[i3 + 2] *= dr;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.aRot.array[i] += this.rotV[i] * dt;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      this.aLife.array[i] = t;
      this.aSize.array[i] = this.size0[i] * (1 + this.grow[i] * (1 - t));
      m[i * 16 + 12] = this.pos[i3];
      m[i * 16 + 13] = this.pos[i3 + 1];
      m[i * 16 + 14] = this.pos[i3 + 2];
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aLife.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aRot.needsUpdate = true;
    this.aColor.needsUpdate = true;
  }
}

export class FX {
  constructor(scene) {
    this.scene = scene;
    this.smokePool = new BillboardPool(scene, 110, puffSprite(), 'smoke');
    this.featherPool = new BillboardPool(scene, 240, featherSprite('#ffffff'), 'feather');
    this.bladeShardPool = new BillboardPool(scene, 96, bladeShardSprite(), 'shard');

    // 火花
    const N = this.sparkN = 500;
    this.sparkPos = new Float32Array(N * 3);
    this.sparkVel = new Float32Array(N * 3);
    this.sparkLife = new Float32Array(N);
    this.sparkMax = new Float32Array(N);
    this.sparkCol = new Float32Array(N * 3);
    this.sparkSize = new Float32Array(N);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.sparkCol, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aLife', new THREE.BufferAttribute(this.sparkLife, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.sparkSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.sparkMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: sparkSprite() } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute vec3 aColor; attribute float aLife; attribute float aSize;
        varying vec3 vC; varying float vL;
        void main() {
          vC = aColor; vL = aLife;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * aLife * (160.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap; varying vec3 vC; varying float vL;
        void main() {
          vec4 t = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(vC, 1.0) * t * vL;
        }`,
    });
    this.sparkPts = new THREE.Points(g, this.sparkMat);
    this.sparkPts.frustumCulled = false;
    scene.add(this.sparkPts);
    this.sparkIdx = 0;

    // 枪口焰 / 光 / 曳光 / 贴花 / 冲击环 / 数字
    this.flashes = [];
    for (let i = 0; i < 8; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flashSprite(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
      s.visible = false; scene.add(s);
      this.flashes.push({ s, life: 0 });
    }
    this.lights = [];
    for (let i = 0; i < 5; i++) {
      const l = new THREE.PointLight(0xffb060, 0, 10, 2);
      scene.add(l); this.lights.push(l);
    }
    this.lightIdx = 0;
    this.decals = [];
    const dGeo = new THREE.CircleGeometry(0.5, 18);
    for (let i = 0; i < 26; i++) {
      const m = new THREE.Mesh(dGeo, new THREE.MeshBasicMaterial({
        map: scorchSprite(), transparent: true, opacity: 0, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2 }));
      m.rotation.x = -Math.PI / 2; m.visible = false; scene.add(m);
      this.decals.push({ m, life: 0 });
    }
    this.rings = [];
    for (let i = 0; i < 10; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: ringSprite(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
      s.visible = false; scene.add(s);
      this.rings.push({ s, life: 0, max: 0 });
    }
    this.beams = [];
    const coreGeo = new THREE.CylinderGeometry(1, 1, 1, 8).rotateX(Math.PI / 2);
    const haloGeo = new THREE.PlaneGeometry(1, 1).rotateY(Math.PI / 2);
    const laserBlend = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false };
    for (let i = 0; i < 12; i++) {
      const group = new THREE.Group();
      const core = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial(laserBlend));
      const halo = new THREE.Group();
      const haloMaterial = new THREE.MeshBasicMaterial({ ...laserBlend, map: laserHaloTexture(), side: THREE.DoubleSide, forceSinglePass: true });
      halo.add(new THREE.Mesh(haloGeo, haloMaterial), new THREE.Mesh(haloGeo, haloMaterial));
      halo.children[1].rotation.z = Math.PI / 2;
      const muzzle = new THREE.Sprite(new THREE.SpriteMaterial({ ...laserBlend, map: glowSprite() }));
      const impact = new THREE.Sprite(muzzle.material.clone());
      muzzle.position.z = -0.5;
      group.add(core, halo, muzzle, impact);
      group.visible = false;
      scene.add(group);
      this.beams.push({ group, core, halo, haloMaterial, muzzle, impact, life: 0, duration: 0.17 });
    }
    this.zones = [];
    const zoneRimGeo = new THREE.RingGeometry(0.94, 1, 48);
    const zoneDiscGeo = new THREE.CircleGeometry(0.94, 48);
    for (let i = 0; i < 6; i++) {
      const rim = new THREE.Mesh(zoneRimGeo, new THREE.MeshBasicMaterial({
        color: 0xffa040, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      const disc = new THREE.Mesh(zoneDiscGeo, new THREE.MeshBasicMaterial({
        color: 0xffa040, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      rim.rotation.x = disc.rotation.x = -Math.PI / 2;
      const g = new THREE.Group(); g.add(rim, disc); g.visible = false; scene.add(g);
      this.zones.push({ g, rim, disc, life: 0, max: 1 });
    }
    this.numbers = [];
    this.numTex = new Map();
    for (let i = 0; i < 14; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, opacity: 0 }));
      s.visible = false; scene.add(s);
      this.numbers.push({ s, life: 0 });
    }
    // 连锁闪电（金卡）：折线电弧池，几何体复用，只更新顶点
    this.bolts = [];
    this._boltSegs = 7;
    for (let i = 0; i < 8; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((this._boltSegs + 1) * 3), 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: 0x9fe8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      line.frustumCulled = false;
      line.visible = false;
      scene.add(line);
      this.bolts.push({ line, life: 0 });
    }
    this.boltIdx = 0;
  }

  // 两点之间的锯齿电弧，命中特效用；池满则复用最早的一条
  bolt(a, b, color = 0x9fe8ff) {
    const item = this.bolts[this.boltIdx];
    this.boltIdx = (this.boltIdx + 1) % this.bolts.length;
    const arr = item.line.geometry.attributes.position.array;
    const n = this._boltSegs;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const jitter = i === 0 || i === n ? 0 : 0.34;
      arr[i * 3] = a.x + (b.x - a.x) * t + (Math.random() - 0.5) * jitter;
      arr[i * 3 + 1] = a.y + (b.y - a.y) * t + (Math.random() - 0.5) * jitter;
      arr[i * 3 + 2] = a.z + (b.z - a.z) * t + (Math.random() - 0.5) * jitter;
    }
    item.line.geometry.attributes.position.needsUpdate = true;
    item.line.material.color.set(color);
    item.line.visible = true;
    item.life = 0.16;
  }

  spark(pos, dir, n = 8, color = 0xffc060, speed = 7) {
    const c = new THREE.Color(color);
    for (let k = 0; k < n; k++) {
      const i = this.sparkIdx; this.sparkIdx = (this.sparkIdx + 1) % this.sparkN;
      const i3 = i * 3;
      this.sparkPos.set([pos.x, pos.y, pos.z], i3);
      const spread = 0.65;
      this.sparkVel.set([
        (dir.x + (Math.random() - 0.5) * spread) * speed * (0.4 + Math.random()),
        (dir.y + (Math.random() - 0.2) * spread) * speed * (0.4 + Math.random()),
        (dir.z + (Math.random() - 0.5) * spread) * speed * (0.4 + Math.random()),
      ], i3);
      this.sparkLife[i] = this.sparkMax[i] = 0.25 + Math.random() * 0.3;
      this.sparkCol.set([c.r, c.g, c.b], i3);
      this.sparkSize[i] = 2.5 + Math.random() * 3.5;
    }
  }

  smoke(pos, n = 1, color = 0x9a8a7a, size = 0.5, grow = 1.8, life = 0.9) {
    for (let k = 0; k < n; k++) {
      this.smokePool.spawn(
        pos.x + (Math.random() - 0.5) * 0.2, pos.y + (Math.random() - 0.5) * 0.2, pos.z + (Math.random() - 0.5) * 0.2,
        (Math.random() - 0.5) * 0.7, 0.5 + Math.random() * 0.7, (Math.random() - 0.5) * 0.7,
        { life: life * (0.7 + Math.random() * 0.6), size, grow, color, rot: Math.random() * 6, rotV: (Math.random() - 0.5) * 1.5, drag: 1.2 });
    }
  }

  feathers(pos, color, n = 10, power = 3) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const up = 1.5 + Math.random() * power;
      this.featherPool.spawn(
        pos.x, pos.y + 0.4 + Math.random() * 0.5, pos.z,
        Math.cos(a) * power * (0.3 + Math.random() * 0.7), up, Math.sin(a) * power * (0.3 + Math.random() * 0.7),
        {
          life: 1.4 + Math.random() * 1.2, size: 0.16 + Math.random() * 0.14, color,
          rot: Math.random() * 6, rotV: (Math.random() - 0.5) * 9, grav: 2.6, drag: 1.6,
        });
    }
  }

  bladeShards(pos, dir, color) {
    const tint = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.38);
    for (let i = -2; i <= 2; i++) {
      const side = i * 0.95;
      this.bladeShardPool.spawn(
        pos.x, pos.y, pos.z, dir.x * 5 + dir.z * side, 0.65 + Math.abs(i) * 0.45, dir.z * 5 - dir.x * side,
        { life: 0.21 + Math.abs(i) * 0.035, size: 0.24, color: tint,
          rot: i * 1.25, rotV: i * 4, grav: 4.2, drag: 2 });
    }
  }

  flash(pos, scale = 0.7, color) {
    const f = this.flashes.find((x) => x.life <= 0) || this.flashes[0];
    f.s.position.copy(pos);
    f.s.material.map = color === undefined ? flashSprite() : glowSprite();
    f.s.material.color.set(color ?? 0xffffff);
    f.s.material.rotation = Math.random() * 6;
    f.s.scale.setScalar(scale * (0.8 + Math.random() * 0.5));
    f.s.visible = true;
    f.life = 0.06;
    const l = this.lights[this.lightIdx]; this.lightIdx = (this.lightIdx + 1) % this.lights.length;
    l.position.copy(pos);
    l.color.set(color ?? 0xffb060);
    l.intensity = 22 * scale;
  }

  decal(pos, size = 0.5) {
    const d = this.decals.find((x) => x.life <= 0) || this.decals[0];
    const wy = waterSurfaceAt(pos.x, pos.z);
    d.m.position.set(pos.x, (wy !== null ? wy : groundHeight(pos.x, pos.z)) + 0.025, pos.z);
    d.m.rotation.z = Math.random() * 6;
    d.m.scale.setScalar(size);
    d.m.visible = true;
    d.life = 14;
  }

  ring(pos, color = 0xffd9a0, max = 2.5) {
    const r = this.rings.find((x) => x.life <= 0) || this.rings[0];
    r.s.position.copy(pos);
    r.s.material.color.set(color);
    r.s.visible = true;
    r.life = 0.4; r.max = max;
  }

  beam(from, to, color, didImpact) {
    const b = this.beams.find((x) => x.life <= 0) || this.beams[0];
    const length = from.distanceTo(to);
    b.group.position.copy(from).lerp(to, 0.5);
    b.group.lookAt(to);
    b.group.scale.z = length;
    b.haloMaterial.color.set(color);
    b.core.material.color.copy(b.haloMaterial.color).lerp(new THREE.Color(0xffffff), 0.76);
    b.muzzle.material.color.copy(b.core.material.color);
    b.impact.material.color.copy(b.core.material.color);
    b.impact.position.z = 0.5 - Math.min(0.4, 0.12 / length);
    b.impact.visible = didImpact;
    b.life = b.duration;
    b.group.visible = true;
    this.updateBeam(b);
  }

  updateBeam(b) {
    const fade = Math.max(0, b.life / b.duration);
    const coreFade = fade ** 3;
    b.core.material.opacity = coreFade;
    b.core.scale.x = b.core.scale.y = 0.048 * (0.35 + 0.65 * fade);
    b.haloMaterial.opacity = 0.72 * fade;
    b.halo.scale.x = b.halo.scale.y = 0.42 + 0.27 * (1 - fade);
    b.muzzle.material.opacity = 0.95 * coreFade;
    b.muzzle.scale.setScalar(0.75 + 0.35 * (1 - fade));
    b.impact.material.opacity = 0.9 * fade * fade;
    b.impact.scale.setScalar(0.62 + 0.58 * (1 - fade));
    b.group.visible = fade > 0;
  }

  zone(pos, radius, color, life) {
    const z = this.zones.find((x) => x.life <= 0) || this.zones[0];
    z.g.position.set(pos.x, groundHeight(pos.x, pos.z) + 0.04, pos.z);
    z.g.scale.set(radius, 1, radius);
    z.rim.material.color.set(color);
    z.disc.material.color.set(color);
    z.g.visible = true;
    z.life = z.max = life;
  }

  // 技能喊话气泡：跟随锚点（玩家 pos 引用），弹入 + 结束淡出
  shout(text, anchor) {
    if (!this.shoutSprite) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false }));
      s.renderOrder = 6;
      s.visible = false;
      this.scene.add(s);
      this.shoutSprite = s;
    }
    const tex = shoutTexture(text);
    const s = this.shoutSprite;
    s.material.map = tex;
    s.material.needsUpdate = true;
    this.shoutAspect = tex.image.width / tex.image.height;
    this.shoutAnchor = anchor;
    this.shoutT = this.shoutDur = 1.8;
    s.visible = true;
  }

  number(pos, text, color = '#ffe28a') {
    const n = this.numbers.find((x) => x.life <= 0) || this.numbers[0];
    const tex = textTexture(text, color); // 贴图由 textures.js 统一缓存
    this.numTex.set(text + color, tex); // 兼容索引（e2e 用），与共享缓存指向同一贴图
    n.s.material.map = tex;
    n.s.material.needsUpdate = true;
    n.s.position.copy(pos).add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 1.3, 0));
    n.s.scale.set(0.85 * (tex.image.width / tex.image.height), 0.85, 1);
    n.s.visible = true;
    n.life = 0.8;
  }

  update(dt) {
    this.smokePool.update(dt);
    this.featherPool.update(dt);
    this.bladeShardPool.update(dt);

    if (this.shoutT > 0) {
      this.shoutT = Math.max(0, this.shoutT - dt);
      const s = this.shoutSprite;
      if (this.shoutT <= 0) s.visible = false;
      else {
        const a = this.shoutAnchor;
        s.position.set(a.x, a.y + 3.15, a.z);
        const pop = Math.min(1, (this.shoutDur - this.shoutT) / 0.14);
        const h = 0.6 * (0.7 + 0.3 * (1 - Math.pow(1 - pop, 3)));
        s.scale.set(h * this.shoutAspect, h, 1);
        s.material.opacity = Math.min(1, this.shoutT / 0.35);
      }
    }

    for (let i = 0; i < this.sparkN; i++) {
      if (this.sparkLife[i] <= 0) continue;
      this.sparkLife[i] -= dt;
      const i3 = i * 3;
      this.sparkVel[i3 + 1] -= 12 * dt;
      this.sparkPos[i3] += this.sparkVel[i3] * dt;
      this.sparkPos[i3 + 1] += this.sparkVel[i3 + 1] * dt;
      this.sparkPos[i3 + 2] += this.sparkVel[i3 + 2] * dt;
      const gh = groundHeight(this.sparkPos[i3], this.sparkPos[i3 + 2]);
      if (this.sparkPos[i3 + 1] < gh) { this.sparkPos[i3 + 1] = gh; this.sparkVel[i3 + 1] *= -0.3; }
      this.sparkLife[i] = Math.max(0, this.sparkLife[i]);
    }
    const sg = this.sparkPts.geometry;
    sg.attributes.position.needsUpdate = true;
    sg.attributes.aLife.needsUpdate = true;
    sg.attributes.aColor.needsUpdate = true;
    sg.attributes.aSize.needsUpdate = true;

    for (const f of this.flashes) {
      if (f.life > 0) { f.life -= dt; f.s.material.opacity = Math.max(0, f.life / 0.06); if (f.life <= 0) f.s.visible = false; }
    }
    for (const b of this.bolts) {
      if (b.life > 0) { b.life -= dt; b.line.material.opacity = Math.max(0, b.life / 0.16); if (b.life <= 0) b.line.visible = false; }
    }
    for (const b of this.beams) {
      if (b.life > 0) {
        b.life -= dt;
        this.updateBeam(b);
      }
    }
    for (const l of this.lights) l.intensity = Math.max(0, l.intensity - dt * 220);
    for (const d of this.decals) {
      if (d.life > 0) { d.life -= dt; d.m.material.opacity = Math.min(0.85, d.life / 4); if (d.life <= 0) d.m.visible = false; }
    }
    for (const r of this.rings) {
      if (r.life > 0) {
        r.life -= dt;
        const t = 1 - r.life / 0.4;
        r.s.scale.setScalar(0.4 + t * r.max);
        r.s.material.opacity = (1 - t) * 0.8;
        if (r.life <= 0) r.s.visible = false;
      }
    }
    for (const z of this.zones) {
      if (z.life <= 0) continue;
      z.life -= dt;
      const pulse = 0.5 + 0.5 * Math.sin((z.max - z.life) * 10);
      const fade = Math.min(1, z.life / 0.15);
      z.rim.material.opacity = (0.45 + 0.3 * pulse) * fade;
      z.disc.material.opacity = (0.1 + 0.08 * pulse) * fade;
      if (z.life <= 0) z.g.visible = false;
    }
    for (const n of this.numbers) {
      if (n.life > 0) {
        n.life -= dt;
        n.s.position.y += dt * 1.3;
        n.s.material.opacity = Math.min(1, n.life / 0.35);
        if (n.life <= 0) n.s.visible = false;
      }
    }
  }
}
