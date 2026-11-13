import { describe, expect, it } from 'vitest';
import { QUALITY, resolveQuality, MUSIC, musicTargetGain } from '../src/quality.js';

describe('QUALITY 档位', () => {
  it('极致与均衡在草量、阴影分辨率、Bloom 上可区分', () => {
    expect(QUALITY.high.grass).toBe(20000);
    expect(QUALITY.medium.grass).toBe(9000);
    expect(QUALITY.high.shadow).toBe(2048);
    expect(QUALITY.medium.shadow).toBe(1024);
    expect(QUALITY.high.bloomEnabled).toBe(true);
    expect(QUALITY.medium.bloomEnabled).toBe(true);
    expect(QUALITY.high.bloomStrength).toBeGreaterThan(QUALITY.medium.bloomStrength);
    expect(QUALITY.high.pixelCap).toBeGreaterThan(QUALITY.medium.pixelCap);
  });

  it('resolveQuality 在非软件渲染下原样返回对应档', () => {
    const hi = resolveQuality('high', false);
    const mid = resolveQuality('medium', false);
    expect(hi.grass).toBe(20000);
    expect(hi.shadow).toBe(2048);
    expect(hi.bloomEnabled).toBe(true);
    expect(hi.bloomStrength).toBe(QUALITY.high.bloomStrength);
    expect(mid.grass).toBe(9000);
    expect(mid.shadow).toBe(1024);
    expect(mid.pixelCap).toBe(1.2);
    expect(hi.id).toBe('high');
    expect(mid.id).toBe('medium');
  });

  it('软件渲染即使请求 high 也强制 medium 草/阴影，关闭 Bloom，像素比 cap 0.75', () => {
    const q = resolveQuality('high', true);
    expect(q.grass).toBe(QUALITY.medium.grass);
    expect(q.shadow).toBe(QUALITY.medium.shadow);
    expect(q.bloomEnabled).toBe(false);
    expect(q.bloomStrength).toBe(0);
    expect(q.pixelCap).toBe(0.75);
    expect(q.id).toBe('medium');
    expect(q.software).toBe(true);
  });

  it('默认档为 high', () => {
    expect(resolveQuality().id).toBe('high');
    expect(resolveQuality(undefined, false).grass).toBe(20000);
  });
});

describe('BGM 目标音量', () => {
  it('战斗满音量，暂停/商店/天赋鸭音，标题与结算为 0（交给 stopMusic）', () => {
    expect(musicTargetGain('playing')).toBe(MUSIC.playGain);
    expect(musicTargetGain('paused')).toBe(MUSIC.duckGain);
    expect(musicTargetGain('shop')).toBe(MUSIC.duckGain);
    expect(musicTargetGain('talent')).toBe(MUSIC.duckGain);
    expect(musicTargetGain('title')).toBe(0);
    expect(musicTargetGain('over')).toBe(0);
    expect(MUSIC.playGain).toBe(0.5);
    expect(MUSIC.duckGain).toBeLessThan(0.001);
    expect(MUSIC.duckTimeConstant).toBeGreaterThan(0);
  });
});

describe('resolveQuality 纯函数契约', () => {
  it('返回浅拷贝，不得回写 QUALITY 常量（软件强制改 bloom 时尤其重要）', () => {
    const before = { ...QUALITY.high };
    const q = resolveQuality('high', true);
    q.grass = -1;
    q.bloomEnabled = true;
    expect(QUALITY.high).toEqual(before);
    expect(QUALITY.high.grass).toBe(20000);
    expect(QUALITY.high.bloomEnabled).toBe(true);
    // 软件档是新对象
    expect(q).not.toBe(QUALITY.medium);
    expect(q).not.toBe(QUALITY.high);
    const mid = resolveQuality('medium', false);
    expect(mid).not.toBe(QUALITY.medium);
    mid.grass = -2;
    expect(QUALITY.medium.grass).toBe(9000);
  });
});
