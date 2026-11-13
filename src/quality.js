/** 画质档纯数据：供 Engine / World 与单测共用，不改玩法数值。 */
export const QUALITY = {
  high: {
    id: 'high',
    grass: 20000,
    shadow: 2048,
    bloomStrength: 0.38,
    bloomRadius: 0.7,
    bloomThreshold: 0.82,
    bloomEnabled: true,
    pixelCap: 1.75,
  },
  medium: {
    id: 'medium',
    grass: 9000,
    shadow: 1024,
    bloomStrength: 0.18,
    bloomRadius: 0.55,
    bloomThreshold: 0.88,
    bloomEnabled: true,
    pixelCap: 1.2,
  },
};

/** 软件渲染强制 medium 的草/阴影，并关闭 Bloom、像素比 cap 0.75。 */
export function resolveQuality(q = 'high', software = false) {
  const base = q === 'medium' ? QUALITY.medium : QUALITY.high;
  if (!software) return { ...base };
  return {
    ...QUALITY.medium,
    bloomStrength: 0,
    bloomEnabled: false,
    pixelCap: 0.75,
    software: true,
  };
}

export const MUSIC = {
  playGain: 0.5,
  duckGain: 0.0001,
  duckTimeConstant: 0.15,
};

/** 战斗进行时满音量；暂停/商店/天赋鸭音；标题与结算由 stopMusic 处理。 */
export function musicTargetGain(state) {
  if (state === 'playing') return MUSIC.playGain;
  if (state === 'paused' || state === 'shop' || state === 'talent') return MUSIC.duckGain;
  return 0;
}
