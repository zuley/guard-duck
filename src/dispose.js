/**
 * GPU 资源释放策略（纯逻辑，可供单测，不依赖 three 运行时）。
 *
 * Three.js 的 Sprite 共用模块级 BufferGeometry（Sprite.js 里的 _geometry）。
 * 若随血条 / 拾取光晕 / 数字一起 dispose，会拆掉场景中全部 Sprite。
 * 子弹本体几何与材质、textures.js 缓存贴图同样不可随单个实体释放。
 */
export function canDisposeGeometry(obj, sharedGeo = new Set()) {
  if (!obj || !obj.geometry) return false;
  if (obj.isSprite) return false;
  if (sharedGeo.has(obj.geometry)) return false;
  return true;
}

export function canDisposeMaterial(mat, sharedMat = new Set()) {
  if (!mat) return false;
  if (sharedMat.has(mat)) return false;
  return true;
}

/** 材质.dispose() 不会释放 map；此处明确禁止动缓存贴图。 */
export function canDisposeTexture(tex, sharedTex = new Set()) {
  if (!tex) return false;
  if (sharedTex.has(tex)) return false;
  return false; // 默认不释放：贴图来自 textures.js 缓存或尚未证明为独占
}
