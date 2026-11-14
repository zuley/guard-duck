// 测评修复验证脚本：每项断言 = 修复后的期望行为，全部 PASS 才算处理完成
// 运行：先 npm run dev，再 node scripts/playtest.mjs
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import WebSocket from 'ws';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:5173/?q=medium';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync('shots/playtest', { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--hide-scrollbars', '--window-size=1280,720',
  '--remote-debugging-port=9223', '--user-data-dir=D:/Code/swyy/shots/.playtest-profile',
  'about:blank',
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map();
const pageErrors = [];

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9223/json/list');
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
        ws.on('message', (data) => {
          const m = JSON.parse(data);
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
          if (m.method === 'Runtime.exceptionThrown')
            pageErrors.push('EXC: ' + JSON.stringify(m.params.exceptionDetails.exception?.description || m.params));
          if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
            pageErrors.push('CONSOLE: ' + m.params.args.map((a) => a.value || a.description).join(' '));
        });
        return;
      }
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error('chrome not reachable');
}

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
  return r.result.result.value;
}

async function key(code, vk, down = true) {
  await send('Input.dispatchKeyEvent', {
    type: down ? 'keyDown' : 'keyUp', code, key: code === 'Space' ? ' ' : code.replace('Key', '').toLowerCase(),
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
}
async function tap(code, vk) { await key(code, vk, true); await key(code, vk, false); }
async function mouse(type, x, y, button = 'left') {
  await send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: 1 });
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`shots/playtest/${name}.png`, Buffer.from(r.result.data, 'base64'));
}
async function waitGameTime(sec, timeoutMs = 60000) {
  const t0 = await ev('window.__game.time');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await ev(`(() => ({ t: window.__game.time, st: window.__game.state }))()`);
    if (s.st === 'paused') await ev('window.__game.resume()');
    if (s.t - t0 >= sec) return true;
    await sleep(250);
  }
  return false;
}

