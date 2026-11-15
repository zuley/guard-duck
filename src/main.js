import { Engine } from './engine.js';
import { World } from './world.js';
import { HUD } from './hud.js';
import { AudioEngine } from './audio.js';
import { Game } from './game.js';

const hud = new HUD();
const audio = new AudioEngine();
let engine, world, game;

try {
  const q0 = new URLSearchParams(location.search).get('q') || 'high';
  engine = new Engine(document.getElementById('app'), q0);
  world = new World(engine.scene, engine.renderer, engine.software ? 'medium' : q0);
  game = new Game(engine, world, hud, audio);
} catch (err) {
  console.error(err);
  const p = document.querySelector('#loading p');
  if (p) p.textContent = '初始化失败：' + err.message;
  throw err;
}

window.__game = game;

document.querySelectorAll('.qualityRow button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.qualityRow button').forEach((x) => x.classList.remove('sel'));
    b.classList.add('sel');
    engine.setQuality(b.dataset.q);
    audio.uiClick();
  });
});

document.getElementById('startBtn').addEventListener('click', () => {
  audio.init(); audio.uiClick(); game.start();
});
document.getElementById('resumeBtn').addEventListener('click', () => {
  audio.uiClick(); game.resume();
});
document.getElementById('quitBtn').addEventListener('click', () => {
  audio.uiClick(); game.toTitle();
});
document.getElementById('retryBtn').addEventListener('click', () => {
  audio.uiClick(); game.start();
});
document.getElementById('titleBtn').addEventListener('click', () => {
  audio.uiClick(); game.toTitle();
});
const volSlider = document.getElementById('volumeSlider');
volSlider.addEventListener('input', () => {
  audio.init();
  audio.setVolume(+volSlider.value / 100);
  hud.syncVolume(audio);
});
document.getElementById('muteBtn').addEventListener('click', () => {
  audio.init();
  audio.toggleMute();
  hud.syncVolume(audio);
  audio.uiClick();
});
hud.syncVolume(audio);
document.getElementById('weaponClose').addEventListener('click', () => {
  game.closeWeapons();
});
document.getElementById('cardBookClose').addEventListener('click', () => {
  game.closeCardBook();
});

window.addEventListener('keydown', (e) => {
  // 一次按下只触发一次动作；关面板/选卡后长按的空格、数字键不能变成冲刺或技能。
  if (e.repeat && /^(Space|Enter|Escape|Key[PBTEQM]|Digit[1-4]|F3)$/.test(e.code)) {
    e.preventDefault(); return;
  }
  const inMenu = ['weapons', 'cardbook', 'paused', 'card'].includes(game.state);
  const onSlider = document.activeElement?.type === 'range';
  if ((e.code.startsWith('Arrow') && !(inMenu && onSlider)) || (e.code === 'Space' && (!inMenu || game.state === 'card')) || (e.code === 'Tab' && game.state === 'playing')) e.preventDefault();
  if (inMenu && e.code === 'Tab') {
    e.preventDefault();
    const list = game.menuFocusables();
    const i = list.indexOf(document.activeElement);
    const next = i < 0
      ? (e.shiftKey ? list.length - 1 : 0)
      : (i + (e.shiftKey ? -1 : 1) + list.length) % list.length;
    list[next]?.focus();
    return;
  }
  if (e.code === 'Escape' || e.code === 'KeyP') {
    if (game.state === 'playing') game.pause();
    else if (game.state === 'paused') game.resume();
    else if (game.state === 'weapons') game.closeWeapons();
    else if (game.state === 'cardbook') game.closeCardBook();
    // 选卡必须三选一，Esc 不能跳过
    return;
  }
  // 选卡界面：1/2/3 直选，方向键移动焦点，回车/空格确认。
  if (game.state === 'card') {
    const draft = game.cardDraft || [];
    if (/^Digit[1-3]$/.test(e.code)) {
      const c = draft[+e.code.slice(5) - 1];
      if (c) game.pickCard(c.id);
      return;
    }
    const cards = [...document.querySelectorAll('#cardRow .pickCard')];
    const i = cards.indexOf(document.activeElement);
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') { cards[(i - 1 + cards.length) % cards.length]?.focus(); return; }
    if (e.code === 'ArrowRight' || e.code === 'KeyD') { cards[(i + 1) % cards.length]?.focus(); return; }
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') { game.menuNavigate(0, e.code === 'ArrowDown' ? 1 : -1); return; }
    if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); (cards[i] || cards[0])?.click(); return; }
    return;
  }
  // 死亡结算延迟期内任意键跳过等待，直接出结算。
  if (game.state === 'over') {
    if (game.overTimer) { clearTimeout(game.overTimer); game.overTimer = null; }
    hud.screen('over');
    return;
  }
  if (game.state === 'title') {
    if (e.code === 'Enter') { e.preventDefault(); audio.init(); audio.uiClick(); game.start(); }
    return;
  }
  if (e.code === 'KeyM') {
    audio.init();
    const muted = audio.toggleMute();
    hud.syncVolume(audio);
    hud.toast(muted ? '已静音' : '声音已开启');
    return;
  }
  // 菜单不记录移动/冲刺键；按钮保留原生回车/空格，方向键只负责导航。
  if (inMenu) {
    if (e.code === 'KeyB' && game.state === 'weapons') game.closeWeapons();
    else if (e.code === 'KeyT' && game.state === 'cardbook') game.closeCardBook();
    else if (e.code.startsWith('Arrow') && document.activeElement?.type !== 'range') {
      game.menuNavigate(e.code === 'ArrowRight' ? 1 : e.code === 'ArrowLeft' ? -1 : 0,
        e.code === 'ArrowDown' ? 1 : e.code === 'ArrowUp' ? -1 : 0);
    }
    return;
  }
  if (e.code === 'KeyB') { game.openWeapons(); return; }
  if (e.code === 'KeyT') { game.openCardBook(); return; }
  if (/^Digit[1-4]$/.test(e.code)) { game.castSkill(+e.code.slice(5)); return; }
  if (e.code === 'KeyQ') { game.cycleGun(-1); return; }
  if (e.code === 'KeyE') { game.cycleGun(1); return; }
  if (e.code === 'F3') { e.preventDefault(); game.showFps = !game.showFps; return; }
  if (game.state === 'playing') game.keys.add(e.code);
});
window.addEventListener('keyup', (e) => game.keys.delete(e.code));
window.addEventListener('mousemove', (e) => { game.mouse.x = e.clientX; game.mouse.y = e.clientY; });
window.addEventListener('wheel', (e) => { if (game.state === 'playing') game.cycleGun(e.deltaY > 0 ? 1 : -1); }, { passive: true });
window.addEventListener('mousedown', (e) => {
  if (e.button === 0 && game.state === 'playing') { game.mouseFire = true; game.mouse.down = true; }
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) { game.mouseFire = false; game.mouse.down = game.padFire || false; }
});
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('blur', () => game.pause());
document.addEventListener('visibilitychange', () => { if (document.hidden) game.pause(); });

const params = new URLSearchParams(location.search);
if (params.has('fragile')) game.fragile = true;
if (params.has('bot')) game.bot = true;
game.best = game.loadBest(); // 模式确定后按对应档位读纪录
if (params.has('autostart')) game.start();

let last = performance.now();
let first = true;
function frame(now) {
  const raw = (now - last) / 1000;
  const dt = Math.min(0.05, raw);
  last = now;
  game.update(dt);
  engine.render(raw);
  if (first) { first = false; hud.loadingDone(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);