import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { canDisposeGeometry, canDisposeMaterial, canDisposeTexture } from '../src/dispose.js';

describe('GPU 资源释放策略', () => {
  it('Three.js Sprite 的共享几何不得释放（否则首个血条/拾取销毁会拆掉全部 Sprite）', () => {
    const spriteGeo = { uuid: 'shared-sprite-geo' };
    const sprite = { isSprite: true, geometry: spriteGeo };
    const mesh = { isSprite: false, isMesh: true, geometry: { uuid: 'owned-box' } };
    expect(canDisposeGeometry(sprite)).toBe(false);
    expect(canDisposeGeometry(mesh)).toBe(true);
    expect(canDisposeGeometry({ geometry: null })).toBe(false);
    expect(canDisposeGeometry(null)).toBe(false);
  });

  it('子弹共享几何与材质在 shared 集合中时不得释放', () => {
    const geo = { uuid: 'bullet' };
    const mat = { uuid: 'bullet-mat' };
    const tailMat = { uuid: 'tail-unique' };
    const sharedGeo = new Set([geo]);
    const sharedMat = new Set([mat]);
    expect(canDisposeGeometry({ geometry: geo }, sharedGeo)).toBe(false);
    expect(canDisposeGeometry({ geometry: { uuid: 'other' } }, sharedGeo)).toBe(true);
    expect(canDisposeMaterial(mat, sharedMat)).toBe(false);
    expect(canDisposeMaterial(tailMat, sharedMat)).toBe(true);
    expect(canDisposeMaterial(null)).toBe(false);
  });

  it('默认不释放贴图（textures.js 的 glowSprite 等为全局缓存）', () => {
    const tex = { uuid: 'glow' };
    expect(canDisposeTexture(tex)).toBe(false);
    expect(canDisposeTexture(tex, new Set([tex]))).toBe(false);
  });

  it('game.js 的 disposeObject 走上述策略，而非直接 geometry.dispose()', () => {
    const src = readFileSync(new URL('../src/game.js', import.meta.url), 'utf8');
    expect(src).toContain("from './dispose.js'");
    expect(src).toContain('canDisposeGeometry(c, sharedGeo)');
    expect(src).toContain('canDisposeMaterial(m, sharedMat)');
    // 回归：不得再出现「有 geometry 就 dispose」且不经 Sprite 判断的旧写法
    expect(src).not.toMatch(/if \(c\.geometry && !sharedGeo\.has\(c\.geometry\)\) c\.geometry\.dispose\(\)/);
  });
});
