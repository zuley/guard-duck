// v2 预告片录制：敌人入屏 1s 后才攻击；多机位空镜 / 快进素材 / 慢动作窗口标记 / 动画章节卡。
// 用法：node scripts/promo2-record.mjs
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import WebSocket from 'ws';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9224, CARD_PORT = 9225;
const W = 1920, H = 1080;
const FRAMES_DIR = 'shots/.promo2-frames';
const CARDS_DIR = 'shots/.promo2-cards';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(FRAMES_DIR, { recursive: true });
mkdirSync(CARDS_DIR, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--hide-scrollbars', `--window-size=${W},${H}`,
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=D:/Code/swyy/shots/.chrome-promo2',
  'about:blank',
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map();
const frames = [];
const markers = {};

async function connect(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const sock = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
        await new Promise((r, j) => { sock.on('open', r); sock.on('error', j); });
        return sock;
      }
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error('devtools not reachable on ' + port);
}

function client(sock, onFrame) {
  let id = 0;
  const pend = new Map();
  sock.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Page.screencastFrame') {
      onFrame(m.params);
      sock.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId: m.params.sessionId } }));
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id;
    pend.set(mid, resolve);
    sock.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };
  return { send, evaluate };
}

const nowEpoch = () => evaluate('performance.timeOrigin + performance.now()').then((ms) => ms / 1000);
const mark = async (name) => { markers[name] = await nowEpoch(); console.log('mark', name, markers[name].toFixed(2)); };

const snap = () => evaluate(`(() => { const g = window.__game; return {
  state: g.state, wave: g.wave, kills: g.kills, hp: Math.round(g.p.hp),
  enemies: g.enemies.length, fps: g.engine.fps }; })()`);

async function key(code, vk, down = true) {
  await send('Input.dispatchKeyEvent', {
    type: down ? 'keyDown' : 'keyUp', code, key: code === 'Space' ? ' ' : code.replace('Key', '').toLowerCase(),
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
}
async function tapKey(code, vk) { await key(code, vk, true); await sleep(110); await key(code, vk, false); }
async function mouse(type, x, y, button = 'left') {
  await send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: 1 });
}
async function clickAt(x, y) { await mouse('mousePressed', x, y); await sleep(80); await mouse('mouseReleased', x, y); }
async function clickSel(sel) {
  const r = await evaluate(`(() => { const b = document.querySelector('${sel}'); if (!b) return null; const rc = b.getBoundingClientRect(); return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 }; })()`);
  if (!r) throw new Error('element not found: ' + sel);
  await clickAt(r.x, r.y);
}
async function clickText(sel, text) {
  const r = await evaluate(`(() => { const b = [...document.querySelectorAll('${sel}')].find(x => x.textContent.trim() === '${text}'); if (!b) return null; const rc = b.getBoundingClientRect(); return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 }; })()`);
  if (!r) throw new Error('button not found: ' + text);
  await clickAt(r.x, r.y);
}
const aimAt = (x, y, z) => evaluate(`(() => { const g = window.__game;
  const v = new (g.engine.camera.position.constructor)(${x}, ${y}, ${z}); v.project(g.engine.camera);
  return { x: (v.x + 1) / 2 * ${W}, y: (1 - v.y) / 2 * ${H} }; })()`).then((p) => mouse('mouseMoved', p.x, p.y));

const clearField = () => evaluate(`(() => { const g = window.__game;
  for (const e of g.enemies) { g.engine.scene.remove(e.duck.group); if (e.hpBar) g.engine.scene.remove(e.hpBar.group); }
  g.enemies = []; g.spawnQueue = [];
  for (const b of g.ebullets) if (b.spr) g.engine.scene.remove(b.spr);
  g.ebullets = []; return 1; })()`);

let send, evaluate;
let stage = 'warmup';
let keeper = null;

