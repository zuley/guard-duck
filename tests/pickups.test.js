import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdditiveBlending, Texture } from 'three';
import { LOOT_ITEMS } from '../src/rules.js';
import { glowSprite, textTexture } from '../src/textures.js';

// 模型模板只需要贴图尺寸；不创建 canvas、DOM 或 WebGL 上下文。
vi.mock('../src/textures.js', async () => {
  const { Texture } = await import('three');
  return {
    glowSprite: vi.fn(() => new Texture({ width: 64, height: 64 })),
    textTexture: vi.fn((text, color, size) => {
      const texture = new Texture({ width: text.length * size, height: size });
      texture.name = text;
      return texture;
    }),
  };
});

const cases = [...LOOT_ITEMS.map((item) => ['loot', item.id]), ['ammo'], ['health']];
const nodesOf = (root) => {
  const nodes = [];
  root.traverse((node) => nodes.push(node));
  return nodes;
};
const transformsOf = (root) => nodesOf(root).map((node) => ({
  position: node.position.toArray(), quaternion: node.quaternion.toArray(), scale: node.scale.toArray(),
}));
function resourcesOf(visuals) {
  const geometries = new Set(), materials = new Set(), maps = new Set();
  for (const visual of visuals) for (const node of nodesOf(visual)) {
    if (node.geometry) geometries.add(node.geometry);
    for (const material of [].concat(node.material || [])) {
      materials.add(material);
      if (material.map) maps.add(material.map);
    }
  }
  return { geometries, materials, maps };
}

let makePickupVisual;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ({ makePickupVisual } = await import('../src/pickups.js'));
});

describe('makePickupVisual 有限共享模板', () => {
  it('9 种福利和弹药/回血都生成有效模型，福利带正确标签与光晕颜色', () => {
    expect(cases).toHaveLength(11);
    for (const [kind, id] of cases) {
      const visual = makePickupVisual(kind, id);
      const nodes = nodesOf(visual);
      expect(visual.isGroup).toBe(true);
      expect(visual.parent).toBeNull();
      expect(nodes.some((node) => node.isMesh && node.geometry.attributes.position.count > 0)).toBe(true);
      const sprites = nodes.filter((node) => node.isSprite);
      expect(sprites).toHaveLength(kind === 'loot' ? 2 : 1);
      for (const sprite of sprites) {
        expect(sprite.material.map).toBeInstanceOf(Texture);
        expect(sprite.material.map.image.width).toBeGreaterThan(0);
        expect(sprite.material.map.image.height).toBeGreaterThan(0);
      }
      const item = LOOT_ITEMS.find((entry) => entry.id === id);
      const glow = sprites.find((sprite) => sprite.material.blending === AdditiveBlending);
      expect(glow.material.color.getHex()).toBe(item?.color ?? (kind === 'ammo' ? 0xffd95e : 0xff8070));
      if (item) {
        const label = sprites.find((sprite) => sprite.renderOrder === 1);
        expect(label.material.map.name).toBe(item.label);
        expect(label.scale.x / label.scale.y).toBeCloseTo(label.material.map.image.width / label.material.map.image.height);
        expect(textTexture).toHaveBeenCalledWith(item.label, '#' + item.color.toString(16).padStart(6, '0'), 32);
      }
    }
    expect(glowSprite).toHaveBeenCalledTimes(11);
    expect(textTexture).toHaveBeenCalledTimes(9);
  });

  it('每种掉落仅主体投射阴影，丝带/杯盖/文字等装饰不投影', () => {
    for (const args of cases) {
      const nodes = nodesOf(makePickupVisual(...args));
      const meshes = nodes.filter((node) => node.isMesh);
      expect(meshes.length).toBeGreaterThan(1);
      const casters = nodes.filter((node) => node.castShadow);
      expect(casters).toHaveLength(1);
      expect(casters[0]).toBe(meshes[0]);
    }
  });

  it('未知/缺失 kind 或福利 id（含继承属性名）返回 null，不分配模板资源', () => {
    for (const [kind, id] of [
      [undefined], [null], [''], ['unknown', 'subsidy'], ['subsidy'],
      ['loot'], ['loot', ''], ['loot', null], ['loot', 'missing'], ['loot', 'neck'],
      ['loot', 'toString'], ['loot', 'constructor'], ['loot', '__proto__'],
    ]) expect(makePickupVisual(kind, id)).toBeNull();
    expect(glowSprite).not.toHaveBeenCalled();
    expect(textTexture).not.toHaveBeenCalled();
  });

  it('同种类生成独立场景节点，但几何体、材质与贴图引用全部共享', () => {
    for (const args of cases) {
      const first = nodesOf(makePickupVisual(...args));
      const second = nodesOf(makePickupVisual(...args));
      expect(second).toHaveLength(first.length);
      first.forEach((node, index) => {
        const clone = second[index];
        expect(clone).not.toBe(node);
        expect(clone.geometry).toBe(node.geometry);
        expect(clone.material).toBe(node.material);
        if (node.material?.map) expect(clone.material.map).toBe(node.material.map);
      });
    }
    expect(glowSprite).toHaveBeenCalledTimes(11);
    expect(textTexture).toHaveBeenCalledTimes(9);
  });

  it('移动/旋转/缩放一个实例及子节点不影响另一实例或之后生成的模板克隆', () => {
    for (const args of cases) {
      const first = makePickupVisual(...args), second = makePickupVisual(...args);
      const original = transformsOf(second);
      for (const node of nodesOf(first)) {
        node.position.addScalar(5);
        node.rotation.set(0.4, 0.7, 1.1);
        node.scale.multiplyScalar(2);
      }
      expect(transformsOf(second)).toEqual(original);
      expect(transformsOf(makePickupVisual(...args))).toEqual(original);
    }
  });

  it('反复生成全部种类后资源集合不增长，贴图工厂只为每个有限模板调用一次', () => {
    const initial = cases.map((args) => makePickupVisual(...args));
    const before = resourcesOf(initial);
    const repeated = [];
    for (let round = 0; round < 20; round++) for (const args of cases) repeated.push(makePickupVisual(...args));
    const after = resourcesOf([...initial, ...repeated]);
    for (const name of ['geometries', 'materials', 'maps']) {
      expect(before[name].size).toBeGreaterThan(0);
      expect(after[name].size).toBe(before[name].size);
      expect([...after[name]].every((resource) => before[name].has(resource))).toBe(true);
    }
    expect(glowSprite).toHaveBeenCalledTimes(11);
    expect(textTexture).toHaveBeenCalledTimes(9);
  });
});
