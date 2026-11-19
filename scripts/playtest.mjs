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

async function key(code, vk, down = true, modifiers = 0) {
  await send('Input.dispatchKeyEvent', {
    type: down ? 'keyDown' : 'keyUp', code, modifiers,
    key: code === 'Space' ? ' ' : code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    // Chromium 的原生 Enter 激活依赖字符事件，真实键盘会同时发送回车字符。
    ...(down && code === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
  });
}
async function tap(code, vk, modifiers = 0) { await key(code, vk, true, modifiers); await sleep(90); await key(code, vk, false, modifiers); }
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
    if (s.st === 'card' && await ev('window.__game.bot')) await ev('window.__game.pickCard(window.__game.cardDraft[0].id)');
    if (s.t - t0 >= sec) return true;
    await sleep(250);
  }
  throw new Error('waitGameTime timeout: ' + sec + 's, state=' + await ev('window.__game.state'));
}

const findings = [];
function check(id, title, ok, detail) {
  findings.push({ id, title, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${title}\n    ${detail}`);
}

async function ensurePlaying() {
  await send('Page.bringToFront').catch(() => {});
  await ev(`(() => { const g = window.__game;
    if (g.state === 'title' || g.state === 'over') window.__startSubscribed(g.bot);
    if (g.state === 'paused') g.resume();
    if (g.state === 'cardbook') g.closeCardBook();
    if (g.state === 'card') g.pickCard(g.cardDraft[0].id);
    if (g.state === 'weapons') {
      if (g.planId) g.closeWeapons();
      else if (!g.subscribe('ds')) throw new Error('DS onboarding fixture failed');
    }
    g.banRng = () => 1; return g.state;
  })()`);
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
  await ev(`(() => {
    window.__resolveDraft = () => { const g = window.__game;
      if (g.state === 'card') g.pickCard(g.cardDraft[0].id); };
    window.__startSubscribed = (bot = false) => { const g = window.__game;
      g.bot = bot; g.start(); g.banRng = () => 1;
      if (g.state === 'weapons' && !g.subscribe('ds')) throw new Error('DS onboarding fixture failed');
      if (g.state !== 'playing') throw new Error('subscribed fixture is not playing');
      g.interT = 99999; return 1; };
    return 1; })()`);

  // ---------- V0 开局必须先确认订阅，Esc 只能退回标题 ----------
  const v0 = await ev(`(() => { const g = window.__game; g.bot = false; g.start(); g.banRng = () => 1;
    return { state: g.state, plan: g.planId, coins: g.coins, earned: g.coinsEarned, tokens: g.tokens,
      focus: document.activeElement?.dataset.plan, time: g.time }; })()`);
  await sleep(600); // 冻结断言用墙钟；模拟进度始终按 game.time 等待。
  const v0frozen = await ev('window.__game.time');
  await tap('Escape', 27);
  const v0escape = await ev('window.__game.state');
  await ev('window.__game.start(); window.__game.banRng = () => 1');
  await tap('Enter', 13);
  const v0selected = await ev(`(() => { const g = window.__game; g.interT = 99999;
    return { state: g.state, plan: g.planId, coins: g.coins, tokens: g.tokens, calls: g.calls }; })()`);
  check('V0', '开局冻结且不代选；Esc 回标题；原生 Enter 确认 DS 只支付一次',
    v0.state === 'weapons' && v0.plan === null && v0.coins === 180 && v0.earned === 0 && v0.tokens === 0
    && v0.focus === 'ds' && v0frozen === v0.time && v0escape === 'title'
    && v0selected.state === 'playing' && v0selected.plan === 'ds' && v0selected.coins === 165
    && v0selected.tokens === 2000 && v0selected.calls === 0, JSON.stringify({ v0, v0frozen, v0escape, v0selected }));

  // ---------- V1 原生空格订阅后关闭面板不再自动冲刺 ----------
  await ev('window.__startSubscribed()');
  await sleep(300);
  await ev('window.__game.coins = 500');
  await tap('KeyB', 66);
  await sleep(200);
  await ev('document.querySelector(\'#weaponGrid button[data-plan="glm"]\').focus()');
  await tap('Space', 32);
  const v1mid = await ev(`(() => { const g = window.__game;
    return { coins: g.coins, gun: g.planId, spaceInKeys: g.keys.has('Space') }; })()`);
  await tap('KeyB', 66);
  await sleep(300);
  const v1after = await ev(`(() => ({ coins: window.__game.coins, dashCd: window.__game.p.dashCd, dashT: window.__game.p.dashT }))()`);
  check('V1', '原生空格付费切换 GLM，关闭面板不残留冲刺',
    v1mid.coins === 456 && v1mid.gun === 'glm' && !v1mid.spaceInKeys && v1after.dashCd === 0 && v1after.dashT === 0,
    `订阅发生 coins 500→${v1after.coins}；keys含Space=${v1mid.spaceInKeys}；关闭后 dashCd=${v1after.dashCd.toFixed(2)}`);

  // ---------- V2 订阅面板内 Q/E 不切换、不产生隐式交易 ----------
  await ensurePlaying();
  await ev('window.__game.openWeapons(); window.__game.coins = 2000; window.__game.subscribe("glm")');
  const v2before = await ev('window.__game.planId');
  await tap('KeyE', 69);
  const v2e = await ev('window.__game.planId');
  await tap('KeyQ', 81);
  const v2after = await ev(`(() => ({ gun: window.__game.planId, state: window.__game.state }))()`);
  check('V2', '订阅面板打开时 Q/E 均被屏蔽',
    v2after.state === 'weapons' && v2e === v2before && v2after.gun === v2before,
    `面板中按 E/Q：${v2before} → ${v2e} → ${v2after.gun}（应不变）`);
  await tap('KeyB', 66);
  await sleep(150);

  // 战斗快捷键/滚轮已删除，不能绕过明确的订阅确认。
  const v2live0 = await ev('({ plan: window.__game.planId, wallet: window.__game.walletMicros, tokens: window.__game.tokens })');
  for (const [code, vk] of [['KeyQ', 81], ['KeyE', 69], ['KeyR', 82]]) await tap(code, vk);
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 300, deltaX: 0, deltaY: 120 });
  await waitGameTime(0.1);
  const v2live1 = await ev('({ plan: window.__game.planId, wallet: window.__game.walletMicros, tokens: window.__game.tokens })');
  check('V2b', '战斗中的 Q/E/R/滚轮不切换、不补额、不收费',
    v2live1.plan === v2live0.plan && v2live1.wallet === v2live0.wallet && v2live1.tokens === v2live0.tokens,
    JSON.stringify({ before: v2live0, after: v2live1 }));

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
  await ev(`(() => { const g = window.__game; g.tokens = g.quotaGranted; g.p.fireT = 0; g.banRng = () => 1; })()`);
  const v4shots0 = await ev('window.__game.shots');
  await mouse('mousePressed', 640, 300);
  await waitGameTime(0.5);
  const v4 = await ev(`(() => ({ down: window.__game.mouse.down, shots: window.__game.shots }))()`);
  await mouse('mouseReleased', 640, 300);
  await ev('navigator.getGamepads = window.__realGetGamepads');
  check('V4', '手柄接入（不碰）时鼠标左键仍可射击',
    v4.down === true && v4.shots > v4shots0,
    `按住鼠标 0.5 游戏秒：mouse.down=${v4.down}，子弹 ${v4shots0}→${v4.shots}`);

  // ---------- V4b 纯手柄真实耗尽预算，再用免费技能恢复射击 ----------
  const v4b = await ev(`(() => { const g = window.__game;
    g.bot = false; g.start(); g.banRng = () => 1;
    if (!g.subscribe('claude')) throw new Error('Claude recovery fixture failed');
    g.nextWave(); g.clearField(); g.spawnQueue = []; g.waveState = 'inter'; g.interT = 99999;
    window.__padBanRolls = 0; g.banRng = () => { window.__padBanRolls++; return 1; };
    for (let i = 0; i < 22; i++) { g.p.fireT = 0; if (!g.fire()) throw new Error('Call rejected: ' + i); }
    g.p.fireT = 0;
    const exhausted = { coins: g.coins, tokens: g.tokens, calls: g.calls, used: g.tokensUsed,
      rolls: window.__padBanRolls, rejected: !g.fire() };
    g.clearField(); g.spawnEnemy('brawler');
    const e = g.enemies[g.enemies.length - 1];
    e.pos.copy(g.p.pos); e.pos.z += 1; e.hp = e.maxHp = 1; e.speed = 0; e.attackT = 999;
    e.duck.group.position.copy(e.pos);
    const pad = { buttons: Array.from({ length: 17 }, () => ({ pressed: false })), axes: [0, 0, 0, 0] };
    navigator.getGamepads = () => [pad]; g.padPrev = [];
    try {
      g.aimPoint.copy(e.pos);
      pad.buttons[12].pressed = true; g.pollGamepad();
      const delayed = !e.dead && g.bombs.length === 1;
      g.updateBombs(0.6);
      const free = { killed: e.dead, coins: g.coins, calls: g.calls, used: g.tokensUsed,
        rolls: window.__padBanRolls, cooldown: g.skillCd.storm };
      const wallet = g.walletMicros;
      const resumed = { fired: g.fire(), walletBefore: wallet, wallet: g.walletMicros,
        calls: g.calls, rolls: window.__padBanRolls, state: g.state };
      return { exhausted, delayed, free, resumed };
    } finally { pad.buttons[12].pressed = false; g.pollGamepad(); navigator.getGamepads = window.__realGetGamepads; }
  })()`);
  check('V4b', '纯手柄 22 次 Claude 调用后剩 4.72 刀，加班炸弹落地击杀后可恢复射击',
    v4b.exhausted.coins === 4.72 && v4b.exhausted.tokens === 0 && v4b.exhausted.calls === 22
    && v4b.exhausted.rolls === 22 && v4b.exhausted.rejected && v4b.delayed && v4b.free.killed && v4b.free.cooldown > 0
    && v4b.free.calls === 22 && v4b.free.used === v4b.exhausted.used && v4b.free.rolls === 22
    && v4b.resumed.fired && v4b.resumed.calls === 23 && v4b.resumed.rolls === 23
    && v4b.resumed.wallet === v4b.resumed.walletBefore - 10_240_000 && v4b.resumed.state === 'playing',
    JSON.stringify(v4b));
  await shot('v4b-controller-recovery');

  // ---------- V5 Boss 预警独立通道不被技能 toast 覆盖 ----------
  await ensurePlaying();
  const bossFound = await ev(`(() => { const g = window.__game;
    g.cards = { c_hp: 1 }; g.level = Math.max(g.level, 3); g.recomputeLoadout();
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
      warnSeen && v5.bossWindup && v5.alertShown && v5.alert.includes('全图冲击波') && v5.toast.includes('调休'),
      `toast="${v5.toast}"，alert="${v5.alert}"（独立显示=${v5.alertShown}）`);
    await shot('v5-boss-alert');
  } else check('V5', 'Boss 预警独立通道', false, 'Boss 未出生');

  // ---------- V6 不足整次调用原子拒绝，技能/收入保留而不是免费 Token 救济 ----------
  await ensurePlaying();
  const v6 = await ev(`(() => { const g = window.__game;
    g.bot = false; g.mouse.down = false; g.mouseFire = false; g.keys.clear();
    window.__resolveDraft(); g.clearField(); g.spawnQueue = []; g.waveState = 'inter'; g.interT = 99999;
    g.coins = 0; g.tokens = 31; g.p.fireT = 0;
    const before = { calls: g.calls, used: g.tokensUsed, shots: g.shots };
    g.fire(); g.fire(); g.hud.subscription(g);
    return { before, calls: g.calls, used: g.tokensUsed, shots: g.shots, tokens: g.tokens, wallet: g.walletMicros,
      hint: document.getElementById('usageHint').textContent }; })()`);
  check('V6a', 'Token 与余额不足时整次拒绝，不吞额度、不出弹、不形成债务且 HUD 提示',
    v6.wallet === 0 && v6.tokens === 31 && v6.calls === v6.before.calls && v6.used === v6.before.used
      && v6.shots === v6.before.shots && /不足/.test(v6.hint), JSON.stringify(v6));
  await ev('window.__game.tokens = 0');
  await waitGameTime(6.2, 120000);
  const v6idle = await ev(`(() => { const g = window.__game; return { wallet: g.walletMicros, tokens: g.tokens,
    pickups: g.pickups.length, rescue: 'dryT' in g || 'rescued' in g || typeof g.startReload === 'function' }; })()`);
  const v6recover = await ev(`(() => { const g = window.__game;
    g.skillCd.storm = 0; g.castSkill(1); const skill = g.skillCd.storm > 0;
    const before = { calls: g.calls, xp: g.xpEarned, earned: g.coinsEarned };
    g.spawnPickup(g.p.pos.clone(), 'loot', 'overtime'); g.updatePickups(0.016);
    g.p.fireT = 0; g.fire();
    return { skill, before, calls: g.calls, xp: g.xpEarned, earned: g.coinsEarned,
      tokens: g.tokens, wallet: g.walletMicros, quote: g.usageQuote() }; })()`);
  check('V6b', '空余额等待不会凭空补 Token；技能可用，加班费提供收入后可恢复按量调用',
    v6idle.wallet === 0 && v6idle.tokens === 0 && v6idle.pickups === 0 && !v6idle.rescue
    && v6recover.skill && v6recover.calls === v6recover.before.calls + 1
    && v6recover.earned === v6recover.before.earned + 18 && v6recover.xp === v6recover.before.xp + 12
    && v6recover.tokens === 0 && v6recover.wallet === 18_000_000 - v6recover.quote.costMicros,
    JSON.stringify({ idle: v6idle, recovery: v6recover }));

  // ---------- V7 朝天瞄准沿当前朝向延伸 ----------
  await ensurePlaying();
  await clearKeys();
  await ev(`(() => { const g = window.__game; g.p.aimYaw = 0; })()`);
  await mouse('mouseMoved', 640, 5);
  await waitGameTime(0.15);
  const v7 = await ev(`(() => { const g = window.__game;
    const dx = g.aimPoint.x - g.p.pos.x, dz = g.aimPoint.z - g.p.pos.z;
    const len = Math.hypot(dx, dz);
    return { len: +len.toFixed(1), yaw: +g.p.aimYaw.toFixed(2),
      along: len > 1 ? +((Math.sin(g.p.aimYaw) * dx + Math.cos(g.p.aimYaw) * dz) / len).toFixed(2) : 0 }; })()`);
  check('V7', '射线朝天时瞄准点沿当前朝向延伸（不再硬跳正北）',
    v7.len > 8 && v7.along > 0.95,
    `瞄准距离=${v7.len}m，与朝向夹角余弦=${v7.along}（1=完全同向）`);
  await mouse('mouseMoved', 640, 360);

  // ---------- V8 谷仓拐角挡住挥击；无遮挡的同类挥击确实扣血 ----------
  await ensurePlaying();
  const v8 = await ev(`(() => { const g = window.__game;
    window.__startSubscribed(false); g.nextWave(); g.clearField();
    g.spawnQueue = []; g.waveState = 'inter'; g.interT = 99999;
    const barn = g.world.colliders.find(c => c.hx !== undefined);
    if (!barn) return { skip: true };
    g.spawnEnemy('clubber');
    const e = window.__coverEnemy = g.enemies[g.enemies.length - 1];
    const left = barn.x - barn.hx, front = barn.z + barn.hz;
    // 线段明确穿过谷仓角部，且双方均在碰撞体外；旧硬编码坐标实际擦角而过。
    g.p.pos.set(left + 0.8, 0, front + 0.55); g.p.vel.set(0, 0, 0);
    e.pos.set(left - 0.5, 0, front - 0.9); e.speed = 0; e.vel.set(0, 0, 0); e.radius = 0.01;
    g.p.hp = g.p.maxHp; g.p.iframes = 0; g.p.lastHurt = g.time;
    e.windup = 0.2; e.attackT = 9;
    return { skip: false, hpBefore: g.p.hp, damage: e.damage,
      distance: e.pos.distanceTo(g.p.pos), reach: e.reach + 0.35 }; })()`);
  if (!v8.skip) {
    await waitGameTime(0.6);
    const v8after = await ev(`(() => ({ hp: window.__game.p.hp, windup: window.__coverEnemy.windup }))()`);
    const openBefore = await ev(`(() => { const g = window.__game, e = window.__coverEnemy;
      e.pos.copy(g.p.pos); e.pos.z += 1.2; e.vel.set(0, 0, 0);
      g.p.iframes = 0; g.p.lastHurt = g.time; e.windup = 0.2; e.attackT = 9;
      return g.p.hp; })()`);
    await waitGameTime(0.4);
    const openAfter = await ev('window.__game.p.hp');
    await ev('delete window.__coverEnemy');
    check('V8', '近战挥击被谷仓拐角掩体挡住',
      v8.distance < v8.reach && v8after.windup <= 0 && v8after.hp === v8.hpBefore
        && openAfter === openBefore - v8.damage,
      JSON.stringify({ blocked: { before: v8.hpBefore, after: v8after, distance: v8.distance, reach: v8.reach },
        clear: { before: openBefore, after: openAfter, damage: v8.damage } }));
  } else check('V8', '近战掩体', false, '未找到矩形碰撞体');

  // ---------- V9 原换弹卡实际优化每次 Token 用量，向上取整 ----------
  await ensurePlaying();
  const v9 = await ev(`(() => { const g = window.__game; const cards = { ...g.cards };
    if (g.planId !== 'ds') { g.coins = Math.max(g.coins, 15); g.openWeapons(); g.subscribe('ds'); g.closeWeapons(); }
    window.__resolveDraft(); g.clearField(); g.spawnQueue = []; g.waveState = 'inter'; g.interT = 99999;
    g.cards.c_reload = 3; g.recomputeLoadout(); g.tokens = 100; g.p.fireT = 0;
    const before = { calls: g.calls, used: g.tokensUsed, wallet: g.walletMicros };
    const quote = g.usageQuote(); g.fire();
    const after = { tokens: g.tokens, calls: g.calls, used: g.tokensUsed, wallet: g.walletMicros };
    g.cards = cards; g.recomputeLoadout();
    return { before, after, quote, noReload: !('reloadTime' in g.loadout) && typeof g.audio.reload !== 'function' }; })()`);
  check('V9', '三层 Token 优化把 DS 单次调用从 11 Token 降到 8，调用与扣量一致',
    v9.quote.tokens === 8 && v9.after.tokens === 92 && v9.after.calls === v9.before.calls + 1
    && v9.after.used === v9.before.used + 8 && v9.after.wallet === v9.before.wallet && v9.noReload, JSON.stringify(v9));

  // ---------- V10 福利经验应用倍率，加班费改为 18 刀 +12 基础经验 ----------
  const v10 = await ev(`(() => { const g = window.__game; const cards = { ...g.cards };
    g.cards = { c_ammo: 2, c_xp: 2 }; g.recomputeLoadout();
    window.__resolveDraft(); g.clearField(); g.spawnQueue = []; g.waveState = 'inter'; g.interT = 9999;
    const tokens = g.tokens, xp = g.xpEarned, wallet = g.walletMicros;
    g.spawnPickup(g.p.pos.clone(), 'loot', 'overtime');
    g.spawnPickup(g.p.pos.clone(), 'loot', 'performance');
    g.updatePickups(0.016); g.updatePickups(0.016);
    const result = { benefitXp: g.xpEarned - xp, benefitMicros: g.walletMicros - wallet,
      tokensUnchanged: g.tokens === tokens, meteredMul: g.loadout.meteredCostMul,
      noInventory: !('inv' in g), noReserve: !('reserve' in g.p), left: g.pickups.length };
    g.cards = cards; g.recomputeLoadout(); return result; })()`);
  check('V10', '绩效/加班费经验均乘 1.5，刀一次到账，不赠送 Token 或旧备弹',
    v10.benefitXp === 63 && v10.benefitMicros === 42_000_000 && v10.tokensUnchanged
    && v10.meteredMul === 0.8 && v10.noInventory && v10.noReserve && v10.left === 0, JSON.stringify(v10));

  // ---------- V11 死亡结算延迟可跳过 ----------
  await ensurePlaying();
  await ev(`(() => { const g = window.__game; g.p.iframes = 0; g.p.shieldSkillT = 0; g.damagePlayer(99999); })()`);
  await sleep(200);
  const v11before = await ev(`document.getElementById('gameoverScreen').classList.contains('hidden')`);
  await tap('KeyB', 66);
  await sleep(150);
  const v11after = await ev(`document.getElementById('gameoverScreen').classList.contains('hidden')`);
  check('V11', '死亡延迟期内按键立即跳过出结算',
    v11before === true && v11after === false,
    `按键前结算屏隐藏=${v11before}，按键后隐藏=${v11after}`);
  await shot('v11-gameover');

  // ---------- V11b 结算按钮焦点循环，重复显示不得抢回 Retry ----------
  const resultFocus = [await ev('document.activeElement.id')];
  for (const [code, vk, modifiers] of [['Tab', 9, 0], ['Tab', 9, 0], ['Tab', 9, 8], ['Tab', 9, 8], ['ArrowRight', 39, 0]]) {
    await tap(code, vk, modifiers); resultFocus.push(await ev('document.activeElement.id'));
  }
  await ev("window.__game.hud.screen('over'); window.__game.hud.screen('over')");
  resultFocus.push(await ev('document.activeElement.id'));
  await shot('v11b-keyboard-results');
  await tap('ArrowLeft', 37); resultFocus.push(await ev('document.activeElement.id'));
  const resultsInert = await ev(`!document.getElementById('gameoverScreen').inert
    && [...document.querySelectorAll('.overlay.hidden')].every(el => el.inert)`);
  check('V11b', '结算页 Tab/Shift+Tab/方向键正常循环，重复显示保留选择，隐藏层 inert',
    resultFocus.join(',') === 'retryBtn,titleBtn,retryBtn,titleBtn,retryBtn,titleBtn,titleBtn,retryBtn'
    && resultsInert, JSON.stringify({ focus: resultFocus, inert: resultsInert }));

  async function resultFixture(immediate) {
    return ev(`(() => { const g = window.__game; window.__startSubscribed(false);
      window.__resultClicks = []; g.endRun('combat');
      if (${immediate}) { clearTimeout(g.overTimer); g.overTimer = null; g.hud.screen('over'); }
      return { hidden: document.getElementById('gameoverScreen').classList.contains('hidden'), state: g.state }; })()`);
  }
  await ev(`(() => { window.__resultClicks = [];
    window.__observeResultClick = e => { const button = e.target.closest('#gameoverScreen button');
      if (button) window.__resultClicks.push(button.id); };
    window.addEventListener('click', window.__observeResultClick); return 1; })()`);
  const resultActions = [];
  for (const [code, vk] of [['Enter', 13], ['Space', 32]]) {
    for (const target of ['titleBtn', 'retryBtn']) {
      await resultFixture(true);
      if (target === 'titleBtn') await tap('Tab', 9);
      const focused = await ev('document.activeElement.id');
      await tap(code, vk);
      const after = await ev('({ state: window.__game.state, clicks: [...window.__resultClicks] })');
      resultActions.push({ code, target, focused, ...after });
    }
  }
  check('V11c', '原生 Enter/Space 分别正确激活回标题和重开，各只触发选中按钮一次',
    resultActions.every(r => r.focused === r.target && r.clicks.length === 1 && r.clicks[0] === r.target
      && r.state === (r.target === 'titleBtn' ? 'title' : 'weapons')), JSON.stringify(resultActions));

  const skippedResults = [];
  for (const [code, vk] of [['Space', 32], ['Enter', 13]]) {
    const before = await resultFixture(false);
    await tap(code, vk); // 必须包含 keyup，才能覆盖 Space 的原生按钮激活时机。
    const after = await ev(`(() => ({ state: window.__game.state,
      hidden: document.getElementById('gameoverScreen').classList.contains('hidden'),
      timer: window.__game.overTimer, clicks: [...window.__resultClicks], focus: document.activeElement.id }))()`);
    skippedResults.push({ code, before, after });
  }
  check('V11d', '完整 Enter/Space 按下松开只跳过结算延迟，不顺带激活重开',
    skippedResults.every(r => r.before.hidden && r.after.state === 'over' && !r.after.hidden
      && r.after.timer === null && r.after.clicks.length === 0 && r.after.focus === 'retryBtn'), JSON.stringify(skippedResults));
  await ev("window.removeEventListener('click', window.__observeResultClick); delete window.__observeResultClick; 1");

  // ---------- V12 纪录分模式 + 0 分不占坑 + 平纪录算新纪录 ----------
  await ev(`(() => { localStorage.removeItem('swyy_best'); localStorage.removeItem('swyy_best_bot'); localStorage.removeItem('swyy_best_fragile'); })()`);
  await ev('window.__startSubscribed()');
  await sleep(200);
  await ev(`(() => { const g = window.__game; g.p.iframes = 0; g.p.shieldSkillT = 0; g.damagePlayer(99999); })()`);
  await sleep(200);
  const v12a = await ev(`localStorage.getItem('swyy_best')`);
  await ev('window.__startSubscribed()');
  await sleep(200);
  await ev(`(() => { const g = window.__game; g.score = 100; g.p.iframes = 0; g.p.shieldSkillT = 0; g.damagePlayer(99999); })()`);
  await sleep(200);
  const v12b = await ev(`(() => ({ best: localStorage.getItem('swyy_best'), badge: !document.getElementById('recordBadge').classList.contains('hidden') }))()`);
  await ev('window.__startSubscribed()');
  await sleep(200);
  await ev(`(() => { const g = window.__game; g.score = 100; g.p.iframes = 0; g.p.shieldSkillT = 0; g.damagePlayer(99999); })()`);
  await sleep(200);
  const v12c = await ev(`(() => ({ badge: !document.getElementById('recordBadge').classList.contains('hidden') }))()`);
  await ev(`(() => { const g = window.__game; g.bot = true; window.__startSubscribed(g.bot); g.score = 99999; g.p.iframes = 0; g.damagePlayer(99999); })()`);
  await sleep(200);
  const v12d = await ev(`(() => ({ normal: localStorage.getItem('swyy_best'), bot: localStorage.getItem('swyy_best_bot') }))()`);
  check('V12', '0 分不写纪录；平纪录算新纪录；bot/fragile 分档',
    v12a === null && JSON.parse(v12b.best).score === 100 && v12b.badge && v12c.badge
      && JSON.parse(v12d.normal).score === 100 && JSON.parse(v12d.bot).score === 99999,
    `0分死亡后 best=${v12a}；100分首纪录徽章=${v12b.badge}；平100分徽章=${v12c.badge}；bot 99999 分后 normal=${v12d.normal} bot档=${v12d.bot}`);
  await ev('window.__game.bot = false; window.__startSubscribed()');
  await sleep(200);

  // ---------- V13 手柄 B 打开、方向导航、A 付费订阅、B 关闭 ----------
  await ensurePlaying();
  const v13open = await ev(`(() => { const g = window.__game; g.coins = 500; g.padPrev = [];
    window.__fakePad = { buttons: Array.from({length: 17}, () => ({ pressed: false })), axes: [0, 0, 0, 0], connected: true };
    navigator.getGamepads = () => [window.__fakePad];
    window.__fakePad.buttons[1].pressed = true; g.pollGamepad();
    window.__fakePad.buttons[1].pressed = false; g.pollGamepad();
    return g.state; })()`);
  await sleep(200);
  const v13a = await ev(`(() => { const g = window.__game;
    document.activeElement && document.activeElement.blur();
    g.padNavT = 0; window.__fakePad.axes[1] = 0.9; g.pollGamepad();
    const first = document.activeElement;
    window.__fakePad.axes[1] = 0; g.pollGamepad();
    g.padNavT = 0; window.__fakePad.axes[1] = 0.9; g.pollGamepad();
    window.__fakePad.axes[1] = 0; g.pollGamepad();
    const second = document.activeElement;
    return { first: first ? (first.id || first.dataset.plan || first.tagName) : null,
      focused: second ? (second.id || second.dataset.plan || second.tagName) : null,
      inPanel: !!second?.closest('#weaponScreen'), moved: first !== second }; })()`);
  const v13b = await ev(`(() => { const g = window.__game;
    document.querySelector('#weaponGrid button[data-plan="glm"]').focus();
    window.__fakePad.buttons[0].pressed = true; g.pollGamepad();
    window.__fakePad.buttons[0].pressed = false; g.pollGamepad();
    return { coins: g.coins, state: g.state, gun: g.planId }; })()`);
  await ev(`(() => { const g = window.__game;
    window.__fakePad.buttons[1].pressed = true; g.pollGamepad();
    window.__fakePad.buttons[1].pressed = false; g.pollGamepad();
    navigator.getGamepads = window.__realGetGamepads; })()`);
  const v13c = await ev('window.__game.state');
  check('V13', '手柄 B 打开订阅面板、方向导航、A 支付 44 切换 GLM、B 关闭',
    v13open === 'weapons' && v13a.inPanel && v13a.moved && v13b.coins === 456
    && v13b.gun === 'glm' && v13b.state === 'weapons' && v13c === 'playing',
    JSON.stringify({ open: v13open, nav: v13a, purchase: v13b, closed: v13c }));

  await tap('KeyB', 66); await sleep(150);
  await ev('document.querySelector(\'#weaponGrid button[data-plan="claude"]\').focus()');
  await tap('ArrowRight', 39);
  const v13keys = await ev(`(() => ({ gun: document.activeElement?.dataset.plan,
    inPanel: !!document.activeElement?.closest('#weaponScreen'), keys: window.__game.keys.size }))()`);
  await tap('Escape', 27);
  check('V13b', '订阅面板方向键移动焦点但不记录为移动，Esc 关闭',
    v13keys.inPanel && v13keys.gun !== 'claude' && v13keys.keys === 0 && await ev('window.__game.state') === 'playing',
    JSON.stringify(v13keys));

  // ---------- V14 真实原生 Space/Enter 各只调用一次付费订阅 ----------
  await ensurePlaying();
  await ev(`(() => { const g = window.__game; window.__startSubscribed(g.bot); g.coins = 2000;
    window.__weaponActivation = { original: g.subscribe, calls: [] };
    g.subscribe = function (id) { window.__weaponActivation.calls.push(id); return window.__weaponActivation.original.call(this, id); };
    window.__activationKeyEvents = [];
    window.__observeActivation = (e) => { if (['Space', 'Enter'].includes(e.code) && e.target.closest('#weaponGrid'))
      window.__activationKeyEvents.push({ code: e.code, prevented: e.defaultPrevented }); };
    window.addEventListener('keydown', window.__observeActivation);
    g.openWeapons(); return 1; })()`);
  const v14 = [];
  for (const [code, vk, id, price] of [['Space', 32, 'qwen', 45], ['Enter', 13, 'gpt', 120]]) {
    const before = await ev(`(() => { document.querySelector('#weaponGrid button[data-plan="${id}"]').focus();
      return { coins: window.__game.coins, calls: window.__weaponActivation.calls.length }; })()`);
    await tap(code, vk); await sleep(150);
    const after = await ev(`(() => ({ coins: window.__game.coins, gun: window.__game.planId,
      calls: window.__weaponActivation.calls.length, keys: window.__game.keys.size,
      event: window.__activationKeyEvents[window.__activationKeyEvents.length - 1] }))()`);
    v14.push({ code, id, price, before, after });
  }
  await ev(`(() => { const g = window.__game; g.subscribe = window.__weaponActivation.original;
    window.removeEventListener('keydown', window.__observeActivation); return 1; })()`);
  await tap('KeyB', 66);
  check('V14', '原生 Space/Enter 各激活一次，不靠阻止默认行为或重复 click',
    v14.every(r => r.after.coins === r.before.coins - r.price && r.after.gun === r.id
      && r.after.calls === r.before.calls + 1 && r.after.keys === 0
      && r.after.event?.code === r.code && r.after.event.prevented === false), JSON.stringify(v14));

  // ---------- V15 GPU 资源不再单调增长 ----------
  await ev('window.__game.bot = false');
  // 先让五个有限模型模板都渲染一次，再测重复切换是否泄漏。
  await ev(`(() => { const g = window.__game; window.__startSubscribed(false);
    g.coins = 5000; g.openWeapons();
    for (const id of ['claude', 'gpt', 'qwen', 'glm', 'ds']) g.subscribe(id);
    g.closeWeapons(); return 1; })()`);
  await waitGameTime(0.1);
  const v15base = await ev('window.__game.engine.renderer.info.memory.geometries');
  for (let i = 0; i < 8; i++) {
    await ev(`(() => { const g = window.__game;
      g.coins = 5000; g.openWeapons();
      for (const id of ['claude', 'gpt', 'qwen', 'glm', 'ds']) g.subscribe(id);
      g.closeWeapons();
      for (let k = 0; k < 6; k++) g.spawnEnemy('brawler');
      window.__startSubscribed(false); return 1; })()`);
    await waitGameTime(0.1);
  }
  const v15end = await ev(`window.__game.engine.renderer.info.memory.geometries`);
  check('V15', '重开/五家付费切换/刷怪 8 轮后几何体数量稳定（共享缓存）',
    v15end <= v15base + 20,
    `geometries ${v15base}→${v15end}（应无逐轮增长）`);

  // ---------- V16 自动战斗冒烟（按游戏时间推进，软件渲染帧率低） ----------
  await ev('window.__startSubscribed()');
  await ev('window.__game.bot = true; window.__game.interT = 0; window.__game.banRng = () => 1');
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
  await ensurePlaying();
  await ev('window.__game.bot = false; window.__game.keys.clear(); window.__game.mouse.down = false');
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

  // ---------- V19b 首次 Tab / Shift+Tab 与首尾循环 ----------
  await ev(`(() => { const g = window.__game; g.bot = false; window.__startSubscribed(g.bot);
    g.interT = 99999; g.p.iframes = 999; })()`);
  await tap('Escape', 27);
  const v19b = { autofocusReverse: await ev('document.activeElement.id') };
  await ev('document.activeElement?.blur()'); // 单独覆盖焦点落在菜单外时的 i < 0 分支。
  v19b.beforeReverse = await ev('document.activeElement === document.body');
  await tap('Tab', 9, 8); // CDP modifiers: Shift = 8
  v19b.reverse = await ev('document.activeElement.id');
  await tap('Tab', 9);
  v19b.wrapForward = await ev('document.activeElement.id');
  await tap('Tab', 9);
  v19b.next = await ev('document.activeElement.id');
  await tap('Escape', 27);
  await tap('Escape', 27);
  v19b.autofocusForward = await ev('document.activeElement.id');
  await ev('document.activeElement?.blur()');
  v19b.beforeForward = await ev('document.activeElement === document.body');
  await tap('Tab', 9);
  v19b.forward = await ev('document.activeElement.id');
  await tap('Tab', 9, 8);
  v19b.wrapBackward = await ev('document.activeElement.id');
  check('V19b', '暂停自然聚焦继续按钮；主动移出焦点后首次 Tab/Shift+Tab 及首尾循环正确',
    v19b.autofocusReverse === 'resumeBtn' && v19b.autofocusForward === 'resumeBtn'
      && v19b.beforeReverse && v19b.beforeForward && v19b.reverse === 'muteBtn'
      && v19b.wrapForward === 'resumeBtn' && v19b.next === 'quitBtn'
      && v19b.forward === 'resumeBtn' && v19b.wrapBackward === 'muteBtn', JSON.stringify(v19b));
  await tap('Escape', 27);

  // ---------- V20 九类福利、四类保护与回血的实景外观和共享 GPU 资源 ----------
  await ev(`(async () => { const g = window.__game; const { LOOT_ITEMS } = await import('/src/rules.js');
    const { PROTECTION_ITEMS } = await import('/src/subscriptions.js');
    window.__startSubscribed(false); g.p.pos.set(0, 0, 3); g.p.vel.set(0, 0, 0); g.p.iframes = 999;
    window.__benefitShowcase = () => { window.__resolveDraft(); g.clearField(); g.spawnQueue = []; g.waveState = 'inter'; g.interT = 99999;
      LOOT_ITEMS.forEach((it, i) => g.spawnPickup(g.p.pos.clone().set(-2.2 + (i % 3) * 2.2, 0, -3 + Math.floor(i / 3) * 2.2), 'loot', it.id));
      PROTECTION_ITEMS.forEach((it, i) => g.spawnPickup(g.p.pos.clone().set(-6 + i * 4, 0, 6), 'protection', it.id));
      g.spawnPickup(g.p.pos.clone().set(5, 0, 1), 'health'); };
    window.__benefitShowcase(); return 1; })()`);
  await waitGameTime(0.3);
  await shot('v20-benefit-drops');
  const v20before = await ev(`(() => ({ ...window.__game.engine.renderer.info.memory }))()`);
  for (let i = 0; i < 6; i++) { await ev('window.__benefitShowcase()'); await waitGameTime(0.1); }
  const v20 = await ev(`(() => { const g = window.__game; return { count: g.pickups.length,
    ids: g.pickups.filter(p => p.kind === 'loot').map(p => p.item),
    protectionIds: g.pickups.filter(p => p.kind === 'protection').map(p => p.item),
    memory: { ...g.engine.renderer.info.memory } }; })()`);
  check('V20', '九类福利 + 四类保护 + 回血共 14 种外观，反复掉落六轮 GPU 资源不增长',
    v20.count === 14 && new Set(v20.ids).size === 9 && new Set(v20.protectionIds).size === 4
      && v20.memory.geometries <= v20before.geometries && v20.memory.textures <= v20before.textures,
    JSON.stringify({ before: v20before, after: v20 }));

  const v20b = await ev(`window.__game.pickups.map(pk => {
    const meshes = []; pk.mesh.traverse(node => { if (node.isMesh) meshes.push(node); });
    return { kind: pk.item || pk.kind, bodies: meshes.filter(node => node.castShadow).length,
      mainCastsShadow: meshes[0]?.castShadow }; })`);
  check('V20b', '全部 14 种掉落仅主体投影，装饰不增加阴影绘制',
    v20b.length === 14 && v20b.every(pk => pk.bodies === 1 && pk.mainCastsShadow), JSON.stringify(v20b));

  // ---------- V21 窄屏五家订阅可内部滚动，关闭始终可达，无横向溢出 ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 780, deviceScaleFactor: 1, mobile: false });
  await ev('window.__game.coins = 1600; window.__game.openWeapons()');
  await sleep(600);
  const v21 = await ev(`(() => {
    const panel = document.querySelector('.weaponWrap').getBoundingClientRect();
    const scroll = document.querySelector('.weaponScroll'), close = document.getElementById('weaponClose');
    const closeRect = close.getBoundingClientRect(); const scrollRect = scroll.getBoundingClientRect();
    const closeVisible = () => { const r = close.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return r.y >= 0 && r.bottom <= innerHeight && !!top && close.contains(top); };
    const before = closeVisible();
    const rects = [...document.querySelectorAll('#weaponGrid .weaponCard')].map(el => {
      el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect();
      const visibleHeight = Math.max(0, Math.min(r.bottom, scrollRect.bottom) - Math.max(r.top, scrollRect.top));
      return { id: el.dataset.plan, x: r.x, right: r.right, h: r.height,
        reachable: visibleHeight >= Math.min(r.height, scrollRect.height) - 2, closeVisible: closeVisible() }; });
    scroll.scrollTop = scroll.scrollHeight;
    const last = document.querySelector('#weaponGrid [data-plan="ds"]').getBoundingClientRect();
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      panel: { x: panel.x, right: panel.right }, rects, before, after: closeVisible(),
      scrollable: scroll.scrollHeight > scroll.clientHeight && /auto|scroll/.test(getComputedStyle(scroll).overflowY),
      scrollTop: scroll.scrollTop, lastBottom: last.bottom, viewportBottom: scrollRect.bottom,
      closeStable: Math.abs(close.getBoundingClientRect().y - closeRect.y) < 1,
      closePoint: { x: closeRect.x + closeRect.width / 2, y: closeRect.y + closeRect.height / 2 } }; })()`);
  check('V21', '400px 五家订阅在内部纵向滚动可达，关闭固定且无遮挡，侧边距 ≥16px',
    v21.rects.length === 5 && v21.rects.every(r => r.x >= 16 && r.right <= v21.width - 16 && r.reachable && r.closeVisible)
      && v21.before && v21.after && v21.closeStable && v21.scrollable && v21.scrollTop > 0
      && v21.lastBottom <= v21.viewportBottom + 1 && v21.scrollWidth <= v21.width
      && v21.panel.x >= 16 && v21.panel.right <= v21.width - 16, JSON.stringify(v21));
  await shot('v21-subscriptions-phone');
  await mouse('mousePressed', v21.closePoint.x, v21.closePoint.y);
  await mouse('mouseReleased', v21.closePoint.x, v21.closePoint.y);
  check('V21b', '400px 滚到面板底部后仍可真实点击关闭恢复战斗', await ev('window.__game.state') === 'playing', 'fixed close button');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  check('V22', '全程无页面运行时异常', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | ') || 'none');

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
