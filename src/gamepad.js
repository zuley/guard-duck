import * as THREE from 'three';

const GAMEPAD_SKILLS = [[12, 1], [15, 2], [13, 3], [14, 4]];
const _botLead = new THREE.Vector3();
const _botProj = new THREE.Vector3();
const _botDir = new THREE.Vector3();
const _botMove = new THREE.Vector3();

// 菜单手柄导航：方向键/D-pad 移动焦点，A 确认；焦点环复用 :focus 样式
export function menuFocusables(game) {
  const sel = {
    weapons: '#weaponScreen button, #weaponScreen summary, #weaponScreen a[href]',
    card: '#cardScreen .pickCard',
    cardbook: '#cardBookClose',
    paused: '#pauseScreen button, #pauseScreen input',
    over: '#gameoverScreen button',
  }[game.state];
  if (!sel) return [];
  return [...document.querySelectorAll(sel)].filter((el) => {
    if (el.disabled || el.closest('.hidden')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

export function menuNavigate(game, dx, dy) {
  const list = game.menuFocusables();
  if (!list.length) return;
  const cur = list.indexOf(document.activeElement);
  if (cur < 0) { list[0].focus(); return; }
  const cr = list[cur].getBoundingClientRect();
  const cx = cr.x + cr.width / 2, cy = cr.y + cr.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of list) {
    if (el === list[cur]) continue;
    const r = el.getBoundingClientRect();
    const vx = r.x + r.width / 2 - cx, vy = r.y + r.height / 2 - cy;
    const along = vx * dx + vy * dy;
    if (along <= 4) continue;
    const perp = Math.abs(vx * dy - vy * dx);
    const score = along + perp * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) best.focus();
}

export function pollGamepad(game) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = pads && pads[0];
  if (!gp) { game.padAim = null; game.padFire = false; return; }
  const prev = game.padPrev;
  const btn = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
  const edge = (i) => btn(i) && !prev[i];
  const dead = (v) => (Math.abs(v) > 0.22 ? v : 0);
  const lx = dead(gp.axes[0] || 0), ly = dead(gp.axes[1] || 0);
  const rx = dead(gp.axes[2] || 0), ry = dead(gp.axes[3] || 0);

  if (game.state === 'title' || game.state === 'over') {
    if (edge(0)) { game.audio.init(); game.start(); }
  } else if (game.state === 'playing') {
    // 手柄与键鼠共存：摇杆有输入才接管移动，扳机与鼠标左键并联，互不清零
    const k = game.keys;
    if (lx || ly) {
      for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) k.delete(c);
      if (lx > 0.35) k.add('KeyD'); else if (lx < -0.35) k.add('KeyA');
      if (ly > 0.35) k.add('KeyS'); else if (ly < -0.35) k.add('KeyW');
    }
    game.padAim = (rx || ry) ? { x: rx, z: ry } : null;
    game.padFire = btn(7) || btn(6);
    game.mouse.down = game.mouseFire || game.padFire;
    if (edge(0)) k.add('Space');
    // 战斗十字键顺时针对应技能 1–4；菜单分支只导航，沿用同一份按键边沿。
    for (const [button, skill] of GAMEPAD_SKILLS) {
      if (edge(button)) game.castSkill(skill);
    }
    if (edge(1)) game.openWeapons();
    if (edge(3)) game.openCardBook();
    if (edge(9)) game.pause();
  } else if (game.state === 'weapons' || game.state === 'card' || game.state === 'cardbook' || game.state === 'paused') {
    // 菜单内：方向导航 + A 确认 + B/Start 返回
    const now = game.t;
    const nx = (lx > 0.55 || btn(15)) ? 1 : (lx < -0.55 || btn(14)) ? -1 : 0;
    const ny = (ly > 0.55 || btn(13)) ? 1 : (ly < -0.55 || btn(12)) ? -1 : 0;
    if ((nx || ny) && now - (game.padNavT || 0) > 0.24) {
      game.padNavT = now;
      const ae = document.activeElement;
      if (ae && ae.type === 'range' && nx) {
        // 焦点在音量滑条上：左右直接调音量
        ae.value = String(Math.min(100, Math.max(0, +ae.value + nx * 5)));
        ae.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        game.menuNavigate(nx, ny);
      }
    }
    if (edge(0)) {
      const list = game.menuFocusables();
      const el = list.includes(document.activeElement) ? document.activeElement : list[0];
      if (el) {
        if (el.tagName === 'INPUT') el.focus();
        else el.click();
        // 计划订阅后会重绘并恢复焦点，不要把新焦点清掉。
        if (el.tagName === 'BUTTON' && !el.classList.contains('weaponCard')) el.blur();
      }
    }
    if (game.state === 'weapons' && (edge(1) || edge(9))) game.closeWeapons();
    else if (game.state === 'cardbook' && (edge(3) || edge(1) || edge(9))) game.closeCardBook();
    else if (game.state === 'paused' && (edge(9) || edge(1))) game.resume();
    // 选卡界面必须选一张，B/Start 不能跳过
  }
  game.padPrev = gp.buttons.map((b) => b.pressed);
}

export function botControl(game) {
  const p = game.p;
  const k = game.keys;
  for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) k.delete(c);
  let nearest = null, nd = 1e9;
  for (const e of game.enemies) {
    if (e.dead) continue;
    const d = e.pos.distanceTo(p.pos);
    if (d < nd) { nd = d; nearest = e; }
  }
  if (!nearest) {
    game.mouse.down = false;
    if (Math.sin(game.t * 0.4) > 0) k.add('KeyW'); else k.add('KeyS');
    if (Math.cos(game.t * 0.3) > 0) k.add('KeyD'); else k.add('KeyA');
    return;
  }
  _botLead.copy(nearest.vel).multiplyScalar(Math.min(0.45, nd / 70));
  _botProj.copy(nearest.pos).add(_botLead).setY(0).project(game.engine.camera);
  game.mouse.x = (_botProj.x * 0.5 + 0.5) * innerWidth;
  game.mouse.y = (-_botProj.y * 0.5 + 0.5) * innerHeight;
  game.mouse.down = true;
  _botDir.subVectors(nearest.pos, p.pos).setY(0).normalize();
  if (nd > 9) _botMove.copy(_botDir);
  else if (nd < 5) _botMove.copy(_botDir).negate();
  else _botMove.set(-_botDir.z, 0, _botDir.x);
  _botMove.x -= p.pos.x / 22; _botMove.z -= p.pos.z / 22;
  if (_botMove.lengthSq() > 1e-6) _botMove.normalize();
  if (_botMove.x > 0.35) k.add('KeyD'); else if (_botMove.x < -0.35) k.add('KeyA');
  if (_botMove.z > 0.35) k.add('KeyS'); else if (_botMove.z < -0.35) k.add('KeyW');
  if (nd < 3.2 && p.dashCd <= 0) k.add('Space');
}
