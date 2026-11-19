import { afterEach, describe, expect, it, vi } from 'vitest';
import { HUD } from '../src/hud.js';
import { PROTECTION_DURATION } from '../src/subscriptions.js';

// 只模拟 screen() 所需的可见性/焦点 API；原生按键激活另由浏览器回归验证。
function screenHarness() {
  const elements = new Map();
  const doc = { activeElement: null, body: null, getElementById: (id) => elements.get(id) };
  function element(id, parent = null, overlay = false, hidden = false) {
    const classes = new Set([...(overlay ? ['overlay'] : []), ...(hidden ? ['hidden'] : [])]);
    const el = {
      id, parent, inert: hidden,
      classList: {
        contains: (name) => classes.has(name),
        add: (...names) => names.forEach((name) => classes.add(name)),
        toggle(name, force) {
          const on = force === undefined ? !classes.has(name) : force;
          if (on) classes.add(name); else classes.delete(name);
          return on;
        },
      },
      closest() {
        for (let node = this; node; node = node.parent) {
          if (node.classList.contains('overlay') && node.classList.contains('hidden')) return node;
        }
        return null;
      },
      focus: vi.fn(() => { doc.activeElement = el; }),
      blur: vi.fn(() => { if (doc.activeElement === el) doc.activeElement = doc.body; }),
    };
    elements.set(id, el);
    return el;
  }
  doc.body = element('body'); doc.activeElement = doc.body;
  const hud = Object.create(HUD.prototype);
  hud.el = Object.fromEntries(['start', 'pause', 'over', 'weapons', 'card', 'cardBook'].map((name) => [
    name, element(name, null, true, name !== 'start'),
  ]));
  const start = element('startBtn', hud.el.start);
  const resume = element('resumeBtn', hud.el.pause);
  const retry = element('retryBtn', hud.el.over);
  const title = element('titleBtn', hud.el.over);
  vi.stubGlobal('document', doc);
  return { hud, doc, start, resume, retry, title };
}

afterEach(() => vi.unstubAllGlobals());

describe('结算层只在进入时自动聚焦', () => {
  it('首次显示聚焦重开，重复显示保留玩家选中的回标题按钮', () => {
    const { hud, doc, retry, title } = screenHarness();
    hud.screen('over');
    expect(doc.activeElement).toBe(retry);
    expect(retry.focus).toHaveBeenCalledTimes(1);
    title.focus();
    hud.screen('over'); hud.screen('over');
    expect(doc.activeElement).toBe(title);
    expect(retry.focus).toHaveBeenCalledTimes(1);
    expect(title.blur).not.toHaveBeenCalled();
  });

  it('离开隐藏层清理焦点，下一次结算会重新获得初始焦点', () => {
    const { hud, doc, retry, title } = screenHarness();
    hud.screen('over'); title.focus();
    hud.screen(null);
    expect(doc.activeElement).toBe(doc.body);
    expect(title.blur).toHaveBeenCalledTimes(1);
    expect(hud.el.over.inert).toBe(true);
    hud.screen('over');
    expect(doc.activeElement).toBe(retry);
    expect(retry.focus).toHaveBeenCalledTimes(2);
  });

  it('显示结算时仅该层可交互，隐藏菜单保持 inert', () => {
    const { hud } = screenHarness();
    hud.screen('over');
    for (const [name, panel] of Object.entries(hud.el)) {
      expect(panel.classList.contains('hidden')).toBe(name !== 'over');
      expect(panel.inert).toBe(name !== 'over');
    }
  });

  it('保留标题和暂停的初始焦点及离开菜单时的清理', () => {
    const { hud, doc, start, resume } = screenHarness();
    hud.screen('start'); expect(doc.activeElement).toBe(start);
    hud.screen('pause'); expect(doc.activeElement).toBe(resume);
    hud.screen(null); expect(doc.activeElement).toBe(doc.body);
  });
});

function protectionHarness() {
  const makeEl = (tag) => {
    const classes = new Set();
    const el = {
      tag, children: [], className: '', title: '', textContent: '', dataset: {},
      style: { setProperty: vi.fn() },
      classList: {
        contains: (name) => classes.has(name),
        toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); return on; },
      },
      setAttribute: vi.fn(),
      appendChild: (child) => { el.children.push(child); return child; },
      append: (...kids) => { el.children.push(...kids); },
    };
    return el;
  };
  vi.stubGlobal('document', { createElement: makeEl });
  const hud = Object.create(HUD.prototype);
  hud._protectionRefs = new Map();
  return { hud, container: makeEl('div') };
}

