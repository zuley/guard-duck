import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import WebSocket from 'ws';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:5173/?autostart&bot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync('shots', { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--hide-scrollbars', '--window-size=800,450',
  '--remote-debugging-port=9222', '--user-data-dir=D:/Code/swyy/shots/.chrome-profile',
  'about:blank',
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map();
const errors = [];

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9222/json/list');
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
        ws.on('message', (data) => {
          const m = JSON.parse(data);
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
          if (m.method === 'Runtime.exceptionThrown')
            errors.push('EXC: ' + JSON.stringify(m.params.exceptionDetails.exception?.description || m.params));
          if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
            errors.push('CONSOLE: ' + m.params.args.map((a) => a.value || a.description).join(' '));
        });
        return;
      }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('chrome devtools not reachable');
}

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
}

async function waitGame(gsec, timeoutMs = 180000) {
  const t0 = (await snap()).time;
  const start = Date.now();
  let lastLog = start;
  while (Date.now() - start < timeoutMs) {
    await sleep(400);
    const s = await snap();
    if (s.state === 'paused' && gsec >= 5) {
      console.log('headless focus quirk: auto-resume');
      await evaluate('window.__game.resume()');
    }
    if (s.state === 'over' && gsec >= 5) {
      console.log('bot died: auto-restart for demo stage');
      await evaluate('window.__game.start()');
    }
    if (Date.now() - lastLog > 10000) {
      lastLog = Date.now();
      console.log('wait progress:', JSON.stringify(s));
    }
    if (s.time - t0 >= gsec) return;
  }
  throw new Error('waitGame timeout: ' + gsec + ' last=' + JSON.stringify(await snap()) + ' errs=' + errors.slice(0, 3).join('|'));
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`shots/${name}.png`, Buffer.from(r.result.data, 'base64'));
  console.log('shot:', name);
}

const snap = () => evaluate(`(() => { const g = window.__game; return {
  state: g.state, wave: g.wave, kills: g.kills, shots: g.shots, hits: g.hits, score: g.score,
  mag: g.p.mag, reserve: g.p.reserve, hp: Math.round(g.p.hp), enemies: g.enemies.length,
  pickups: g.pickups.length, reloadT: +g.p.reloadT.toFixed(2), dashCd: +g.p.dashCd.toFixed(2),
  x: +g.p.pos.x.toFixed(2), z: +g.p.pos.z.toFixed(2), fps: g.engine.fps, time: +g.time.toFixed(2) }; })()`);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function key(code, vk, down = true) {
  await send('Input.dispatchKeyEvent', {
    type: down ? 'keyDown' : 'keyUp', code, key: code === 'Space' ? ' ' : code.replace('Key', '').toLowerCase(),
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
}

async function mouse(type, x, y, button = 'left') {
  await send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: 1 });
}

