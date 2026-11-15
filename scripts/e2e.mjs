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
    // 每波肃清会弹三选一强化卡；长跑演示阶段自动选第一张继续推进
    if (s.state === 'card' && gsec >= 5) {
      await evaluate('window.__game.pickCard(window.__game.cardDraft[0].id)');
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
    type: down ? 'keyDown' : 'keyUp', code,
    key: code === 'Space' ? ' ' : code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    ...(down && code === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
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
  await evaluate(`(() => { const g = window.__game;
    if (g.state === 'card') g.pickCard(g.cardDraft[0].id);
    g.bot = false; g.keys.clear(); g.mouse.down = false; g.mouseFire = false;
    g.clearField(); g.spawnQueue = []; g.waveState = 'inter'; g.interT = 9999;
    g.cards = {}; g.cardHistory = []; g.recomputeLoadout(); g.p.iframes = 60; return 1; })()`);
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
  // 先把相机落到「朝北(−z)」的收敛位姿：bot 战斗后相机朝向随机，低帧率下 lead 来不及摆正，
  // 直接给定位姿保证「屏幕前方=世界−z」这一前提成立（与遮挡测试同一手法）
  await evaluate(`(() => { const g = window.__game;
    g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0);
    g.engine.camLook.set(0, 0.6, -2); g.engine.camPos.set(0, 11.2, 6.6);
    g.engine.camera.position.copy(g.engine.camPos); g.engine.camera.lookAt(g.engine.camLook);
    g.engine.camera.updateMatrixWorld();
    g.mouse.x = innerWidth / 2; g.mouse.y = innerHeight / 2; return 1; })()`);
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
    g.clearField();
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

  // 准星只是方向：始终钉在鼠标指针处，不吸附到弹道落点；真实落点由地面琥珀环单独显示
  const xhairPos = () => evaluate(`(() => { const g = window.__game;
    const m = /translate\\(([-\\d.]+)px, ([-\\d.]+)px\\)/.exec(document.getElementById('crosshair').style.transform);
    return { cx: +m[1], cy: +m[2], mx: g.mouse.x, my: g.mouse.y }; })()`);
  await evaluate(`(() => { const g = window.__game; g.bot = false; g.keys.clear(); g.mouse.down = false;
    window.__waveX = { s: g.waveState, t: g.interT, q: [...g.spawnQueue] };
    g.clearField(); g.waveState = 'inter'; g.interT = 999;
    window.__collidersX = g.world.colliders; g.world.colliders = [];
    g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0); g.p.iframes = 60;
    const v = g.aimPoint.clone().set(6, 0, 6).project(g.engine.camera);
    g.mouse.x = (v.x * 0.5 + 0.5) * innerWidth; g.mouse.y = (-v.y * 0.5 + 0.5) * innerHeight;
    return 1; })()`);
  await waitGame(0.5);
  const xg = await xhairPos();
  const xgIy = await evaluate('+window.__game.impactPoint.y.toFixed(2)');
  check('空地准星钉在鼠标指针处（只指示方向）', Math.hypot(xg.cx - xg.mx, xg.cy - xg.my) < 2 && xgIy < 0.1,
    JSON.stringify({ ...xg, iy: xgIy }));
  // 先把鼠标预置到目标地面点方向，等相机 lead 收敛（否则旧相机投影会随相机移动失效）
  await evaluate(`(() => { const g = window.__game;
    const v = g.aimPoint.clone().set(0.4, 0, -4.4).project(g.engine.camera);
    g.mouse.x = (v.x * 0.5 + 0.5) * innerWidth; g.mouse.y = (-v.y * 0.5 + 0.5) * innerHeight;
    return 1; })()`);
  await waitGame(2.5);
  await evaluate(`(() => { const g = window.__game;
    g.spawnEnemy('brawler'); const e = g.enemies[g.enemies.length - 1];
    e.pos.set(0, 0, -4); e.duck.group.position.copy(e.pos);
    e.speed = 0; e.vel.set(0, 0, 0); // 冻结敌人，防止等待期间追击玩家导致包围球脱靶
    // 相机直接落到收敛位姿再冻结：bot 战斗后相机可能仍在 lerp 中途，
    // 非收敛机位下固定鼠标射线会擦不到包围球。收敛位姿 = 玩家(0,0,0) + lead(0.4,-4.4)*0.4
    const look = { x: 0.16, y: 0.6, z: -1.76 };
    g.engine.camLook.set(look.x, look.y, look.z);
    g.engine.camPos.set(look.x, look.y + 10.6, look.z + 8.6);
    g.engine.camera.position.copy(g.engine.camPos);
    g.engine.camera.lookAt(g.engine.camLook);
    g.engine.camera.updateMatrixWorld();
    // 冻结相机：相机 lead 跟随瞄准点，吸附会把相机拉向敌人→固定鼠标射线脱靶→吸附释放，
    // 形成反馈震荡。测试期间固定机位保证射线稳定（与曳光截图同一手法）
    window.__origCamOccl = g.engine.updateCamera.bind(g.engine);
    g.engine.updateCamera = () => {};
    // 瞄敌人侧后方地面 (0.4,-4.4)：射线擦边穿过包围球（球面命中点低于枪口上沿，
    // 弹道步进也能命中敌人圆柱）。准星应留在鼠标处，落点环单独标在敌人身上
    const v = g.aimPoint.clone().set(0.4, 0, -4.4).project(g.engine.camera);
    g.mouse.x = (v.x * 0.5 + 0.5) * innerWidth; g.mouse.y = (-v.y * 0.5 + 0.5) * innerHeight;
    return 1; })()`);
  await waitGame(0.5);
  const xo = await xhairPos();
  // 新设计断言：准星钉在鼠标指针处（方向指示），弹道预测仍命中敌人。
  // 落点环仅在落点与瞄准方向分离 >0.5m 时显示（此处命中同一敌人，环正确隐藏）
  const xoSnap = await evaluate(`(() => { const g = window.__game; const e = g.enemies[g.enemies.length - 1];
    const d = Math.hypot(g.aimPoint.x - e.pos.x, g.aimPoint.y - 0.75 * e.scale, g.aimPoint.z - e.pos.z);
    return { sphereDist: +d.toFixed(2), r: +(0.8 * e.scale).toFixed(2), y: +g.aimPoint.y.toFixed(2),
      impactD: +Math.hypot(g.impactPoint.x - e.pos.x, g.impactPoint.z - e.pos.z).toFixed(2) }; })()`);
  check('遮挡时准星留在鼠标处（只指示方向）、弹道仍命中敌人',
    Math.hypot(xo.cx - xo.mx, xo.cy - xo.my) < 2 && xoSnap.impactD < 1.2,
    JSON.stringify({ ...xo, ...xoSnap }));
  await shot('aim-impact');
  await evaluate(`(() => { const g = window.__game;
    g.clearField();
    g.engine.updateCamera = window.__origCamOccl;
    g.world.colliders = window.__collidersX;
    g.waveState = window.__waveX.s; g.interT = window.__waveX.t; g.spawnQueue = window.__waveX.q;
    g.bot = true; return 1; })()`);

  // 射程限制：瞄准点超出射程时子弹在射程末端坠地，准星显示短落点，远处敌人不受伤害
  await evaluate(`(() => { const g = window.__game; g.bot = false; g.keys.clear(); g.mouse.down = false;
    window.__waveR = { s: g.waveState, t: g.interT, q: [...g.spawnQueue] };
    g.clearField(); g.waveState = 'inter'; g.interT = 999;
    window.__collidersR = g.world.colliders; g.world.colliders = [];
    for (const b of g.bullets) if (b.vis) g.engine.scene.remove(b.vis);
    g.bullets = [];
    g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0); g.p.iframes = 60;
    window.__rangeR = g.loadout.range; g.loadout.range = 6;
    window.__spreadR = g.spreadNow; g.spreadNow = () => 0;
    g.spawnEnemy('brawler'); const e = g.enemies[g.enemies.length - 1];
    e.pos.set(0, 0, -12); e.speed = 0; e.duck.group.position.copy(e.pos); window.__hpR = e.hp;
    return 1; })()`);
  await waitGame(0.6);
  await evaluate(`(() => { const g = window.__game;
    const v = g.aimPoint.clone().set(0, 0.75, -12).project(g.engine.camera);
    g.mouse.x = (v.x * 0.5 + 0.5) * innerWidth; g.mouse.y = (-v.y * 0.5 + 0.5) * innerHeight;
    return 1; })()`);
  await waitGame(0.4);
  const rngImp = await evaluate(`(() => { const g = window.__game;
    return { d: +Math.hypot(g.impactPoint.x - g.p.pos.x, g.impactPoint.z - g.p.pos.z).toFixed(2), y: +g.impactPoint.y.toFixed(2) }; })()`);
  check('瞄准超出射程时预测落点截断在射程内', rngImp.d > 5 && rngImp.d < 7.3 && rngImp.y < 0.1, JSON.stringify(rngImp));
  const rngX = await xhairPos();
  check('超射程时准星留在鼠标瞄准点（准星只是方向）', Math.hypot(rngX.cx - rngX.mx, rngX.cy - rngX.my) < 8, JSON.stringify(rngX));
  const rngMark = await evaluate(`(() => { const g = window.__game;
    return { vis: g.impactMarker ? g.impactMarker.visible : false,
      d: g.impactMarker ? +Math.hypot(g.impactMarker.position.x - g.impactPoint.x, g.impactMarker.position.z - g.impactPoint.z).toFixed(2) : -1 }; })()`);
  check('超射程时地面显示真实落点标记', rngMark.vis && rngMark.d < 0.3, JSON.stringify(rngMark));
  const rngFire = await evaluate(`(async () => { const g = window.__game;
    g.p.mag = 5; g.p.fireT = 0; g.fire();
    const b = g.bullets[g.bullets.length - 1];
    await new Promise(r => setTimeout(r, 600));
    const e = g.enemies[g.enemies.length - 1];
    return { gone: !g.bullets.includes(b), traveled: +b.traveled.toFixed(2), hp: e.hp, hp0: window.__hpR }; })()`);
  check('子弹在射程末端坠地且未伤及射程外敌人', rngFire.gone && rngFire.traveled >= 5.5 && rngFire.traveled <= 6.6 && rngFire.hp === rngFire.hp0, JSON.stringify(rngFire));
  await evaluate(`(() => { const g = window.__game;
    g.clearField();
    g.loadout.range = window.__rangeR; g.spreadNow = window.__spreadR;
    g.world.colliders = window.__collidersR;
    g.waveState = window.__waveR.s; g.interT = window.__waveR.t; g.spawnQueue = window.__waveR.q;
    g.bot = true; return 1; })()`);

  // 福利拾取浮字：完整名称 + 金币纹理不裁切，精灵按纹理宽高比缩放
  const clip = await evaluate(`(() => { const g = window.__game;
    g.fx.number(g.p.pos.clone(), '季度绩效 +24', '#ffe28a');
    const tex = g.fx.numTex.get('季度绩效 +24#ffe28a');
    const c = document.createElement('canvas'); const ctx = c.getContext('2d');
    ctx.font = '900 64px "Yuanti SC","YouYuan","Microsoft YaHei",sans-serif';
    const need = Math.ceil(ctx.measureText('季度绩效 +24').width) + 10;
    const n = g.fx.numbers.find(x => x.life > 0 && x.s.material.map === tex);
    return { w: tex.image.width, need, sx: n.s.scale.x, sy: n.s.scale.y, tw: tex.image.width, th: tex.image.height }; })()`);
  check('拾取浮字纹理宽度容纳福利名称与金币', clip.w >= clip.need, JSON.stringify(clip));
  check('拾取浮字精灵按纹理宽高比缩放', Math.abs(clip.sx / clip.sy - clip.tw / clip.th) < 0.02, JSON.stringify(clip));
  await evaluate(`(() => { const g = window.__game;
    const n = g.fx.numbers.find(x => x.life > 0 && x.s.material.map === g.fx.numTex.get('季度绩效 +24#ffe28a'));
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
    // 软件渲染可能低至 3fps（帧间隔 333ms），等待需覆盖至少 2 帧
    await new Promise(r => setTimeout(r, 900));
    const d = +p0.distanceTo(b.vis.position).toFixed(2);
    b.life = 0.001;
    await new Promise(r => setTimeout(r, 700));
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

  // 武器面板：只购买/装备 AI 模型枪，不再有弹药商店、护具或背包出售
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
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
  const weaponSnap = () => evaluate(`(() => { const g = window.__game; return {
    coins: g.coins, reserve: g.p.reserve, gunId: g.gunId, owned: [...g.ownedGuns], mag: g.p.mag,
    magSize: g.loadout.magSize, pellets: g.loadout.pellets, model: g.playerDuck.weapon,
    wallet: document.getElementById('weaponCoins').textContent }; })()`);
  await evaluate(`(() => { const g = window.__game;
    if (g.state === 'card') g.pickCard(g.cardDraft[0].id);
    if (g.state === 'paused') g.resume();
    g.bot = false; g.keys.clear(); g.mouse.down = false; g.mouseFire = false;
    g.clearField(); g.spawnQueue = []; g.waveState = 'inter'; g.interT = 9999;
    g.coins = 1000; g.cards = { c_mag: 2 }; g.cardHistory = ['c_mag', 'c_mag'];
    g.recomputeLoadout(); g.p.iframes = 60; return 1; })()`);
  await key('KeyB', 66, true); await sleep(120); await key('KeyB', 66, false);
  await sleep(350);
  const weaponState = await snap();
  check('B 键打开武器面板并暂停', weaponState.state === 'weapons');
  const weaponDom = await evaluate(`(() => { const g = window.__game;
    const cards = [...document.querySelectorAll('#weaponGrid button.weaponCard')];
    return { ids: cards.map(c => c.dataset.gun), hidden: document.getElementById('weaponScreen').classList.contains('hidden'),
      complete: cards.every(c => ['canvas', '.weaponName', '.weaponTag', '.weaponStats', '.weaponPrice', '.weaponAction'].every(s => c.querySelector(s))),
      buy: document.querySelector('#weaponGrid [data-gun="glm"] .weaponAction').textContent.trim(),
      oldDom: !!document.querySelector('#shopScreen, #buyPane, #sellPane, .shopTabs, #tip'),
      oldState: 'gear' in g || 'inv' in g,
      oldMethods: ['buyGood', 'openShop', 'closeShop', 'sellItem'].some(k => typeof g[k] === 'function'),
      keys: g.keys.size, mouse: g.mouse.down || g.mouseFire }; })()`);
  check('武器面板仅渲染 4 把模型枪，卡面信息齐全',
    JSON.stringify(weaponDom.ids) === JSON.stringify(['claude', 'qwen', 'glm', 'codex']) && !weaponDom.hidden
    && weaponDom.complete && /购买|購買/.test(weaponDom.buy), JSON.stringify(weaponDom));
  check('旧商店/出售/悬浮提示/背包护具接口已移除', !weaponDom.oldDom && !weaponDom.oldState && !weaponDom.oldMethods, JSON.stringify(weaponDom));
  check('打开武器面板清空移动与鼠标输入', weaponDom.keys === 0 && !weaponDom.mouse, JSON.stringify({ keys: weaponDom.keys, mouse: weaponDom.mouse }));
  const frozen0 = weaponState.time;
  await sleep(900);
  const frozen1 = (await snap()).time;
  check('武器面板打开时战斗时间冻结', Math.abs(frozen1 - frozen0) < 0.05, `time ${frozen0}->${frozen1}`);
  await shot('weapons');

  const w0 = await weaponSnap();
  await clickSel('#weaponGrid button[data-gun="glm"]');
  const w1 = await weaponSnap();
  check('真实点击购买 GLM：扣 400 金币、立即装备霰弹模型',
    w1.coins === w0.coins - 400 && w1.gunId === 'glm' && w1.owned.includes('glm')
    && w1.model === 'shotgun' && w1.pellets === 6 && w1.reserve === w0.reserve,
    JSON.stringify({ w0, w1 }));
  check('新购武器弹匣立即包含两层弹匣卡加成', w1.mag === 9 && w1.mag === w1.magSize, JSON.stringify(w1));
  check('武器面板金币随购买实时更新', Number(w1.wallet.replace(/[^0-9]/g, '')) === w1.coins, JSON.stringify(w1));

  await clickSel('#weaponGrid button[data-gun="codex"]');
  const rejected = await weaponSnap();
  check('金币不足不能购买 Codex，也不改变当前武器',
    rejected.coins === w1.coins && rejected.gunId === 'glm' && !rejected.owned.includes('codex'), JSON.stringify(rejected));
  await evaluate('window.__game.p.mag = 4');
  await clickSel('#weaponGrid button[data-gun="claude"]');
  const freeEquip = await weaponSnap();
  await clickSel('#weaponGrid button[data-gun="glm"]');
  const duplicate = await weaponSnap();
  check('已购武器免费装备、重复点击不重复扣款或补满弹匣',
    freeEquip.gunId === 'claude' && duplicate.gunId === 'glm' && duplicate.coins === w1.coins
    && freeEquip.coins === w1.coins && duplicate.owned.length === 2 && duplicate.mag === 4,
    JSON.stringify({ freeEquip, duplicate }));

  await clickSel('#weaponClose');
  check('关闭按钮恢复战斗', (await snap()).state === 'playing');
  await key('KeyB', 66, true); await key('KeyB', 66, false); await sleep(150);
  await key('Escape', 27, true); await key('Escape', 27, false); await sleep(200);
  check('Esc 关闭武器面板而非切换到暂停', (await snap()).state === 'playing');
  await key('KeyB', 66, true); await key('KeyB', 66, false); await sleep(150);
  await key('KeyB', 66, true); await key('KeyB', 66, false); await sleep(200);
  check('B 键也能关闭武器面板', (await snap()).state === 'playing');

  // Q/E + 滚轮切枪（只在已购的 Claude / GLM 间循环）
  await key('KeyQ', 81, true); await sleep(120); await key('KeyQ', 81, false); await sleep(250);
  check('Q 键切上一把已购枪', (await evaluate('window.__game.gunId')) === 'claude');
  await key('KeyE', 69, true); await sleep(120); await key('KeyE', 69, false); await sleep(250);
  const swE = await evaluate(`(() => { const g = window.__game; return { gunId: g.gunId, pellets: g.loadout.pellets }; })()`);
  check('E 键切下一把已购枪（GLM）', swE.gunId === 'glm' && swE.pellets === 6, JSON.stringify(swE));
  await wheel(120); await sleep(200);
  check('滚轮下滚切枪，跳过未购武器', (await evaluate('window.__game.gunId')) === 'claude');
  await wheel(-120); await sleep(200);
  check('滚轮上滚切回 GLM', (await evaluate('window.__game.gunId')) === 'glm');

  // 福利：真实 spawnPickup → updatePickups，金币与即时效果一次到账，无背包积压
  const benefits = await evaluate(`(async () => { const g = window.__game; const { LOOT_ITEMS } = await import('/src/rules.js');
    const rows = [];
    for (const item of LOOT_ITEMS) {
      g.clearField(); g.spawnQueue = []; g.waveState = 'inter'; g.interT = 9999;
      g.cards = {}; g.cardHistory = []; g.level = 1; g.xp = 0; g.xpEarned = 0; g.recomputeLoadout();
      g.p.hp = 10; g.p.reserve = 0; g.p.shield = 0; g.p.skillShield = 0; g.p.shieldMax = 0; g.p.shieldSkillT = 0;
      g.p.hasteT = 0; g.p.rageT = 0; g.coins = 10; g.coinsEarned = 20;
      g.spawnPickup(g.p.pos.clone(), 'loot', item.id);
      const queued = g.pickups.length;
      g.updatePickups(0.016);
      const first = { coins: g.coins, earned: g.coinsEarned, hp: g.p.hp, shield: g.p.shield, reserve: g.p.reserve,
        hasteT: g.p.hasteT, rageT: g.p.rageT, xp: g.xpEarned };
      g.updatePickups(0.016);
      rows.push({ id: item.id, coins: item.coins, queued, left: g.pickups.length, first,
        once: first.coins === g.coins && first.earned === g.coinsEarned, noInventory: !('inv' in g) });
    }
    g.p.reserve = 96;
    return rows; })()`);
  check('全部 9 种福利拾取即加金币且只结算一次，不产生背包',
    benefits.length === 9 && benefits.every(r => r.queued === 1 && r.left === 0 && r.once && r.noInventory
    && r.first.coins === 10 + r.coins && r.first.earned === 20 + r.coins), JSON.stringify(benefits));
  const benefitExpected = {
    subsidy: ['hp', 20], welfare: ['shield', 20], salary: ['hp', 35], coffee: ['hasteT', 5],
    overtime: ['reserve', 16], performance: ['xp', 30], bonus: ['rageT', 4], yearbonus: ['hp', 70], stock: ['hp', 100],
  };
  for (const row of benefits) {
    const [field, expected] = benefitExpected[row.id];
    check('福利即时效果 ' + row.id, row.first[field] === expected, JSON.stringify(row.first));
  }

  // ===== 成长线：经验 / 等级 / 波次强化卡 / 技能 =====
  // 每波肃清会弹三选一强化卡（新系统），确定性测试期间先挂起出怪，避免随机插入选卡界面
  await evaluate(`(() => { const g = window.__game; g.bot = false; g.keys.clear(); g.mouse.down = false;
    g.p.iframes = 60; g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0);
    g.clearField(); g.spawnQueue = []; g.waveState = 'inter'; g.interT = 9999; return 1; })()`);

  const xp0 = await evaluate(`(() => { const g = window.__game; g.spawnEnemy('brawler'); const e = g.enemies[g.enemies.length - 1];
    e.pos.set(2, 0, 2); e.hp = 1; const before = g.xpEarned; g.killEnemy(e); return { before, after: g.xpEarned }; })()`);
  check('击杀获得经验', xp0.after > xp0.before, `xpEarned ${xp0.before}->${xp0.after}`);

  const lvl = await evaluate(`(() => { const g = window.__game; g.p.hp = 50; const l0 = g.level;
    g.addXp(3000); return { l0, l1: g.level, hp: Math.round(g.p.hp), noPoints: !('points' in g) }; })()`);
  check('升级提升等级（天赋点已移除）', lvl.l1 > lvl.l0 && lvl.noPoints, JSON.stringify(lvl));
  check('升级回复生命', lvl.hp > 50, `hp=${lvl.hp}`);

  // 波次肃清 → 三选一强化卡
  const draft = await evaluate(`(() => { const g = window.__game;
    g.clearField(); g.spawnQueue = []; g.waveState = 'fight';
    g.updateWaves(0.016);
    const cards = [...document.querySelectorAll('#cardRow .pickCard')];
    return { state: g.state, n: cards.length, ids: (g.cardDraft || []).map(c => c.id),
      hidden: document.getElementById('cardScreen').classList.contains('hidden'),
      badges: cards.map(c => c.querySelector('.rarBadge').textContent),
      descs: cards.map(c => c.querySelector('.cdesc').textContent.length),
      arts: cards.filter(c => c.querySelector('.art canvas')).length }; })()`);
  check('每波肃清弹出 3 张互不相同的强化卡', draft.state === 'card' && draft.n === 3
    && new Set(draft.ids).size === 3 && !draft.hidden, JSON.stringify(draft));
  check('卡面含稀有度徽标 / 图标 / 效果描述', draft.arts === 3 && draft.badges.every(Boolean)
    && draft.descs.every((n) => n > 4), JSON.stringify({ badges: draft.badges, descs: draft.descs }));
  const cd0 = (await snap()).time; await sleep(800); const cd1 = (await snap()).time;
  check('选卡期间战斗时间冻结', Math.abs(cd1 - cd0) < 0.05, `time ${cd0}->${cd1}`);
  await shot('card-draft');

  await key('Escape', 27, true); await sleep(100); await key('Escape', 27, false); await sleep(200);
  check('选卡必须三选一，Esc 无法跳过', (await snap()).state === 'card');

  // 指定一张已知普通卡走完整点击流程，验证数值真实生效
  await evaluate(`(async () => { const g = window.__game; const { CARD_BY_ID } = await import('/src/rules.js');
    g.cards = {}; g.cardHistory = []; g.recomputeLoadout();
    const c = CARD_BY_ID.c_dmg; g.cardDraft = [{ ...c, stacks: 0, next: 1 }];
    g.state = 'card'; g.hud.cardOpen(true); g.hud.renderCards(g); return 1; })()`);
  const dmg0 = await evaluate(`(() => { const g = window.__game; return { dmg: g.loadout.damage, rank: g.cards.c_dmg || 0, hist: g.cardHistory.length }; })()`);
  await clickSel('#cardRow .pickCard[data-card="c_dmg"]');
  const dmg1 = await evaluate(`(() => { const g = window.__game; return { dmg: g.loadout.damage, rank: g.cards.c_dmg || 0,
    hist: g.cardHistory.length, state: g.state, draft: g.cardDraft,
    hidden: document.getElementById('cardScreen').classList.contains('hidden'),
    chip: document.getElementById('cardChip').textContent }; })()`);
  check('点选普通卡「尖嘴利喙」伤害 +12%', dmg1.rank === 1 && Math.abs(dmg1.dmg - dmg0.dmg * 1.12) < 0.01,
    JSON.stringify({ dmg0, dmg1 }));
  check('选卡后关闭面板、回到战斗、HUD 层数 +1',
    dmg1.state === 'playing' && dmg1.hidden && dmg1.draft === null && dmg1.hist === dmg0.hist + 1
    && +dmg1.chip === dmg0.hist + 1, JSON.stringify(dmg1));

  // 数字键直选第二张
  await evaluate(`(() => { const g = window.__game; g.clearField(); g.spawnQueue = [];
    g.waveState = 'fight'; g.updateWaves(0.016); return 1; })()`);
  const k2 = await evaluate(`(() => { const g = window.__game; const id = g.cardDraft[1].id;
    return { id, stacks: g.cards[id] || 0, hist: g.cardHistory.length }; })()`);
  await key('Digit2', 50, true); await sleep(120); await key('Digit2', 50, false); await sleep(250);
  const k2s = await evaluate(`(() => { const g = window.__game; return {
    state: g.state, got: g.cards['${k2.id}'] || 0, hist: g.cardHistory.length }; })()`);
  check('数字键 2 直选第二张卡并只增加一层', k2s.state === 'playing' && k2s.got === k2.stacks + 1
    && k2s.hist === k2.hist + 1, JSON.stringify({ before: k2, after: k2s }));

  // 卡牌图鉴（T 键）
  await tapT();
  check('T 键打开卡牌图鉴并暂停', (await snap()).state === 'cardbook');
  const book = await evaluate(`(() => { const g = window.__game;
    return { cards: document.querySelectorAll('#cardBookGrid .bookCard').length,
      kinds: new Set(g.cardHistory).size, layers: g.cardHistory.length,
      hidden: document.getElementById('cardBookScreen').classList.contains('hidden'),
      total: document.getElementById('cardBookCount').textContent }; })()`);
  check('图鉴列出已获卡牌与总层数', book.cards === book.kinds && book.cards >= 1 && !book.hidden
    && book.total.includes(`${book.kinds} 种`) && book.total.includes(`${book.layers} 层`), JSON.stringify(book));
  const bt0 = (await snap()).time; await sleep(800); const bt1 = (await snap()).time;
  check('图鉴打开时战斗时间冻结', Math.abs(bt1 - bt0) < 0.05, `time ${bt0}->${bt1}`);
  await shot('card-book');
  await tapT();
  check('T 键关闭图鉴恢复战斗', (await snap()).state === 'playing');

  // 抽到的随机特效不能影响后续技能倍率与弹丸计数断言。
  await evaluate('window.__game.cards = {}; window.__game.cardHistory = []; window.__game.recomputeLoadout()');
  check('开局自带嘎嘎乱杀（等级解锁，无需卡牌）', (await evaluate('window.__game.loadout.skills.storm')) === true);
  await evaluate(`(() => { const g = window.__game; g.cards.g_storm = 1; g.recomputeLoadout(); return 1; })()`);
  check('金卡「乱杀精通」提升技能数值', (await evaluate('window.__game.loadout.storm.damage')) === 100);
  await evaluate(`(() => { const g = window.__game; delete g.cards.g_storm; g.recomputeLoadout();
    g.waveState = 'inter'; g.interT = 9999; return 1; })()`);

  const stormSetup = await evaluate(`(() => { const g = window.__game;
    g.clearField();
    for (let i = 0; i < 3; i++) { g.spawnEnemy('brawler'); const e = g.enemies[g.enemies.length - 1]; e.pos.set(1.5 + i * 0.4, 0, 1.5); e.duck.group.position.copy(e.pos); e.hp = 30; }
    g.p.pos.set(0, 0, 0); g.p.iframes = 60; return { kills: g.kills }; })()`);
  await key('Digit1', 49, true); await sleep(120); await key('Digit1', 49, false); await sleep(300);
  const stormAfter = await evaluate(`(() => { const g = window.__game; return { cd: +g.skillCd.storm.toFixed(1), kills: g.kills }; })()`);
  check('Digit1 释放嘎嘎乱杀进入冷却', stormAfter.cd > 10, `cd=${stormAfter.cd}`);
  check('嘎嘎乱杀击杀近身敌人', stormAfter.kills > stormSetup.kills, `kills ${stormSetup.kills}->${stormAfter.kills}`);

  // 精确等级边界：addXp(3000) 已把等级推到 ~18，这里重置到阈值上下各测一次
  const shieldGate = await evaluate(`(() => { const g = window.__game;
    g.level = 2; g.recomputeLoadout(); const at2 = g.loadout.skills.shield;
    g.level = 3; g.recomputeLoadout(); const at3 = g.loadout.skills.shield;
    return { at2, at3 }; })()`);
  check('抱头蹲防恰在 Lv.3 解锁（Lv.2 仍锁定）', shieldGate.at2 === false && shieldGate.at3 === true, JSON.stringify(shieldGate));
  await key('Digit2', 50, true); await sleep(120); await key('Digit2', 50, false); await sleep(250);
  const shieldOn = await evaluate(`(() => { const g = window.__game; return { shield: g.p.shield, shieldT: +g.p.shieldSkillT.toFixed(1), cd: +g.skillCd.shield.toFixed(1), bar: document.getElementById('shieldBar').classList.contains('on') }; })()`);
  check('Digit2 抱头蹲防展开护盾条', shieldOn.shield > 0 && shieldOn.shieldT > 0 && shieldOn.cd > 15 && shieldOn.bar, JSON.stringify(shieldOn));
  const absorb = await evaluate(`(() => { const g = window.__game; g.p.iframes = 0; const h = g.p.hp; g.damagePlayer(20); return { h: Math.round(h), after: Math.round(g.p.hp), shield: Math.round(g.p.shield) }; })()`);
  check('抱头蹲防吸收伤害不扣血', absorb.after === absorb.h && absorb.shield < shieldOn.shield, JSON.stringify(absorb));

  // Lv.3 时红温暴走（Lv.6）仍未解锁：按键应提示且不进入冷却
  const rageLocked = await evaluate('window.__game.loadout.skills.rage');
  await key('Digit3', 51, true); await sleep(120); await key('Digit3', 51, false); await sleep(200);
  const rageLockedAfter = await evaluate(`(() => { const g = window.__game; return { cd: g.skillCd.rage, rageT: g.p.rageT }; })()`);
  check('未解锁技能按键不进入冷却', rageLocked === false && rageLockedAfter.cd === 0 && rageLockedAfter.rageT === 0, JSON.stringify(rageLockedAfter));

  const rageGate = await evaluate(`(() => { const g = window.__game;
    g.level = 5; g.recomputeLoadout(); const at5 = g.loadout.skills.rage;
    g.level = 6; g.recomputeLoadout(); const at6 = g.loadout.skills.rage;
    return { at5, at6 }; })()`);
  check('红温暴走恰在 Lv.6 解锁（Lv.5 仍锁定）', rageGate.at5 === false && rageGate.at6 === true, JSON.stringify(rageGate));

  const slowGate = await evaluate(`(() => { const g = window.__game;
    g.level = 8; g.recomputeLoadout(); const at8 = g.loadout.skills.slow;
    g.level = 9; g.recomputeLoadout(); const at9 = g.loadout.skills.slow;
    return { at8, at9 }; })()`);
  check('嘎瓦鲁多恰在 Lv.9 解锁（Lv.8 仍锁定）', slowGate.at8 === false && slowGate.at9 === true, JSON.stringify(slowGate));
  await key('Digit4', 52, true); await sleep(120); await key('Digit4', 52, false); await sleep(250);
  const slowOn = await evaluate(`(() => { const g = window.__game; return { slowT: +g.slowT.toFixed(1), factor: g.slowFactor, cd: +g.skillCd.slow.toFixed(1) }; })()`);
  check('Digit4 释放嘎瓦鲁多减速敌人', slowOn.slowT > 4 && slowOn.factor < 1 && slowOn.cd > 20, JSON.stringify(slowOn));

  await key('Digit3', 51, true); await sleep(120); await key('Digit3', 51, false); await sleep(250);
  const rageOn = await evaluate(`(() => { const g = window.__game; return { rageT: +g.p.rageT.toFixed(1), cd: +g.skillCd.rage.toFixed(1) }; })()`);
  check('Digit3 释放红温暴走', rageOn.rageT > 5 && rageOn.cd > 18, JSON.stringify(rageOn));
  const rageDmg = await evaluate(`(() => { const g = window.__game; g.p.mag = 24; g.p.fireT = 0; g.aimPoint.set(0, 0.7, 5); g.fire(); const b = g.bullets[g.bullets.length - 1]; return { dmg: +b.dmg.toFixed(2), expect: +(g.loadout.damage * g.loadout.rage.dmgMul).toFixed(2) }; })()`);
  check('红温暴走按倍率提升子弹伤害', Math.abs(rageDmg.dmg - rageDmg.expect) < 0.02, JSON.stringify(rageDmg));
  const skillDom = await evaluate(`(() => [...document.querySelectorAll('#skillBar .slot')].map(s => ({ skill: s.dataset.skill, locked: s.classList.contains('locked'), active: s.classList.contains('active') })))()`);
  check('技能栏四格全部解锁且红温暴走高亮', skillDom.every(s => !s.locked) && skillDom.find(s => s.skill === 'rage').active, JSON.stringify(skillDom));
  await shot('skill');

  // 霰弹枪弹丸计数 + 低弹药兜底 + 场外威胁预警
  const sgBefore = await evaluate(`(() => { const g = window.__game; g.bot = false; g.keys.clear(); g.mouse.down = false;
    g.p.mag = 6; g.p.reserve = 0; g.p.iframes = 60; g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0);
    g.clearField(); g.spawnQueue = [];
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
    g.clearField();
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
    g.clearField();
    for (const b of g.ebullets) if (b.vis) g.engine.scene.remove(b.vis);
    g.ebullets = [];
    g.spawnEnemy({ type: 'brawler', elite: true });
    const e = g.enemies[g.enemies.length - 1];
    e.pos.set(6, 0, 7); e.duck.group.position.copy(e.pos);
    g.p.pos.set(9, 0, 10); g.p.vel.set(0, 0, 0); g.p.iframes = 0; g.p.shieldSkillT = 0; g.p.shield = 0; g.p.hp = g.p.maxHp;
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
    g.clearField();
    for (const b of g.ebullets) if (b.vis) g.engine.scene.remove(b.vis);
    g.ebullets = [];
    g.spawnEnemy('boss');
    const b = g.enemies.find(e => e.type === 'boss');
    b.pos.set(-8, 0, -8); b.duck.group.position.copy(b.pos); b.fireT = 99;
    g.p.pos.set(20, 0, 20); g.p.vel.set(0, 0, 0); g.p.iframes = 0; g.p.shieldSkillT = 0; g.p.shield = 0; g.p.hp = g.p.maxHp;
    b.skillCd = 0;
    return 1; })()`);
  await waitGame(0.3);
  const bs1 = await evaluate(`(() => { const g = window.__game; const b = g.enemies.find(e => e.type === 'boss');
    return { kind: b.skillKind, casting: b.skillT > 0, zone: g.fx.zones.some(z => z.life > 0 && z.g.visible),
      alert: document.getElementById('alertBanner').textContent, hp: g.p.hp, max: g.p.maxHp }; })()`);
  check('Boss 蓄力全图技能并全图预警', bs1.kind === 'nova' && bs1.casting && bs1.zone && bs1.alert.includes('全图') && bs1.hp === bs1.max, JSON.stringify(bs1));
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
    b.skillCd = 0; b.skillT = 0; g.p.hp = g.p.maxHp; g.p.iframes = 0; g.p.shieldSkillT = 0; g.p.shield = 0; return 1; })()`);
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

  // GLM 模型枪上身特写
  await evaluate(`(() => { const g = window.__game; g.bot = false; g.mouse.down = false; g.keys.clear();
    g.clearField();
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
  await shot('weapon-closeup');
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
  const fragileBenefit = await evaluate(`(() => { const g = window.__game; g.coins = 9999;
    g.openWeapons(); g.buyGun('glm'); g.closeWeapons();
    g.cards.c_hp = 3; g.recomputeLoadout(); g.p.hp = 0.5;
    g.spawnPickup(g.p.pos.clone(), 'loot', 'stock'); g.updatePickups(0.016);
    return { maxHp: g.p.maxHp, hp: g.p.hp, loMax: g.loadout.maxHp, gunId: g.gunId }; })()`);
  check('fragile 模式购枪/叠生命卡/全额回血福利仍保持 1 HP', fragileBenefit.maxHp === 1
    && fragileBenefit.hp === 1 && fragileBenefit.loMax > 1 && fragileBenefit.gunId === 'glm', JSON.stringify(fragileBenefit));
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