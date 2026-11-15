import * as THREE from 'three';
import { LOOT_ITEMS } from './rules.js';
import { getProtection } from './subscriptions.js';
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
  const glowColor = it?.color ?? 0xff8070;
  if (kind === 'protection') {
    const shell = material(it.color, { metalness: 0.18 });
    const screen = material(0x20303b, { emissive: it.color, emissiveIntensity: 0.12 });
    const light = material(0xfff2d8, { emissive: it.color, emissiveIntensity: 0.4 });
    if (it.id === 'us_phone') {
      // 只有空白屏幕与抽象线条；不存在电话号码或账号数据。
      box(0.24, 0.42, 0.065, shell).castShadow = true;
      box(0.19, 0.29, 0.012, screen, 0, 0.015, 0.04);
      box(0.065, 0.013, 0.014, light, 0, 0.175, 0.04);
      box(0.09, 0.015, 0.016, light, 0, -0.176, 0.04);
      box(0.11, 0.025, 0.016, shell, 0, 0.035, 0.05);
    } else if (it.id === 'us_credit') {
      box(0.49, 0.3, 0.045, shell).castShadow = true;
      box(0.49, 0.055, 0.009, screen, 0, 0.07, 0.028);
      box(0.085, 0.065, 0.014, light, -0.13, -0.04, 0.029);
      box(0.12, 0.018, 0.012, screen, 0.1, -0.08, 0.03);
    } else if (it.id === 'us_ip') {
      box(0.42, 0.16, 0.28, shell).castShadow = true;
      box(0.44, 0.025, 0.29, screen, 0, 0.085);
      for (const side of [-1, 1]) {
        const antenna = mesh(new THREE.CylinderGeometry(0.017, 0.022, 0.28, 8), screen, side * 0.16, 0.21, -0.08);
        antenna.rotation.z = -side * 0.18;
      }
      for (let i = 0; i < 3; i++) box(0.025, 0.025, 0.012, light, -0.09 + i * 0.07, 0.005, 0.147);
    } else if (it.id === 'kyc') {
      box(0.35, 0.43, 0.045, shell).castShadow = true;
      box(0.28, 0.3, 0.01, screen, 0, -0.025, 0.029);
      box(0.09, 0.025, 0.016, light, 0, 0.17, 0.031);
      const portrait = mesh(new THREE.SphereGeometry(0.045, 10, 8), light, -0.065, 0.038, 0.039);
      portrait.scale.z = 0.3;
      box(0.1, 0.045, 0.012, light, -0.065, -0.035, 0.038);
      const checkA = box(0.045, 0.018, 0.014, shell, 0.055, -0.05, 0.04);
      checkA.rotation.z = -0.7;
      const checkB = box(0.09, 0.018, 0.014, shell, 0.095, -0.036, 0.04);
      checkB.rotation.z = 0.8;
    }
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
  let it = null;
  if (kind === 'loot') {
    if (typeof item !== 'string' || !Object.hasOwn(lootById, item)) return null;
    it = lootById[item];
  } else if (kind === 'protection') {
    it = getProtection(item);
    if (!it) return null;
  } else if (kind !== 'health') return null;
  // 9 种福利 + 4 种保护 + 回血；无弹药箱，也不提供免费 Token 补给。
  const key = it ? `${kind}:${it.id}` : kind;
  if (!templates.has(key)) templates.set(key, buildTemplate(kind, it));
  return templates.get(key).clone(true);
}