try {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL });
  await send('Page.bringToFront');
  for (let i = 0; i < 80; i++) {
    if (await evaluate('!!window.__game')) break;
    await sleep(500);
  }
  if (!(await evaluate('!!window.__game'))) throw new Error('game boot failed: ' + errors.join(' | '));
  await evaluate(`(() => { localStorage.removeItem('swyy_best'); window.__game.best = null; return 1; })()`);
  await waitGame(22);

  const s1 = await snap();
  console.log('after 20s bot:', JSON.stringify(s1));
  check('bot 自动战斗产生射击', s1.shots > 0, `shots=${s1.shots}`);
  check('bot 自动战斗产生击杀', s1.kills > 0, `kills=${s1.kills}`);
  check('波次推进或敌人存在', s1.wave >= 1 && (s1.enemies > 0 || s1.kills > 0));
  check('无运行时异常', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('命中率不超过 100%（按弹丸计数）', s1.hits <= s1.shots, `hits=${s1.hits} shots=${s1.shots}`);
  const remainOk = await evaluate(`(() => { const g = window.__game; const expect = g.spawnQueue.length + g.enemies.filter(e => !e.dead).length; return +document.getElementById('statRemain').textContent === expect; })()`);
  check('HUD 剩余敌人计数与实时状态一致', remainOk);
  const musicOn = await evaluate(`(() => { const a = window.__game.audio; a.init(); a.startMusic(); const on = !!a.musicTimer; a.stopMusic(); return on && !a.musicTimer; })()`);
  check('BGM 可启动/停止', musicOn);
  const padOk = await evaluate(`(() => { const g = window.__game; g.pollGamepad(); return typeof g.pollGamepad === 'function' && g.padAim === null; })()`);
  check('手柄轮询无设备时安全', padOk);
  await shot('combat');

  // 真实鼠标射击
  await evaluate('window.__game.bot = false; window.__game.keys.clear(); window.__game.p.iframes = 60;');
  await evaluate('(() => { const g = window.__game; g.p.mag = 24; g.p.reloadT = 0; g.p.reserve = 96; return 1; })()');
  const before = await snap();
  await mouse('mouseMoved', 450, 180);
  await mouse('mousePressed', 450, 180);
  await waitGame(0.6);
  await mouse('mouseReleased', 450, 180);
  const afterShot = await snap();
  check('鼠标左键真实射击', afterShot.shots > before.shots && afterShot.mag < before.mag,
    `shots ${before.shots}->${afterShot.shots}`);

  // 真实键盘移动
  await evaluate('(() => { const g = window.__game; g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0); g.p.iframes = 3; return 1; })()');
  const beforeMove = await snap();
  await key('KeyW', 87, true); await waitGame(0.6); await key('KeyW', 87, false);
  const afterMove = await snap();
  check('W 键真实移动', afterMove.z < beforeMove.z - 0.5, `z ${beforeMove.z}->${afterMove.z}`);

  // 冲刺
  await key('Space', 32, true); await sleep(400); await key('Space', 32, false);
  const afterDash = await snap();
  check('空格冲刺触发冷却', afterDash.dashCd > 0.5, `dashCd=${afterDash.dashCd}`);
  await evaluate('window.__game.p.iframes = 60;');

  // 换弹
  await key('KeyR', 82, true); await sleep(400); await key('KeyR', 82, false);
  const reloading = await snap();
  check('R 键进入换弹', reloading.reloadT > 0, `reloadT=${reloading.reloadT}`);
  await waitGame(2.0);
  const reloaded = await snap();
  check('换弹完成弹匣补满', reloaded.mag === 24, `mag=${reloaded.mag}`);

  // 换弹动作 + 头顶换弹进度条
  await evaluate('(() => { const g = window.__game; g.p.mag = 5; g.p.reserve = 96; g.p.reloadT = 0; g.startReload(); return 1; })()');
  const rlSnap = () => evaluate(`(() => { const g = window.__game; const d = g.playerDuck;
    const rb = g.playerHpBar.reload || { group: { visible: false }, fill: { scale: { x: 0 } } };
    return { prog: +(d.reload || 0).toFixed(2), gunX: +d.gun.rotation.x.toFixed(2), headX: +d.head.rotation.x.toFixed(2),
      barVis: rb.group.visible, w: +rb.fill.scale.x.toFixed(2) }; })()`);
  let rl1 = await rlSnap();
  for (let i = 0; i < 40 && !(rl1.prog >= 0.3 && rl1.prog <= 0.75); i++) { await sleep(150); rl1 = await rlSnap(); }
  await sleep(400);
  const rl2 = await rlSnap();
  check('换弹时鸭鸭播放换弹动作', rl1.prog > 0 && rl1.prog < 1 && rl1.gunX > 0.15 && rl1.headX > 0.1, JSON.stringify(rl1));
  check('头顶血条显示换弹进度条且推进', rl1.barVis && rl2.w > rl1.w && rl2.w <= 1.42, JSON.stringify({ rl1, rl2 }));
  await waitGame(2.0);
  const rl3 = await evaluate(`(() => { const g = window.__game;
    return { barVis: g.playerHpBar.reload ? g.playerHpBar.reload.group.visible : false, prog: g.playerDuck.reload || 0, mag: g.p.mag }; })()`);
  check('换弹完成后进度条隐藏', !rl3.barVis && rl3.prog === 0 && rl3.mag === 24, JSON.stringify(rl3));

  // 鼠标居中/近中时朝屏幕前方瞄准（不向后、不大幅横摆）
  await evaluate('(() => { const g = window.__game; g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0); g.mouse.x = innerWidth / 2; g.mouse.y = innerHeight / 2; return 1; })()');
  await waitGame(1.2);
  const aimC = await evaluate('(() => { const g = window.__game; return { dz: +(g.aimPoint.z - g.p.pos.z).toFixed(2) }; })()');
  await evaluate('(() => { const g = window.__game; g.mouse.x = innerWidth * 0.52; g.mouse.y = innerHeight * 0.48; return 1; })()');
  await waitGame(1.0);
  const aimN = await evaluate('(() => { const g = window.__game; return { yaw: +g.p.aimYaw.toFixed(2) }; })()');
  check('鼠标居中/近中时朝屏幕前方瞄准', aimC.dz < -0.2 && Math.abs(aimN.yaw) > 2.35, JSON.stringify({ aimC, aimN }));

  // 指哪打哪：零散布单发弹道直线应与准星相机射线相交（线间距离≈0）
  await evaluate(`(() => { const g = window.__game; g.bot = false; g.keys.clear(); g.mouse.down = false;
    g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0);
    g.mouse.x = innerWidth * 0.62; g.mouse.y = innerHeight * 0.40; return 1; })()`);
  await waitGame(1.0);
  const xhair = await evaluate(`(() => { const g = window.__game;
    const origSpread = g.spreadNow; g.spreadNow = () => 0;
    for (const b of g.bullets) if (b.vis) g.engine.scene.remove(b.vis);
    g.bullets = [];
    g.fire();
    g.spreadNow = origSpread;
    const b = g.bullets[0];
    let out;
    if (!b) out = { err: 'no bullet' };
    else {
      g.ray.setFromCamera({ x: (g.mouse.x / innerWidth) * 2 - 1, y: -(g.mouse.y / innerHeight) * 2 + 1 }, g.engine.camera);
      const u = g.ray.ray.direction.clone().normalize();
      const C = g.ray.ray.origin.clone();
      const M = b.pos.clone(); const v = b.vel.clone().normalize();
      const w = M.clone().sub(C);
      const bb = u.dot(v), d = u.dot(w), e = v.dot(w);
      const D = 1 - bb * bb;
      const sc = (d - bb * e) / D, tc = (bb * d - e) / D;
      const gap = C.clone().addScaledVector(u, sc).distanceTo(M.clone().addScaledVector(v, tc));
      out = { gap: +gap.toFixed(3), depth: +sc.toFixed(1) };
    }
    for (const b2 of g.bullets) if (b2.vis) g.engine.scene.remove(b2.vis);
    g.bullets = [];
    g.bot = true;
    return out; })()`);
  check('子弹弹道与准星射线重合（指哪打哪）', !xhair.err && xhair.gap < 0.15, JSON.stringify(xhair));

  // 曳光穿准星定格截图：固定机位 + 零散布连射 + 慢弹速让曳光留在空中
  await evaluate(`(() => { const g = window.__game; g.bot = false; g.keys.clear(); g.mouse.down = false;
    for (const e of g.enemies) { g.engine.scene.remove(e.duck.group); if (e.hpBar) g.engine.scene.remove(e.hpBar.group); }
    g.enemies = [];
    for (const b of g.ebullets) if (b.vis) g.engine.scene.remove(b.vis);
    g.ebullets = [];
    g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0);
    g.mouse.x = innerWidth * 0.62; g.mouse.y = innerHeight * 0.40;
    window.__origSpreadX = g.spreadNow; g.spreadNow = () => 0;
    window.__origSpeedX = g.loadout.bulletSpeed; g.loadout.bulletSpeed = 14;
    window.__origCamX = g.engine.updateCamera.bind(g.engine);
    g.engine.updateCamera = () => { g.engine.camera.position.set(0, 3.2, 7.5); g.engine.camera.lookAt(0, 0.6, -6); };
    return 1; })()`);
  await waitGame(0.6);
  await evaluate('(() => { window.__game.mouse.down = true; return 1; })()');
  await sleep(900);
  await shot('crosshair');
  await evaluate(`(() => { const g = window.__game; g.mouse.down = false;
    g.spreadNow = window.__origSpreadX; g.loadout.bulletSpeed = window.__origSpeedX;
    g.engine.updateCamera = window.__origCamX; g.bot = true; return 1; })()`);

  // 拾取浮字：3 字标签（鸭锁骨）纹理不裁切，精灵按纹理宽高比缩放
  const clip = await evaluate(`(() => { const g = window.__game;
    g.fx.number(g.p.pos.clone(), '鸭锁骨', '#ffe28a');
    const tex = g.fx.numTex.get('鸭锁骨#ffe28a');
    const c = document.createElement('canvas'); const ctx = c.getContext('2d');
    ctx.font = '900 64px "Yuanti SC","YouYuan","Microsoft YaHei",sans-serif';
    const need = Math.ceil(ctx.measureText('鸭锁骨').width) + 10;
    const n = g.fx.numbers.find(x => x.life > 0 && x.s.material.map === tex);
    return { w: tex.image.width, need, sx: n.s.scale.x, sy: n.s.scale.y, tw: tex.image.width, th: tex.image.height }; })()`);
  check('拾取浮字纹理宽度容纳 3 字标签', clip.w >= clip.need, JSON.stringify(clip));
  check('拾取浮字精灵按纹理宽高比缩放', Math.abs(clip.sx / clip.sy - clip.tw / clip.th) < 0.02, JSON.stringify(clip));
  await evaluate(`(() => { const g = window.__game;
    const n = g.fx.numbers.find(x => x.life > 0 && x.s.material.map === g.fx.numTex.get('鸭锁骨#ffe28a'));
    if (n) { n.life = 2.5; n.s.position.set(0, 1.7, 0); }
    window.__origCamPick = g.engine.updateCamera.bind(g.engine);
    g.engine.updateCamera = () => { g.engine.camera.position.set(0, 2.0, 4.2); g.engine.camera.lookAt(0, 1.6, 0); };
    return 1; })()`);
  await sleep(400);
  await shot('pickup-text');
  await evaluate(`(() => { const g = window.__game; g.engine.updateCamera = window.__origCamPick; return 1; })()`);

  // 真实弹体：可见子弹 + 短拖尾，取代瞬时 beams
  const bulletVis = await evaluate(`(() => { const g = window.__game;
    for (const b of g.bullets) if (b.vis) g.engine.scene.remove(b.vis);
    g.bullets.length = 0; g.fire();
    const b = g.bullets[g.bullets.length - 1];
    return { hasVis: !!b.vis, children: b.vis ? b.vis.children.length : 0, beams: g.fx.tracers ? g.fx.tracers.length : 0 };
  })()`);
  check('玩家子弹生成可见弹体（无瞬时 beams）', bulletVis.hasVis && bulletVis.children === 2 && bulletVis.beams === 0, JSON.stringify(bulletVis));
  const bulletMove = await evaluate(`(async () => { const g = window.__game;
    const b = g.bullets[g.bullets.length - 1];
    const p0 = b.vis.position.clone();
    await new Promise(r => setTimeout(r, 250));
    const d = +p0.distanceTo(b.vis.position).toFixed(2);
    b.life = 0.001;
    await new Promise(r => setTimeout(r, 300));
    return { d, removed: !g.bullets.includes(b), detached: b.vis.parent === null };
  })()`);
  check('弹体随帧移动且到期后移除', bulletMove.d > 1 && bulletMove.removed && bulletMove.detached, JSON.stringify(bulletMove));
  const ebVis = await evaluate(`(async () => { const g = window.__game;
    g.p.iframes = 60;
    const clear = (x, z) => g.world.colliders.every(c => c.hx !== undefined
      ? (Math.abs(x - c.x) > c.hx + 2 || Math.abs(z - c.z) > c.hz + 2)
      : Math.hypot(x - c.x, z - c.z) > c.r + 2)
      && Math.hypot(x - g.p.pos.x, z - g.p.pos.z) > 5;
    const spots = [[0, -19], [18, 18], [-18, 18], [18, -18], [-18, -18], [19, 0]];
    const spot = spots.find(([x, z]) => clear(x, z) && clear(x + 3.5, z)) || [0, -19];
    const pos = g.p.pos.clone().set(spot[0], 1.2, spot[1]);
    const vel = g.p.vel.clone().set(14, 0, 0);
    const b = { pos, vel, life: 1, dmg: 1 };
    g.ebullets.push(b);
    await new Promise(r => setTimeout(r, 200));
    return { grp: !!b.spr && b.spr.isGroup === true, children: b.spr ? b.spr.children.length : 0, alive: g.ebullets.includes(b) };
  })()`);
  check('敌弹同样使用可见弹体', ebVis.grp && ebVis.children === 2 && ebVis.alive, JSON.stringify(ebVis));

  // 暂停 / 恢复
  await key('Escape', 27, true); await sleep(120); await key('Escape', 27, false);
  await sleep(300);
  const paused = await snap();
  check('Esc 暂停', paused.state === 'paused');
  await shot('pause');
  await key('Escape', 27, true); await sleep(120); await key('Escape', 27, false);
  await sleep(300);
  check('Esc 恢复', (await snap()).state === 'playing');

  // 拾取
  const reserveBefore = (await snap()).reserve;
  await evaluate(`(() => { const g = window.__game; const v = g.p.pos.clone(); v.x += 0.4; g.spawnPickup(v, 'ammo'); return g.pickups.length; })()`);
  await waitGame(1.0);
  const afterPick = await snap();
  check('弹药拾取生效', afterPick.reserve > reserveBefore, `reserve ${reserveBefore}->${afterPick.reserve}`);

  // 商店：暂停 / 购买 / 出售 / 装备
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  async function clickText(sel, text) {
    const r = await evaluate(`(() => { const b = [...document.querySelectorAll('${sel}')].find(x => x.textContent.trim() === '${text}'); if (!b) return null; const rc = b.getBoundingClientRect(); return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 }; })()`);
    if (!r) throw new Error('button not found: ' + text);
    await mouse('mousePressed', r.x, r.y); await sleep(80); await mouse('mouseReleased', r.x, r.y);
    await sleep(250);
  }
  async function clickSel(sel) {
    const r = await evaluate(`(() => { const b = document.querySelector('${sel}'); if (!b) return null; const rc = b.getBoundingClientRect(); return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 }; })()`);
    if (!r) throw new Error('element not found: ' + sel);
    await mouse('mousePressed', r.x, r.y); await sleep(80); await mouse('mouseReleased', r.x, r.y);
    await sleep(250);
  }
  async function wheel(dy) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 360, deltaX: 0, deltaY: dy });
    await sleep(250);
  }
  async function tapT() {
    await key('KeyT', 84, true); await sleep(120); await key('KeyT', 84, false); await sleep(320);
  }
  const eco = () => evaluate(`(() => { const g = window.__game; return { coins: g.coins, reserve: g.p.reserve, neck: g.inv.neck || 0, maxHp: g.p.maxHp }; })()`);
  await evaluate(`(() => { const g = window.__game; g.coins = 500; g.inv.neck = 2; return 1; })()`);
  await key('KeyB', 66, true); await sleep(120); await key('KeyB', 66, false);
  await sleep(350);
  const shopState = await snap();
  check('B 键打开商店并暂停', shopState.state === 'shop');
  const shopDom = await evaluate(`(() => ({ goods: document.querySelectorAll('#buyPane .tile').length, hidden: document.getElementById('shopScreen').classList.contains('hidden') }))()`);
  check('商店 UI 渲染 8 件商品', shopDom.goods === 8 && !shopDom.hidden, `goods=${shopDom.goods}`);
  const frozen0 = shopState.time;
  await sleep(900);
  const frozen1 = (await snap()).time;
  check('商店打开时战斗时间冻结', Math.abs(frozen1 - frozen0) < 0.05, `time ${frozen0}->${frozen1}`);
  await shot('shop');

  const tileDom = await evaluate(`(() => { const t = [...document.querySelectorAll('#buyPane .tile')];
    return { n: t.length, icons: t.filter(x => x.querySelector('canvas,svg')).length,
      prices: t.filter(x => x.querySelector('.price')).length, descs: t.filter(x => x.querySelector('.desc')).length }; })()`);
  check('商品为图标格子（图标+价格角标，无长描述）', tileDom.n === 8 && tileDom.icons === 8 && tileDom.prices === 8 && tileDom.descs === 0, JSON.stringify(tileDom));
  const ammoPos = await evaluate(`(() => { const rc = document.querySelector('#buyPane .tile[data-good="ammo"]').getBoundingClientRect(); return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 }; })()`);
  await mouse('mouseMoved', ammoPos.x, ammoPos.y); await sleep(250);
  const tipOn = await evaluate(`(() => { const tip = document.getElementById('tip'); return { vis: !!tip && !tip.classList.contains('hidden'), text: tip ? tip.textContent : '' }; })()`);
  await shot('shop-tip');
  await mouse('mouseMoved', 640, 120); await sleep(250);
  const tipOff = await evaluate(`(() => { const tip = document.getElementById('tip'); return !tip || tip.classList.contains('hidden'); })()`);
  check('悬停商品浮层展示名称/数值/价格', tipOn.vis && tipOn.text.includes('子弹箱') && tipOn.text.includes('48') && tipOn.text.includes('60') && tipOff, JSON.stringify({ text: tipOn.text.slice(0, 60), tipOff }));

  const e0 = await eco();
  await clickSel('#buyPane .tile[data-good="ammo"]');
  const e1 = await eco();
  check('真实点击购买子弹箱', e1.reserve === e0.reserve + 48 && e1.coins === e0.coins - 60,
    `reserve ${e0.reserve}->${e1.reserve} coins ${e0.coins}->${e1.coins}`);

  await clickText('.shopTabs button', '出售背包');
  await shot('shop-sell');
  await clickText('#sellPane button', '全卖');
  const e2 = await eco();
  check('真实点击全卖鸭脖得金币', e2.neck === 0 && e2.coins === e1.coins + 32, `coins ${e1.coins}->${e2.coins}`);

  await evaluate(`(() => { const g = window.__game; g.inv.neck = 3; g.hud.renderShop(g); return 1; })()`);
  const bagDom = await evaluate(`(() => { const t = document.querySelector('#sellPane .tile[data-loot="neck"]');
    return { count: t && t.querySelector('.count') ? t.querySelector('.count').textContent : '', icon: !!(t && t.querySelector('canvas,svg')) }; })()`);
  const bagPos = await evaluate(`(() => { const rc = document.querySelector('#sellPane .tile[data-loot="neck"]').getBoundingClientRect(); return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 }; })()`);
  await mouse('mouseMoved', bagPos.x, bagPos.y); await sleep(250);
  const bagTip = await evaluate(`(() => { const tip = document.getElementById('tip'); return { vis: !tip.classList.contains('hidden'), text: tip.textContent }; })()`);
  check('背包图标格+数量角标+悬停浮层', bagDom.count === '×3' && bagDom.icon && bagTip.vis && bagTip.text.includes('鸭脖') && bagTip.text.includes('16'), JSON.stringify({ bagDom, tip: bagTip.text.slice(0, 40) }));
  await shot('bag-tip');
  const c0 = await eco();
  await clickSel('#sellPane .tile[data-loot="neck"]');
  const c1 = await eco();
  check('点击背包图标卖 1', c1.neck === 2 && c1.coins === c0.coins + 16, `neck ${c0.neck}->${c1.neck} coins ${c0.coins}->${c1.coins}`);

  await clickText('.shopTabs button', '购买装备');
  await clickSel('#buyPane .tile[data-good="armor"]');
  const armorState = await evaluate(`(() => { const g = window.__game; return { gear: !!g.gear.armor, dmgMul: g.loadout.dmgMul, vest: g.playerDuck.gearMeshes.armor[0].visible }; })()`);
  check('购买盔甲减伤且模型可见', armorState.gear && armorState.dmgMul === 0.7 && armorState.vest);

  await evaluate(`(() => { const g = window.__game; g.coins = 2000; g.hud.renderShop(g); return 1; })()`);
  await clickSel('#buyPane .tile[data-good="armor"]');
  const armor2 = await evaluate(`(() => { const g = window.__game; return { lvl: g.gear.armor, dmgMul: g.loadout.dmgMul }; })()`);
  check('盔甲升级到 II 级减伤 45%', armor2.lvl === 2 && armor2.dmgMul === 0.55, JSON.stringify(armor2));

  await evaluate(`(() => { const g = window.__game; g.coins = 1000; g.hud.renderShop(g); return 1; })()`);
  await clickSel('#buyPane .tile[data-good="shotgun"]');
  const gunState = await evaluate(`(() => { const g = window.__game; return { gunId: g.gunId, weapon: g.playerDuck.weapon, mag: g.p.mag, pellets: g.loadout.pellets }; })()`);
  check('购买并装备霰弹枪', gunState.gunId === 'shotgun' && gunState.weapon === 'shotgun' && gunState.pellets === 6 && gunState.mag === 6,
    JSON.stringify(gunState));
  await clickSel('#buyPane .tile[data-good="helmet"]');
  const helmState = await eco();
  check('购买头盔提升生命上限', helmState.maxHp === 130, `maxHp=${helmState.maxHp}`);
  await clickSel('#buyPane .tile[data-good="shoes"]');
  await clickSel('#buyPane .tile[data-good="gloves"]');
  const gearVis = await evaluate(`(() => { const m = window.__game.playerDuck.gearMeshes; return { shoes: m.shoes[0].visible, gloves: m.gloves[0].visible, speed: window.__game.loadout.speedMul, reload: +window.__game.loadout.reloadTime.toFixed(2) }; })()`);
  check('鞋子手套生效且模型可见', gearVis.shoes && gearVis.gloves && gearVis.speed === 1.15 && gearVis.reload === 1.4,
    JSON.stringify(gearVis));

  await key('KeyB', 66, true); await sleep(120); await key('KeyB', 66, false);
  await sleep(350);
  check('B 键关闭商店恢复战斗', (await snap()).state === 'playing');

  // Q/E + 滚轮切枪（数字键已让给主动技能）
  await key('KeyQ', 81, true); await sleep(120); await key('KeyQ', 81, false); await sleep(250);
  check('Q 键切上一把枪', (await evaluate('window.__game.gunId')) === 'carbine');
  await key('KeyE', 69, true); await sleep(120); await key('KeyE', 69, false); await sleep(250);
  const swE = await evaluate(`(() => { const g = window.__game; return { gunId: g.gunId, pellets: g.loadout.pellets }; })()`);
  check('E 键切下一把枪（霰弹）', swE.gunId === 'shotgun' && swE.pellets === 6, JSON.stringify(swE));
  await wheel(120); await sleep(200);
  check('滚轮下滚切枪', (await evaluate('window.__game.gunId')) === 'carbine');
  await wheel(-120); await sleep(200);
  check('滚轮上滚切回霰弹枪', (await evaluate('window.__game.gunId')) === 'shotgun');

  // ===== 成长线：经验 / 等级 / 天赋 / 技能 =====
  await evaluate(`(() => { const g = window.__game; g.bot = false; g.keys.clear(); g.mouse.down = false;
    g.p.iframes = 60; g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0);
    for (const e of g.enemies) { g.engine.scene.remove(e.duck.group); if (e.hpBar) g.engine.scene.remove(e.hpBar.group); }
    g.enemies = []; g.spawnQueue = []; return 1; })()`);

  const xp0 = await evaluate(`(() => { const g = window.__game; g.spawnEnemy('brawler'); const e = g.enemies[g.enemies.length - 1];
    e.pos.set(2, 0, 2); e.hp = 1; const before = g.xpEarned; g.killEnemy(e); return { before, after: g.xpEarned }; })()`);
  check('击杀获得经验', xp0.after > xp0.before, `xpEarned ${xp0.before}->${xp0.after}`);

  const lvl = await evaluate(`(() => { const g = window.__game; g.p.hp = 50; const l0 = g.level, p0 = g.points;
    g.addXp(3000); return { l0, l1: g.level, p0, p1: g.points, hp: Math.round(g.p.hp) }; })()`);
  check('升级获得天赋点', lvl.l1 > lvl.l0 && lvl.p1 > lvl.p0, JSON.stringify(lvl));
  check('升级回复生命', lvl.hp > 50, `hp=${lvl.hp}`);

  await tapT();
  check('T 键打开天赋树并暂停', (await snap()).state === 'talent');
  const tDom = await evaluate(`(() => ({ nodes: document.querySelectorAll('#talentTree .tnode').length, branches: document.querySelectorAll('#talentTree .branch').length, hidden: document.getElementById('talentScreen').classList.contains('hidden') }))()`);
  check('天赋树渲染 3 分支 12 节点', tDom.nodes === 12 && tDom.branches === 3 && !tDom.hidden, JSON.stringify(tDom));
  const ft0 = (await snap()).time; await sleep(800); const ft1 = (await snap()).time;
  check('天赋树打开时战斗时间冻结', Math.abs(ft1 - ft0) < 0.05, `time ${ft0}->${ft1}`);
  await shot('talent');

  const dmg0 = await evaluate(`(() => { const g = window.__game; return { points: g.points, dmg: g.loadout.damage, rank: g.talents.t_dmg || 0 }; })()`);
  await clickSel('#talentTree .tnode[data-talent="t_dmg"] button');
  const dmg1 = await evaluate(`(() => { const g = window.__game; return { points: g.points, dmg: g.loadout.damage, rank: g.talents.t_dmg || 0 }; })()`);
  check('点选天赋嘴强王者伤害 +8%', dmg1.rank === 1 && dmg1.points === dmg0.points - 1 && Math.abs(dmg1.dmg - dmg0.dmg * 1.08) < 0.01, JSON.stringify({ dmg0, dmg1 }));

  await clickSel('#talentTree .tnode[data-talent="t_storm"] button');
  check('点选天赋解锁嘎嘎乱杀', (await evaluate('window.__game.loadout.skills.storm')) === true);
  await tapT();
  check('T 键关闭天赋树恢复战斗', (await snap()).state === 'playing');

  const stormSetup = await evaluate(`(() => { const g = window.__game;
    for (const e of g.enemies) { g.engine.scene.remove(e.duck.group); if (e.hpBar) g.engine.scene.remove(e.hpBar.group); }
    g.enemies = [];
    for (let i = 0; i < 3; i++) { g.spawnEnemy('brawler'); const e = g.enemies[g.enemies.length - 1]; e.pos.set(1.5 + i * 0.4, 0, 1.5); e.duck.group.position.copy(e.pos); e.hp = 30; }
    g.p.pos.set(0, 0, 0); g.p.iframes = 60; return { kills: g.kills }; })()`);
  await key('Digit1', 49, true); await sleep(120); await key('Digit1', 49, false); await sleep(300);
  const stormAfter = await evaluate(`(() => { const g = window.__game; return { cd: +g.skillCd.storm.toFixed(1), kills: g.kills }; })()`);
  check('Digit1 释放嘎嘎乱杀进入冷却', stormAfter.cd > 10, `cd=${stormAfter.cd}`);
  check('嘎嘎乱杀击杀近身敌人', stormAfter.kills > stormSetup.kills, `kills ${stormSetup.kills}->${stormAfter.kills}`);

  await tapT();
  await clickSel('#talentTree .tnode[data-talent="t_hp"] button');
  await clickSel('#talentTree .tnode[data-talent="t_shield"] button');
  check('点选天赋解锁抱头蹲防', (await evaluate('window.__game.loadout.skills.shield')) === true);
  await tapT();
  await key('Digit2', 50, true); await sleep(120); await key('Digit2', 50, false); await sleep(250);
  const shieldOn = await evaluate(`(() => { const g = window.__game; return { shield: g.p.shield, shieldT: +g.p.shieldT.toFixed(1), cd: +g.skillCd.shield.toFixed(1), bar: document.getElementById('shieldBar').classList.contains('on') }; })()`);
  check('Digit2 抱头蹲防展开护盾条', shieldOn.shield > 0 && shieldOn.shieldT > 0 && shieldOn.cd > 15 && shieldOn.bar, JSON.stringify(shieldOn));
  const absorb = await evaluate(`(() => { const g = window.__game; g.p.iframes = 0; const h = g.p.hp; g.damagePlayer(20); return { h: Math.round(h), after: Math.round(g.p.hp), shield: Math.round(g.p.shield) }; })()`);
  check('抱头蹲防吸收伤害不扣血', absorb.after === absorb.h && absorb.shield < shieldOn.shield, JSON.stringify(absorb));

  const rageLocked = await evaluate('window.__game.loadout.skills.rage');
  await key('Digit3', 51, true); await sleep(120); await key('Digit3', 51, false); await sleep(200);
  const rageLockedAfter = await evaluate(`(() => { const g = window.__game; return { cd: g.skillCd.rage, rageT: g.p.rageT }; })()`);
  check('未解锁技能按键不进入冷却', rageLocked === false && rageLockedAfter.cd === 0 && rageLockedAfter.rageT === 0, JSON.stringify(rageLockedAfter));

  await tapT();
  await clickSel('#talentTree .tnode[data-talent="t_speed"] button');
  await clickSel('#talentTree .tnode[data-talent="t_slow"] button');
  await tapT();
  await key('Digit4', 52, true); await sleep(120); await key('Digit4', 52, false); await sleep(250);
  const slowOn = await evaluate(`(() => { const g = window.__game; return { slowT: +g.slowT.toFixed(1), factor: g.slowFactor, cd: +g.skillCd.slow.toFixed(1) }; })()`);
  check('Digit4 释放嘎瓦鲁多减速敌人', slowOn.slowT > 4 && slowOn.factor < 1 && slowOn.cd > 20, JSON.stringify(slowOn));

  await tapT();
  await clickSel('#talentTree .tnode[data-talent="t_storm2"] button');
  await clickSel('#talentTree .tnode[data-talent="t_rage"] button');
  await tapT();
  await key('Digit3', 51, true); await sleep(120); await key('Digit3', 51, false); await sleep(250);
  const rageOn = await evaluate(`(() => { const g = window.__game; return { rageT: +g.p.rageT.toFixed(1), cd: +g.skillCd.rage.toFixed(1) }; })()`);
  check('Digit3 释放红温暴走', rageOn.rageT > 5 && rageOn.cd > 18, JSON.stringify(rageOn));
  const rageDmg = await evaluate(`(() => { const g = window.__game; g.p.mag = 24; g.p.fireT = 0; g.aimPoint.set(0, 0.7, 5); g.fire(); const b = g.bullets[g.bullets.length - 1]; return { dmg: +b.dmg.toFixed(2), expect: +(g.loadout.damage * 1.35).toFixed(2) }; })()`);
  check('红温暴走提升子弹伤害 35%', Math.abs(rageDmg.dmg - rageDmg.expect) < 0.02, JSON.stringify(rageDmg));
  const skillDom = await evaluate(`(() => [...document.querySelectorAll('#skillBar .slot')].map(s => ({ skill: s.dataset.skill, locked: s.classList.contains('locked'), active: s.classList.contains('active') })))()`);
  check('技能栏四格全部解锁且红温暴走高亮', skillDom.every(s => !s.locked) && skillDom.find(s => s.skill === 'rage').active, JSON.stringify(skillDom));
  await shot('skill');

  // 霰弹枪弹丸计数 + 低弹药兜底 + 场外威胁预警
  const sgBefore = await evaluate(`(() => { const g = window.__game; g.bot = false; g.keys.clear(); g.mouse.down = false;
    g.p.mag = 6; g.p.reserve = 0; g.p.iframes = 60; g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0);
    for (const e of g.enemies) { g.engine.scene.remove(e.duck.group); if (e.hpBar) g.engine.scene.remove(e.hpBar.group); }
    g.enemies = []; g.spawnQueue = [];
    for (let i = 0; i < 3; i++) g.spawnEnemy('brawler');
    return { shots: g.shots, hits: g.hits, kills: g.kills, threats: document.querySelectorAll('.threat').length }; })()`);
  check('场外出生触发威胁预警', sgBefore.threats > 0, `threats=${sgBefore.threats}`);
  await evaluate(`(() => { const g = window.__game;
    g.enemies.forEach((e, i) => { e.pos.set(1.2 + i * 0.3, 0, 1.2); e.duck.group.position.copy(e.pos); e.hp = 1; });
    g.aimPoint.set(1.5, 0.7, 1.2); g.fire(); return 1; })()`);
  await waitGame(0.6);
  const sgAfter = await evaluate(`(() => { const g = window.__game; return { shots: g.shots, hits: g.hits, kills: g.kills, ammo: g.pickups.filter(p => p.kind === 'ammo').length }; })()`);
  check('霰弹枪一次射击计 6 弹丸', sgAfter.shots - sgBefore.shots === 6, `shots +${sgAfter.shots - sgBefore.shots}`);
  check('霰弹枪命中率不超 100%', sgAfter.hits <= sgAfter.shots, `hits=${sgAfter.hits} shots=${sgAfter.shots}`);
  check('低弹药击杀必掉弹药箱', sgAfter.kills > sgBefore.kills && sgAfter.ammo >= sgAfter.kills - sgBefore.kills,
    `kills +${sgAfter.kills - sgBefore.kills} ammo=${sgAfter.ammo}`);

  // Boss 生成 / 血量成长 / 血条 / 皇冠
  const bossInfo = await evaluate(`(async () => { const g = window.__game; const { wavePlan } = await import('/src/rules.js');
    for (const e of g.enemies) { g.engine.scene.remove(e.duck.group); if (e.hpBar) g.engine.scene.remove(e.hpBar.group); }
    g.enemies = [];
    g.wave = 5; g.plan = wavePlan(5); g.spawnEnemy('boss');
    const b = g.enemies.find(e => e.type === 'boss');
    b.pos.set(4, 0, 4); b.duck.group.position.copy(b.pos);
    const cones = b.duck.head.children.filter(c => c.geometry && c.geometry.type === 'ConeGeometry').length;
    return { hp: b.hp, bar: !!b.hpBar, cones, planBoss: wavePlan(10).counts.boss, scale25: wavePlan(25).bossScale }; })()`);
  check('Boss 按独立曲线生成 600 HP', bossInfo.hp === 600 && bossInfo.planBoss === 1 && bossInfo.scale25 > 1, JSON.stringify(bossInfo));
  check('Boss 戴皇冠（5 尖刺）', bossInfo.cones === 5, `cones=${bossInfo.cones}`);
  await evaluate(`(() => { const g = window.__game; const b = g.enemies.find(e => e.type === 'boss'); b.hp = 300; return 1; })()`);
  await waitGame(0.3);
  const bossBar = await evaluate(`(() => { const b = window.__game.enemies.find(e => e.type === 'boss'); return { visible: b.hpBar.group.visible, fill: +b.hpBar.fill.scale.x.toFixed(2) }; })()`);
  check('Boss 血条受伤后显示半血', bossBar.visible && Math.abs(bossBar.fill - 0.71) < 0.02, JSON.stringify(bossBar));
  await evaluate(`(() => { const g = window.__game; const b = g.enemies.find(e => e.type === 'boss');
    g.p.pos.set(0, 0, 0); g.p.iframes = 60;
    window.__origCam2 = g.engine.updateCamera.bind(g.engine);
    g.engine.updateCamera = () => { g.engine.camera.position.set(b.pos.x + 4, 2.2, b.pos.z + 5.6); g.engine.camera.lookAt(b.pos.x, 2.0, b.pos.z); };
    return 1; })()`);
  await sleep(1200);
  await shot('boss');
  await evaluate(`(() => { const g = window.__game; g.engine.updateCamera = window.__origCam2;
    const b = g.enemies.find(e => e.type === 'boss');
    if (b) { g.engine.scene.remove(b.duck.group); if (b.hpBar) g.engine.scene.remove(b.hpBar.group); g.enemies = g.enemies.filter(e => e !== b); }
    return 1; })()`);

  // 敌我全员头顶血条
  await evaluate(`(() => { const g = window.__game; g.p.iframes = 60;
    if (!g.enemies.some(e => !e.dead)) g.spawnEnemy('brawler');
    return 1; })()`);
  await waitGame(0.3);
  const bars = await evaluate(`(() => { const g = window.__game; const e = g.enemies.find(x => !x.dead);
    return { enemy: !!(e && e.hpBar && e.hpBar.group.visible), player: g.playerHpBar.group.visible }; })()`);
  check('小兵与玩家头顶血条常驻显示', bars.enemy && bars.player, JSON.stringify(bars));

  // 精英强化单位：大体型 / 加强数值 / 红莫西干 / 三倍分值
  const eliteInfo = await evaluate(`(() => { const g = window.__game;
    g.spawnEnemy({ type: 'brawler', elite: true });
    const e = g.enemies[g.enemies.length - 1];
    e.pos.set(2, 0, 2); e.duck.group.position.copy(e.pos);
    const cones = e.duck.head.children.filter(c => c.geometry && c.geometry.type === 'ConeGeometry').length;
    return { elite: !!e.elite, scale: +e.duck.group.scale.x.toFixed(2), hp: e.hp, baseHp: 40 * g.plan.hpScale, cones, radius: e.radius, planElite: g.plan.counts.elite };
  })()`);
  check('精英大体型加强血量且红莫西干', eliteInfo.elite && eliteInfo.scale === 1.45 && eliteInfo.hp > 2 * eliteInfo.baseHp && eliteInfo.cones >= 3 && eliteInfo.radius > 0.5 && eliteInfo.planElite === 1, JSON.stringify(eliteInfo));
  await evaluate(`(() => { const g = window.__game; const e = g.enemies.find(x => x.elite);
    g.p.iframes = 60;
    window.__origCam3 = g.engine.updateCamera.bind(g.engine);
    g.engine.updateCamera = () => { g.engine.camera.position.set(e.pos.x + 2.6, 1.5, e.pos.z + 3.6); g.engine.camera.lookAt(e.pos.x, 1.2, e.pos.z); };
    return 1; })()`);
  await sleep(1200);
  await shot('elite');
  const eliteScore = await evaluate(`(async () => { const g = window.__game; const { scoreFor } = await import('/src/rules.js');
    g.engine.updateCamera = window.__origCam3;
    const e = g.enemies.find(x => x.elite);
    const before = g.score; g.killEnemy(e);
    return { delta: g.score - before, expect: scoreFor('brawler', g.wave, true) }; })()`);
  check('精英击杀三倍分值', eliteScore.delta === eliteScore.expect, JSON.stringify(eliteScore));
  const queueElite = await evaluate(`(() => { const g = window.__game; g.nextWave();
    const has = g.spawnQueue.some(x => typeof x === 'object' && x.elite);
    g.spawnQueue = []; g.waveState = 'inter'; g.interT = 9999; return has; })()`);
  check('出怪队列包含精英单位', queueElite === true);

  // 精英大范围技能：预警圈 + 圈内伤害（空旷站位；暂清碰撞体，避免木箱把冲锋路径挤到圈边）
  await evaluate(`(() => { const g = window.__game; g.bot = false; g.keys.clear(); g.mouse.down = false;
    window.__colsBackup = g.world.colliders; g.world.colliders = [];
    for (const e of g.enemies) { g.engine.scene.remove(e.duck.group); if (e.hpBar) g.engine.scene.remove(e.hpBar.group); }
    g.enemies = [];
    for (const b of g.ebullets) if (b.vis) g.engine.scene.remove(b.vis);
    g.ebullets = [];
    g.spawnEnemy({ type: 'brawler', elite: true });
    const e = g.enemies[g.enemies.length - 1];
    e.pos.set(6, 0, 7); e.duck.group.position.copy(e.pos);
    g.p.pos.set(9, 0, 10); g.p.vel.set(0, 0, 0); g.p.iframes = 0; g.p.shieldT = 0; g.p.shield = 0; g.p.hp = g.p.maxHp;
    e.skillCd = 0;
    return 1; })()`);
  await waitGame(0.3);
  const es1 = await evaluate(`(() => { const g = window.__game; const e = g.enemies.find(x => x.elite);
    return { kind: e.skillKind, casting: e.skillT > 0, zone: g.fx.zones.some(z => z.life > 0 && z.g.visible), hp: g.p.hp, max: g.p.maxHp }; })()`);
  check('精英蓄力大范围技能并显示预警圈', es1.kind === 'stomp' && es1.casting && es1.zone && es1.hp === es1.max, JSON.stringify(es1));
  await evaluate(`(() => { const g = window.__game;
    window.__origCamStomp = g.engine.updateCamera.bind(g.engine);
    g.engine.updateCamera = () => { g.engine.camera.position.set(9, 8, 15); g.engine.camera.lookAt(7.5, 0.5, 8.5); };
    return 1; })()`);
  await sleep(600);
  await shot('elite-skill');
  await evaluate(`(() => { const g = window.__game; g.engine.updateCamera = window.__origCamStomp; return 1; })()`);
  await waitGame(1.2);
  const es2 = await evaluate(`(() => { const g = window.__game; return { hp: g.p.hp, max: g.p.maxHp }; })()`);
  check('精英技能圈内玩家受伤', es2.hp < es2.max, JSON.stringify(es2));

  // Boss 全图技能：远距离仍命中 + 冲刺无敌帧可闪避
  await evaluate(`(() => { const g = window.__game;
    g.world.colliders = window.__colsBackup;
    for (const e of g.enemies) { g.engine.scene.remove(e.duck.group); if (e.hpBar) g.engine.scene.remove(e.hpBar.group); }
    g.enemies = [];
    for (const b of g.ebullets) if (b.vis) g.engine.scene.remove(b.vis);
    g.ebullets = [];
    g.spawnEnemy('boss');
    const b = g.enemies.find(e => e.type === 'boss');
    b.pos.set(-8, 0, -8); b.duck.group.position.copy(b.pos); b.fireT = 99;
    g.p.pos.set(20, 0, 20); g.p.vel.set(0, 0, 0); g.p.iframes = 0; g.p.shieldT = 0; g.p.shield = 0; g.p.hp = g.p.maxHp;
    b.skillCd = 0;
    return 1; })()`);
  await waitGame(0.3);
  const bs1 = await evaluate(`(() => { const g = window.__game; const b = g.enemies.find(e => e.type === 'boss');
    return { kind: b.skillKind, casting: b.skillT > 0, zone: g.fx.zones.some(z => z.life > 0 && z.g.visible),
      toast: document.getElementById('toast').textContent, hp: g.p.hp, max: g.p.maxHp }; })()`);
  check('Boss 蓄力全图技能并全图预警', bs1.kind === 'nova' && bs1.casting && bs1.zone && bs1.toast.includes('全图') && bs1.hp === bs1.max, JSON.stringify(bs1));
  await evaluate(`(() => { const g = window.__game;
    window.__origCamNova = g.engine.updateCamera.bind(g.engine);
    g.engine.updateCamera = () => { g.engine.camera.position.set(0, 26, 24); g.engine.camera.lookAt(0, 0, 0); };
    return 1; })()`);
  await sleep(600);
  await shot('boss-skill');
  await evaluate(`(() => { const g = window.__game; g.engine.updateCamera = window.__origCamNova; return 1; })()`);
  await waitGame(1.6);
  const bs2 = await evaluate(`(() => { const g = window.__game; return { hp: g.p.hp, max: g.p.maxHp }; })()`);
  check('Boss 全图技能远距离仍命中', bs2.hp < bs2.max, JSON.stringify(bs2));
  await evaluate(`(() => { const g = window.__game; const b = g.enemies.find(e => e.type === 'boss');
    b.skillCd = 0; b.skillT = 0; g.p.hp = g.p.maxHp; g.p.iframes = 0; g.p.shieldT = 0; g.p.shield = 0; return 1; })()`);
  let bs3 = null;
  for (let i = 0; i < 50; i++) {
    bs3 = await evaluate(`(() => { const g = window.__game; const b = g.enemies.find(e => e.type === 'boss');
      if (b && b.skillT > 0 && b.skillT < 0.3) { g.p.iframes = 0.6; return { dodged: true }; }
      return { dodged: false }; })()`);
    if (bs3.dodged) break;
    await sleep(120);
  }
  await waitGame(0.8);
  const bs4 = await evaluate(`(() => { const g = window.__game;
    const b = g.enemies.find(e => e.type === 'boss');
    if (b) { g.engine.scene.remove(b.duck.group); if (b.hpBar) g.engine.scene.remove(b.hpBar.group); g.enemies = g.enemies.filter(e => e !== b); }
    return { hp: g.p.hp, max: g.p.maxHp }; })()`);
  check('冲刺无敌帧可闪避 Boss 全图技能', bs3 && bs3.dodged && bs4.hp === bs4.max, JSON.stringify({ bs3, bs4 }));

  // 护具 + 霰弹枪上身特写
  await evaluate(`(() => { const g = window.__game; g.bot = false; g.mouse.down = false; g.keys.clear();
    for (const e of g.enemies) { g.engine.scene.remove(e.duck.group); if (e.hpBar) g.engine.scene.remove(e.hpBar.group); }
    g.enemies = [];
    for (const b of g.ebullets) if (b.spr) g.engine.scene.remove(b.spr);
    g.ebullets = [];
    g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0); g.p.iframes = 60;
    window.__origCam = g.engine.updateCamera.bind(g.engine);
    g.engine.updateCamera = () => { const p = g.p.pos;
      g.engine.camera.position.set(p.x + 1.9, 1.05, p.z + 2.7);
      g.engine.camera.lookAt(p.x, 1.0, p.z); };
    const du = g.playerDuck; const orig = du.update.bind(du);
    du.update = (dt, st) => orig(dt, Object.assign({}, st, { aimYaw: 0.62, moving: false }));
    return 1; })()`);
  await sleep(1500);
  await shot('gear');
  await evaluate(`(() => { const g = window.__game; g.engine.updateCamera = window.__origCam; return 1; })()`);

  // 阵亡与结算
  await evaluate('window.__game.p.iframes = 0; window.__game.damagePlayer(9999)');
  await sleep(1600);
  const over = await snap();
  check('阵亡进入结算', over.state === 'over');
  check('阵亡隐藏玩家头顶血条', (await evaluate('window.__game.playerHpBar.group.visible')) === false);
  const overDom = await evaluate(`(() => ({ time: document.getElementById('resTime').textContent, coins: document.getElementById('resCoins').textContent, best: document.getElementById('resBest').textContent, acc: document.getElementById('resAcc').textContent, badge: !document.getElementById('recordBadge').classList.contains('hidden'), stored: localStorage.getItem('swyy_best') }))()`);
  check('结算页补全时间/金币/历史最佳并持久化', overDom.time !== '0:00' && overDom.best !== '0' && !!overDom.stored, JSON.stringify(overDom));
  check('首局结算显示新纪录徽章', overDom.badge === true);
  check('结算命中率 ≤ 100%', parseInt(overDom.acc, 10) <= 100, overDom.acc);
  await shot('over2');

  // 真实点击再次守卫（等结算覆盖层淡入完成，避免点击落在过渡帧上）
  for (let i = 0; i < 40; i++) {
    const op = await evaluate(`getComputedStyle(document.getElementById('gameoverScreen')).opacity`);
    if (op === '1') break;
    await sleep(120);
  }
  const diag = await evaluate(`(() => {
    const r = document.getElementById('retryBtn').getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const top = document.elementFromPoint(x, y);
    window.__clickLog = [];
    document.addEventListener('mousedown', (e) => window.__clickLog.push('down:' + (e.target.id || e.target.tagName)), true);
    document.addEventListener('click', (e) => window.__clickLog.push('click:' + (e.target.id || e.target.tagName)), true);
    return { x, y, top: top ? (top.id || top.className || top.tagName) : null,
      topHtml: top ? top.outerHTML.slice(0, 90) : null,
      topOverlay: top && top.closest ? (top.closest('.overlay') || {}).id : null,
      overlays: [...document.querySelectorAll('.overlay')].map((o) => ({
        id: o.id, hidden: o.classList.contains('hidden'),
        op: getComputedStyle(o).opacity, pe: getComputedStyle(o).pointerEvents })),
      overHidden: document.getElementById('gameoverScreen').classList.contains('hidden'),
      overPE: getComputedStyle(document.getElementById('gameoverScreen')).pointerEvents,
      state: window.__game.state }; })()`);
  console.log('retry diag:', JSON.stringify(diag));
  await mouse('mousePressed', diag.x, diag.y); await sleep(80); await mouse('mouseReleased', diag.x, diag.y);
  await sleep(600);
  console.log('click log:', JSON.stringify(await evaluate('window.__clickLog')));
  const restarted = await snap();
  check('点击再次守卫重开', restarted.state === 'playing' && restarted.hp === 100 && restarted.kills === 0,
    `state=${restarted.state} hp=${restarted.hp}`);

  // 子弹 swept 碰撞：大步长不得穿透障碍物
  const blockTest = await evaluate(`(() => { const g = window.__game;
    const savedC = g.world.colliders; const savedE = g.enemies;
    g.world.colliders = [{ x: 0, z: 0, r: 0.5 }]; g.enemies = [];
    for (const b of g.bullets) if (b.vis) g.engine.scene.remove(b.vis);
    g.bullets.length = 0;
    const pos = g.p.pos.clone().set(-1.7, 0.9, 0);
    const vel = g.p.vel.clone().set(60, 0, 0);
    g.bullets.push({ pos, vel, life: 1.1, traveled: 0, dmg: 10 });
    g.updateBullets(0.05);
    const left = g.bullets.length;
    for (const b of g.bullets) if (b.vis) g.engine.scene.remove(b.vis);
    g.bullets.length = 0; g.world.colliders = savedC; g.enemies = savedE;
    return { left }; })()`);
  check('子弹大步长不穿透障碍物', blockTest.left === 0, JSON.stringify(blockTest));

  // ===== 枪口火光缩小 =====
  const flashNow = await evaluate(`(() => { const g = window.__game;
    g.p.mag = 24; g.p.fireT = 0; g.fire();
    let maxS = 0, maxI = 0;
    for (const f of g.fx.flashes) if (f.life > 0) maxS = Math.max(maxS, f.s.scale.x);
    for (const l of g.fx.lights) maxI = Math.max(maxI, l.intensity);
    for (const b of g.bullets) if (b.vis) g.engine.scene.remove(b.vis);
    g.bullets.length = 0;
    return { maxS: +maxS.toFixed(2), maxI: +maxI.toFixed(1) }; })()`);
  check('枪口火光显著缩小', flashNow.maxS > 0 && flashNow.maxS < 0.5 && flashNow.maxI < 15, JSON.stringify(flashNow));

  // fragile 调试模式跨重开保持
  const fragileHp = await evaluate(`(() => { const g = window.__game; g.fragile = true; g.start(); return g.p.hp; })()`);
  check('fragile 模式重开保持 1 HP', fragileHp === 1, `hp=${fragileHp}`);
  const fragileGear = await evaluate(`(() => { const g = window.__game; g.coins = 9999; g.buyGood('helmet'); g.points = 5; g.buyTalent('t_hp'); return { maxHp: g.p.maxHp, hp: g.p.hp }; })()`);
  check('fragile 模式买装备/天赋仍保持 1 HP', fragileGear.maxHp === 1 && fragileGear.hp === 1, JSON.stringify(fragileGear));
  await evaluate(`(() => { const g = window.__game; g.fragile = false; g.start(); return 1; })()`);

  // 720p 战斗美景截图
  await evaluate('window.__game.bot = true');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await sleep(1000);
  await waitGame(8, 180000);
  await shot('beauty');

  // 鸭脸特写（验证参照图形象）
  await evaluate(`(() => { const g = window.__game; g.bot = false; g.mouse.down = false; g.keys.clear();
    g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0);
    const du = g.playerDuck; const orig = du.update.bind(du);
    du.update = (dt, st) => orig(dt, Object.assign({}, st, { aimYaw: 0.62, moving: false }));
    g.engine.updateCamera = () => { const p = g.p.pos;
      g.engine.camera.position.set(p.x + 1.5, 1.35, p.z + 2.1);
      g.engine.camera.lookAt(p.x, 0.72, p.z); }; return 1; })()`);
  await sleep(1500);
  await shot('closeup');

  const failed = results.filter((r) => !r.ok);
  console.log(`\nE2E ${results.length - failed.length}/${results.length} passed`);
  if (errors.length) console.log('runtime errors:', errors.slice(0, 5));
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error('E2E ERROR', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
}