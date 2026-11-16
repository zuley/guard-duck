import { CARD_BY_ID, CARD_RARITIES, SKILLS } from './rules.js';
import {
  PLANS, getPlan, quoteUsage, quoteSubscription, formatCoins, microsToCoins,
  PROTECTION_ITEMS, PROTECTION_DURATION,
} from './subscriptions.js';

const $ = (id) => document.getElementById(id);
const count = (n) => Number(n).toLocaleString('zh-CN');
const hex = (color) => '#' + color.toString(16).padStart(6, '0');

// 自绘枪械轮廓；颜色呼应枪身与曳光，不使用任何厂商标志。
function weaponIcon(id) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  c.setAttribute('aria-hidden', 'true');
  const x = c.getContext('2d');
  const accent = hex((getPlan(id) || PLANS.ds).accent);
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
    box(43, 29, 15, 4, metal);
    box(18, 27, id === 'qwen' ? 22 : 16, 7, accent);
    box(22, 36, 17, 4, accent); // 固定调用核心，不画弹匣。
    poly([[16, 37], [21, 37], [20, 45], [16, 45]], dark);
    if (id === 'gpt') {
      box(19, 22, 24, 3, accent); box(20, 20, 22, 2, metal);
      x.strokeStyle = metal; x.lineWidth = 2;
      x.beginPath(); x.arc(23, 20, 4, 0, Math.PI * 2); x.stroke();
      box(43, 26, 3, 10, accent);
    } else if (id === 'ds') {
      box(40, 26, 10, 10, accent); box(19, 23, 21, 3, accent);
      box(24, 28, 11, 2, metal); box(45, 28, 5, 5, dark);
    } else if (id === 'qwen') {
      for (let i = 0; i < 3; i++) box(32 + i * 4, 27, 2, 8, metal);
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
      tokensRemaining: $('tokensRemaining'), tokensGranted: $('tokensGranted'),
      subscriptionStatus: $('subscriptionStatus'), usageHint: $('usageHint'),
      protectionCounts: $('protectionCounts'), weaponName: $('weaponName'), gunIcon: $('gunIcon'),
      killfeed: $('killfeed'), toast: $('toast'), alert: $('alertBanner'),
      crosshair: $('crosshair'), hitmarker: $('hitmarker'),
      dmg: $('dmgVignette'), low: $('lowVignette'), flash: $('flash'),
      start: $('startScreen'), pause: $('pauseScreen'), over: $('gameoverScreen'),
      resWave: $('resWave'), resKills: $('resKills'), resScore: $('resScore'), resAcc: $('resAcc'),
      fps: $('fps'), loading: $('loading'),
      statCoins: $('statCoins'), weapons: $('weaponScreen'), weaponCoins: $('weaponCoins'),
      weaponGrid: $('weaponGrid'), weaponReferences: $('weaponReferences'),
      overTitle: $('overTitle'), overSub: $('overSub'), overReason: $('overReason'), resCalls: $('resCalls'), resTokensUsed: $('resTokensUsed'),
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
    this._protectionRefs = new Map();
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

  subscription(game) {
    const plan = getPlan(game.planId);
    const quote = game.usageQuote();
    const metered = !!plan && (game.subscriptionStatus === 'metered' || game.tokens === 0);
    this.el.tokensRemaining.textContent = count(game.tokens);
    this.el.tokensGranted.textContent = count(game.quotaGranted);
    this.el.subscriptionStatus.textContent = !plan ? '等待选择' : game.subscriptionStatus === 'metered'
      ? '未续费 · 按量' : metered ? '额度用尽 · 按量' : '额度优先';
    this.el.subscriptionStatus.dataset.status = !plan ? 'none' : metered ? 'metered' : 'active';
    this.el.tokensRemaining.classList.toggle('empty', !!plan && game.tokens === 0);
    this.el.usageHint.classList.toggle('blocked', !!quote && quote.costMicros > game.walletMicros);
    this.el.usageHint.textContent = !quote ? '选择订阅后开始 · 主动技能不耗 Token' : quote.costMicros > game.walletMicros
      ? `余额不足一次调用 · ${count(quote.tokens)} Token / 次；移动、技能和拾取仍可用`
      : `${count(quote.tokens)} Token / 次 · ${quote.costMicros ? `下次 ${formatCoins(microsToCoins(quote.costMicros))} 金币${quote.includedTokens ? '（部分按量）' : '（按量）'}` : '消耗本波额度'}`;
    this.renderProtections(this.el.protectionCounts, game.protections, game.wave);
  }

  renderProtections(container, protections = {}, wave) {
    if (!container) return;
    let refs = this._protectionRefs.get(container);
    if (!refs) {
      refs = PROTECTION_ITEMS.map((item) => {
        const chip = document.createElement('span');
        chip.className = 'protectionChip';
        chip.dataset.protection = item.id;
        chip.title = `${item.label} · 虚构游戏道具，持续 ${PROTECTION_DURATION} 波后销毁`;
        const icon = document.createElement('i');
        icon.className = 'protectionIcon'; icon.textContent = item.icon;
        icon.style.setProperty('--protection-color', hex(item.color));
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.className = 'protectionLabel'; label.textContent = item.label;
        const amount = document.createElement('b');
        amount.className = 'protectionCount';
        chip.append(icon, label, amount);
        container.appendChild(chip);
        return { id: item.id, chip, amount, baseTitle: chip.title };
      });
      this._protectionRefs.set(container, refs);
    }
    for (const ref of refs) {
      const arr = protections?.[ref.id];
      const n = Array.isArray(arr) ? arr.length : 0;
      const text = `×${count(n)}`;
      if (ref.amount.textContent !== text) ref.amount.textContent = text;
      const title = n > 0 && Number.isFinite(wave)
        ? `${ref.baseTitle} · 最近一批剩余 ${arr.reduce((a, w) => Math.min(a, w), Infinity) - wave} 波`
        : ref.baseTitle;
      if (ref.chip.title !== title) ref.chip.title = title;
      ref.chip.classList.toggle('held', n > 0);
    }
  }

  stats(wave, kills, score, time) {
    this.el.statWave.textContent = wave;
    this.el.statKills.textContent = kills;
    this.el.statScore.textContent = score;
    const m = Math.floor(time / 60), s = Math.floor(time % 60);
    this.el.statTime.textContent = `${m}:${String(s).padStart(2, '0')}`;
  }

  coins(v) { this.el.statCoins.textContent = formatCoins(v); }

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

  setWeapon(label, planId) {
    if (this.el.weaponName.textContent !== label) this.el.weaponName.textContent = label;
    if (planId && this._gunIconId !== planId) {
      this._gunIconId = planId;
      const x = this.el.gunIcon.getContext('2d');
      x.clearRect(0, 0, 64, 64);
      x.drawImage(weaponIcon(planId), 0, 0);
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
    const panel = this.el.weapons;
    if (on && panel.classList.contains('hidden')) {
      this._weaponReturnFocus = document.activeElement;
      this._weaponNeedsFocus = true;
    }
    panel.classList.toggle('hidden', !on);
    panel.inert = !on;
    if (on) this.el.crosshair.style.display = 'none';
    else {
      this._weaponNeedsFocus = false;
      if (panel.contains(document.activeElement)) document.activeElement.blur();
      const target = this._weaponReturnFocus;
      if (target?.isConnected && target !== document.body && !target.closest('[inert], .hidden')) target.focus({ preventScroll: true });
      this._weaponReturnFocus = null;
    }
  }

  renderWeapons(game) {
    const plan = getPlan(game.planId);
    this.el.weaponCoins.textContent = formatCoins(game.coins);
    $('weaponClose').textContent = plan ? '返回战斗 (B / Esc)' : '回到标题 (Esc)';

    // 付费后仍聚焦同一卡；首次开局只聚焦 DS，绝不自动订阅。
    const focused = document.activeElement?.closest('.weaponCard')?.dataset.plan;
    const grid = this.el.weaponGrid;
    grid.textContent = '';
    const put = (cls, text, tag = 'span') => {
      const el = document.createElement(tag);
      el.className = cls; el.textContent = text;
      return el;
    };
    for (const candidate of Object.values(PLANS)) {
      const subscription = quoteSubscription(candidate.id, game.loadout);
      const usage = quoteUsage(candidate.id, 0, game.loadout);
      const equipped = game.planId === candidate.id;
      const affordable = subscription.feeMicros <= game.walletMicros;
      const rate = formatCoins(microsToCoins(usage.rateMicros * 1000));
      const action = equipped ? '当前订阅' : affordable ? (plan ? '付费切换' : '确认订阅')
        : `还差 ${formatCoins(microsToCoins(subscription.feeMicros - game.walletMicros))} 金币`;
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = `weaponCard${equipped ? ' equipped' : ''}${!affordable && !equipped ? ' cant' : ''}`;
      tile.dataset.plan = candidate.id;
      tile.style.setProperty('--gun-accent', hex(candidate.accent));
      tile.setAttribute('aria-pressed', String(equipped));
      tile.setAttribute('aria-disabled', String(!affordable || equipped));
      tile.setAttribute('aria-label', `${candidate.label}，每波 ${formatCoins(candidate.fee)} 金币，发放 ${count(subscription.quota)} Token，每次调用 ${count(usage.tokens)} Token，超额每千 Token ${rate} 金币。${action}`);
      const art = put('weaponArt', '');
      art.appendChild(weaponIcon(candidate.id));
      const stats = put('weaponStats', '');
      for (const [label, value] of [
        ['每波额度', `${count(subscription.quota)} Token`],
        ['每次调用', `${count(usage.tokens)} Token`],
        ['超额 / 千 Token', `${rate} 金币`],
      ]) {
        const row = put('', '');
        row.append(put('', label), put('', value, 'b'));
        stats.appendChild(row);
      }
      const combat = put('weaponCombat', `伤害 ${candidate.damage}${candidate.pellets > 1 ? ` × ${candidate.pellets}` : ''} · ${candidate.rpm}/分 · ${candidate.range}m`);
      const desc = put('weaponDesc', candidate.desc);
      const foot = put('weaponFoot', '');
      foot.append(put('weaponPrice', `${formatCoins(candidate.fee)} 金币 / 波`), put('weaponAction', action));
      tile.append(art, put('weaponName', candidate.label, 'b'), put('weaponTag', candidate.tag), stats, combat, desc, foot);
      // 不绑定 keydown：只用 button 原生 Space/Enter，避免一次确认重复扣款。
      tile.addEventListener('click', () => game.subscribe(candidate.id));
      tile.addEventListener('mouseenter', () => game.audio.uiHover());
      grid.appendChild(tile);
    }
    this.renderReferences();
    if ((this._weaponNeedsFocus || focused) && !this.el.weapons.inert) {
      const target = grid.querySelector(`[data-plan="${focused || game.planId || 'ds'}"]`);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    this._weaponNeedsFocus = false;
  }

  renderReferences() {
    const details = this.el.weaponReferences;
    if (details.childElementCount) return;
    const summary = document.createElement('summary');
    summary.textContent = '定价与能力参考';
    const note = document.createElement('p');
    note.textContent = 'API 参考价：美元 / 百万 Token，非缓存输入。金币按输入:输出 = 1:3 换算，订阅约省 25%，非真实会员套餐。战斗属性非模型实测，AA 指数非百分制。';
    details.append(summary, note);
    const list = document.createElement('ul');
    for (const plan of Object.values(PLANS)) {
      const row = document.createElement('li');
      const link = document.createElement('a');
      link.href = plan.reference.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = `${plan.label} 定价来源`;
      const description = document.createElement('span');
      description.textContent = ` · ${plan.reference.model} · 输入 $${plan.reference.inputUsd} / 输出 $${plan.reference.outputUsd} · ${plan.reference.scope} · ${plan.reference.date}`;
      row.append(link, description);
      list.appendChild(row);
    }
    const capability = document.createElement('a');
    capability.href = PLANS.ds.reference.capabilityUrl; capability.target = '_blank'; capability.rel = 'noopener noreferrer';
    capability.textContent = `Artificial Analysis 同口径能力参考 · ${PLANS.ds.reference.date}`;
    details.append(list, capability);
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
    const enteringResults = name === 'over' && this.el.over.classList.contains('hidden');
    this.el.start.classList.toggle('hidden', name !== 'start');
    this.el.pause.classList.toggle('hidden', name !== 'pause');
    this.el.over.classList.toggle('hidden', name !== 'over');
    this.el.weapons.classList.add('hidden');
    this.el.card.classList.add('hidden');
    this.el.cardBook.classList.add('hidden');
    for (const [id, el] of [['start', this.el.start], ['pause', this.el.pause], ['over', this.el.over]]) el.inert = name !== id;
    this.el.weapons.inert = this.el.card.inert = this.el.cardBook.inert = true;
    this._weaponNeedsFocus = false;
    // 隐藏层保持 inert；离开开局选择时返回可见的标题按钮，不遗留不可见焦点。
    if (document.activeElement?.closest('.overlay.hidden')) document.activeElement.blur();
    if (name === null && document.activeElement !== document.body) document.activeElement?.blur();
    if (name === 'start') $('startBtn').focus({ preventScroll: true });
    else if (name === 'pause') $('resumeBtn').focus({ preventScroll: true });
    else if (enteringResults) $('retryBtn').focus({ preventScroll: true });
  }

  results({ wave, kills, score, acc, time = 0, coins = 0, best = 0, isRecord = false, reason = 'combat', provider, providerLabel, calls = 0, tokensUsed = 0 }) {
    this.el.resWave.textContent = wave;
    this.el.resKills.textContent = kills;
    this.el.resScore.textContent = score;
    this.el.resAcc.textContent = Math.round(acc * 100) + '%';
    const m = Math.floor(time / 60), s = Math.floor(time % 60);
    this.el.resTime.textContent = `${m}:${String(s).padStart(2, '0')}`;
    this.el.resCoins.textContent = formatCoins(coins);
    this.el.resBest.textContent = best;
    this.el.resCalls.textContent = count(calls);
    this.el.resTokensUsed.textContent = count(tokensUsed);
    const banned = reason === 'ban';
    const label = providerLabel || getPlan(provider)?.label || '当前计划';
    this.el.over.dataset.reason = banned ? 'ban' : 'combat';
    this.el.overTitle.textContent = banned ? '鸭鸭已被封号' : '鸭鸭倒下了';
    this.el.overSub.textContent = banned ? `${label} 账号已被平台封禁` : '农场失守…但羽毛仍在风中飘扬';
    this.el.overReason.textContent = banned
      ? `死亡原因：${label} 触发平台风控被封号，护盾和免死无法抵挡。`
      : '死亡原因：战斗阵亡。额度用完后还可以按量继续守卫。';
    this.el.overReason.classList.toggle('ban', banned);
    this.el.recordBadge.classList.toggle('hidden', !isRecord);
  }

  fps(v, show) {
    this.el.fps.style.display = show ? 'block' : 'none';
    if (show) this.el.fps.textContent = `${v} FPS`;
  }
}