try {
  ws = await connect(PORT);
  ({ send, evaluate } = client(ws, (p) => {
    const n = frames.length;
    const file = `f${String(n).padStart(5, '0')}.jpg`;
    writeFileSync(`${FRAMES_DIR}/${file}`, Buffer.from(p.data, 'base64'));
    frames.push({ file, ts: p.metadata.timestamp });
  }));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:5173/' });
  await send('Page.bringToFront');
  let booted = false;
  for (let i = 0; i < 80; i++) {
    if (await evaluate('!!window.__game').catch(() => false)) { booted = true; break; }
    await sleep(500);
  }
  if (!booted) throw new Error('game boot failed');

  await evaluate(`(() => { const g = window.__game; g.audio.init();
    window.__fullDest = g.audio.ctx.createMediaStreamDestination();
    g.audio.master.connect(window.__fullDest);
    for (const sel of ['#startScreen .desc', '#startScreen .controls', '#startScreen .qualityRow']) {
      const el = document.querySelector(sel); if (el) el.style.display = 'none';
    }
    return 1; })()`);
  await sleep(3500);
  console.log('warmup:', JSON.stringify(await snap()));

  const fullStart = await nowEpoch();
  await evaluate(`(() => {
    const mk = (dest) => { const mr = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 192000 });
      const rec = { mr, chunks: [] }; mr.ondataavailable = (e) => rec.chunks.push(e.data); mr.start(250); return rec; };
    window.__recFull = mk(window.__fullDest); return 1; })()`);
  await send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: W, maxHeight: H, everyNthFrame: 1 });

  // ---- beauty1: 开局清场 + 高机位环绕 ----
  await mark('beauty1');
  stage = 'beauty1';
  await clickSel('#startBtn');
  await sleep(400);
  await evaluate(`(() => { const g = window.__game;
    window.__musicDest = g.audio.ctx.createMediaStreamDestination();
    g.audio.musicGain.connect(window.__musicDest);
    window.__recMusic = (() => { const mr = new MediaRecorder(window.__musicDest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 192000 });
      const rec = { mr, chunks: [] }; mr.ondataavailable = (e) => rec.chunks.push(e.data); mr.start(250); return rec; })();
    // 敌人入屏 1s 内抑制攻击（fireT/attackT/windup/skill）
    window.__hold = setInterval(() => {
      const gg = window.__game; if (!gg || gg.state !== 'playing') return;
      const now = performance.now() / 1000;
      for (const e of gg.enemies) {
        if (e.dead) continue;
        if (e.__seen == null) {
          const v = e.pos.clone(); v.y += 1; v.project(gg.engine.camera);
          if (v.z <= 1 && Math.abs(v.x) <= 0.98 && Math.abs(v.y) <= 0.98) e.__seen = now; else continue;
        }
        if (now - e.__seen < 1.0) {
          e.fireT = Math.max(e.fireT, 0.5); e.attackT = Math.max(e.attackT, 0.5);
          e.windup = 0; e.skillCd = Math.max(e.skillCd, 0.5); e.skillT = 0;
        }
      }
    }, 40);
    g.bot = false; g.keys.clear(); g.mouse.down = false;
    for (const e of g.enemies) { g.engine.scene.remove(e.duck.group); if (e.hpBar) g.engine.scene.remove(e.hpBar.group); }
    g.enemies = []; g.spawnQueue = [];
    g.p.iframes = 999; g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0);
    document.getElementById('hud').classList.remove('on');
    document.getElementById('crosshair').style.display = 'none';
    window.__origCam = g.engine.updateCamera.bind(g.engine);
    const t0 = performance.now();
    g.engine.updateCamera = () => { const a = (performance.now() - t0) / 1000 * 0.14 + 0.6;
      g.engine.camera.position.set(Math.sin(a) * 13, 5.6, Math.cos(a) * 13);
      g.engine.camera.lookAt(0, 1.1, 0); };
    return 1; })()`);
  await sleep(4000);

  // ---- beauty2: 低机位慢环绕 ----
  await mark('beauty2');
  stage = 'beauty2';
  await evaluate(`(() => { const g = window.__game; const t0 = performance.now();
    g.engine.updateCamera = () => { const a = (performance.now() - t0) / 1000 * 0.10 + 2.2;
      g.engine.camera.position.set(Math.sin(a) * 7, 2.3, Math.cos(a) * 7);
      g.engine.camera.lookAt(0, 0.9, 0); };
    return 1; })()`);
  await sleep(3500);

  // ---- ff: bot 实战 26s（剪辑 4x 快进） ----
  await mark('ff');
  stage = 'ff';
  await evaluate(`(() => { const g = window.__game;
    g.engine.updateCamera = window.__origCam;
    document.getElementById('hud').classList.add('on');
    document.getElementById('crosshair').style.display = '';
    g.coins = 2000; g.buyGood('repeater');
    g.bot = true; g.p.iframes = 30; return 1; })()`);
  keeper = setInterval(async () => {
    try {
      const s = await snap();
      if (s.state === 'paused') { await evaluate('window.__game.resume()'); console.log('auto-resume'); }
      if (stage !== 'over' && s.state === 'playing') await evaluate('window.__game.p.iframes = Math.max(window.__game.p.iframes, 6)');
      if (Date.now() - (keeper.lastLog || 0) > 5000) {
        keeper.lastLog = Date.now();
        console.log(`stage=${stage} frames=${frames.length}`, JSON.stringify(s));
      }
    } catch { /* page busy */ }
  }, 1500);
  await sleep(26000);

  // ---- combat1: 敌人从屏幕上缘入屏，1s 后接战 ----
  await mark('combat1');
  stage = 'combat1';
  await evaluate(`(() => { const g = window.__game; g.bot = false; g.keys.clear(); g.mouse.down = false;
    g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0); g.p.iframes = 30; g.p.mag = 36; g.p.reserve = 120; return 1; })()`);
  await clearField();
  await evaluate(`(() => { const g = window.__game;
    const spots = [['brawler', -4, -7.5], ['brawler', -1.5, -8], ['knifer', 1.5, -8], ['pistol', 4, -7.5]];
    for (const [t, x, z] of spots) { g.spawnEnemy(t); const e = g.enemies[g.enemies.length - 1];
      e.pos.set(x, 0, z); e.duck.group.position.copy(e.pos); }
    return 1; })()`);
  await sleep(1200);
  await evaluate('window.__game.mouse.down = true');
  for (let i = 0; i < 16; i++) {
    const p = await evaluate(`(() => { const g = window.__game;
      const e = g.enemies.filter(e => !e.dead).sort((a, b) => a.pos.distanceTo(g.p.pos) - b.pos.distanceTo(g.p.pos))[0];
      if (!e) return null; const v = e.pos.clone(); v.y = 0.8; v.project(g.engine.camera);
      return { x: (v.x + 1) / 2 * ${W}, y: (1 - v.y) / 2 * ${H} }; })()`);
    if (p) await mouse('mouseMoved', p.x, p.y);
    await sleep(300);
  }
  await evaluate('window.__game.mouse.down = false');

  // ---- shotgun: 贴脸爆发（慢动作窗口 shotgunFire+0.25..+1.15） ----
  await mark('shotgun');
  stage = 'shotgun';
  await evaluate(`(() => { const g = window.__game; g.bot = false; g.keys.clear(); g.mouse.down = false;
    g.coins = 2000; g.buyGood('shotgun'); g.p.mag = 6; g.p.reserve = 60; g.p.iframes = 30;
    g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0); return 1; })()`);
  await clearField();
  await evaluate(`(() => { const g = window.__game;
    for (let i = 0; i < 5; i++) { const a = -0.55 + i * 0.27; const d = 2.6 + (i % 2) * 0.7;
      g.spawnEnemy('brawler'); const e = g.enemies[g.enemies.length - 1];
      e.pos.set(Math.sin(a) * d, 0, Math.cos(a) * d); e.duck.group.position.copy(e.pos); }
    return 1; })()`);
  await sleep(1500);
  await aimAt(0, 0.7, 3);
  await mark('shotgunFire');
  await evaluate('window.__game.mouse.down = true');
  await sleep(2600);
  await evaluate('window.__game.mouse.down = false');

  // ---- dodge: 近战前摇 + 冲刺闪避（慢动作窗口 dodgeDash+0.1..+0.9） ----
  await mark('dodge');
  stage = 'dodge';
  await clearField();
  await evaluate(`(() => { const g = window.__game; g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0); g.p.iframes = 30;
    g.spawnEnemy('clubber'); const e = g.enemies[g.enemies.length - 1];
    e.pos.set(0, 0, 1.7); e.duck.group.position.copy(e.pos); return 1; })()`);
  let windupSeen = false;
  for (let i = 0; i < 35; i++) {
    await sleep(100);
    if (await evaluate('window.__game.enemies.some(e => e.windup > 0)')) { windupSeen = true; break; }
  }
  console.log('windup telegraph seen:', windupSeen);
  await mark('dodgeDash');
  await key('KeyD', 68, true); await sleep(60);
  await tapKey('Space', 32);
  await sleep(350); await key('KeyD', 68, false);
  await sleep(1500);

  // ---- boss: 正面特写 + 击杀（慢动作窗口 bossKill..+0.9） ----
  await mark('boss');
  stage = 'boss';
  await evaluate(`(async () => { const g = window.__game; const { wavePlan } = await import('/src/rules.js');
    for (const e of g.enemies) { g.engine.scene.remove(e.duck.group); if (e.hpBar) g.engine.scene.remove(e.hpBar.group); }
    g.enemies = []; g.spawnQueue = [];
    for (const b of g.ebullets) if (b.spr) g.engine.scene.remove(b.spr);
    g.ebullets = [];
    g.wave = 5; g.plan = wavePlan(5); g.spawnEnemy('boss');
    const b = g.enemies.find(e => e.type === 'boss');
    g.bot = false; g.p.pos.set(0, 0, 0); g.p.iframes = 60; g.p.mag = 6; g.p.reserve = 60;
    b.hp = 210;
    window.__bossPin = setInterval(() => { const bb = g.enemies.find(e => e.type === 'boss');
      if (bb && !bb.dead) { bb.pos.set(0, 0, 3.6); bb.vel.set(0, 0, 0); bb.hp = 210; bb.duck.group.position.copy(bb.pos); } }, 50);
    g.engine.updateCamera = () => { g.engine.camera.position.set(b.pos.x + 2.6, 2.2, b.pos.z - 4.4); g.engine.camera.lookAt(b.pos.x, 1.9, b.pos.z); };
    return 1; })()`);
  await sleep(2600);
  await evaluate('window.__game.engine.updateCamera = window.__origCam');
  await sleep(300);
  await evaluate('window.__game.mouse.down = true');
  for (let i = 0; i < 8; i++) {
    const p = await evaluate(`(() => { const g = window.__game; const b = g.enemies.find(e => e.type === 'boss');
      if (!b) return null; const v = b.pos.clone(); v.y = 1.0; v.project(g.engine.camera);
      return { x: (v.x + 1) / 2 * ${W}, y: (1 - v.y) / 2 * ${H} }; })()`);
    if (p) await mouse('mouseMoved', p.x, p.y);
    await sleep(300);
  }
  await mark('bossKill');
  await evaluate(`(() => { const g = window.__game; clearInterval(window.__bossPin);
    const b = g.enemies.find(e => e.type === 'boss');
    if (b) { b.pos.set(g.p.pos.x, 0, g.p.pos.z + 3.2); b.duck.group.position.copy(b.pos); b.hp = 1; g.killEnemy(b); }
    g.mouse.down = false; return 1; })()`);
  await sleep(2500);

  // ---- talents: 波次肃清三选一强化卡（剪辑 2x）——展示三档稀有度 + 真实点击选卡 + 图鉴 ----
  await mark('talents');
  stage = 'talents';
  await evaluate(`(() => { const g = window.__game; g.bot = false; g.mouse.down = false; g.keys.clear();
    g.addXp(120); return 1; })()`);
  // 第一轮固定金/绿/普通各一张，让宣传片一眼看出稀有度差异
  await evaluate(`(async () => { const g = window.__game; const { CARD_BY_ID } = await import('/src/rules.js');
    g.cardDraft = ['g_chain', 'r_frost', 'c_dmg'].map(id => ({ ...CARD_BY_ID[id], stacks: 0, next: 1 }));
    g.state = 'card'; g.hud.cardOpen(true); g.hud.renderCards(g); g.audio.cardDeal(); return 1; })()`);
  await sleep(2400);
  await clickSel('#cardRow .pickCard.gold');
  await sleep(1400);
  // 第二轮走真实肃清抽卡，数字键直选
  await evaluate(`(() => { const g = window.__game; g.clearField(); g.spawnQueue = [];
    g.waveState = 'fight'; g.updateWaves(0.016); return 1; })()`);
  await sleep(2000);
  await tapKey('Digit2', 50);
  await sleep(1200);
  await tapKey('KeyT', 84);
  await sleep(2000);
  await tapKey('KeyT', 84);
  await sleep(500);

  // ---- skills: 四技能（cast1-4 标记供白闪对齐） ----
  await mark('skills');
  stage = 'skills';
  await clearField();
  await evaluate(`(() => { const g = window.__game; g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0); g.p.iframes = 60;
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; const d = 2.3 + (i % 2) * 0.6;
      g.spawnEnemy('brawler'); const e = g.enemies[g.enemies.length - 1];
      e.pos.set(Math.sin(a) * d, 0, Math.cos(a) * d); e.duck.group.position.copy(e.pos); }
    return 1; })()`);
  await sleep(400);
  await mark('cast1');
  await tapKey('Digit1', 49);
  await sleep(3000);
  await evaluate(`(() => { const g = window.__game;
    for (const [x, z] of [[3, 3], [-3, 3]]) { g.spawnEnemy('pistol'); const e = g.enemies[g.enemies.length - 1];
      e.pos.set(x, 0, z); e.duck.group.position.copy(e.pos); }
    return 1; })()`);
  await mark('cast2');
  await tapKey('Digit2', 50);
  await sleep(3000);
  await mark('cast3');
  await tapKey('Digit3', 51);
  await sleep(300);
  await aimAt(2, 0.7, 2);
  await evaluate('window.__game.mouse.down = true');
  await sleep(3200);
  await evaluate('window.__game.mouse.down = false');
  await evaluate(`(() => { const g = window.__game;
    for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI * 2 + 0.4;
      g.spawnEnemy('brawler'); const e = g.enemies[g.enemies.length - 1];
      e.pos.set(Math.sin(a) * 4, 0, Math.cos(a) * 4); e.duck.group.position.copy(e.pos); }
    return 1; })()`);
  await mark('cast4');
  await tapKey('Digit4', 52);
  await sleep(3000);

  // ---- shop: 购买/升阶/出售（2x）+ 护具特写 ----
  await mark('shop');
  stage = 'shop';
  await evaluate(`(() => { const g = window.__game; g.bot = false; g.mouse.down = false; g.keys.clear();
    g.coins = 3000; Object.assign(g.inv, { head: 1, neck: 2, wing: 2, feather: 4, blood: 2 });
    return 1; })()`);
  await tapKey('KeyB', 66);
  await sleep(1000);
  await clickSel('#buyPane .tile[data-good="armor"]'); await sleep(600);
  await clickSel('#buyPane .tile[data-good="armor"]'); await sleep(600);
  await clickSel('#buyPane .tile[data-good="helmet"]'); await sleep(600);
  await clickSel('#buyPane .tile[data-good="shoes"]'); await sleep(600);
  await clickSel('#buyPane .tile[data-good="gloves"]'); await sleep(600);
  await clickText('.shopTabs button', '出售背包'); await sleep(900);
  await clickText('#sellPane button', '全卖'); await sleep(900);
  await clickText('.shopTabs button', '购买装备'); await sleep(600);
  await tapKey('KeyB', 66);
  await sleep(500);
  await clearField();
  await mark('shopGear');
  await evaluate(`(() => { const g = window.__game; g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0); g.p.iframes = 60;
    const du = g.playerDuck; window.__origDuckUpdate = du.update.bind(du);
    du.update = (dt, st) => window.__origDuckUpdate(dt, Object.assign({}, st, { aimYaw: 0.62, moving: false }));
    const t0 = performance.now();
    g.engine.updateCamera = () => { const p = g.p.pos; const a = (performance.now() - t0) / 1000 * 0.25 + 0.7;
      g.engine.camera.position.set(p.x + Math.sin(a) * 2.6, 1.5, p.z + Math.cos(a) * 2.6);
      g.engine.camera.lookAt(p.x, 0.72, p.z); };
    return 1; })()`);
  await sleep(4000);

  // ---- over: 阵亡结算 ----
  await mark('over');
  stage = 'over';
  await evaluate(`(() => { const g = window.__game;
    g.engine.updateCamera = window.__origCam;
    g.playerDuck.update = window.__origDuckUpdate;
    g.p.iframes = 0; g.damagePlayer(9999); return 1; })()`);
  await sleep(5500);
  await mark('end');

  clearInterval(keeper);
  await send('Page.stopScreencast');
  const dump = (name) => evaluate(`(async () => {
    const r = window.${name};
    const done = new Promise((res) => { r.mr.onstop = res; });
    r.mr.stop(); await done;
    const blob = new Blob(r.chunks, { type: 'audio/webm' });
    const f = new FileReader();
    const p = new Promise((res) => { f.onload = () => res(f.result); });
    f.readAsDataURL(blob);
    return { b64: (await p).split(',')[1], bytes: blob.size };
  })()`);
  const full = await dump('__recFull');
  writeFileSync('shots/.promo2-full.webm', Buffer.from(full.b64, 'base64'));
  const music = await dump('__recMusic');
  writeFileSync('shots/.promo2-music.webm', Buffer.from(music.b64, 'base64'));
  const span = frames[frames.length - 1].ts - frames[0].ts;
  console.log(`captured ${frames.length} frames over ${span.toFixed(2)}s (${(frames.length / span).toFixed(1)}fps)`);
  console.log(`audio full=${(full.bytes / 1024).toFixed(0)}KB music=${(music.bytes / 1024).toFixed(0)}KB fullStart=${fullStart.toFixed(3)}`);
  writeFileSync('shots/.promo2-markers.json', JSON.stringify({ fullStart, markers, frames }, null, 1));
  console.log('GAMEPLAY DONE');
} catch (e) {
  console.error('RECORD ERROR', e.message);
  process.exitCode = 1;
} finally {
  clearInterval(keeper);
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
}

