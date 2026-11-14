import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { grassMaps, dirtMaps, woodMaps, metalMaps, hayMaps, waterNormalMap, glowSprite } from './textures.js';
import { mulberry32 } from './rules.js';

export const ARENA = 20.3;
export const POND = { x: -13, z: -13, r: 6.6 };
export const GATES = [
  { x: 0, z: -26 }, { x: 0, z: 26 }, { x: -26, z: 0 }, { x: 26, z: 0 },
];
// 门口沙袋布局常数：两垛分列入口两侧，中间留净空通道。
// GATE_LANE_HALF 是通道净空半宽（collider 内缘），由沙袋首袋偏移与半径推导，
// spawnEnemy 用它限制生点横移，保证任何敌人（含精英重装）直线进场不碰沙袋。
const BAG_INNER_OFFSET = 3.25;
const BAG_RADIUS = 0.55;
export const GATE_LANE_HALF = BAG_INNER_OFFSET - BAG_RADIUS; // 2.7

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function groundHeight(x, z) {
  const r = Math.hypot(x, z);
  let h = (Math.sin(x * 0.16) * Math.cos(z * 0.13) + Math.sin(x * 0.07 + 1.7) * Math.cos(z * 0.09 + 0.4) * 1.4) * 0.22;
  h *= smooth(21, 30, r);
  const pd = Math.hypot(x - POND.x, z - POND.z);
  h -= 0.85 * (1 - smooth(4.6, 6.9, pd));
  return h;
}

// 池塘水面高度：水面 mesh 在 y=-0.26，弹体落水即停，不再沉到池底
export const WATER_Y = -0.26;
export function waterSurfaceAt(x, z) {
  return Math.hypot(x - POND.x, z - POND.z) < POND.r + 0.35 ? WATER_Y : null;
}

export function pathMask(x, z) {
  const inArena = smooth(21.5, 20, Math.hypot(x, z));
  const cross = Math.max(1 - smooth(1.6, 2.6, Math.abs(x)), 1 - smooth(1.6, 2.6, Math.abs(z)));
  const plaza = 1 - smooth(2.6, 4.2, Math.hypot(x, z));
  return Math.max(cross, plaza) * inArena;
}

export function resolveColliders(pos, radius, colliders) {
  for (const c of colliders) {
    if (c.hx !== undefined) {
      const dx = pos.x - c.x, dz = pos.z - c.z;
      const px = c.hx + radius - Math.abs(dx);
      const pz = c.hz + radius - Math.abs(dz);
      if (px > 0 && pz > 0) {
        if (px < pz) pos.x += Math.sign(dx || 1) * px;
        else pos.z += Math.sign(dz || 1) * pz;
      }
    } else {
      const dx = pos.x - c.x, dz = pos.z - c.z;
      const d = Math.hypot(dx, dz);
      const min = c.r + radius;
      if (d < min && d > 1e-5) {
        pos.x = c.x + (dx / d) * min;
        pos.z = c.z + (dz / d) * min;
      }
    }
  }
}

function box(w, h, d, x, y, z, ry = 0, rx = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Matrix4();
  const e = new THREE.Euler(rx, ry, rz);
  m.makeRotationFromEuler(e);
  m.setPosition(x, y, z);
  g.applyMatrix4(m);
  return g;
}

export class World {
  constructor(scene, renderer, quality = 'high') {
    this.scene = scene;
    this.quality = quality;
    this.colliders = [{ x: POND.x, z: POND.z, r: POND.r + 0.2 }];
    this.lanterns = [];
    this.time = 0;
    this.uniforms = { uTime: { value: 0 } };
    const rng = mulberry32(2026);
    this.rng = rng;

    this._sky(renderer);
    this._lights();
    this._terrain();
    this._water();
    this._fence();
    this._props(rng);
    this._trees(rng);
    this._grass(rng);
    this._ambientLife(rng);
  }

