// v2 预告片录制：敌人入屏 1s 后才攻击；多机位空镜 / 快进素材 / 慢动作窗口标记 / 动画章节卡。
// 用法：node scripts/promo2-record.mjs
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import WebSocket from 'ws';
import { PLAN_IDS, MICROCOINS_PER_COIN, REFERENCE_DATE } from '../src/subscriptions.js';
import { createPromoActions } from './promo-automation.mjs';

const MECHANICS = 'subscriptions-tokens-v1';
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
  planId: g.planId, tokens: g.tokens, quotaGranted: g.quotaGranted, coins: g.coins,
  calls: g.calls, tokensUsed: g.tokensUsed, subscription: g.subscription, protections: { ...g.protections },
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
  const r = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)});
    if (!b || b.disabled || !b.getClientRects().length) return null;
    b.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rc = b.getBoundingClientRect(); return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 }; })()`);
  if (!r) throw new Error('visible, enabled element not found: ' + sel);
  await clickAt(r.x, r.y);
}
const aimAt = (x, y, z) => evaluate(`(() => { const g = window.__game;
  const v = new (g.engine.camera.position.constructor)(${x}, ${y}, ${z}); v.project(g.engine.camera);
  return { x: (v.x + 1) / 2 * ${W}, y: (1 - v.y) / 2 * ${H} }; })()`).then((p) => mouse('mouseMoved', p.x, p.y));

const clearField = () => {
  if (stage === 'talents') throw new Error('Choose showcase cards explicitly before clearing');
  return evaluate(`(() => { const g = window.__game;
    // clearField 会清掉 cardDraft 却不会退出 card；必须先真实选卡，再关菜单 / 清场。
    if (g.state === 'card') {
      const card = g.cardDraft?.[0];
      if (!card) throw new Error('Missing pending card before staging');
      g.pickCard(card.id);
    }
    if (g.state === 'weapons' && g.planId === null) throw new Error('Confirm an initial paid plan before staging');
    if (g.state === 'weapons') g.closeWeapons();
    if (g.state === 'cardbook') g.closeCardBook();
    if (g.state === 'paused') g.resume();
    if (g.state !== 'playing') throw new Error('Cannot stage from ' + g.state);
    g.bot = false; g.keys.clear(); g.mouse.down = false; g.mouseFire = false;
    g.clearField(); g.spawnQueue = [];
    // 手动摆拍阶段不自动开新波；选卡分镜会显式触发肃清。
    g.waveState = 'inter'; g.interT = 60;
    return 1; })()`);
};

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
  const { choosePlan, collectProtections } = createPromoActions({ evaluate, clickSel, key, sleep });
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

  // ---- initialPlan: 开局冻结选择；真实支付 DS 首波费用后才进入 playing ----
  await mark('initialPlan');
  stage = 'initialPlan';
  await clickSel('#startBtn');
  await sleep(1400);
  await choosePlan('ds');
  await sleep(400);

  // ---- beauty1: 付费开局后清场 + 高机位环绕 ----
  await mark('beauty1');
  stage = 'beauty1';
  await clearField();
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
  await clearField();
  await evaluate(`(() => { const g = window.__game;
    g.engine.updateCamera = window.__origCam;
    document.getElementById('hud').classList.add('on');
    document.getElementById('crosshair').style.display = '';
    g.coins = 2000; return 1; })()`); // 摆拍资金，不增加累计收入；额度仍须真实付费发放。
  await choosePlan('qwen');
  await evaluate(`(() => { const g = window.__game;
    g.interT = 0; g.bot = true; g.p.iframes = 30; return 1; })()`);
  keeper = setInterval(async () => {
    try {
      const s = await snap();
      if (stage !== 'talents' && stage !== 'over' && s.state === 'card') {
        await evaluate(`(() => { const g = window.__game;
          if (g.state === 'card' && g.cardDraft?.[0]) g.pickCard(g.cardDraft[0].id);
          return 1; })()`);
      }
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
  await clearField();
  await evaluate(`(() => { const g = window.__game;
    g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0); g.p.iframes = 30; return 1; })()`);
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

  // ---- shotgun: GLM 六弹丸仅付一次基础 32 Token（保留慢动作标记） ----
  stage = 'shotgun';
  await clearField();
  await evaluate('window.__game.coins = 2000');
  await choosePlan('glm');
  await mark('shotgun');
  await evaluate(`(() => { const g = window.__game; g.p.iframes = 30;
    g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0); return 1; })()`);
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
  await clearField();
  await evaluate(`(async () => { const g = window.__game; const { wavePlan } = await import('/src/rules.js');
    g.wave = 5; g.plan = wavePlan(5); g.spawnEnemy('boss');
    const b = g.enemies.find(e => e.type === 'boss');
    g.bot = false; g.p.pos.set(0, 0, 0); g.p.iframes = 60;
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
  stage = 'talents'; // 先停 keeper 自动选卡，再开始记录刻意展示的卡牌分镜。
  await mark('talents');
  await evaluate(`(() => { const g = window.__game; g.bot = false; g.mouse.down = false; g.keys.clear();
    g.addXp(120); return 1; })()`);
  // 第一轮固定金/绿/普通各一张，让宣传片一眼看出稀有度差异
  await evaluate(`(async () => { const g = window.__game; const { CARD_BY_ID } = await import('/src/rules.js');
    g.cardDraft = ['g_chain', 'r_ammoBack', 'c_reload'].map(id => ({ ...CARD_BY_ID[id], stacks: 0, next: 1 }));
    g.state = 'card'; g.hud.cardOpen(true); g.hud.renderCards(g); g.audio.cardDeal(); return 1; })()`);
  await sleep(2400);
  await clickSel('#cardRow .pickCard.gold');
  await sleep(1400);
  // 第二轮走真实肃清抽卡，数字键直选
  await evaluate(`(() => { const g = window.__game;
    if (g.state !== 'playing') throw new Error('Showcase card was not selected');
    g.clearField(); g.spawnQueue = [];
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
  await evaluate(`(() => { const g = window.__game; g.level = Math.max(g.level, 9); g.recomputeLoadout(); return 1; })()`);
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

  // ---- plans: 五计划单一订阅；每次切换立即全费，切回也付费 ----
  await mark('plans');
  stage = 'plans';
  await clearField();
  await evaluate(`(() => { const g = window.__game;
    // 只提供摆拍预算；不重置订阅、不伪造免费额度或永久所有权。
    g.coins = 600; g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0); g.p.iframes = 60;
    return 1; })()`);
  await tapKey('KeyB', 66);
  await sleep(1000);
  for (const id of [...PLAN_IDS, 'claude', 'ds']) {
    console.log('paid plan:', id, JSON.stringify(await choosePlan(id, { close: false })));
    await sleep(850);
  }
  console.log('same-plan no-op:', JSON.stringify(await choosePlan('ds', { close: false })));
  await tapKey('KeyB', 66);
  await sleep(500);

  // ---- benefits: 展示名称 / 实体，真实走近拾取并结算收益与即时效果 ----
  stage = 'benefits';
  await mark('benefits');
  await clearField();
  const benefits = await evaluate(`(async () => { const g = window.__game;
    const { LOOT_ITEMS } = await import('/src/rules.js');
    g.engine.updateCamera = window.__origCam;
    g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0);
    const overtime = LOOT_ITEMS.find(it => it.id === 'overtime');
    if (overtime?.coins !== 18 || overtime.effect.kind !== 'xp' || overtime.effect.amount !== 12) {
      throw new Error('Outdated overtime fixture');
    }
    return LOOT_ITEMS.map(({ id, coins, effect }) => ({ id, coins,
      xp: effect.kind === 'xp' ? effect.amount : 0, heal: ['heal', 'fullheal'].includes(effect.kind) })); })()`);
  for (const [i, benefit] of benefits.entries()) {
    const direction = i % 2 === 0 ? 1 : -1;
    const before = await evaluate(`(() => { const g = window.__game;
      g.p.vel.set(0, 0, 0);
      if (${benefit.heal}) { g.p.hp = Math.max(1, g.p.maxHp * 0.3); g.p.lastHurt = g.time; }
      const pos = g.p.pos.clone();
      // 先放在磁铁吸取范围之外，让信封 / 礼盒 / 咖啡与标签有完整展示时间。
      pos.x += ${direction} * Math.max(3, 1.1 * (g.loadout.mods.magnet?.mul || 1) * 2.6 + 0.8);
      g.spawnPickup(pos, 'loot', '${benefit.id}');
      return { walletMicros: g.walletMicros, xpEarned: g.xpEarned,
        xpDelta: Math.round(${benefit.xp} * g.loadout.xpMul) }; })()`);
    await sleep(1000);
    const code = direction > 0 ? 'KeyD' : 'KeyA', vk = direction > 0 ? 68 : 65;
    let collected = false;
    await key(code, vk, true);
    try {
      for (let j = 0; j < 40; j++) {
        await sleep(100);
        collected = await evaluate(`(() => { const g = window.__game;
          return !g.pickups.some(p => p.kind === 'loot' && p.item === '${benefit.id}')
            && g.walletMicros === ${before.walletMicros + benefit.coins * MICROCOINS_PER_COIN}
            && g.xpEarned === ${before.xpEarned + before.xpDelta}; })()`);
        if (collected) break;
      }
    } finally { await key(code, vk, false); }
    if (!collected) throw new Error('Benefit pickup failed: ' + benefit.id);
    await sleep(650);
  }

  // ---- protections: 四种虚构保护物品真实拾取；只增加本地层数，不索取任何资料 ----
  stage = 'protections';
  await clearField();
  await choosePlan('claude'); // 展示可降低但不能清零的风险；录制 RNG 仍固定为 1。
  await mark('protections');
  await collectProtections();

  await tapKey('KeyB', 66); // 实际面板展示四种持有量与降低后仍大于零的 Claude 风险。
  await sleep(1400);
  await tapKey('KeyB', 66);

  // ---- over: 确定性战斗阵亡结算，不让不死鸟 / 结界挡住分镜 ----
  await mark('over');
  stage = 'over';
  await evaluate(`(() => { const g = window.__game;
    g.engine.updateCamera = window.__origCam;
    g.endRun('combat'); return 1; })()`);
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
  writeFileSync('shots/.promo2-markers.json', JSON.stringify({ mechanics: MECHANICS, referenceDate: REFERENCE_DATE, fullStart, markers, frames }, null, 1));
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
  // 在首次绘制前替换旧章节文案，不改动独立的 cards2.html 动画模板。
  await c2.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    document.addEventListener('DOMContentLoaded', () => {
      const note = document.createElement('div');
      note.textContent = '本地游戏演示 · 订阅 / Token / 封号 / 保护道具均为虚构机制 · 无真实 API、账号、支付或身份资料采集';
      Object.assign(note.style, { position: 'absolute', bottom: '40px', left: '24px', right: '24px',
        textAlign: 'center', color: '#e8dcc0', fontSize: '24px', letterSpacing: '0.04em' });
      document.body.appendChild(note);
      const captions = {
        1: ['调用与生存', ['每次基础32 Token', '齐射只计一次', '旧额度不跨波']],
        2: ['主动技能', ['按等级解锁', '独立冷却', '零Token', '零刀']],
        3: ['波次强化卡', ['肃清三选一', '普通稀有传说', '经济卡叠层']],
        4: ['订阅与保护', ['Claude / GPT / Qwen / GLM / DS', '按波续订', '切换全费']],
      };
      const caption = captions[new URLSearchParams(location.search).get('c')];
      if (!caption) return;
      const [title, words] = caption, heading = document.getElementById('title');
      heading.replaceChildren();
      [...title].forEach((ch, i) => {
        const span = document.createElement('span');
        span.textContent = ch; span.style.animationDelay = (0.45 + i * 0.08) + 's';
        heading.appendChild(span);
      });
      const sub = document.getElementById('sub');
      sub.style.letterSpacing = '0.06em';
      sub.replaceChildren();
      words.forEach((word, i) => {
        if (i) {
          const dot = document.createElement('div'); dot.className = 'd';
          dot.style.animationDelay = (1.15 + i * 0.12) + 's'; sub.appendChild(dot);
        }
        const el = document.createElement('div'); el.className = 'w'; el.textContent = word;
        el.style.animationDelay = (1.1 + i * 0.12) + 's'; sub.appendChild(el);
      });
    });
  ` });
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
  writeFileSync('shots/.promo2-cards.json', JSON.stringify({ mechanics: MECHANICS, referenceDate: REFERENCE_DATE, frames: cardFrames }, null, 1));
  console.log('CARDS DONE');
} catch (e) {
  console.error('CARDS ERROR', e.message);
  process.exitCode = 1;
} finally {
  try { ws2?.close(); } catch { /* ignore */ }
  chrome2?.kill();
}