// ---- 动画章节卡录制（独立 Chrome，file:// 本地页面） ----
let chrome2, ws2;
try {
  chrome2 = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--hide-scrollbars', `--window-size=${W},${H}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--remote-debugging-port=${CARD_PORT}`, '--user-data-dir=D:/Code/swyy/shots/.chrome-promo2-cards',
    'about:blank',
  ], { stdio: 'ignore' });
  ws2 = await connect(CARD_PORT);
  const cardFrames = {};
  let cur = null;
  const c2 = client(ws2, (p) => {
    if (!cur) return;
    const n = cur.frames.length;
    const file = `f${String(n).padStart(5, '0')}.jpg`;
    writeFileSync(`${CARDS_DIR}/${cur.name}/${file}`, Buffer.from(p.data, 'base64'));
    cur.frames.push({ file, ts: p.metadata.timestamp });
  });
  await c2.send('Page.enable');
  await c2.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await c2.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  const durs = { 0: 2.8, 1: 2.6, 2: 2.6, 3: 2.6, 4: 2.6, 5: 3.8 };
  for (const c of [0, 1, 2, 3, 4, 5]) {
    mkdirSync(`${CARDS_DIR}/c${c}`, { recursive: true });
    cur = { name: `c${c}`, frames: [] };
    const navEpoch = Date.now() / 1000;
    await c2.send('Page.navigate', { url: `file:///D:/Code/swyy/shots/cards2.html?c=${c}` });
    await sleep(durs[c] * 1000 + 700);
    cur.frames = cur.frames.filter((f) => f.ts >= navEpoch + 0.05);
    cardFrames[`c${c}`] = cur.frames;
    console.log(`card c${c}: ${cur.frames.length} frames`);
    cur = null;
    await sleep(200);
  }
  await c2.send('Page.stopScreencast');
  writeFileSync('shots/.promo2-cards.json', JSON.stringify(cardFrames, null, 1));
  console.log('CARDS DONE');
} catch (e) {
  console.error('CARDS ERROR', e.message);
  process.exitCode = 1;
} finally {
  try { ws2?.close(); } catch { /* ignore */ }
  chrome2?.kill();
}