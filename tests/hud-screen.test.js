import { afterEach, describe, expect, it, vi } from 'vitest';
import { HUD } from '../src/hud.js';

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
