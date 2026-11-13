import { shopCatalog, LOOT_ITEMS, gearNext, TALENT_BRANCHES, TALENTS, talentNext, SKILLS } from './rules.js';

const $ = (id) => document.getElementById(id);

function itemIcon(id) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const x = c.getContext('2d');
  x.lineCap = 'round'; x.lineJoin = 'round';
  const box = (bx, by, w, h, col) => { x.fillStyle = col; x.fillRect(bx, by, w, h); };
  const circ = (cx, cy, r, col) => { x.fillStyle = col; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill(); };
  const poly = (pts, col) => { x.fillStyle = col; x.beginPath(); x.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) x.lineTo(p[0], p[1]); x.closePath(); x.fill(); };
  const metal = '#4a5058', wood = '#8a5a2e', steel = '#8a9098';
  if (id === 'carbine' || id === 'repeater' || id === 'longrifle') {
    box(6, 30, 40, 7, metal); box(44, 31, 14, 4, metal);
    poly([[6, 30], [16, 30], [12, 44], [4, 44]], wood);
    box(24, 37, 7, 12, metal); box(30, 26, 3, 5, metal);
    if (id === 'repeater') box(24, 37, 9, 16, metal);
    if (id === 'longrifle') { box(20, 22, 16, 5, metal); circ(36, 24, 3, steel); }
  } else if (id === 'shotgun') {
    box(8, 28, 42, 6, metal); box(8, 35, 42, 5, metal);
    poly([[8, 28], [18, 28], [14, 46], [4, 46]], wood);
    box(28, 40, 12, 7, wood);
  } else if (id === 'ammo') {
    box(10, 20, 44, 30, '#6a5a3a'); box(10, 30, 44, 8, '#ffd95e');
    box(10, 20, 44, 4, '#57492e');
  } else if (id === 'armor') {
    poly([[16, 12], [48, 12], [52, 34], [32, 54], [12, 34]], '#6a7a5a');
    poly([[24, 12], [40, 12], [32, 24]], '#59684b');
  } else if (id === 'helmet') {
    x.fillStyle = steel; x.beginPath(); x.arc(32, 34, 20, Math.PI, 0); x.fill();
    box(10, 32, 44, 6, '#6a6f76');
  } else if (id === 'shoes') {
    poly([[14, 14], [28, 14], [30, 34], [50, 40], [50, 50], [14, 50]], '#7a4a26');
    box(14, 46, 36, 5, '#5a3418');
  } else if (id === 'gloves') {
    circ(30, 30, 14, '#b03028'); box(24, 40, 14, 12, '#8a2018'); circ(44, 26, 6, '#b03028');
  } else {
    const it = LOOT_ITEMS.find((l) => l.id === id);
    const col = '#' + (it ? it.color : 0xffffff).toString(16).padStart(6, '0');
    if (id === 'feather') poly([[32, 6], [44, 26], [32, 58], [20, 26]], col);
    else if (id === 'blood') { x.fillStyle = col; x.beginPath(); x.moveTo(32, 8); x.quadraticCurveTo(50, 34, 32, 54); x.quadraticCurveTo(14, 34, 32, 8); x.fill(); }
    else if (id === 'intestine' || id === 'esophagus') { x.strokeStyle = col; x.lineWidth = 7; x.beginPath(); x.moveTo(12, 20); x.bezierCurveTo(52, 12, 12, 40, 52, 44); x.stroke(); }
    else if (id === 'wing') poly([[10, 40], [30, 12], [38, 20], [24, 44], [44, 26], [50, 34], [30, 52]], col);
    else if (id === 'foot') poly([[32, 10], [36, 30], [52, 44], [32, 40], [12, 44], [28, 30]], col);
    else if (id === 'head') { circ(32, 28, 16, col); poly([[44, 24], [58, 30], [44, 36]], '#f08c1e'); circ(26, 24, 3, '#20180a'); }
    else if (id === 'neck') { x.strokeStyle = col; x.lineWidth = 12; x.beginPath(); x.moveTo(20, 10); x.lineTo(40, 54); x.stroke(); }
    else if (id === 'clavicle') { x.strokeStyle = col; x.lineWidth = 8; x.beginPath(); x.moveTo(12, 24); x.lineTo(52, 24); x.moveTo(32, 24); x.lineTo(32, 52); x.stroke(); }
    else circ(32, 32, 18, col);
  }
  return c;
}

