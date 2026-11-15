// 波次三选一强化卡：真实浏览器运行时验证
// 覆盖 抽卡→选卡→生效→下一波→图鉴→重开 全链路，以及三档稀有度与传说特效实机表现。
// 运行：先 npm run dev，再 node scripts/cardtest.mjs
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import WebSocket from 'ws';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:5173/?q=medium';
const PORT = 9225;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync('shots/cards', { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--hide-scrollbars', '--window-size=1280,720',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=D:/Code/swyy/shots/.card-profile',
  'about:blank',
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map();
const pageErrors = [];

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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

const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
});

async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails)
    throw new Error('eval: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
  return r.result.result.value;
}
async function key(code, vk, down = true) {
  await send('Input.dispatchKeyEvent', {
    type: down ? 'keyDown' : 'keyUp', code,
    key: code === 'Space' ? ' ' : code.startsWith('Digit') ? code.slice(5) : code.replace('Key', '').toLowerCase(),
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
}
const tap = async (code, vk) => { await key(code, vk, true); await sleep(90); await key(code, vk, false); };
const mouse = (type, x, y, button = 'left') => send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: 1 });
async function clickSel(sel) {
  const r = await ev(`(() => { const el = document.querySelector('${sel}'); if (!el) return null;
    const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!r) throw new Error('no element ' + sel);
  await mouse('mouseMoved', r.x, r.y);
  await mouse('mousePressed', r.x, r.y);
  await mouse('mouseReleased', r.x, r.y);
  await sleep(180);
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`shots/cards/${name}.png`, Buffer.from(r.result.data, 'base64'));
}
// 软件渲染 3~6fps：一切等待都以游戏内时间为准，不用墙钟
async function waitGame(sec, timeoutMs = 180000) {
  const t0 = await ev('window.__game.time');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await ev('({t: window.__game.time, st: window.__game.state})');
    if (s.st === 'paused') await ev('window.__game.resume()');
    if (s.t - t0 >= sec) return true;
    await sleep(200);
  }
  return false;
}

// 页面内测试工具：走游戏自身的清理路径，避免残留网格污染 GPU 资源计数
const HELPERS = `
window.__T = {
  // 挂起出怪，让确定性测试不被随机波次打断
  hold() { const g = window.__game; g.waveState = 'inter'; g.interT = 99999; g.spawnQueue = []; return g; },
  // 在开阔地摆一排静止靶子（暂清碰撞体，确保弹道不被木箱挡住）
  line(n, z0, dz, hp) { const g = window.__game;
    this.hold();
    g.clearField(); this.hold();
    if (!g.plan) g.nextWave();
    this.hold();
    window.__cols = g.world.colliders; g.world.colliders = [];
    g.p.pos.set(0, 0, 0); g.p.vel.set(0, 0, 0); g.p.iframes = 60;
    for (let i = 0; i < n; i++) {
      g.spawnEnemy('brawler');
      const e = g.enemies[g.enemies.length - 1];
      e.pos.set(0, 0, z0 + i * dz); e.speed = 0; e.vel.set(0, 0, 0);
      e.hp = e.maxHp = hp; e.attackT = 999;
      e.duck.group.position.copy(e.pos);
    }
    return g.enemies.length;
  },
  unline() { const g = window.__game; if (window.__cols) g.world.colliders = window.__cols; return 1; },
}; 1`;

// 直接把当前波清空 → 触发肃清 → 弹卡
async function clearWave() {
  await ev(`(() => { const g = window.__game;
    if (g.state === 'card') return 1;
    if (!g.plan) g.nextWave();
    g.clearField(); g.spawnQueue = []; g.waveState = 'fight';
    g.updateWaves(0.016);
    return 1; })()`);
  for (let i = 0; i < 40; i++) {
    if (await ev('window.__game.state') === 'card') return true;
    await sleep(150);
  }
  return false;
}

const results = [];
function check(id, title, ok, detail = '') {
  results.push({ id, title, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${title}${detail ? '\n    ' + detail : ''}`);
}