  _sky(renderer) {
    this.sunDir = new THREE.Vector3(-0.62, 0.42, -0.42).normalize();
    const skyUniforms = {
      uTime: this.uniforms.uTime,
      uSunDir: { value: this.sunDir },
      uSunColor: { value: new THREE.Color(1.0, 0.82, 0.58) },
      uHorizon: { value: new THREE.Color(0.99, 0.78, 0.52) },
      uMid: { value: new THREE.Color(0.52, 0.62, 0.80) },
      uZenith: { value: new THREE.Color(0.16, 0.32, 0.60) },
    };
    const skyMat = new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform vec3 uSunDir, uSunColor, uHorizon, uMid, uZenith;
        varying vec3 vDir;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                     mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.y), f.x);
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 5; i++) { v += noise(p) * a; p *= 2.03; a *= 0.5; }
          return v;
        }
        void main() {
          vec3 dir = normalize(vDir);
          float y = dir.y;
          vec3 col = mix(uHorizon, uMid, smoothstep(-0.02, 0.22, y));
          col = mix(col, uZenith, smoothstep(0.18, 0.65, y));
          col = mix(col, uHorizon * 0.55, smoothstep(0.0, -0.25, y));
          float s = max(dot(dir, uSunDir), 0.0);
          col += uSunColor * (pow(s, 1200.0) * 4.0 + pow(s, 24.0) * 0.4 + pow(s, 3.0) * 0.14);
          if (y > 0.015) {
            vec2 cuv = dir.xz / (y + 0.14) * 0.55;
            float c = fbm(cuv + vec2(uTime * 0.006, uTime * 0.002));
            float cov = smoothstep(0.5, 0.74, c) * smoothstep(0.015, 0.16, y);
            vec3 cloudCol = mix(uHorizon * 1.05, vec3(0.98, 0.88, 0.78), 0.45);
            cloudCol += uSunColor * pow(s, 4.0) * 0.3;
            col = mix(col, cloudCol, cov * 0.75);
          }
          float st = step(0.9985, hash(floor(dir.xz * 260.0 + dir.y * 173.0))) * smoothstep(0.35, 0.7, y);
          col += vec3(st * 0.3);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.skyMesh = new THREE.Mesh(new THREE.SphereGeometry(190, 48, 24), skyMat);
    this.scene.add(this.skyMesh);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMat));
    const env = pmrem.fromScene(envScene, 0.035, 0.1, 200);
    this.scene.environment = env.texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
  }

  _lights() {
    this.sun = new THREE.DirectionalLight(0xffd7a0, 3.1);
    this.sun.position.copy(this.sunDir).multiplyScalar(60);
    this.sun.castShadow = true;
    const sc = this.sun.shadow;
    sc.mapSize.set(this.quality === 'high' ? 2048 : 1024, this.quality === 'high' ? 2048 : 1024);
    sc.camera.left = -34; sc.camera.right = 34;
    sc.camera.top = 34; sc.camera.bottom = -34;
    sc.camera.near = 10; sc.camera.far = 130;
    sc.bias = -0.0004; sc.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xa8c0e0, 0x6a5638, 0.8);
    this.scene.add(this.hemi);
    const fill = new THREE.DirectionalLight(0x5f7fd0, 0.4);
    fill.position.set(30, 20, 26);
    this.scene.add(fill);
  }

  _terrain() {
    const grass = grassMaps(), dirt = dirtMaps();
    grass.map.repeat.set(14, 14);
    grass.normalMap.repeat.set(14, 14);
    dirt.map.repeat.set(14, 14);
    const geo = new THREE.PlaneGeometry(110, 110, 150, 150);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      pos.setY(i, groundHeight(x, z));
      const pd = Math.hypot(x - POND.x, z - POND.z);
      colors[i * 3] = pathMask(x, z);
      colors[i * 3 + 1] = smooth(7.8, 6.9, pd) * smooth(5.9, 6.5, pd);
      colors[i * 3 + 2] = 1;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      map: grass.map, normalMap: grass.normalMap, normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 0.94, metalness: 0, vertexColors: true,
    });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.dirtMap = { value: dirt.map };
      sh.vertexShader = 'varying vec2 vMask;\n' + sh.vertexShader.replace(
        '#include <color_vertex>', '#include <color_vertex>\n vMask = color.rg;');
      sh.fragmentShader = 'varying vec2 vMask;\nuniform sampler2D dirtMap;\n' + sh.fragmentShader
        .replace('#include <color_fragment>', '')
        .replace(
        '#include <map_fragment>',
        `vec4 gCol = texture2D(map, vMapUv);
         vec4 dCol = texture2D(dirtMap, vMapUv);
         vec4 sampledDiffuseColor = mix(gCol, dCol, clamp(vMask.x, 0.0, 1.0));
         sampledDiffuseColor.rgb = mix(sampledDiffuseColor.rgb, vec3(0.66, 0.56, 0.40), clamp(vMask.y, 0.0, 1.0));
         diffuseColor *= sampledDiffuseColor;`);
    };
    const ground = new THREE.Mesh(geo, mat);
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  _water() {
    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uNormal: { value: waterNormalMap() },
        uSunDir: { value: this.sunDir },
        uSunColor: { value: new THREE.Color(1.0, 0.82, 0.58) },
        uSkyTop: { value: new THREE.Color(0.20, 0.36, 0.60) },
        uSkyHorizon: { value: new THREE.Color(0.99, 0.78, 0.52) },
        uDeep: { value: new THREE.Color(0.03, 0.14, 0.17) },
        uShallow: { value: new THREE.Color(0.10, 0.36, 0.36) },
        uCenter: { value: new THREE.Vector2(POND.x, POND.z) },
      },
    ]);
    uniforms.uTime = this.uniforms.uTime;
    const mat = new THREE.ShaderMaterial({
      uniforms, transparent: true, fog: true,
      vertexShader: /* glsl */`
        varying vec3 vWorldPos;
        #include <fog_pars_vertex>
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform sampler2D uNormal;
        uniform vec3 uSunDir, uSunColor, uSkyTop, uSkyHorizon, uDeep, uShallow;
        uniform vec2 uCenter;
        varying vec3 vWorldPos;
        #include <fog_pars_fragment>
        void main() {
          vec2 uv = vWorldPos.xz * 0.16;
          vec3 n1 = texture2D(uNormal, uv + vec2(uTime * 0.02, uTime * 0.013)).xyz * 2.0 - 1.0;
          vec3 n2 = texture2D(uNormal, uv * 1.7 - vec2(uTime * 0.017, uTime * 0.024)).xyz * 2.0 - 1.0;
          vec3 n = normalize(vec3(n1.x + n2.x, 2.4, n1.y + n2.y));
          vec3 V = normalize(cameraPosition - vWorldPos);
          float fres = pow(1.0 - max(dot(V, n), 0.0), 3.0);
          float d = length(vWorldPos.xz - uCenter);
          float depth = smoothstep(6.9, 3.0, d);
          vec3 base = mix(uShallow, uDeep, depth);
          vec3 R = reflect(-V, n);
          vec3 sky = mix(uSkyHorizon, uSkyTop, clamp(R.y * 1.7, 0.0, 1.0));
          float spec = pow(max(dot(reflect(-uSunDir, n), V), 0.0), 150.0);
          vec3 col = mix(base, sky, 0.18 + fres * 0.55) + uSunColor * spec * 2.6;
          float shore = smoothstep(5.6, 6.5, d);
          col += vec3(0.85, 0.8, 0.7) * shore * 0.15 * (0.6 + 0.4 * sin(uTime * 1.8 + d * 7.0));
          gl_FragColor = vec4(col, 0.94);
          #include <fog_fragment>
        }`,
    });
    const water = new THREE.Mesh(new THREE.CircleGeometry(POND.r + 0.35, 48), mat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(POND.x, -0.26, POND.z);
    this.scene.add(water);
  }

  _fence() {
    const wood = woodMaps();
    const geos = [];
    const L = 21;
    for (let side = 0; side < 4; side++) {
      for (let t = -L; t <= L; t += 2.625) {
        if (Math.abs(t) < 2.7) continue;
        const [x, z] = side === 0 ? [t, -L] : side === 1 ? [t, L] : side === 2 ? [-L, t] : [L, t];
        geos.push(box(0.15, 1.2, 0.15, x, 0.6, z));
        geos.push(box(0.22, 0.1, 0.22, x, 1.22, z));
      }
      for (const seg of [[-L, -2.7], [2.7, L]]) {
        const len = seg[1] - seg[0], mid = (seg[0] + seg[1]) / 2;
        for (const y of [0.5, 0.95]) {
          if (side < 2) geos.push(box(len, 0.1, 0.07, mid, y, side === 0 ? -L : L));
          else geos.push(box(0.07, 0.1, len, side === 2 ? -L : L, y, mid));
        }
      }
    }
    const mat = new THREE.MeshStandardMaterial({ map: wood.map, normalMap: wood.normalMap, roughness: 0.85 });
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  _props(rng) {
    const wood = woodMaps(), metal = metalMaps(), hay = hayMaps(), dirt = dirtMaps();
    const woodMat = new THREE.MeshStandardMaterial({ map: wood.map, normalMap: wood.normalMap, roughness: 0.82 });
    const darkWoodMat = new THREE.MeshStandardMaterial({ map: wood.map, color: 0x8a6a4a, roughness: 0.88 });
    const metalMat = new THREE.MeshStandardMaterial({ map: metal.map, roughness: 0.5, metalness: 0.72 });
    const hayMat = new THREE.MeshStandardMaterial({ map: hay.map, normalMap: hay.normalMap, roughness: 0.96 });
    const bagMat = new THREE.MeshStandardMaterial({ map: dirt.map, color: 0xb8a878, roughness: 1 });

    const woodGeos = [], metalGeos = [], hayGeos = [], bagGeos = [];

    const crates = [
      [4, 3, 1.1], [5.3, 3.5, 0.9], [4.5, 4.6, 1.0], [4.4, 3.4, 0.8, 1.1],
      [-6, 8, 1.15], [-7.2, 8.5, 0.9], [8, -4, 1.1], [9.2, -4.5, 0.85],
      [2, -9, 1.0], [-3, -6, 0.9], [12, 6, 1.1], [-9, -1, 1.0], [6, 10, 0.95],
    ];
    for (const [x, z, s, y] of crates) {
      woodGeos.push(box(s, s, s, x, (y || 0) + s / 2, z, rng() * 0.8));
      this.colliders.push({ x, z, r: s * 0.72 });
    }
    const barrels = [[6.6, 3.1], [-5.2, 9.0], [9.8, -3.2], [-2, -8.6], [13.4, 7.6], [-9.6, -2.4], [1.2, 6.5]];
    for (const [x, z] of barrels) {
      const c = new THREE.CylinderGeometry(0.42, 0.42, 1.05, 14);
      c.translate(x, 0.52, z);
      metalGeos.push(c);
      for (const y of [0.25, 0.8]) {
        const t = new THREE.TorusGeometry(0.43, 0.028, 6, 18);
        t.rotateX(Math.PI / 2); t.translate(x, y, z);
        metalGeos.push(t);
      }
      this.colliders.push({ x, z, r: 0.5 });
    }
    const hays = [[-8, 4], [3, 7.5], [-4, -10.5], [10, 2], [-10.5, -6.5], [7, -8]];
    for (const [x, z] of hays) {
      const c = new THREE.CylinderGeometry(0.62, 0.62, 1.3, 14);
      c.rotateZ(Math.PI / 2); c.rotateY(rng() * 3); c.translate(x, 0.62, z);
      hayGeos.push(c);
      this.colliders.push({ x, z, r: 0.85 });
    }
    // 沙袋拆成左右两垛分列入口两侧（原本横在路中间会卡住进场的鸭子），
    // 中间留净空通道（collider 内缘 ±GATE_LANE_HALF），与栅栏门口同宽；
    // 生点横移由 spawnEnemy 按 GATE_LANE_HALF - 敌人半径 动态限制，不再靠手同步常数
    for (const g of GATES) {
      const inward = new THREE.Vector3(-g.x, 0, -g.z).normalize();
      const side = new THREE.Vector3(-inward.z, 0, inward.x);
      for (const dir of [-1, 1]) {
        for (let row = 0; row < 2; row++) {
          const n = row === 0 ? 3 : 2;
          for (let k = 0; k < n; k++) {
            const p = new THREE.Vector3(g.x, 0, g.z)
              .addScaledVector(inward, 3.2 + row * 0.55)
              .addScaledVector(side, dir * (BAG_INNER_OFFSET + k * 0.72) + (row ? dir * 0.36 : 0));
            const s = new THREE.SphereGeometry(0.34, 8, 6);
            s.scale(1.25, 0.6, 0.85);
            s.rotateY(Math.atan2(side.x, side.z) + (rng() - 0.5) * 0.3);
            s.translate(p.x, 0.2 + row * 0.36, p.z);
            bagGeos.push(s);
            if (row === 0) this.colliders.push({ x: p.x, z: p.z, r: BAG_RADIUS });
          }
        }
      }
    }
    // 谷仓
    woodGeos.push(box(7.5, 4.2, 5.5, 13, 2.1, -14));
    woodGeos.push(box(8.3, 0.16, 3.5, 13, 4.85, -15.5, 0, 0.62));
    woodGeos.push(box(8.3, 0.16, 3.5, 13, 4.85, -12.5, 0, -0.62));
    woodGeos.push(box(8.4, 0.22, 0.3, 13, 5.62, -14));
    this.colliders.push({ x: 13, z: -14, hx: 3.85, hz: 2.85 });
    const door = new THREE.Mesh(box(1.9, 2.7, 0.12, 13, 1.35, -11.2), darkWoodMat);
    door.castShadow = true;
    this.scene.add(door);
    const winMat = new THREE.MeshStandardMaterial({ color: 0x2a1a0a, emissive: 0xffb066, emissiveIntensity: 2.4 });
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95), winMat);
    win.position.set(10.6, 2.7, -11.24);
    this.scene.add(win);
    const winLight = new THREE.PointLight(0xffa050, 4, 8, 2);
    winLight.position.set(10.6, 2.7, -10.6);
    this.scene.add(winLight);

    // 瞭望塔
    const tx = 15, tz = 13;
    for (const [dx, dz] of [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]])
      woodGeos.push(box(0.17, 3.5, 0.17, tx + dx, 1.75, tz + dz));
    woodGeos.push(box(2.5, 0.16, 2.5, tx, 3.5, tz));
    for (const [dx, dz] of [[-1.15, 0], [1.15, 0], [0, -1.15], [0, 1.15]])
      woodGeos.push(box(dx ? 0.08 : 2.4, 0.08, dz ? 0.08 : 2.4, tx + dx, 4.15, tz + dz));
    for (let i = 0; i < 5; i++) woodGeos.push(box(0.6, 0.06, 0.06, tx, 0.6 + i * 0.62, tz - 1.05));
    const roof = new THREE.ConeGeometry(2.0, 1.2, 4);
    roof.rotateY(Math.PI / 4); roof.translate(tx, 4.85, tz);
    woodGeos.push(roof);
    this.colliders.push({ x: tx, z: tz, r: 1.35 });

    // 灯柱
    for (const [x, z] of [[-17, -17], [17, -17], [-17, 17], [17, 17], [tx, tz]]) {
      const y = x === tx && z === tz ? 3.6 : 0;
      woodGeos.push(box(0.13, 2.6, 0.13, x, y + 1.3, z));
      woodGeos.push(box(0.5, 0.08, 0.08, x + 0.2, y + 2.55, z));
      const lampMat = new THREE.MeshStandardMaterial({ color: 0x3a2a12, emissive: 0xffb45e, emissiveIntensity: 3.2 });
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.34, 0.26), lampMat);
      lamp.position.set(x + 0.4, y + 2.35, z);
      this.scene.add(lamp);
      const pl = new THREE.PointLight(0xffa040, 7, 12, 2);
      pl.position.set(x + 0.4, y + 2.3, z);
      this.scene.add(pl);
      this.lanterns.push({ light: pl, base: 7, phase: rng() * 10 });
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowSprite(), color: 0xffb45e, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      glow.scale.set(1.6, 1.6, 1);
      glow.position.copy(lamp.position);
      this.scene.add(glow);
    }

    const add = (geos, mat) => {
      if (!geos.length) return;
      const m = new THREE.Mesh(mergeGeometries(geos), mat);
      m.castShadow = true; m.receiveShadow = true;
      this.scene.add(m);
    };
    add(woodGeos, woodMat);
    add(metalGeos, metalMat);
    add(hayGeos, hayMat);
    add(bagGeos, bagMat);

    // 石头
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x8a8578, roughness: 0.95, flatShading: true });
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, 34);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    for (let i = 0; i < 34; i++) {
      const a = rng() * Math.PI * 2;
      const r = i < 6 ? 8 + rng() * 11 : 23 + rng() * 16;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const s = 0.25 + rng() * (i < 6 ? 0.4 : 0.85);
      e.set(rng() * 3, rng() * 3, rng() * 3); q.setFromEuler(e);
      m4.compose(new THREE.Vector3(x, groundHeight(x, z) + s * 0.3, z), q, new THREE.Vector3(s, s * 0.75, s));
      rocks.setMatrixAt(i, m4);
      if (i < 6 && Math.hypot(x - POND.x, z - POND.z) > POND.r + 1) this.colliders.push({ x, z, r: s });
    }
    rocks.castShadow = true; rocks.receiveShadow = true;
    this.scene.add(rocks);
  }

  _trees(rng) {
    const trunkGeos = [], leafGeos = [];
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.92 });
    const positions = [];
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + rng() * 0.2;
      const r = 27 + rng() * 14;
      positions.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    positions.push([-24, -24], [24, -25], [-25, 22]);
    for (const [x, z] of positions) {
      const y = groundHeight(x, z);
      const h = 2.4 + rng() * 1.4;
      const t = new THREE.CylinderGeometry(0.2, 0.34, h, 7);
      t.translate(x, y + h / 2, z);
      trunkGeos.push(t);
      const tint = 0.75 + rng() * 0.5;
      for (let k = 0; k < 3; k++) {
        const s = 1.7 - k * 0.42 + rng() * 0.3;
        const g = new THREE.IcosahedronGeometry(s, 1);
        g.scale(1, 0.8, 1);
        g.translate(x + (rng() - 0.5) * 0.8, y + h + 0.5 + k * 0.85, z + (rng() - 0.5) * 0.8);
        const col = new THREE.Color(0.36 * tint, 0.55 * tint, 0.26 * tint);
        const arr = new Float32Array(g.attributes.position.count * 3);
        for (let v = 0; v < arr.length; v += 3) { arr[v] = col.r; arr[v + 1] = col.g; arr[v + 2] = col.b; }
        g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
        leafGeos.push(g);
      }
      if (Math.hypot(x, z) < 26) this.colliders.push({ x, z, r: 0.5 });
    }
    const trunk = new THREE.Mesh(mergeGeometries(trunkGeos), trunkMat);
    trunk.castShadow = true;
    this.scene.add(trunk);
    const leafMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
    leafMat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.uniforms.uTime;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vec4 wp = modelMatrix * vec4(position, 1.0);
         float sway = sin(uTime * 1.1 + wp.x * 0.35 + wp.z * 0.28) * 0.14;
         transformed.x += sway * smoothstep(2.0, 5.0, wp.y);
         transformed.z += sway * 0.6 * smoothstep(2.0, 5.0, wp.y);`);
    };
    const leaves = new THREE.Mesh(mergeGeometries(leafGeos), leafMat);
    leaves.castShadow = true;
    this.scene.add(leaves);
  }

  _grass(rng) {
    const count = this.quality === 'high' ? 20000 : 9000;
    const geo = new THREE.PlaneGeometry(0.12, 0.4, 1, 3);
    geo.translate(0, 0.2, 0);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      const t = y / 0.4;
      p.setX(i, p.getX(i) * (1 - t * 0.85));
      p.setZ(i, t * t * 0.1);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.uniforms.uTime;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         #ifdef USE_INSTANCING
           vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
           float w = sin(uTime * 1.7 + ip.x * 0.6 + ip.z * 0.8) + sin(uTime * 3.1 + ip.z * 1.7) * 0.4;
           transformed.x += w * 0.09 * (position.y / 0.4);
           transformed.z += w * 0.05 * (position.y / 0.4);
         #endif`);
    };
    const grass = new THREE.InstancedMesh(geo, mat, count);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const col = new THREE.Color();
    let placed = 0, guard = 0;
    while (placed < count && guard++ < count * 30) {
      const x = (rng() - 0.5) * 84, z = (rng() - 0.5) * 84;
      const r = Math.hypot(x, z);
      if (Math.hypot(x - POND.x, z - POND.z) < POND.r + 0.9) continue;
      if (r < 21) {
        if (pathMask(x, z) > 0.25 && rng() < 0.85) continue;
        if (rng() < 0.25) continue;
        let blocked = false;
        for (const c of this.colliders) {
          if (c.hx === undefined && Math.hypot(x - c.x, z - c.z) < c.r + 0.3) { blocked = true; break; }
        }
        if (blocked) continue;
      }
      const s = 0.7 + rng() * 0.9;
      e.set(0, rng() * Math.PI, 0); q.setFromEuler(e);
      m4.compose(new THREE.Vector3(x, groundHeight(x, z), z), q, new THREE.Vector3(s, s, s));
      grass.setMatrixAt(placed, m4);
      const tint = 0.7 + rng() * 0.6;
      col.setRGB(0.24 * tint, 0.42 * tint, 0.15 * tint);
      grass.setColorAt(placed, col);
      placed++;
    }
    grass.count = placed;
    grass.receiveShadow = true;
    grass.instanceMatrix.needsUpdate = true;
    if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
    this.scene.add(grass);

    // 芦苇
    const reedGeo = new THREE.ConeGeometry(0.035, 1.4, 5);
    reedGeo.translate(0, 0.7, 0);
    const reedMat = new THREE.MeshStandardMaterial({ color: 0x6a8a44, roughness: 0.9 });
    const reeds = new THREE.InstancedMesh(reedGeo, reedMat, 110);
    const headGeo = new THREE.CapsuleGeometry(0.05, 0.2, 4, 8);
    headGeo.translate(0, 1.32, 0);
    const headMat = new THREE.MeshStandardMaterial({ color: 0x6a4526, roughness: 0.95 });
    const heads = new THREE.InstancedMesh(headGeo, headMat, 40);
    for (let i = 0; i < 110; i++) {
      const a = rng() * Math.PI * 2;
      const r = POND.r + 0.15 + rng() * 0.8;
      const x = POND.x + Math.cos(a) * r, z = POND.z + Math.sin(a) * r;
      const s = 0.7 + rng() * 0.8;
      e.set((rng() - 0.5) * 0.2, rng() * 3, (rng() - 0.5) * 0.2); q.setFromEuler(e);
      m4.compose(new THREE.Vector3(x, groundHeight(x, z), z), q, new THREE.Vector3(s, s, s));
      reeds.setMatrixAt(i, m4);
      if (i < 40) heads.setMatrixAt(i, m4);
    }
    reeds.castShadow = true;
    this.scene.add(reeds, heads);
  }

  _ambientLife(rng) {
    const mkPoints = (count, gen, size, color, blink) => {
      const pos = new Float32Array(count * 3);
      const phase = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const [x, y, z] = gen(i);
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
        phase[i] = rng() * 10;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
      const m = new THREE.ShaderMaterial({
        uniforms: {
          uTime: this.uniforms.uTime, uMap: { value: glowSprite() },
          uColor: { value: new THREE.Color(color) }, uSize: { value: size }, uBlink: { value: blink },
        },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: /* glsl */`
          attribute float aPhase;
          uniform float uTime, uSize, uBlink;
          varying float vA;
          void main() {
            vec3 p = position;
            p.x += sin(uTime * 0.5 + aPhase) * 0.6;
            p.y += sin(uTime * 0.8 + aPhase * 2.0) * 0.3;
            p.z += cos(uTime * 0.4 + aPhase) * 0.6;
            vA = uBlink > 0.5 ? (0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * 2.2 + aPhase * 7.0), 3.0)) : 0.18;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_PointSize = min(uSize * (140.0 / -mv.z), uSize * 5.0);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */`
          uniform sampler2D uMap;
          uniform vec3 uColor;
          varying float vA;
          void main() {
            vec4 t = texture2D(uMap, gl_PointCoord);
            gl_FragColor = vec4(uColor, 1.0) * t * vA;
          }`,
      });
      const pts = new THREE.Points(g, m);
      pts.frustumCulled = false;
      this.scene.add(pts);
    };
    mkPoints(64, () => {
      const a = rng() * Math.PI * 2, r = POND.r + rng() * 8;
      return [POND.x + Math.cos(a) * r, 0.5 + rng() * 1.8, POND.z + Math.sin(a) * r];
    }, 3.0, 0xd8ff9a, 1);
    mkPoints(90, () => [(rng() - 0.5) * 40, 0.3 + rng() * 3.2, (rng() - 0.5) * 40], 1.4, 0xffd9a0, 0);

    this.birds = [];
    const birdMat = new THREE.MeshBasicMaterial({ color: 0x2a2028, side: THREE.DoubleSide });
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      const w1 = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.22), birdMat);
      w1.position.x = -0.4; w1.rotation.z = 0.3;
      const w2 = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.22), birdMat);
      w2.position.x = 0.4; w2.rotation.z = -0.3;
      g.add(w1, w2);
      g.userData = { a: rng() * 6, r: 30 + rng() * 14, h: 22 + rng() * 8, s: 0.05 + rng() * 0.04, w1, w2 };
      this.scene.add(g);
      this.birds.push(g);
    }
  }

  update(dt) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    for (const l of this.lanterns) {
      l.light.intensity = l.base * (0.86 + 0.14 * Math.sin(this.time * 9 + l.phase) * Math.sin(this.time * 3.7 + l.phase * 2));
    }
    for (const b of this.birds) {
      const u = b.userData;
      u.a += dt * u.s;
      b.position.set(Math.cos(u.a) * u.r, u.h + Math.sin(u.a * 3) * 1.2, Math.sin(u.a) * u.r);
      b.rotation.y = -u.a;
      const flap = Math.sin(this.time * 9 + u.r) * 0.5;
      u.w1.rotation.z = 0.3 + flap;
      u.w2.rotation.z = -0.3 - flap;
    }
  }
}