const findings = [];
function check(id, title, ok, detail) {
  findings.push({ id, title, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${title}\n    ${detail}`);
}

async function ensurePlaying() {
  await send('Page.bringToFront').catch(() => {});
  const st = await ev('window.__game.state');
  if (st === 'paused') await ev('window.__game.resume()');
  if (st === 'title' || st === 'over') await ev('window.__game.start()');
  if (st === 'shop') await ev('window.__game.closeShop()');
  if (st === 'talent') await ev('window.__game.closeTalents()');
  await sleep(120);
}
const clearKeys = () => ev('window.__game.keys.clear(); window.__game.mouse.down = false; window.__game.mouseFire = false;');

try {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL });
  await send('Page.bringToFront');
  for (let i = 0; i < 80; i++) {
    if (await ev('!!window.__game').catch(() => false)) break;
    await sleep(500);
  }
  await sleep(1500);

  // ---------- V1 商店空格购买后关店不再自动冲刺 ----------
  await ev('window.__game.start()');
  await sleep(300);
  await ev('window.__game.coins = 500');
  await tap('KeyB', 66);
  await sleep(200);
  const v1mid = await ev(`(() => { const g = window.__game;
    const tile = document.querySelector('#buyPane .tile');
    tile.focus();
    tile.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }));
    return { coins: g.coins, spaceInKeys: g.keys.has('Space') }; })()`);
  await tap('KeyB', 66);
  await sleep(300);
  const v1after = await ev(`(() => ({ coins: window.__game.coins, dashCd: window.__game.p.dashCd, dashT: window.__game.p.dashT }))()`);
  check('V1', '商店空格购买正常，关店不再残留冲刺',
    v1mid.coins < 500 && !v1mid.spaceInKeys && v1after.dashCd === 0 && v1after.dashT === 0,
    `购买发生 coins 500→${v1after.coins}；keys含Space=${v1mid.spaceInKeys}；关店后 dashCd=${v1after.dashCd.toFixed(2)}`);

  // ---------- V2 商店内 Q/E 不再切枪 ----------
  await ensurePlaying();
  await ev('window.__game.coins = 2000; window.__game.buyGood("shotgun")');
  await sleep(150);
  await tap('KeyB', 66);
  await sleep(150);
  const v2before = await ev('window.__game.gunId');
  await tap('KeyE', 69);
  await sleep(150);
  const v2after = await ev(`(() => ({ gun: window.__game.gunId, state: window.__game.state }))()`);
  check('V2', '商店打开时 Q/E 被屏蔽',
    v2after.state === 'shop' && v2after.gun === v2before,
    `商店中按 E：${v2before} → ${v2after.gun}（应不变）`);
  await tap('KeyB', 66);
  await sleep(150);

  // ---------- V3 切窗暂停清空鼠标/按键 ----------
  await ensurePlaying();
  await mouse('mousePressed', 640, 300);
  await sleep(100);
  await ev(`window.dispatchEvent(new Event('blur'))`);
  await sleep(150);
  const v3paused = await ev(`(() => ({ down: window.__game.mouse.down, fire: window.__game.mouseFire, state: window.__game.state }))()`);
  await ev('window.__game.resume()');
  await sleep(200);
  const v3after = await ev(`(() => ({ down: window.__game.mouse.down, state: window.__game.state }))()`);
  check('V3', '按住鼠标切窗：暂停即清输入，恢复后不自动开火',
    v3paused.state === 'paused' && !v3paused.down && !v3after.down,
    `blur 后 mouse.down=${v3paused.down}，resume 后=${v3after.down}`);
  await mouse('mouseReleased', 640, 300);

  await ensurePlaying();
  await key('KeyW', 87, true);
  await sleep(100);
  await ev(`window.dispatchEvent(new Event('blur'))`);
  await sleep(150);
  await ev('window.__game.resume()');
  await sleep(150);
  const v3b = await ev(`window.__game.keys.has('KeyW')`);
  check('V3b', '按住 W 切窗：恢复后不自动前进', v3b === false, `resume 后 keys 含 KeyW=${v3b}`);
  await key('KeyW', 87, false);

  // ---------- V4 手柄接入鼠标仍可用 ----------
  await ensurePlaying();
  await clearKeys();
  await ev(`(() => {
    window.__realGetGamepads = navigator.getGamepads.bind(navigator);
    const fake = { buttons: Array.from({length: 17}, () => ({ pressed: false })), axes: [0, 0, 0, 0], connected: true };
    navigator.getGamepads = () => [fake];
  })()`);
  await ev(`(() => { const g = window.__game; g.p.mag = 24; g.p.reserve = 96; g.p.fireT = 0; g.p.reloadT = 0; })()`);
  const v4shots0 = await ev('window.__game.shots');
  await mouse('mousePressed', 640, 300);
  await waitGameTime(0.5);
  const v4 = await ev(`(() => ({ down: window.__game.mouse.down, shots: window.__game.shots }))()`);
  await mouse('mouseReleased', 640, 300);
  await ev('navigator.getGamepads = window.__realGetGamepads');
  check('V4', '手柄接入（不碰）时鼠标左键仍可射击',
    v4.down === true && v4.shots > v4shots0,
    `按住鼠标 0.5 游戏秒：mouse.down=${v4.down}，子弹 ${v4shots0}→${v4.shots}`);

  // ---------- V5 Boss 预警独立通道不被技能 toast 覆盖 ----------
  await ensurePlaying();
  const bossFound = await ev(`(() => { const g = window.__game;
    g.talents = { t_hp: 1 }; g.level = Math.max(g.level, 3); g.recomputeLoadout();
    g.nextWave(); g.spawnQueue = [];
    g.spawnEnemy('boss');
    return g.enemies.some(e => e.type === 'boss' && !e.dead); })()`);
  if (bossFound) {
    await ev(`(() => { const b = window.__game.enemies.find(e => e.type === 'boss'); b.skillCd = 0; })()`);
    let warnSeen = false;
    for (let i = 0; i < 30; i++) {
      warnSeen = await ev(`document.getElementById('alertBanner').textContent.includes('全图冲击波')`);
      if (warnSeen) break;
      await sleep(100);
    }
    await ev('window.__game.castSkill(2)');
    await sleep(80);
    const v5 = await ev(`(() => ({ toast: document.getElementById('toast').textContent,
      alert: document.getElementById('alertBanner').textContent,
      alertShown: document.getElementById('alertBanner').classList.contains('show'),
      bossWindup: window.__game.enemies.find(e => e.type === 'boss')?.skillT > 0 }))()`);
    check('V5', 'Boss 预警走独立通道，技能提示无法覆盖',
      warnSeen && v5.bossWindup && v5.alertShown && v5.alert.includes('全图冲击波') && v5.toast.includes('蹲防'),
      `toast="${v5.toast}"，alert="${v5.alert}"（独立显示=${v5.alertShown}）`);
    await shot('v5-boss-alert');
  } else check('V5', 'Boss 预警独立通道', false, 'Boss 未出生');

  // ---------- V6 弹药耗尽提示 + 紧急补给 ----------
  await ensurePlaying();
  const v6 = await ev(`(() => { const g = window.__game;
    g.p.mag = 0; g.p.reserve = 0; g.dryT = 0; g.rescued = false;
    g.startReload();
    return { reloadT: g.p.reloadT }; })()`);
  await sleep(150);
  const v6hint = await ev(`document.getElementById('reloadHint').textContent`);
  check('V6a', '0 备弹时 HUD 提示改为「弹药耗尽」而非「按 R」',
    v6.reloadT === 0 && v6hint.includes('弹药耗尽'),
    `startReload 无效(reloadT=${v6.reloadT})，HUD 提示="${v6hint}"`);
  // 补给箱掉在脚边会被立即拾取，验证备弹实际到账
  const v6r0 = await ev('window.__game.p.reserve');
  await ev(`(() => { const g = window.__game; g.dryT = 6.1; })()`);
  await waitGameTime(0.5);
  const v6b = await ev(`(() => ({ reserve: window.__game.p.reserve, rescued: window.__game.rescued, dryT: +window.__game.dryT.toFixed(1) }))()`);
  check('V6b', '弹药死锁 6 秒后紧急补给到账（备弹 +48）',
    v6b.reserve >= v6r0 + 48 && v6b.rescued,
    `备弹 ${v6r0}→${v6b.reserve}，rescued=${v6b.rescued}`);

  // ---------- V7 朝天瞄准沿当前朝向延伸 ----------
  await ensurePlaying();
  await clearKeys();
  await ev(`(() => { const g = window.__game; g.p.mag = 24; g.p.reserve = 96; g.p.aimYaw = 0; })()`);
  await mouse('mouseMoved', 640, 5);
  await sleep(300);
  const v7 = await ev(`(() => { const g = window.__game;
    const dx = g.aimPoint.x - g.p.pos.x, dz = g.aimPoint.z - g.p.pos.z;
    const len = Math.hypot(dx, dz);
    return { len: +len.toFixed(1), yaw: +g.p.aimYaw.toFixed(2),
      along: len > 1 ? +((Math.sin(g.p.aimYaw) * dx + Math.cos(g.p.aimYaw) * dz) / len).toFixed(2) : 0 }; })()`);
  check('V7', '射线朝天时瞄准点沿当前朝向延伸（不再硬跳正北）',
    v7.len > 8 && v7.along > 0.95,
    `瞄准距离=${v7.len}m，与朝向夹角余弦=${v7.along}（1=完全同向）`);
  await mouse('mouseMoved', 640, 360);

  // ---------- V8 近战隔着谷仓拐角不再命中 ----------
  await ensurePlaying();
  const v8 = await ev(`(() => { const g = window.__game;
    const barn = g.world.colliders.find(c => c.hx !== undefined);
    if (!barn) return { skip: true };
    for (const e of g.enemies) { e.dead = true; e.duck.deathT = 9; }
    g.spawnQueue = [];
    if (!g.plan) { g.nextWave(); g.spawnQueue = []; }
    g.spawnEnemy('clubber');
    const e = g.enemies[g.enemies.length - 1];
    g.p.pos.set(9.6, 0, -10.6); g.p.vel.set(0,0,0);
    e.pos.set(8.7, 0, -11.6); e.speed = 0; e.vel.set(0,0,0); e.radius = 0.01;
    g.p.hp = g.p.maxHp; g.p.iframes = 0; g.p.lastHurt = g.time;
    e.windup = 0.4; e.attackT = 9;
    return { skip: false, hpBefore: g.p.hp }; })()`);
  if (!v8.skip) {
    await sleep(2500);
    const v8after = await ev(`(() => ({ hp: window.__game.p.hp, maxHp: window.__game.p.maxHp }))()`);
    check('V8', '近战挥击被谷仓拐角掩体挡住',
      v8after.hp === v8.hpBefore,
      `隔拐角挥击后 hp ${v8.hpBefore}→${v8after.hp}（应不变；视线判定生效）`);
  } else check('V8', '近战掩体', false, '未找到矩形碰撞体');

  // ---------- V9 换弹音效按实际时长缩放（代码路径） ----------
  await ensurePlaying();
  const v9 = await ev(`(() => { const g = window.__game;
    g.gear.gloves = 3; g.recomputeLoadout();
    let arg = null; const orig = g.audio.reload.bind(g.audio);
    g.audio.reload = (t) => { arg = t; return orig(t); };
    g.p.mag = 1; g.startReload();
    g.audio.reload = orig;
    const rt = g.loadout.reloadTime;
    g.gear.gloves = 0; g.recomputeLoadout(); g.p.reloadT = 0;
    return { arg, rt }; })()`);
  check('V9', '换弹音效接收实际换弹时长（手套缩短后 <1.6s 基准）',
    Math.abs(v9.arg - v9.rt) < 0.01 && v9.rt < 1.6,
    `audio.reload(${v9.arg})，reloadTime=${v9.rt.toFixed(2)}s（音效节点按 k=时长/1.6 等比排程）`);

  // ---------- V10 备弹共享明示 ----------
  const v10 = await ev(`(async () => { const r = await import('/src/rules.js');
    return r.shopCatalog().find(x => x.id === 'ammo').desc; })()`);
  check('V10', '子弹箱描述明示「全枪通用」',
    v10.includes('全枪通用'), `desc="${v10}"`);

  // ---------- V11 死亡结算延迟可跳过 ----------
  await ensurePlaying();
  await ev(`(() => { const g = window.__game; g.p.iframes = 0; g.p.shieldT = 0; g.damagePlayer(99999); })()`);
  await sleep(200);
  const v11before = await ev(`document.getElementById('gameoverScreen').classList.contains('hidden')`);
  await tap('KeyB', 66);
  await sleep(150);
  const v11after = await ev(`document.getElementById('gameoverScreen').classList.contains('hidden')`);
  check('V11', '死亡延迟期内按键立即跳过出结算',
    v11before === true && v11after === false,
    `按键前结算屏隐藏=${v11before}，按键后隐藏=${v11after}`);
  await shot('v11-gameover');

  // ---------- V12 纪录分模式 + 0 分不占坑 + 平纪录算新纪录 ----------
  await ev(`(() => { localStorage.removeItem('swyy_best'); localStorage.removeItem('swyy_best_bot'); localStorage.removeItem('swyy_best_fragile'); })()`);
  await ev('window.__game.start()');
  await sleep(200);
  await ev(`(() => { const g = window.__game; g.p.iframes = 0; g.p.shieldT = 0; g.damagePlayer(99999); })()`);
  await sleep(200);
  const v12a = await ev(`localStorage.getItem('swyy_best')`);
  await ev('window.__game.start()');
  await sleep(200);
  await ev(`(() => { const g = window.__game; g.score = 100; g.p.iframes = 0; g.p.shieldT = 0; g.damagePlayer(99999); })()`);
  await sleep(200);
  const v12b = await ev(`(() => ({ best: localStorage.getItem('swyy_best'), badge: !document.getElementById('recordBadge').classList.contains('hidden') }))()`);
  await ev('window.__game.start()');
  await sleep(200);
  await ev(`(() => { const g = window.__game; g.score = 100; g.p.iframes = 0; g.p.shieldT = 0; g.damagePlayer(99999); })()`);
  await sleep(200);
  const v12c = await ev(`(() => ({ badge: !document.getElementById('recordBadge').classList.contains('hidden') }))()`);
  await ev(`(() => { const g = window.__game; g.bot = true; g.start(); g.score = 99999; g.p.iframes = 0; g.damagePlayer(99999); })()`);
  await sleep(200);
  const v12d = await ev(`(() => ({ normal: localStorage.getItem('swyy_best'), bot: localStorage.getItem('swyy_best_bot') }))()`);
  check('V12', '0 分不写纪录；平纪录算新纪录；bot/fragile 分档',
    v12a === null && JSON.parse(v12b.best).score === 100 && v12b.badge && v12c.badge
      && JSON.parse(v12d.normal).score === 100 && JSON.parse(v12d.bot).score === 99999,
    `0分死亡后 best=${v12a}；100分首纪录徽章=${v12b.badge}；平100分徽章=${v12c.badge}；bot 99999 分后 normal=${v12d.normal} bot档=${v12d.bot}`);
  await ev('window.__game.bot = false; window.__game.start()');
  await sleep(200);

  // ---------- V13 手柄菜单导航 + A 购买 ----------
  await ensurePlaying();
  await ev(`(() => { const g = window.__game; g.coins = 500;
    window.__fakePad = { buttons: Array.from({length: 17}, () => ({ pressed: false })), axes: [0, 0, 0, 0], connected: true };
    navigator.getGamepads = () => [window.__fakePad];
    g.openShop(); })()`);
  await sleep(200);
  const v13a = await ev(`(() => { const g = window.__game;
    document.activeElement && document.activeElement.blur();
    window.__fakePad.axes[1] = 0.9; g.pollGamepad(); // 第一次：聚焦首个可交互元素
    const first = document.activeElement;
    window.__fakePad.axes[1] = 0; g.pollGamepad();
    g.padNavT = 0;
    window.__fakePad.axes[1] = 0.9; g.pollGamepad(); // 第二次：向下移动焦点
    window.__fakePad.axes[1] = 0;
    const second = document.activeElement;
    return { first: first ? (first.id || first.dataset.good || first.tagName) : null,
      focused: second ? (second.dataset.good || second.tagName) : null,
      moved: first !== second }; })()`);
  const v13b = await ev(`(() => { const g = window.__game;
    window.__fakePad.buttons[0].pressed = true; g.pollGamepad();
    window.__fakePad.buttons[0].pressed = false; g.pollGamepad();
    return { coins: g.coins, state: g.state }; })()`);
  await ev(`(() => { const g = window.__game;
    window.__fakePad.buttons[1].pressed = true; g.pollGamepad();
    window.__fakePad.buttons[1].pressed = false; g.pollGamepad();
    navigator.getGamepads = window.__realGetGamepads; })()`);
  const v13c = await ev('window.__game.state');
  check('V13', '手柄商店内方向导航 + A 购买 + B 关闭',
    v13a.focused !== null && v13a.moved && v13b.coins < 500 && v13c === 'playing',
    `首个焦点=${v13a.first} → 下移后=${v13a.focused}（moved=${v13a.moved}）；A 确认后 coins 500→${v13b.coins}；B 关闭后 state=${v13c}`);

  // ---------- V14 空格单击单买（防双触发） ----------
  await ensurePlaying();
  await ev('window.__game.coins = 500');
  await tap('KeyB', 66);
  await sleep(200);
  const v14 = await ev(`(() => { const g = window.__game;
    const tile = document.querySelector('#buyPane .tile[data-good="ammo"]');
    tile.focus();
    const e1 = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true });
    tile.dispatchEvent(e1);
    return { coins: g.coins, prevented: e1.defaultPrevented }; })()`);
  await tap('KeyB', 66);
  check('V14', '商店空格购买单次触发且阻止原生激活',
    v14.coins === 440 && v14.prevented,
    `coins 500→${v14.coins}（应只买一次 60），defaultPrevented=${v14.prevented}（原生 click 激活被阻止）`);

  // ---------- V15 GPU 资源不再单调增长 ----------
  await ev('window.__game.bot = false');
  const v15base = await ev(`(() => { const g = window.__game; g.start();
    return g.engine.renderer.info.memory.geometries; })()`);
  for (let i = 0; i < 8; i++) {
    await ev(`(() => { const g = window.__game;
      g.coins = 5000;
      for (const id of ['repeater', 'shotgun', 'longrifle']) if (!g.ownedGuns.includes(id)) g.buyGood(id);
      for (let k = 0; k < 5; k++) g.cycleGun(1);
      for (let k = 0; k < 6; k++) g.spawnEnemy('brawler');
      g.start(); })()`);
    await sleep(200);
  }
  const v15end = await ev(`window.__game.engine.renderer.info.memory.geometries`);
  check('V15', '重开/切枪/刷怪 8 轮后几何体数量稳定（共享缓存）',
    v15end <= v15base + 20,
    `geometries ${v15base}→${v15end}（修复前同操作 +280）`);

  // ---------- V16 自动战斗冒烟（按游戏时间推进，软件渲染帧率低） ----------
  await ev('window.__game.start()');
  await ev('window.__game.bot = true');
  await waitGameTime(10, 180000);
  const v16 = await ev(`(() => { const g = window.__game; return {
    state: g.state, wave: g.wave, kills: g.kills, shots: g.shots, fps: g.engine.fps }; })()`);
  check('V16', '10 游戏秒自动战斗产生射击且无页面错误',
    pageErrors.length === 0 && v16.shots > 0 && v16.wave >= 1,
    `state=${v16.state} wave=${v16.wave} kills=${v16.kills} shots=${v16.shots}；页面错误 ${pageErrors.length} 条${pageErrors.length ? '：' + pageErrors.slice(0, 3).join(' | ') : ''}`);
  await shot('v16-combat');

  // ---------- V17 波次构成平滑递减 ----------
  const v17 = await ev(`(async () => { const r = await import('/src/rules.js');
    const bs = []; for (let w = 2; w <= 16; w++) bs.push(r.wavePlan(w).counts.brawler);
    const monotonic = bs.every((v, i) => i === 0 || v <= bs[i - 1]);
    return { w5: r.wavePlan(5).counts.brawler, w9: r.wavePlan(9).counts.brawler, w16: r.wavePlan(16).counts.brawler, monotonic }; })()`);
  check('V17', '杂兵数量随波次平滑递减（不再第5波骤降钳底）',
    v17.w5 > v17.w9 && v17.w9 > v17.w16 && v17.monotonic,
    `brawler w5=${v17.w5} w9=${v17.w9} w16=${v17.w16}，单调递减=${v17.monotonic}`);

  // ---------- V18 子弹落水即停 ----------
  const v18 = await ev(`(() => { const g = window.__game;
    const V = g.p.pos.constructor; // THREE.Vector3
    for (const b of g.bullets) if (b.vis) g.engine.scene.remove(b.vis);
    g.bullets.length = 0;
    g.bullets.push({ pos: new V(-13, 0.2, -13), vel: new V(0, -8, 0), life: 1, traveled: 0, dmg: 1 });
    g.updateBullets(0.05);
    return { left: g.bullets.length }; })()`);
  const v18b = await ev(`(async () => { const w = await import('/src/world.js');
    return { pond: w.waterSurfaceAt(-13, -13), land: w.waterSurfaceAt(0, 0) }; })()`);
  check('V18', '子弹落入池塘在水面即停（不再沉底）',
    v18.left === 0 && v18b.pond === -0.26 && v18b.land === null,
    `水面高度=${v18b.pond}（陆地=${v18b.land}），下落子弹一帧后剩余=${v18.left}`);

  // ---------- V19 音量控制 ----------
  await ev('window.__game.pause()');
  await sleep(200);
  const v19 = await ev(`(() => { const g = window.__game;
    const slider = document.getElementById('volumeSlider');
    slider.value = '30'; slider.dispatchEvent(new Event('input', { bubbles: true }));
    const v1 = g.audio.volume, gain1 = g.audio.master ? g.audio.master.gain.value : null;
    document.getElementById('muteBtn').click();
    const muted = g.audio.muted, gain2 = g.audio.master ? g.audio.master.gain.value : null;
    document.getElementById('muteBtn').click();
    const stored = localStorage.getItem('swyy_volume');
    return { v1, gain1, muted, gain2, unmuted: !g.audio.muted, stored,
      sliderVisible: !!slider && slider.closest('#pauseScreen') !== null }; })()`);
  check('V19', '暂停菜单音量滑条 + 静音按钮 + 持久化',
    v19.sliderVisible && Math.abs(v19.v1 - 0.3) < 0.01 && v19.muted && v19.gain2 === 0 && v19.unmuted && v19.stored === '0.3',
    `滑条30→volume=${v19.v1} gain=${v19.gain1}；静音 gain=${v19.gain2}；取消静音=${v19.unmuted}；localStorage=${v19.stored}`);
  await ev('window.__game.resume()');

  // ---------- 汇总 ----------
  console.log('\n===== 汇总 =====');
  const failed = findings.filter((f) => !f.ok);
  console.log(`${findings.length - failed.length}/${findings.length} 项通过`);
  if (failed.length) for (const f of failed) console.log(`  FAIL [${f.id}] ${f.title}`);
  writeFileSync('shots/playtest/verify.json', JSON.stringify(findings, null, 2));
  process.exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error('PLAYTEST ERROR:', err.message);
  console.error('page errors:', pageErrors.slice(0, 5));
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
}