try {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL });
  await send('Page.bringToFront');
  for (let i = 0; i < 80; i++) { if (await ev('!!window.__game').catch(() => false)) break; await sleep(500); }
  await sleep(1500);
  await ev(HELPERS);

  // ---------- C1 旧天赋系统已彻底移除 ----------
  const c1 = await ev(`(() => { const g = window.__game;
    return { tree: !!document.getElementById('talentScreen'), chip: !!document.getElementById('pointsChip'),
      hasBuyTalent: typeof g.buyTalent === 'function', hasPoints: 'points' in g, hasTalents: 'talents' in g,
      hasCards: !!document.getElementById('cardScreen'), hasBook: !!document.getElementById('cardBookScreen') }; })()`);
  check('C1', '旧天赋树/天赋点已移除，卡牌界面就位',
    !c1.tree && !c1.chip && !c1.hasBuyTalent && !c1.hasPoints && !c1.hasTalents && c1.hasCards && c1.hasBook,
    JSON.stringify(c1));

  // ---------- C2 波次肃清弹出三张卡 ----------
  await ev('window.__game.start()');
  await waitGame(0.4);
  const got = await clearWave();
  const c2 = await ev(`(() => { const g = window.__game;
    const cards = [...document.querySelectorAll('#cardRow .pickCard')];
    return { state: g.state, draft: (g.cardDraft || []).length, dom: cards.length,
      hidden: document.getElementById('cardScreen').classList.contains('hidden'),
      ids: (g.cardDraft || []).map(c => c.id),
      wave: document.getElementById('cardWave').textContent,
      names: cards.map(c => c.querySelector('.cname').textContent) }; })()`);
  check('C2', '每波敌人肃清后弹出 3 张互不相同的卡',
    got && c2.state === 'card' && c2.draft === 3 && c2.dom === 3 && !c2.hidden && new Set(c2.ids).size === 3,
    JSON.stringify(c2));
  await shot('01-draft');

  // ---------- C3 选卡期间战斗冻结 ----------
  const f0 = await ev('window.__game.time');
  await sleep(1200);
  const f1 = await ev('window.__game.time');
  check('C3', '选卡期间战斗时间冻结', Math.abs(f1 - f0) < 0.02, `time ${f0.toFixed(2)}→${f1.toFixed(2)}`);

  // ---------- C4 卡面信息完整 ----------
  const c4 = await ev(`(() => [...document.querySelectorAll('#cardRow .pickCard')].map(c => ({
      rar: c.className.match(/common|rare|gold/)[0],
      badge: c.querySelector('.rarBadge').textContent, name: c.querySelector('.cname').textContent,
      desc: c.querySelector('.cdesc').textContent.length, art: !!c.querySelector('.art canvas'),
      pips: c.querySelectorAll('.cpips i').length, kbd: c.querySelector('.cfoot kbd').textContent,
      w: Math.round(c.getBoundingClientRect().width), h: Math.round(c.getBoundingClientRect().height) })))()`);
  check('C4', '每张卡有稀有度/图标/名称/描述/层数/快捷键且尺寸正常',
    c4.length === 3 && c4.every((c) => c.badge && c.name && c.desc > 4 && c.art && c.pips > 0 && c.kbd && c.w > 150 && c.h > 200),
    JSON.stringify(c4));

  // ---------- C5 鼠标点击选卡：立即生效并回到战斗 ----------
  const before = await ev(`(() => { const g = window.__game; const c = g.cardDraft[0];
    return { id: c.id, kinds: Object.keys(g.cards).length, hist: g.cardHistory.length }; })()`);
  await clickSel('#cardRow .pickCard');
  const c5 = await ev(`(() => { const g = window.__game;
    return { state: g.state, hidden: document.getElementById('cardScreen').classList.contains('hidden'),
      draft: g.cardDraft, kinds: Object.keys(g.cards).length, hist: g.cardHistory.length,
      stacks: g.cards['${before.id}'] || 0, chip: document.getElementById('cardChip').textContent }; })()`);
  check('C5', '点击卡片后叠层 +1、关闭面板、回到战斗',
    c5.state === 'playing' && c5.hidden && c5.draft === null && c5.stacks === 1
    && c5.hist === before.hist + 1 && c5.kinds === before.kinds + 1 && +c5.chip === c5.hist,
    JSON.stringify({ before, c5 }));

  // ---------- C6 键盘 1/2/3 直选 ----------
  await clearWave();
  const k6 = await ev('window.__game.cardDraft.map(c => c.id)');
  await tap('Digit2', 50);
  await sleep(220);
  const c6 = await ev(`(() => { const g = window.__game; return { state: g.state, got: g.cards['${k6[1]}'] || 0 }; })()`);
  check('C6', '数字键 2 选中第二张卡', c6.state === 'playing' && c6.got === 1, JSON.stringify({ pick: k6[1], ...c6 }));

  // ---------- C7 方向键 + 回车选择 ----------
  await clearWave();
  await ev(`document.querySelectorAll('#cardRow .pickCard')[0].focus()`);
  await tap('ArrowRight', 39);
  await sleep(140);
  const focusIdx = await ev(`[...document.querySelectorAll('#cardRow .pickCard')].indexOf(document.activeElement)`);
  const k7 = await ev('window.__game.cardDraft.map(c => c.id)');
  await tap('Enter', 13);
  await sleep(220);
  const c7 = await ev(`(() => { const g = window.__game; return { state: g.state, got: g.cards['${k7[1]}'] || 0 }; })()`);
  check('C7', '方向键移动焦点 + 回车确认', focusIdx === 1 && c7.state === 'playing' && c7.got >= 1,
    JSON.stringify({ focusIdx, pick: k7[1], ...c7 }));

  // ---------- C8 选卡界面不能被 Esc/B 跳过 ----------
  await clearWave();
  await tap('Escape', 27);
  await tap('KeyB', 66);
  await sleep(220);
  const c8 = await ev('({ state: window.__game.state, draft: (window.__game.cardDraft || []).length })');
  check('C8', '选卡必须三选一，Esc/B 无法跳过', c8.state === 'card' && c8.draft === 3, JSON.stringify(c8));
  await ev('window.__game.pickCard(window.__game.cardDraft[0].id)');
  await sleep(200);

  // ---------- C9 属性卡真实改写战斗数值 ----------
  const c9 = await ev(`(() => { const g = window.__game;
    __T.hold(); g.cards = {}; g.recomputeLoadout();
    const base = { dmg: g.loadout.damage, hp: g.loadout.maxHp, rpm: g.loadout.rpm, mag: g.loadout.magSize, spd: g.loadout.speedMul };
    const step = {};
    for (const [k, id] of [['dmg','c_dmg'],['hp','c_hp'],['rpm','c_rate'],['mag','c_mag'],['spd','c_speed']]) {
      g.cards[id] = 1; g.recomputeLoadout();
      step[k] = { dmg: g.loadout.damage, hp: g.loadout.maxHp, rpm: g.loadout.rpm, mag: g.loadout.magSize, spd: g.loadout.speedMul };
    }
    return { base, step, playerHpSync: g.p.maxHp === g.loadout.maxHp }; })()`);
  check('C9', '属性卡生效：伤害/血量/射速/弹匣/移速真实提升且同步玩家上限',
    c9.step.dmg.dmg > c9.base.dmg && c9.step.hp.hp === c9.base.hp + 25 && c9.step.rpm.rpm > c9.base.rpm
    && c9.step.mag.mag > c9.base.mag && c9.step.spd.spd > c9.base.spd && c9.playerHpSync,
    JSON.stringify(c9));

  // ---------- C10 稀有度分布 + Boss 波保底金 ----------
  const c10 = await ev(`(async () => { const { rollCards, mulberry32, CARD_RARITIES } = await import('/src/rules.js');
    const rng = mulberry32(20261114); const cnt = { common: 0, rare: 0, gold: 0 };
    for (let i = 0; i < 400; i++) for (const c of rollCards(rng, {}, 3)) cnt[c.rarity]++;
    const boss = []; for (let i = 0; i < 30; i++) boss.push(rollCards(rng, {}, 5).some(c => c.rarity === 'gold'));
    const normal = []; for (let i = 0; i < 30; i++) normal.push(rollCards(rng, {}, 4).some(c => c.rarity === 'gold'));
    return { cnt, total: cnt.common + cnt.rare + cnt.gold, bossAllGold: boss.every(Boolean),
      normalGoldRate: normal.filter(Boolean).length / normal.length,
      weights: Object.fromEntries(Object.entries(CARD_RARITIES).map(([k, v]) => [k, v.weight])) }; })()`);
  check('C10', '普通最常见、金卡最稀有，Boss 波保底金卡',
    c10.cnt.common > c10.cnt.rare && c10.cnt.rare > c10.cnt.gold && c10.bossAllGold
    && c10.cnt.gold / c10.total < 0.16 && c10.cnt.common / c10.total > 0.55 && c10.normalGoldRate < 0.6,
    JSON.stringify(c10));

  // ---------- C11 三档稀有度视觉差异 ----------
  await ev(`(async () => { const g = window.__game; const { CARD_BY_ID } = await import('/src/rules.js');
    g.cardDraft = ['g_chain', 'r_frost', 'c_dmg'].map(id => ({ ...CARD_BY_ID[id], stacks: 0, next: 1 }));
    g.state = 'card'; g.hud.cardOpen(true); g.hud.renderCards(g); return 1; })()`);
  await sleep(1000);
  const c11 = await ev(`(() => { const q = (r) => document.querySelector('#cardRow .pickCard.' + r);
    const gold = q('gold'), rare = q('rare'), common = q('common');
    const cs = getComputedStyle(gold);
    return { goldBorder: cs.borderTopColor, rareBorder: getComputedStyle(rare).borderTopColor,
      commonBorder: getComputedStyle(common).borderTopColor,
      sheen: getComputedStyle(gold, '::after').animationName, goldAnim: cs.animationName,
      opacity: [gold, rare, common].map(e => +getComputedStyle(e).opacity),
      badge: gold.querySelector('.rarBadge').textContent }; })()`);
  check('C11', '三档稀有度边框配色不同，金卡有流光与呼吸动画且已完全显现',
    c11.goldBorder !== c11.rareBorder && c11.rareBorder !== c11.commonBorder
    && c11.sheen === 'goldSheen' && c11.goldAnim.includes('goldPulse')
    && c11.opacity.every((o) => o > 0.98) && c11.badge === '传说',
    JSON.stringify(c11));
  await shot('02-rarities');
  await ev('window.__game.pickCard("g_chain")');
  await sleep(200);

  // ---------- C12 传说特效：连锁闪电 ----------
  const c12 = await ev(`(() => { const g = window.__game;
    g.cards = { g_chain: 2 }; g.recomputeLoadout();
    __T.line(4, -6, 1.6, 5000);
    const es = g.enemies.filter(e => !e.dead);
    const hp0 = es.map(e => e.hp);
    const t = es[0];
    g.damageEnemy(t, 40);
    g.applyHitMods(t, t.pos.clone(), 40);
    return { mod: g.loadout.mods.chain, hp0, hp1: es.map(e => Math.round(e.hp)),
      bolts: g.fx.bolts.filter(b => b.life > 0).length,
      boltVisible: g.fx.bolts.filter(b => b.life > 0 && b.line.visible).length }; })()`);
  check('C12', '连锁闪电金卡：命中后电击弹射到附近敌人并渲染电弧',
    c12.mod && c12.mod.count === 3 && c12.hp1.filter((h, i) => h < c12.hp0[i]).length === 4
    && c12.bolts === 3 && c12.boltVisible === 3,
    JSON.stringify(c12));

  // ---------- C13 传说特效：护卫羽毛 ----------
  await ev(`(() => { const g = window.__game; g.cards = { g_orbit: 2 }; g.recomputeLoadout(); g.syncOrbit(); return 1; })()`);
  await waitGame(1.0);
  const c13 = await ev(`(() => { const g = window.__game;
    const dists = g.orbitals.map(o => +Math.hypot(o.position.x - g.p.pos.x, o.position.z - g.p.pos.z).toFixed(2));
    const e = g.enemies.find(x => !x.dead);
    // 羽毛一直在转：按小步推进，每步把靶子贴到当前羽毛位置，模拟「敌人被羽毛扫到」
    let hurt = 0; const hp0 = e.hp = e.maxHp = 5000;
    for (let i = 0; i < 12; i++) {
      const m = g.orbitals[0];
      e.pos.set(m.position.x, 0, m.position.z); e.duck.group.position.copy(e.pos);
      const before = e.hp;
      g.updateOrbit(0.05);
      if (e.hp < before) hurt++;
    }
    return { count: g.orbitals.length, inScene: g.orbitals.every(o => !!o.parent), dists,
      hurtSteps: hurt, damage: +(hp0 - e.hp).toFixed(1), dps: g.loadout.mods.orbit.dps,
      spins: g.orbitT > 0 }; })()`);
  check('C13', '护卫羽毛：4 枚实体等距环绕玩家，接触持续造成伤害',
    c13.count === 4 && c13.inScene && c13.dists.every((d) => d > 1.7 && d < 2.0)
    && c13.hurtSteps >= 8 && c13.damage > 0 && c13.dps === 60,
    JSON.stringify(c13));
  await shot('03-orbit');

  // ---------- C14 稀有特效：燃烧 / 霜冻 / 穿透 ----------
  const c14 = await ev(`(() => { const g = window.__game;
    g.cards = { r_burn: 2, r_frost: 2, r_pierce: 2 }; g.recomputeLoadout();
    __T.line(3, -3, -1.2, 5000);
    const es = g.enemies.filter(e => !e.dead);
    const e = es[0];
    g.applyHitMods(e, e.pos.clone(), 30);
    const applied = { burnT: +e.burnT.toFixed(1), burnDps: e.burnDps,
      frostT: +e.frostT.toFixed(1), frostFactor: +e.frostFactor.toFixed(2) };
    const hp0 = e.hp; g.updateEnemies(0.5);
    const burned = e.hp < hp0;
    // 穿透：一发子弹连续穿过多个敌人
    g.p.mag = 24; g.p.fireT = 0; g.p.heat = 0; g.p.moving = false;
    g.aimPoint.set(0, 0.7, -9);
    const orig = g.spreadNow; g.spreadNow = () => 0;
    g.fire();
    g.spreadNow = orig;
    const b = g.bullets[g.bullets.length - 1];
    const pierce0 = b.pierce;
    const dmg0 = b.dmg;
    for (let i = 0; i < 60 && g.bullets.includes(b); i++) g.updateBullets(0.016);
    return { applied, burned, pierce0, hitCount: b.hitSet ? b.hitSet.size : 0,
      gone: !g.bullets.includes(b), dmgDecay: +(b.dmg / dmg0).toFixed(3),
      targets: es.length, hurtCount: es.filter(x => x.hp < 5000).length,
      lastHp: Math.round(es[es.length - 1].hp) }; })()`);
  // 穿透 2 层 = 首个目标之后再穿 2 个，共命中 3 个；每穿一个伤害 ×0.8，穿透用尽后弹体消失
  check('C14', '稀有特效生效：点燃持续掉血、霜冻减速、子弹穿透 2 个后消失',
    c14.applied.burnT > 2 && c14.applied.burnDps === 16 && c14.applied.frostFactor < 1 && c14.burned
    && c14.pierce0 === 2 && c14.hitCount === 2 && c14.gone && c14.hurtCount === 3
    && Math.abs(c14.dmgDecay - 0.64) < 0.01 && c14.lastHp < 5000,
    JSON.stringify(c14));

  // ---------- C15 传说特效：不死鸟 ----------
  await ev('window.__game.start()');
  await waitGame(0.3);
  const c15 = await ev(`(() => { const g = window.__game;
    __T.hold();
    g.cards = { g_phoenix: 1 }; g.recomputeLoadout();
    g.phoenixUsed = false; g.p.iframes = 0; g.p.shield = 0; g.p.maxHp = 200; g.p.hp = 10;
    g.damagePlayer(9999);
    const first = { hp: Math.round(g.p.hp), state: g.state, used: g.phoenixUsed, iframes: +g.p.iframes.toFixed(1) };
    g.p.iframes = 0; g.p.hp = 5;
    g.damagePlayer(9999);
    return { first, second: { hp: Math.round(g.p.hp), state: g.state } }; })()`);
  check('C15', '不死鸟：首次致死伤害复活回血，第二次正常阵亡',
    c15.first.state === 'playing' && c15.first.hp === 120 && c15.first.used && c15.first.iframes > 1
    && c15.second.state === 'over',
    JSON.stringify(c15));

  // ---------- C16 传说特效：守护结界 + 荆棘反伤 ----------
  await ev('window.__game.start()');
  await waitGame(0.3);
  const c16 = await ev(`(() => { const g = window.__game;
    g.cards = { g_guardian: 2, r_thorns: 2 }; g.recomputeLoadout();
    __T.line(1, -1.5, 0, 5000);
    g.guardianCd = 0; g.p.iframes = 0; g.p.hp = g.p.maxHp = 300; g.p.shield = 0;
    const e = g.enemies.find(x => !x.dead);
    e.pos.set(g.p.pos.x + 1.5, 0, g.p.pos.z); e.duck.group.position.copy(e.pos);
    const hp0 = g.p.hp, eh0 = e.hp;
    g.damagePlayer(50);
    const blocked = { hp: g.p.hp, cd: +g.guardianCd.toFixed(1), enemyHurt: e.hp < eh0 };
    g.p.iframes = 0; g.damagePlayer(50);
    return { blocked, through: g.p.hp < hp0, thorns: g.loadout.mods.thorns }; })()`);
  check('C16', '守护结界完全抵挡一次并进入冷却，荆棘对周围敌人反伤',
    c16.blocked.hp === 300 && c16.blocked.cd === 6 && c16.blocked.enemyHurt && c16.through && c16.thorns.damage === 50,
    JSON.stringify(c16));
  await ev('__T.unline()');

  // ---------- C17 图鉴：T 打开、排序、层数、关闭 ----------
  await ev('window.__game.start()');
  await waitGame(0.3);
  await ev(`(() => { const g = window.__game; __T.hold();
    g.cards = { c_dmg: 2, r_frost: 1, g_chain: 1 };
    g.cardHistory = ['c_dmg', 'c_dmg', 'r_frost', 'g_chain']; g.recomputeLoadout(); return 1; })()`);
  await tap('KeyT', 84);
  await sleep(320);
  const c17 = await ev(`(() => { const g = window.__game;
    const cards = [...document.querySelectorAll('#cardBookGrid .bookCard')];
    return { state: g.state, hidden: document.getElementById('cardBookScreen').classList.contains('hidden'),
      count: cards.length, order: cards.map(c => c.className.match(/common|rare|gold/)[0]),
      levels: cards.map(c => c.querySelector('b em').textContent),
      total: document.getElementById('cardBookCount').textContent }; })()`);
  check('C17', 'T 键打开图鉴：金→绿→普通排序，显示层数与总数',
    c17.state === 'cardbook' && !c17.hidden && c17.count === 3
    && JSON.stringify(c17.order) === JSON.stringify(['gold', 'rare', 'common'])
    && c17.levels[0] === 'Lv.1/2' && c17.total === '3 种 · 4 层',
    JSON.stringify(c17));
  await shot('04-book');
  const bf0 = await ev('window.__game.time');
  await sleep(900);
  const bf1 = await ev('window.__game.time');
  await tap('KeyT', 84);
  await sleep(300);
  const c17b = await ev('window.__game.state');
  check('C17b', '图鉴打开时战斗冻结，T 键关闭恢复', Math.abs(bf1 - bf0) < 0.02 && c17b === 'playing',
    `time ${bf0.toFixed(2)}→${bf1.toFixed(2)}, state=${c17b}`);

  // ---------- C18 连续 6 波抽卡循环稳定 ----------
  await ev('window.__game.start()');
  await waitGame(0.3);
  const loop = [];
  for (let w = 0; w < 6; w++) {
    const ok = await clearWave();
    if (!ok) { loop.push({ w, err: 'no draft' }); break; }
    const info = await ev(`(() => { const g = window.__game;
      return { wave: g.wave, ids: g.cardDraft.map(c => c.id), rar: g.cardDraft.map(c => c.rarity),
        geo: g.engine.renderer.info.memory.geometries }; })()`);
    await ev(`window.__game.pickCard(window.__game.cardDraft[${w % 3}].id)`);
    await sleep(160);
    const st = await ev(`(() => { const g = window.__game;
      return { state: g.state, total: Object.values(g.cards).reduce((a,b)=>a+b,0), hist: g.cardHistory.length,
        geo: g.engine.renderer.info.memory.geometries }; })()`);
    loop.push({ ...info, ...st });
    await waitGame(0.3);
  }
  const allThree = loop.every((l) => l.ids && l.ids.length === 3 && new Set(l.ids).size === 3);
  const allResumed = loop.every((l) => l.state === 'playing');
  const totalsOk = loop.every((l, i) => l.total === i + 1 && l.hist === i + 1);
  const geoGrow = loop.length ? loop[loop.length - 1].geo - loop[0].geo : 999;
  check('C18', '连续 6 波抽卡→选卡→复战循环稳定，层数正确、GPU 资源不累积',
    loop.length === 6 && allThree && allResumed && totalsOk && geoGrow <= 12,
    JSON.stringify({ rounds: loop.length, allThree, allResumed, totalsOk, geoGrow, last: loop[loop.length - 1] }));

  // ---------- C19 满层卡退出卡池 ----------
  const c19 = await ev(`(async () => { const { rollCards, CARDS, CARD_BY_ID, mulberry32 } = await import('/src/rules.js');
    const owned = { c_dmg: CARD_BY_ID.c_dmg.max };
    const rng = mulberry32(8); let seen = false;
    for (let i = 0; i < 80; i++) if (rollCards(rng, owned, 3).some(c => c.id === 'c_dmg')) seen = true;
    const all = Object.fromEntries(CARDS.map(c => [c.id, c.max]));
    return { seen, emptyWhenAllMax: rollCards(rng, all, 5).length, poolSize: CARDS.length }; })()`);
  check('C19', '满层卡退出卡池，全满时不再弹卡（不卡流程）',
    !c19.seen && c19.emptyWhenAllMax === 0, JSON.stringify(c19));

  // 卡池抽空时肃清不卡死：回退为普通提示并继续下一波
  const c19b = await ev(`(async () => { const g = window.__game; const { CARDS } = await import('/src/rules.js');
    g.cards = Object.fromEntries(CARDS.map(c => [c.id, c.max])); g.recomputeLoadout();
    g.clearField(); g.spawnQueue = []; g.waveState = 'fight'; g.updateWaves(0.016);
    return { state: g.state, waveState: g.waveState, offered: !!g.cardDraft }; })()`);
  check('C19b', '卡池抽空时肃清直接跳过选卡，流程不卡死',
    c19b.state === 'playing' && c19b.waveState === 'inter' && !c19b.offered, JSON.stringify(c19b));

  // ---------- C20 重开清空所有卡牌与特效实体 ----------
  await ev(`(() => { const g = window.__game; g.cards = { g_orbit: 2, c_dmg: 3 };
    g.cardHistory = ['g_orbit', 'c_dmg']; g.recomputeLoadout(); g.syncOrbit(); return 1; })()`);
  await waitGame(0.3);
  const preReset = await ev('window.__game.orbitals.length');
  await ev('window.__game.start()');
  await waitGame(0.3);
  const c20 = await ev(`(() => { const g = window.__game;
    return { cards: Object.keys(g.cards).length, hist: g.cardHistory.length, orbit: g.orbitals.length,
      mods: Object.keys(g.loadout.mods).length, chip: document.getElementById('cardChip').textContent,
      draft: g.cardDraft, cardHidden: document.getElementById('cardScreen').classList.contains('hidden'),
      bookHidden: document.getElementById('cardBookScreen').classList.contains('hidden') }; })()`);
  check('C20', '重开彻底重置卡牌/层数/特效实体，HUD 归零',
    preReset === 4 && c20.cards === 0 && c20.hist === 0 && c20.orbit === 0 && c20.mods === 0
    && c20.chip === '0' && c20.draft === null && c20.cardHidden && c20.bookHidden,
    JSON.stringify({ preReset, ...c20 }));

  // ---------- C21 bot 长时间自动战斗（含自动选卡） ----------
  await ev(`(() => { const g = window.__game; g.bot = true;
    // bot 演示自动选第一张，让长跑能持续跨波推进
    if (!window.__origOffer) { window.__origOffer = g.offerCards.bind(g);
      g.offerCards = function () { const r = window.__origOffer(); if (r && this.bot) this.pickCard(this.cardDraft[0].id); return r; }; }
    return 1; })()`);
  await waitGame(25, 300000);
  const c21 = await ev(`(() => { const g = window.__game;
    return { state: g.state, wave: g.wave, kills: g.kills, time: +g.time.toFixed(1),
      cards: Object.values(g.cards).reduce((a,b)=>a+b,0), hist: g.cardHistory.length,
      hp: Math.round(g.p.hp), fps: g.engine.fps }; })()`);
  check('C21', 'bot 25 秒自动战斗（跨波自动选卡）无崩溃、推进正常',
    ['playing', 'card', 'over'].includes(c21.state) && c21.time > 20 && c21.kills > 0,
    JSON.stringify(c21));
  await shot('05-combat');

  // ---------- C22 窄屏布局 ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 780, deviceScaleFactor: 1, mobile: true });
  await sleep(700);
  await ev(`(() => { const g = window.__game; g.bot = false;
    if (g.state !== 'playing') g.start();
    __T.hold(); return 1; })()`);
  await clearWave();
  await sleep(1000);
  const c22 = await ev(`(() => { const cards = [...document.querySelectorAll('#cardRow .pickCard')];
    const rects = cards.map(c => { const r = c.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
    const wrap = document.querySelector('.draftWrap');
    return { rects, vw: innerWidth, vh: innerHeight,
      scrollable: wrap.scrollHeight > wrap.clientHeight,
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      opacity: cards.map(c => +getComputedStyle(c).opacity) }; })()`);
  const stacked = c22.rects.length === 3 && c22.rects[1].y > c22.rects[0].y && c22.rects[2].y > c22.rects[1].y;
  const inWidth = c22.rects.every((r) => r.x >= -1 && r.x + r.w <= c22.vw + 1);
  // 三选一必须一眼看全：三张卡都要完整落在首屏内，不能靠滚动才看得到第三张
  const allVisible = c22.rects.every((r) => r.y >= 0 && r.y + r.h <= c22.vh);
  check('C22', '窄屏(400px)三张卡纵向堆叠、首屏全部可见、无横向溢出',
    stacked && inWidth && allVisible && !c22.overflowX && c22.opacity.every((o) => o > 0.98),
    JSON.stringify(c22));
  await shot('06-mobile');
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(400);

  // ---------- C23 全程无运行时异常 ----------
  check('C23', '全流程无 JS 运行时异常', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | ') || 'none');

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== 汇总 =====\n${pass}/${results.length} 项通过`);
  writeFileSync('shots/cards/verify.json', JSON.stringify(results, null, 2));
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
  process.exit(pass === results.length ? 0 : 1);
} catch (err) {
  console.error('CARDTEST ERROR', err);
  writeFileSync('shots/cards/verify.json', JSON.stringify({ error: String(err), results, pageErrors }, null, 2));
  try { ws?.close(); } catch { /* ignore */ }
  try { chrome.kill(); } catch { /* ignore */ }
  process.exit(1);
}