export class HUD {
  constructor() {
    this.el = {
      hud: $('hud'), hpFill: $('hpFill'), hpText: $('hpText'), dashFill: $('dashFill'),
      statWave: $('statWave'), statKills: $('statKills'), statScore: $('statScore'), statTime: $('statTime'),
      waveBanner: $('waveBanner'), waveTitle: $('waveTitle'), waveTip: $('waveTip'),
      mag: $('mag'), reserve: $('reserve'), reloadHint: $('reloadHint'),
      reloadBar: $('reloadBar'), reloadFill: $('reloadFill'), weaponName: $('weaponName'), gunIcon: $('gunIcon'),
      killfeed: $('killfeed'), toast: $('toast'),
      crosshair: $('crosshair'), hitmarker: $('hitmarker'),
      dmg: $('dmgVignette'), low: $('lowVignette'), flash: $('flash'),
      start: $('startScreen'), pause: $('pauseScreen'), over: $('gameoverScreen'),
      resWave: $('resWave'), resKills: $('resKills'), resScore: $('resScore'), resAcc: $('resAcc'),
      fps: $('fps'), loading: $('loading'),
      statCoins: $('statCoins'), shop: $('shopScreen'), shopCoins: $('shopCoins'),
      buyPane: $('buyPane'), sellPane: $('sellPane'), tabBuy: $('tabBuy'), tabSell: $('tabSell'), tip: $('tip'),
      statRemain: $('statRemain'), resTime: $('resTime'), resCoins: $('resCoins'),
      resBest: $('resBest'), recordBadge: $('recordBadge'),
      levelBadge: $('levelBadge'), xpFill: $('xpFill'), xpText: $('xpText'), pointsChip: $('pointsChip'),
      skillBar: $('skillBar'), shieldBar: $('shieldBar'), shieldFill: $('shieldFill'),
      talent: $('talentScreen'), talentPoints: $('talentPoints'), talentTree: $('talentTree'),
    };
    this.el.skillSlots = {};
    for (const sk of SKILLS) this.el.skillSlots[sk.id] = document.querySelector(`#skillBar .slot[data-skill="${sk.id}"]`);
    this._bannerT = null;
    this._toastT = null;
    this._hitT = null;
    this._dmgT = null;
    this.cross = { x: innerWidth / 2, y: innerHeight / 2 };
  }

  loadingDone() { this.el.loading.classList.add('hidden'); }
  hudOn(on) { this.el.hud.classList.toggle('on', on); }

  hp(v, max) {
    const pct = Math.max(0, v / max) * 100;
    this.el.hpFill.style.width = pct + '%';
    this.el.hpFill.classList.toggle('low', pct < 35);
    this.el.hpText.textContent = Math.ceil(Math.max(0, v));
    this.el.low.classList.toggle('on', pct < 35 && pct > 0);
  }

  dash(t) { this.el.dashFill.style.width = Math.min(1, Math.max(0, t)) * 100 + '%'; }

  ammo(mag, reserve, reloadT, reloadTotal) {
    this.el.mag.textContent = mag;
    this.el.mag.classList.toggle('empty', mag === 0);
    this.el.mag.classList.toggle('low', mag > 0 && mag <= 6);
    this.el.reserve.textContent = reserve;
    const reloading = reloadT > 0;
    this.el.reloadBar.classList.toggle('on', reloading);
    this.el.reloadFill.style.width = reloading ? ((1 - reloadT / reloadTotal) * 100) + '%' : '0%';
    this.el.reloadHint.textContent = reloading ? '换弹中…' : mag === 0 ? '按 R 换弹！' : '';
  }

  stats(wave, kills, score, time) {
    this.el.statWave.textContent = wave;
    this.el.statKills.textContent = kills;
    this.el.statScore.textContent = score;
    const m = Math.floor(time / 60), s = Math.floor(time % 60);
    this.el.statTime.textContent = `${m}:${String(s).padStart(2, '0')}`;
  }

  coins(v) { this.el.statCoins.textContent = v; }

  remain(v) { this.el.statRemain.textContent = v; }

