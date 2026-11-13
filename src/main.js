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
document.getElementById('shopClose').addEventListener('click', () => {
  game.closeShop();
});
document.getElementById('talentClose').addEventListener('click', () => {
  game.closeTalents();
});
document.getElementById('tabBuy').addEventListener('click', () => {
  audio.uiClick(); hud.shopTab('buy');
});
document.getElementById('tabSell').addEventListener('click', () => {
  audio.uiClick(); hud.shopTab('sell');
});

window.addEventListener('keydown', (e) => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
  if (e.code === 'Escape' || e.code === 'KeyP') {
    if (game.state === 'playing') game.pause();
    else if (game.state === 'paused') game.resume();
    else if (game.state === 'shop') game.closeShop();
    else if (game.state === 'talent') game.closeTalents();
    return;
  }
  // 死亡结算延迟期内任意键跳过等待，直接出结算
  if (game.state === 'over') {
    if (game.overTimer) { clearTimeout(game.overTimer); game.overTimer = null; }
    hud.screen('over');
    return;
  }
  if (game.state === 'title') {
    if (e.code === 'Enter') { audio.init(); audio.uiClick(); game.start(); }
    return;
  }
  if (e.code === 'KeyM') {
    audio.init();
    const muted = audio.toggleMute();
    hud.syncVolume(audio);
    hud.toast(muted ? '已静音' : '声音已开启');
    return;
  }
  // 菜单打开时不记录移动/冲刺键，避免关店瞬间残留触发
  if (game.state === 'shop' || game.state === 'talent' || game.state === 'paused') {
    if (e.code === 'KeyB' && game.state === 'shop') game.closeShop();
    else if (e.code === 'KeyT' && game.state === 'talent') game.closeTalents();
    return;
  }
  if (e.code === 'KeyB') { game.openShop(); return; }
  if (e.code === 'KeyT') { game.openTalents(); return; }
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