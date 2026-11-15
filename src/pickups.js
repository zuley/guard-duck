import * as THREE from 'three';
import { LOOT_ITEMS } from './rules.js';
import { glowSprite, textTexture } from './textures.js';

const lootById = Object.fromEntries(LOOT_ITEMS.map((it) => [it.id, it]));
// 种类有限的共享模板：克隆只复制场景节点，几何体、材质和文字贴图始终复用。
// 拾取 / 过期 / 重开时只移除节点，避免每次掉落都新建一套 GPU 资源。
const templates = new Map();

function buildTemplate(kind, it) {
  const group = new THREE.Group();
  const material = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });
  const mesh = (geometry, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geometry, mat);
    m.position.set(x, y, z);
    // 仅主体显式开启投影，装饰仍保留材质受光，避免重复的阴影绘制。
    group.add(m);
    return m;
  };
  const box = (w, h, d, mat, x = 0, y = 0, z = 0) => mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
  const glowColor = it?.color ?? (kind === 'ammo' ? 0xffd95e : 0xff8070);
  if (kind === 'ammo') {
    box(0.44, 0.3, 0.32, material(0x6a5a3a)).castShadow = true;
    box(0.46, 0.1, 0.34, material(0x3a3010, { emissive: 0xffd95e, emissiveIntensity: 1.6 }));
  } else if (kind === 'health') {
    const bread = mesh(new THREE.SphereGeometry(0.22, 14, 10), material(0xe8b464));
    bread.castShadow = true;
    bread.scale.set(1.3, 0.8, 0.9);
    const red = material(0xd03028, { emissive: 0xd03028, emissiveIntensity: 0.8 });
    box(0.2, 0.06, 0.06, red, 0, 0.18);
    box(0.06, 0.06, 0.2, red, 0, 0.18);
  } else if (it.id === 'coffee') {
    const paper = material(0xffedce);
    mesh(new THREE.CylinderGeometry(0.17, 0.13, 0.32, 12), paper).castShadow = true;
    mesh(new THREE.CylinderGeometry(0.185, 0.185, 0.045, 12), material(0x573c2e), 0, 0.18);
    mesh(new THREE.CylinderGeometry(0.159, 0.146, 0.12, 12), material(it.color), 0, -0.015);
    mesh(new THREE.TorusGeometry(0.085, 0.026, 6, 12), paper, 0.17, 0.02);
  } else if (it.id === 'welfare') {
    const wrapping = material(it.color);
    const ribbon = material(0xffe9a8, { metalness: 0.2 });
    box(0.38, 0.32, 0.34, wrapping).castShadow = true;
    box(0.42, 0.06, 0.38, wrapping, 0, 0.18);
    box(0.075, 0.39, 0.355, ribbon);
    box(0.395, 0.39, 0.07, ribbon);
    for (const side of [-1, 1]) {
      const bow = mesh(new THREE.TorusGeometry(0.065, 0.018, 5, 10), ribbon, side * 0.06, 0.24);
      bow.scale.y = 0.6;
    }
  } else {
    // 工资 / 补贴 / 奖金是彩色信封，绩效 / 期权是带金印的纸质凭证。
    const certificate = it.id === 'performance' || it.id === 'stock';
    const paper = material(certificate ? 0xfff2d8 : it.color);
    const ink = material(certificate ? it.color : 0xffedce);
    box(0.5, 0.32, 0.055, paper).castShadow = true;
    if (certificate) {
      box(0.32, 0.026, 0.012, ink, -0.035, 0.075, 0.035);
      box(0.24, 0.018, 0.012, ink, -0.075, 0.012, 0.035);
      box(0.18, 0.018, 0.012, ink, -0.105, -0.043, 0.035);
    } else {
      const flap = new THREE.Shape();
      flap.moveTo(-0.25, 0.16); flap.lineTo(0.25, 0.16); flap.lineTo(0, -0.035); flap.closePath();
      mesh(new THREE.ShapeGeometry(flap), ink, 0, 0, 0.032);
    }
    const seal = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.018, 12), material(0xffc63a, { metalness: 0.55, roughness: 0.35 }), 0.14, -0.07, 0.043);
    seal.rotation.x = Math.PI / 2;
  }
  if (it) {
    const color = '#' + it.color.toString(16).padStart(6, '0');
    const map = textTexture(it.label, color, 32);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false }));
    label.scale.set(0.28 * map.image.width / map.image.height, 0.28, 1);
    label.position.y = 0.47;
    label.renderOrder = 1;
    group.add(label);
  }
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowSprite(), color: glowColor, transparent: true, opacity: 0.4,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  glow.scale.set(1.15, 1.15, 1);
  group.add(glow);
  return group;
}

export function makePickupVisual(kind, item) {
  const it = kind === 'loot' && Object.hasOwn(lootById, item) ? lootById[item] : null;
  if (kind === 'loot' ? !it : kind !== 'ammo' && kind !== 'health') return null;
  const key = it ? `loot:${item}` : kind;
  if (!templates.has(key)) templates.set(key, buildTemplate(kind, it));
  return templates.get(key).clone(true);
}