  threat(x, y) {
    const ang = Math.atan2(y - innerHeight / 2, x - innerWidth / 2);
    const d = document.createElement('div');
    d.className = 'threat';
    d.style.left = x + 'px';
    d.style.top = y + 'px';
    const i = document.createElement('i');
    i.style.transform = `rotate(${(ang * 180) / Math.PI + 45}deg)`;
    d.appendChild(i);
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 1450);
  }

  setWeapon(label, gunId) {
    if (this.el.weaponName.textContent !== label) this.el.weaponName.textContent = label;
    if (gunId && this._gunIconId !== gunId) {
      this._gunIconId = gunId;
      const x = this.el.gunIcon.getContext('2d');
      x.clearRect(0, 0, 64, 64);
      x.drawImage(itemIcon(gunId), 0, 0);
    }
  }

  growth(level, xp, xpNeed, points) {
    this.el.levelBadge.textContent = 'Lv.' + level;
    this.el.xpFill.style.width = Math.min(1, xp / xpNeed) * 100 + '%';
    this.el.xpText.textContent = `${Math.floor(xp)} / ${xpNeed}`;
    this.el.pointsChip.textContent = points;
    this.el.pointsChip.classList.toggle('has', points > 0);
  }

  skills(unlocked, cds, active) {
    for (const sk of SKILLS) {
      const slot = this.el.skillSlots[sk.id];
      if (!slot) continue;
      slot.classList.toggle('locked', !unlocked[sk.id]);
      const cd = cds[sk.id] || 0;
      slot.querySelector('.cd').style.transform = `scaleY(${Math.min(1, cd / sk.cd)})`;
      slot.querySelector('.cdText').textContent = cd > 0 ? Math.ceil(cd) : '';
      slot.classList.toggle('active', (active[sk.id] || 0) > 0);
    }
  }

  shield(v, max, t) {
    const on = t > 0 && v > 0;
    this.el.shieldBar.classList.toggle('on', on);
    this.el.shieldFill.style.width = (on ? Math.min(1, v / max) * 100 : 0) + '%';
  }

  talentOpen(on) {
    this.el.talent.classList.toggle('hidden', !on);
  }

  renderTalents(game) {
    this.el.talentPoints.textContent = game.points;
    const tree = this.el.talentTree;
    tree.textContent = '';
    for (const br of TALENT_BRANCHES) {
      const col = document.createElement('div');
      col.className = 'branch';
      col.style.setProperty('--bc', '#' + br.color.toString(16).padStart(6, '0'));
      const head = document.createElement('div');
      head.className = 'branchHead';
      head.textContent = br.label;
      const sub = document.createElement('span');
      sub.textContent = br.desc;
      head.appendChild(sub);
      col.appendChild(head);
      const nodes = TALENTS.filter((t) => t.branch === br.id).sort((a, b) => a.tier - b.tier);
      for (const t of nodes) {
        const ranks = game.talents[t.id] || 0;
        const next = talentNext(t.id, ranks);
        const reqOk = !t.req || (game.talents[t.req] > 0);
        const card = document.createElement('div');
        card.className = 'tnode' + (ranks > 0 ? ' owned' : '') + (!reqOk ? ' locked' : '');
        card.dataset.talent = t.id;
        const name = document.createElement('b');
        name.textContent = t.name + (t.skill ? ' ★' : '');
        const pips = document.createElement('div');
        pips.className = 'pips';
        for (let i = 0; i < t.max; i++) {
          const pip = document.createElement('i');
          if (i < ranks) pip.className = 'on';
          pips.appendChild(pip);
        }
        const desc = document.createElement('span');
        const btn = document.createElement('button');
        if (!next) {
          desc.textContent = t.desc(ranks - 1);
          btn.textContent = '已满级'; btn.disabled = true;
        } else {
          desc.textContent = t.desc(ranks);
          if (!reqOk) { btn.textContent = '前置未解锁'; btn.disabled = true; }
          else if (game.points < next.cost) { btn.textContent = '天赋点不足'; btn.disabled = true; }
          else { btn.textContent = `加点 ${ranks}/${t.max}`; btn.addEventListener('click', () => game.buyTalent(t.id)); }
        }
        card.append(name, pips, desc, btn);
        col.appendChild(card);
      }
      tree.appendChild(col);
    }
  }

  shopOpen(on) {
    this.el.shop.classList.toggle('hidden', !on);
    if (on) this.shopTab('buy');
    else this.hideTip();
  }

  shopTab(tab) {
    const buy = tab === 'buy';
    this.el.tabBuy.classList.toggle('sel', buy);
    this.el.tabSell.classList.toggle('sel', !buy);
    this.el.buyPane.classList.toggle('hidden', !buy);
    this.el.sellPane.classList.toggle('hidden', buy);
    this.hideTip();
  }

  showTip(data, rect) {
    const tip = this.el.tip;
    tip.textContent = '';
    const put = (cls, text, tag = 'div') => {
      const n = document.createElement(tag);
      n.className = cls;
      n.textContent = text;
      tip.appendChild(n);
    };
    put('', data.title, 'b');
    put('kind', data.kind);
    put('desc', data.desc);
    put('tprice', data.price);
    put('hint', data.hint);
    tip.classList.remove('hidden');
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = rect.right + 12;
    if (left + w > innerWidth - 8) left = rect.left - w - 12;
    tip.style.left = left + 'px';
    tip.style.top = Math.max(8, Math.min(rect.top - 6, innerHeight - h - 8)) + 'px';
  }

  hideTip() { this.el.tip.classList.add('hidden'); }

  bindTile(tile, html, action) {
    tile.addEventListener('mouseenter', () => this.showTip(html, tile.getBoundingClientRect()));
    tile.addEventListener('mouseleave', () => this.hideTip());
    tile.addEventListener('focus', () => this.showTip(html, tile.getBoundingClientRect()));
    tile.addEventListener('blur', () => this.hideTip());
    tile.addEventListener('click', () => { if (action) action(); });
    tile.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && action) { e.preventDefault(); action(); }
    });
  }

  renderShop(game) {
    this.el.shopCoins.textContent = game.coins;
    this.hideTip();
    const grid = this.el.buyPane;
    grid.textContent = '';
    for (const good of shopCatalog()) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.tabIndex = 0;
      tile.dataset.good = good.id;
      tile.appendChild(itemIcon(good.id));
      const price = document.createElement('span');
      price.className = 'price';
      let desc = good.desc, kind = '补给', hint = '点击购买', action = null, state = '';
      if (good.kind === 'gun') {
        kind = '武器';
        price.textContent = good.price;
        const owned = game.ownedGuns.includes(good.id);
        const equipped = game.gunId === good.id;
        if (equipped) { state = '已装备'; hint = '当前装备'; }
        else if (owned) { hint = '点击装备'; action = () => { game.equipGun(good.id); game.hud.renderShop(game); }; }
        else if (game.coins >= good.price) action = () => game.buyGood(good.id);
        else hint = '金币不足';
      } else if (good.kind === 'gear') {
        kind = '护具';
        const cur = game.gear[good.id] || 0;
        const next = gearNext(good.id, cur);
        if (cur) {
          const lvl = document.createElement('span');
          lvl.className = 'lvl';
          lvl.textContent = ['Ⅰ', 'Ⅱ', 'Ⅲ'][cur - 1];
          tile.appendChild(lvl);
        }
        if (!next) { price.textContent = 'MAX'; state = '已满级'; hint = '已满级'; }
        else {
          price.textContent = next.price;
          desc = next.desc;
          hint = cur ? '点击升级' : '点击购买';
          if (game.coins >= next.price) action = () => game.buyGood(good.id);
          else hint = '金币不足';
        }
      } else {
        price.textContent = good.price;
        if (game.coins >= good.price) action = () => game.buyGood(good.id);
        else hint = '金币不足';
      }
      if (!action && !state) tile.classList.add('cant');
      tile.appendChild(price);
      if (state) {
        const st = document.createElement('span');
        st.className = 'state';
        st.textContent = state;
        tile.appendChild(st);
      }
      const tipData = { title: good.label, kind, desc,
        price: price.textContent === 'MAX' ? '已满级' : price.textContent + ' 金币', hint };
      this.bindTile(tile, tipData, action);
      grid.appendChild(tile);
    }
    const list = this.el.sellPane;
    list.textContent = '';
    const entries = LOOT_ITEMS.filter((it) => (game.inv[it.id] || 0) > 0);
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '背包空空如也——击败掠夺者拾取鸭杂，再来出售！';
      list.appendChild(empty);
    }
    for (const it of entries) {
      const n = game.inv[it.id];
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.tabIndex = 0;
      tile.dataset.loot = it.id;
      tile.appendChild(itemIcon(it.id));
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `×${n}`;
      const price = document.createElement('span');
      price.className = 'price';
      price.textContent = it.price;
      const all = document.createElement('button');
      all.className = 'sellAll';
      all.type = 'button';
      all.textContent = '全卖';
      all.addEventListener('click', (e) => { e.stopPropagation(); game.sellItem(it.id, true); });
      tile.append(count, price, all);
      const tipData = { title: it.label, kind: '鸭杂 · 背包',
        desc: `单价 ${it.price} 金币 · 库存 ${n} · 总值 ${n * it.price} 金币`,
        price: `${it.price} 金币 / 个`, hint: '点击卖 1 · 顶部按钮全卖' };
      this.bindTile(tile, tipData, () => game.sellItem(it.id, false));
      list.appendChild(tile);
    }
  }

  banner(wave, tip) {
    this.el.waveTitle.textContent = `第 ${wave} 波`;
    this.el.waveTip.textContent = tip;
    this.el.waveBanner.classList.add('show');
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => this.el.waveBanner.classList.remove('show'), 2800);
  }

  feed(segments) {
    const d = document.createElement('div');
    d.className = 'feed';
    for (const seg of segments) {
      const node = document.createElement(seg.em ? 'em' : 'span');
      node.textContent = seg.text;
      d.appendChild(node);
    }
    this.el.killfeed.prepend(d);
    while (this.el.killfeed.children.length > 5) this.el.killfeed.lastChild.remove();
    setTimeout(() => d.classList.add('out'), 2600);
    setTimeout(() => d.remove(), 3100);
  }

  toast(text, dur = 2200) {
    this.el.toast.textContent = text;
    this.el.toast.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => this.el.toast.classList.remove('show'), dur);
  }

  hitmarker(kill) {
    this.el.hitmarker.classList.toggle('kill', kill);
    this.el.hitmarker.classList.add('show');
    this.el.hitmarker.style.transform = `translate(${this.cross.x}px, ${this.cross.y}px)`;
    clearTimeout(this._hitT);
    this._hitT = setTimeout(() => this.el.hitmarker.classList.remove('show'), kill ? 220 : 110);
  }

  crosshair(x, y, spreadPx, visible) {
    this.cross.x = x; this.cross.y = y;
    const c = this.el.crosshair;
    c.style.display = visible ? 'block' : 'none';
    c.style.transform = `translate(${x}px, ${y}px)`;
    const g = spreadPx;
    c.querySelector('.t').style.transform = `translateY(${-g - 9}px)`;
    c.querySelector('.b').style.transform = `translateY(${g}px)`;
    c.querySelector('.l').style.transform = `translateX(${-g - 9}px)`;
    c.querySelector('.r').style.transform = `translateX(${g}px)`;
  }

  damage() {
    this.el.dmg.style.opacity = 0.95;
    clearTimeout(this._dmgT);
    this._dmgT = setTimeout(() => { this.el.dmg.style.opacity = 0; }, 140);
  }

  screen(name) {
    this.el.start.classList.toggle('hidden', name !== 'start');
    this.el.pause.classList.toggle('hidden', name !== 'pause');
    this.el.over.classList.toggle('hidden', name !== 'over');
    this.el.shop.classList.add('hidden');
    this.el.talent.classList.add('hidden');
  }

  results({ wave, kills, score, acc, time = 0, coins = 0, best = 0, isRecord = false }) {
    this.el.resWave.textContent = wave;
    this.el.resKills.textContent = kills;
    this.el.resScore.textContent = score;
    this.el.resAcc.textContent = Math.round(acc * 100) + '%';
    const m = Math.floor(time / 60), s = Math.floor(time % 60);
    this.el.resTime.textContent = `${m}:${String(s).padStart(2, '0')}`;
    this.el.resCoins.textContent = coins;
    this.el.resBest.textContent = best;
    this.el.recordBadge.classList.toggle('hidden', !isRecord);
  }

  fps(v, show) {
    this.el.fps.style.display = show ? 'block' : 'none';
    if (show) this.el.fps.textContent = `${v} FPS`;
  }
}