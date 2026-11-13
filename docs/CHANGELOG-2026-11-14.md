# 2026-11-14 改动（improve/quality-to-90）

本文件只记录已落地、可用单测或静态检查验证的改动。
**真实浏览器试玩轮数 = 0。** 不给 90 分、不给帧率改善数字、不承诺达到目标。
美术观感、操作手感、经济节奏一律待试玩验收。

## 已做

### 正确性 / UX

- 水面不再留下焦痕（`fx.decal` 与子弹射程耗尽路径改出水花）。
- 精英/Boss 蓄力起手冻结 `skillPos`，蓄力期间原地顿足（`vel = 0`）；预警圈与释放特效/精英践踏判定共用 `skillCenter()`（优先 `skillPos`）。鸭王伤害仍为全图冲击波，只把特效圆心对齐预警圈。
- 表单控件不再被全局 `preventDefault` 吞掉（音量滑条方向键可用）。
- 结算延迟后支持 Enter 再开、Escape 回标题（不用空格，忽略按键重复）。`?autostart` 调用 `audio.init()`。
- 商店展示卡宾「免费」磁贴（`shopCatalog()` 仍排除定价 0，避免把免费枪当成可购项）。
- 标题 / HUD / 结算补充 T、Esc、Enter 提示。F3 额外显示 calls / tris / geos / tex（`white-space: pre`）。

### 资源释放（审查中发现并修正回归）

- 拾取物、弹尾、血条在移除时释放**独占**几何/材质。
- **回归修复**：Three.js `Sprite` 使用模块级共享 `BufferGeometry`。原先 `disposeObject` 见 geometry 就 `dispose()`，第一个血条或拾取光晕被销毁后会拆掉场景中全部 Sprite（玩家血条、换弹条、FX 数字等）。现经 `canDisposeGeometry`：`isSprite` 为真则不释放几何；子弹 `_bulletGeo` / `_tailGeo` / `_bulletMat` 仍走共享集合；`textures.js` 缓存贴图默认不释放（只释放材质）。鸭子几何仍由 `Duck.dispose` 只释放每只鸭独立的 blob 材质。

### 画质切换

- `src/quality.js`：`QUALITY.high|medium` 与 `resolveQuality(q, software)`（返回浅拷贝，不回写常量）。
  - 极致：草 20000、阴影 2048、Bloom 0.38/0.7/0.82 开、像素 cap 1.75。
  - 均衡：草 9000、阴影 1024、Bloom 0.18/0.55/0.88 开、像素 cap 1.2。
  - 软件渲染：即使点「极致」也强制 medium 草/阴影、Bloom 关、cap 0.75。
- `World` 按 20000 建草丛池，切档只改 `InstancedMesh.count`（可逆）。阴影分辨率变化时 `mapSize` 更新后 `shadow.map.dispose()` 并置 `null`，由渲染器按新尺寸重建。标题按钮同时调用 `engine.setQuality` 与 `world.setQuality(..., engine.software)`。构造结束后 `this.quality` 与 `preset.id` 对齐。

### 暂停 BGM

- 暂停 / 商店 / 天赋：`duckMusic` 用 `setTargetAtTime` 把 BGM 降到 0.0001（时间常数 0.15），恢复战斗回到 0.5。`this.t` 即 `AudioContext.currentTime`。不改 master 音量或静音开关。标题与结算仍走 `stopMusic`。

### 临时向量

- 热路径复用实例临时向量（玩家移动/瞄准/开火、敌人追逐与分离、子弹步进、相机跟随、演示 bot）。
- 审查：`marchImpact` 只读坐标，在 `fire()` 覆写 `_muzzle`/`_bdir` 之前已算完落点；敌人循环里 `dirN` / `want` / `_sep`（`.add` 拷贝分量）无危险别名；`_up` 与 `_upWorld` 同为恒定 (0,1,0)，`applyAxisAngle` 不修改轴；子弹 `pos`/`vel` 仍为实体自有分配。

### 测试可移植性

- `scripts/chrome-path.mjs`：Linux + Windows 候选 + `CHROME_PATH`/`CHROME`；user-data-dir 在仓库 `shots/.{profile}`。e2e / playtest 改用该助手。
- 将 `ws` 写入 `devDependencies`（^8.23.0），并在脚本头注释与 README 说明：**本 PR 不运行 CDP / 不启动 Chrome**。先前「`ws` 未写明」的问题已记录并修复依赖，不是靠跑脚本来证明。

## 未做（有意）

- **真实试玩 = 0 轮**（Bot 浏览器无法打开 box 上的 Vite：官方私网/共享出口限制，不绕过）。艺术、手感、经济、Boss 可读性等一律待验收。
- 不改玩法数值、波次上限、经济公式。
- 不拆 `game.js` 大类、不加新模式、不把 chunk 拆包（构建仍有 >500 kB 警告，见下）。
- 不 push 到 `main`、不部署、不 force push、不联系任何人。
- 不为连通浏览器而改端口、关代理或开隧道。

## 测试结果（本机复跑，Asia/Shanghai）

- `npm test`：4 文件，**108 passed**（rules 92 + quality 6 + chrome-path 6 + dispose 4），vitest 3.2.7，约 347 ms。
- `npm run build`：成功。29 modules。`dist/index.html` 32.07 kB（gzip 8.09 kB）；`dist/assets/index-yi2G3J9b.js` **657.23 kB（gzip 176.07 kB）**。
- **已知警告**（未处理）：`(!) Some chunks are larger than 500 kB after minification.` Vite 建议动态 import / `manualChunks` / 调高 `chunkSizeWarningLimit`。本轮不拆包，以免在无试玩反馈时改加载路径。
- 未跑 `scripts/e2e.mjs` / `playtest.mjs`，因此不把历史「96 e2e / 21 playtest」当作本轮已验证结果。
- 不伪造 FPS 或性能提升；画质切换只保证机制（草 count、阴影尺寸、Bloom 开关）由纯逻辑覆盖。

## 网络（试玩阻塞，不是服务挂了）

壳内 curl 对 `127.0.0.1:5173`（仅回环）与 `172.30.0.2:5174`（0.0.0.0）均为 HTTP 200。
Bot 浏览器：前者 connection refused，后者 `net::ERR_HTTP_RESPONSE_CODE_FAILURE`。
官方说明私有/VPN 地址默认拦截：https://docs.x.ai/grok-bot/settings-and-notifications 、https://docs.x.ai/grok-bot/troubleshooting 。
本机 reference 无已验证的「Bot 浏览器打开 box localhost」方法。不要用隧道绕过。
