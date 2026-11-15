import { gunCatalog, GUNS, CARD_BY_ID, CARD_RARITIES, SKILLS } from './rules.js';

const $ = (id) => document.getElementById(id);

// 自绘枪械轮廓；颜色呼应枪身与曳光，不使用任何厂商标志。
function weaponIcon(id) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  c.setAttribute('aria-hidden', 'true');
  const x = c.getContext('2d');
  const accent = '#' + (GUNS[id]?.accent ?? 0xd97757).toString(16).padStart(6, '0');
  const box = (bx, by, w, h, col) => { x.fillStyle = col; x.fillRect(bx, by, w, h); };
  const poly = (pts, col) => {
    x.fillStyle = col; x.beginPath(); x.moveTo(...pts[0]);
    for (const p of pts.slice(1)) x.lineTo(...p);
    x.closePath(); x.fill();
  };
  x.translate(32, 32); x.rotate(-0.22); x.translate(-32, -32);
  const metal = '#b8c2ce', dark = '#414b5b';
  poly([[5, 28], [17, 28], [15, 40], [4, 43]], accent);
  if (id === 'glm') {
    box(17, 25, 39, 5, metal); box(17, 32, 39, 5, metal);
    box(16, 24, 17, 15, dark); box(29, 35, 14, 8, accent);
    box(49, 24, 8, 14, dark);
  } else {
    box(15, 26, id === 'qwen' ? 28 : 31, 11, dark);
    box(43, 29, id === 'codex' ? 19 : 15, 4, metal);
    box(18, 27, id === 'qwen' ? 22 : 16, 7, accent);
    poly([[24, 37], [32, 37], [30, id === 'qwen' ? 52 : 47], [22, id === 'qwen' ? 52 : 47]], metal);
    box(34, 36, 4, 7, dark);
    if (id === 'codex') {
      box(25, 19, 20, 6, dark); box(26, 20, 4, 4, accent);
      box(32, 24, 4, 3, metal); box(45, 30, 13, 2, accent);
    } else if (id === 'qwen') {
      box(36, 28, 2, 5, metal); box(40, 28, 2, 5, metal);
      box(20, 23, 18, 2, metal);
    } else {
      box(30, 22, 3, 4, metal); box(42, 26, 3, 10, accent);
    }
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
      killfeed: $('killfeed'), toast: $('toast'), alert: $('alertBanner'),
      crosshair: $('crosshair'), hitmarker: $('hitmarker'),
      dmg: $('dmgVignette'), low: $('lowVignette'), flash: $('flash'),
      start: $('startScreen'), pause: $('pauseScreen'), over: $('gameoverScreen'),
      resWave: $('resWave'), resKills: $('resKills'), resScore: $('resScore'), resAcc: $('resAcc'),
      fps: $('fps'), loading: $('loading'),
      statCoins: $('statCoins'), weapons: $('weaponScreen'), weaponCoins: $('weaponCoins'),
      weaponGrid: $('weaponGrid'),
      statRemain: $('statRemain'), resTime: $('resTime'), resCoins: $('resCoins'),
      resBest: $('resBest'), recordBadge: $('recordBadge'),
      levelBadge: $('levelBadge'), xpFill: $('xpFill'), xpText: $('xpText'), cardChip: $('cardChip'),
      skillBar: $('skillBar'), shieldBar: $('shieldBar'), shieldFill: $('shieldFill'),
      card: $('cardScreen'), cardWave: $('cardWave'), cardRow: $('cardRow'), cardOwned: $('cardOwned'),
      cardBook: $('cardBookScreen'), cardBookGrid: $('cardBookGrid'), cardBookCount: $('cardBookCount'),
    };
    this.el.skillSlots = {};
    this._skillRefs = {};
    for (const sk of SKILLS) {
      const slot = document.querySelector(`#skillBar .slot[data-skill="${sk.id}"]`);
      this.el.skillSlots[sk.id] = slot;
      if (slot) this._skillRefs[sk.id] = { cd: slot.querySelector('.cd'), cdText: slot.querySelector('.cdText'), lastText: null };
    }
    this._bannerT = null;
    this._toastT = null;
    this._alertT = null;
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
    this.el.reloadHint.textContent = reloading ? '换弹中…' : mag === 0 ? (reserve > 0 ? '按 R 换弹！' : '弹药耗尽！拾取弹药箱') : '';
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
      x.drawImage(weaponIcon(gunId), 0, 0);
    }
  }

  growth(level, xp, xpNeed, cardCount) {
    this.el.levelBadge.textContent = 'Lv.' + level;
    this.el.xpFill.style.width = Math.min(1, xp / xpNeed) * 100 + '%';
    this.el.xpText.textContent = `${Math.floor(xp)} / ${xpNeed}`;
    if (this._cardCount !== cardCount) {
      this._cardCount = cardCount;
      this.el.cardChip.textContent = cardCount;
      this.el.cardChip.classList.toggle('has', cardCount > 0);
    }
  }

  skills(unlocked, cds, active) {
    for (const sk of SKILLS) {
      const slot = this.el.skillSlots[sk.id];
      const ref = this._skillRefs[sk.id];
      if (!slot || !ref) continue;
      const locked = !unlocked[sk.id];
      slot.classList.toggle('locked', locked);
      const cd = cds[sk.id] || 0;
      ref.cd.style.transform = `scaleY(${Math.min(1, cd / sk.cd)})`;
      // 未解锁显示解锁等级（唯一来源 requiredLevel），冷却中显示倒计时；仅在变化时写 DOM
      const text = locked ? `Lv${sk.requiredLevel}` : cd > 0 ? String(Math.ceil(cd)) : '';
      if (text !== ref.lastText) { ref.cdText.textContent = text; ref.lastText = text; }
      slot.classList.toggle('active', (active[sk.id] || 0) > 0);
    }
  }

  shield(v, max, t) {
    const on = t > 0 && v > 0;
    this.el.shieldBar.classList.toggle('on', on);
    this.el.shieldFill.style.width = (on ? Math.min(1, v / max) * 100 : 0) + '%';
  }

  /* ---------------- 波次三选一强化卡 ---------------- */

  cardOpen(on) {
    this.el.card.classList.toggle('hidden', !on);
    this.el.card.inert = !on;
    if (!on && this.el.card.contains(document.activeElement)) document.activeElement.blur();
  }

  cardBookOpen(on) {
    this.el.cardBook.classList.toggle('hidden', !on);
    this.el.cardBook.inert = !on;
    if (on) $('cardBookClose').focus();
    else if (this.el.cardBook.contains(document.activeElement)) document.activeElement.blur();
  }

  // 卡面图标：稀有度配色的程序化 canvas 徽记，金色额外描边光芒
  cardArt(card) {
    const c = document.createElement('canvas');
    c.width = 96; c.height = 96;
    const x = c.getContext('2d');
    const rar = CARD_RARITIES[card.rarity];
    const col = rar.css;
    const g = x.createRadialGradient(48, 44, 4, 48, 48, 46);
    g.addColorStop(0, col + 'cc');
    g.addColorStop(0.55, col + '33');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 96, 96);
    // 稀有度外框：普通圆角方、稀有六边形、传说星芒
    x.strokeStyle = col; x.lineWidth = 3; x.lineJoin = 'round';
    x.beginPath();
    if (card.rarity === 'gold') {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 === 0 ? 38 : 19;
        const px = 48 + Math.cos(a) * r, py = 46 + Math.sin(a) * r;
        i ? x.lineTo(px, py) : x.moveTo(px, py);
      }
    } else if (card.rarity === 'rare') {
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 3;
        const px = 48 + Math.cos(a) * 34, py = 46 + Math.sin(a) * 34;
        i ? x.lineTo(px, py) : x.moveTo(px, py);
      }
    } else {
      x.roundRect(16, 14, 64, 64, 14);
    }
    x.closePath();
    x.stroke();
    x.fillStyle = 'rgba(10,8,4,.55)';
    x.fill();
    x.fillStyle = col;
    x.font = '900 34px "Yuanti SC","Microsoft YaHei",sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.shadowColor = col; x.shadowBlur = 12;
    x.fillText(card.icon, 48, 47);
    return c;
  }

  renderCards(game) {
    const draft = game.cardDraft || [];
    this.el.cardWave.textContent = `第 ${game.wave} 波 · 肃清奖励`;
    const row = this.el.cardRow;
    row.textContent = '';
    draft.forEach((card, i) => {
      const rar = CARD_RARITIES[card.rarity];
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `pickCard ${card.rarity}`;
      el.dataset.card = card.id;
      el.style.setProperty('--rc', rar.css);
      el.style.setProperty('--rg', rar.glow);
      el.style.setProperty('--i', String(i));

      const badge = document.createElement('div');
      badge.className = 'rarBadge';
      badge.textContent = rar.label;
      const art = document.createElement('div');
      art.className = 'art';
      art.appendChild(this.cardArt(card));
      const name = document.createElement('b');
      name.className = 'cname';
      name.textContent = card.name;
      const tag = document.createElement('div');
      tag.className = 'ctag';
      tag.textContent = card.tag;
      const desc = document.createElement('p');
      desc.className = 'cdesc';
      desc.textContent = card.desc(card.next);
      const pips = document.createElement('div');
      pips.className = 'cpips';
      for (let k = 0; k < card.max; k++) {
        const pip = document.createElement('i');
        if (k < card.stacks) pip.className = 'on';
        else if (k === card.stacks) pip.className = 'next';
        pips.appendChild(pip);
      }
      const foot = document.createElement('div');
      foot.className = 'cfoot';
      const lv = document.createElement('span');
      lv.textContent = card.stacks ? `Lv.${card.stacks} → ${card.next}` : '新卡牌';
      const key = document.createElement('kbd');
      key.textContent = String(i + 1);
      foot.append(lv, key);
      el.append(badge, art, name, tag, desc, pips, foot);
      el.addEventListener('click', () => game.pickCard(card.id));
      el.addEventListener('mouseenter', () => { el.classList.add('hover'); game.audio.uiHover(); });
      el.addEventListener('mouseleave', () => el.classList.remove('hover'));
      row.appendChild(el);
    });
    this.cardBook(game);
    // 默认聚焦第一张，键盘/手柄可直接确认
    const first = row.querySelector('.pickCard');
    if (first) first.focus();
  }

  // HUD 角标 + 选卡页底部「已获」缩略条
  cardBook(game) {
    const ids = [...new Set(game.cardHistory)];
    const wrap = this.el.cardOwned;
    if (!wrap) return;
    wrap.textContent = '';
    if (!ids.length) {
      const empty = document.createElement('span');
      empty.className = 'ownedEmpty';
      empty.textContent = '尚未获得强化卡 · 每波肃清后可三选一';
      wrap.appendChild(empty);
      return;
    }
    for (const id of ids) {
      const c = CARD_BY_ID[id];
      const n = game.cards[id] || 0;
      const chip = document.createElement('span');
      chip.className = `ownedChip ${c.rarity}`;
      chip.style.setProperty('--rc', CARD_RARITIES[c.rarity].css);
      chip.textContent = `${c.name} ${n}`;
      chip.title = c.desc(n);
      wrap.appendChild(chip);
    }
  }

  renderCardBook(game) {
    const ids = [...new Set(game.cardHistory)];
    this.el.cardBookCount.textContent = `${ids.length} 种 · ${Object.values(game.cards).reduce((a, b) => a + b, 0)} 层`;
    const grid = this.el.cardBookGrid;
    grid.textContent = '';
    if (!ids.length) {
      const empty = document.createElement('div');
      empty.className = 'bookEmpty';
      empty.textContent = '还没有强化卡。每波敌人肃清后会弹出三张卡，选一张变强！';
      grid.appendChild(empty);
      return;
    }
    // 金 → 绿 → 普通排序，方便一眼看到本局的构筑核心
    const sorted = ids.map((id) => CARD_BY_ID[id]).sort((a, b) => CARD_RARITIES[b.rarity].order - CARD_RARITIES[a.rarity].order);
    for (const c of sorted) {
      const n = game.cards[c.id] || 0;
      const rar = CARD_RARITIES[c.rarity];
      const el = document.createElement('div');
      el.className = `bookCard ${c.rarity}`;
      el.style.setProperty('--rc', rar.css);
      const art = document.createElement('div');
      art.className = 'art';
      art.appendChild(this.cardArt(c));
      const body = document.createElement('div');
      body.className = 'bbody';
      const head = document.createElement('b');
      head.textContent = c.name;
      const lv = document.createElement('em');
      lv.textContent = `Lv.${n}/${c.max}`;
      head.appendChild(lv);
      const rarTag = document.createElement('span');
      rarTag.className = 'brar';
      rarTag.textContent = rar.label;
      const desc = document.createElement('p');
      desc.textContent = c.desc(n);
      body.append(head, rarTag, desc);
      el.append(art, body);
      grid.appendChild(el);
    }
  }

  weaponsOpen(on) {
    this.el.weapons.classList.toggle('hidden', !on);
    this.el.weapons.inert = !on;
    if (on) this.el.crosshair.style.display = 'none';
    else if (this.el.weapons.contains(document.activeElement)) document.activeElement.blur();
  }

  renderWeapons(game) {
    this.el.weaponCoins.textContent = game.coins;
    // 购买后仍聚焦同一把枪，键盘与手柄可连续操作；首次打开聚焦当前装备。
    const focused = document.activeElement?.closest('.weaponCard')?.dataset.gun;
    const grid = this.el.weaponGrid;
    grid.textContent = '';
    for (const good of gunCatalog()) {
      const gun = GUNS[good.id];
      const owned = game.ownedGuns.includes(good.id);
      const equipped = game.gunId === good.id;
      const affordable = owned || game.coins >= good.price;
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = `weaponCard${equipped ? ' equipped' : ''}${!affordable ? ' cant' : ''}`;
      tile.dataset.gun = good.id;
      tile.style.setProperty('--gun-accent', '#' + good.accent.toString(16).padStart(6, '0'));
      tile.setAttribute('aria-pressed', String(equipped));
      tile.setAttribute('aria-disabled', String(!affordable || equipped));
      const put = (cls, text, tag = 'span') => {
        const el = document.createElement(tag);
        el.className = cls; el.textContent = text;
        return el;
      };
      const art = put('weaponArt', '');
      art.appendChild(weaponIcon(good.id));
      const stats = put('weaponStats', '');
      for (const [label, value] of [
        ['伤害', gun.pellets > 1 ? `${gun.damage} × ${gun.pellets}` : gun.damage],
        ['射速', `${gun.rpm}/分`], ['弹匣', gun.magSize], ['射程', `${gun.range}m`],
      ]) {
        const row = put('', '');
        row.append(put('', label), put('', value, 'b'));
        stats.appendChild(row);
      }
      const foot = put('weaponFoot', '');
      foot.append(
        put('weaponPrice', owned ? '已拥有' : `${good.price} 金币`),
        put('weaponAction', equipped ? '已装备' : owned ? '装备' : affordable ? '购买' : `差 ${good.price - game.coins} 金币`),
      );
      tile.append(art, put('weaponName', good.label, 'b'), put('weaponTag', good.tag), stats, foot);
      // 使用 button 原生回车/空格激活，不额外绑定 keydown，避免一次按键重复购买。
      tile.addEventListener('click', () => game.buyGun(good.id));
      tile.addEventListener('mouseenter', () => game.audio.uiHover());
      grid.appendChild(tile);
    }
    grid.querySelector(`[data-gun="${focused || game.gunId}"]`)?.focus({ preventScroll: true });
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

  // 高优先级保命预警（Boss/精英技能）：独立通道，普通 toast 无法覆盖
  alert(text, dur = 2500) {
    this.el.alert.textContent = text;
    this.el.alert.classList.add('show');
    clearTimeout(this._alertT);
    this._alertT = setTimeout(() => this.el.alert.classList.remove('show'), dur);
  }

  syncVolume(audio) {
    const slider = $('volumeSlider'), pct = $('volumePct'), mute = $('muteBtn');
    if (slider) slider.value = String(Math.round(audio.volume * 100));
    if (pct) pct.textContent = Math.round(audio.volume * 100) + '%';
    if (mute) mute.textContent = audio.muted ? '取消静音 (M)' : '静音 (M)';
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
    this.el.weapons.classList.add('hidden');
    this.el.card.classList.add('hidden');
    this.el.cardBook.classList.add('hidden');
    for (const [id, el] of [['start', this.el.start], ['pause', this.el.pause], ['over', this.el.over]]) el.inert = name !== id;
    this.el.weapons.inert = this.el.card.inert = this.el.cardBook.inert = true;
    // 切回战斗/标题时清掉覆盖层按钮焦点，防止空格原生激活隐藏按钮
    if (name === null || name === 'start') {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    }
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