describe('保护芯片提示持续与剩余波次', () => {
  const chipOf = (container, id) => container.children.find((c) => c.dataset.protection === id);

  it('title 用持续常量，并按最近到期批次展示剩余波次', () => {
    const { hud, container } = protectionHarness();
    hud.renderProtections(container, { us_phone: [6, 9] }, 1);
    const chip = chipOf(container, 'us_phone');
    expect(chip.title).toContain(`持续 ${PROTECTION_DURATION} 波后销毁`);
    expect(chip.title).toContain('最近一批剩余 5 波');
    expect(chip.children.at(-1).textContent).toBe('×2');
    expect(chip.classList.contains('held')).toBe(true);
    hud.renderProtections(container, { us_phone: [6, 9] }, 4);
    expect(chip.title).toContain('最近一批剩余 2 波');
  });

  it('未持有、旧数值格式或缺少波次时回退基础提示', () => {
    const { hud, container } = protectionHarness();
    hud.renderProtections(container, { us_phone: 3 });
    const chip = chipOf(container, 'us_phone');
    expect(chip.title).not.toContain('剩余');
    expect(chip.children.at(-1).textContent).toBe('×0');
    expect(chip.classList.contains('held')).toBe(false);
    hud.renderProtections(container, { us_phone: [9] });
    expect(chip.title).not.toContain('剩余');
    expect(chip.children.at(-1).textContent).toBe('×1');
  });
});

it('强化图鉴随当前武器显示多重射击和穿甲特例', () => {
  const { hud, container } = protectionHarness();
  hud.el = { cardBookCount: {}, cardBookGrid: container };
  hud.cardArt = vi.fn(() => ({}));
  const game = { planId: 'qwen', cards: { g_multishot: 1, r_pierce: 1 }, cardHistory: ['g_multishot', 'r_pierce'] };
  const descriptions = () => container.children.map(c => c.children[1].children[2].textContent);
  hud.renderCardBook(game);
  expect(descriptions()).toEqual([expect.stringContaining('固定发射一条'), expect.stringContaining('自带连续穿透')]);
  container.children.length = 0;
  game.planId = 'claude';
  hud.renderCardBook(game);
  expect(descriptions()).toEqual([expect.stringContaining('额外发射 1 发'), expect.stringContaining('导弹命中后引爆')]);
  container.children.length = 0;
  game.planId = 'gpt';
  hud.renderCardBook(game);
  expect(descriptions()).toEqual([expect.stringContaining('额外发射 1 发'), expect.stringContaining('穿透 1 个敌人')]);
});

describe('HUD 脏检查缓存（Dirty-Checking）', () => {
  it('相同数值重复调用 hp / dash / stats / coins / remain / shield 不重复触发 DOM 写入', () => {
    const writes = { hpW: 0, hpTxt: 0, dashW: 0, wave: 0, kills: 0, score: 0, time: 0, coins: 0, remain: 0, shW: 0 };
    const tracked = (key) => {
      let val = '', styleW = '';
      return {
        get textContent() { return val; },
        set textContent(v) { writes[key]++; val = String(v); },
        style: {
          get width() { return styleW; },
          set width(v) { writes[key]++; styleW = v; },
        },
        classList: { toggle: vi.fn() },
      };
    };
    const hud = Object.create(HUD.prototype);
    hud._cache = {};
    hud.el = {
      hpFill: tracked('hpW'), hpText: tracked('hpTxt'), low: { classList: { toggle: vi.fn() } },
      dashFill: tracked('dashW'),
      statWave: tracked('wave'), statKills: tracked('kills'), statScore: tracked('score'), statTime: tracked('time'),
      statCoins: tracked('coins'), statRemain: tracked('remain'),
      shieldBar: { classList: { toggle: vi.fn() } }, shieldFill: tracked('shW'),
    };

    for (let i = 0; i < 10; i++) {
      hud.hp(85, 100);
      hud.dash(0.5);
      hud.stats(2, 14, 1600, 45.2 + i * 0.05); // 同一秒内
      hud.coins(165);
      hud.remain(7);
      hud.shield(40, 80, 3);
    }
    expect(writes).toEqual({
      hpW: 1, hpTxt: 1, dashW: 1, wave: 1, kills: 1, score: 1, time: 1, coins: 1, remain: 1, shW: 1,
    });

    // 数值变化时才触发第二次写入
    hud.hp(70, 100);
    hud.coins(150);
    hud.stats(2, 15, 1700, 46.1);
    expect(writes.hpW).toBe(2);
    expect(writes.hpTxt).toBe(2);
    expect(writes.coins).toBe(2);
    expect(writes.kills).toBe(2);
    expect(writes.time).toBe(2);
  });
});
