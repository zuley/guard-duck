import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { createPromoActions } from '../scripts/promo-automation.mjs';
import { PLANS, PROTECTION_ITEMS, MICROCOINS_PER_COIN } from '../src/subscriptions.js';

const ACTIVE_PLAN = { state: 'playing', planId: 'ds', tokens: 57, quotaGranted: PLANS.ds.quota };

function planHarness({ initial = {}, afterClick } = {}) {
  const events = [];
  const game = {
    state: 'weapons', planId: null, walletMicros: 1000 * MICROCOINS_PER_COIN,
    tokens: 0, quotaGranted: 0, rng: vi.fn(() => 0.25), banRng: vi.fn(() => 0),
    ...initial,
  };
  game.openWeapons = vi.fn(() => { events.push('openWeapons'); game.state = 'weapons'; });
  game.closeWeapons = vi.fn(() => { events.push('closeWeapons'); game.state = 'playing'; });
  const context = createContext({ window: { __game: game } });
  const ops = {
    evaluate: vi.fn(async (expression) => {
      events.push('evaluate');
      return runInContext(expression, context);
    }),
    clickSel: vi.fn(async (selector) => {
      events.push('clickSel');
      const id = /^#weaponGrid \.weaponCard\[data-plan="([^"]+)"\]$/.exec(selector)?.[1];
      if (!PLANS[id]) throw new Error('Unexpected plan selector: ' + selector);
      const first = game.planId === null;
      game.walletMicros -= PLANS[id].fee * MICROCOINS_PER_COIN;
      game.planId = id;
      // 模拟强化卡增加额度；不能拿静态基础 quota 校验真实授予量。
      game.quotaGranted = Math.floor(PLANS[id].quota * 1.5);
      game.tokens = game.quotaGranted;
      game.state = first ? 'playing' : 'weapons';
      afterClick?.(game);
    }),
    key: vi.fn(),
    sleep: vi.fn(async () => {}),
  };
  return { game, ops, events, ...createPromoActions(ops) };
}

function collectPickup(game, pickup) {
  game.pickups = game.pickups.filter((p) => p !== pickup);
  game.protections[pickup.item]++;
}

function pickupHarness({ magnet, onPoll = (game, pickup, poll) => {
  if (poll === 2) collectPickup(game, pickup);
} } = {}) {
  const events = [];
  let held = null, current, polls = 0;
  const game = {
    walletMicros: 123 * MICROCOINS_PER_COIN,
    protections: Object.fromEntries(PROTECTION_ITEMS.map(({ id }, i) => [id, i + 1])),
    pickups: [],
    loadout: { mods: magnet === undefined ? {} : { magnet: { mul: magnet } } },
    p: {
      pos: { x: 10, y: 2, z: -4, clone() { return { x: this.x, y: this.y, z: this.z }; } },
      vel: { set: vi.fn((...args) => { events.push(['velocity', ...args]); }) },
    },
  };
  game.spawnPickup = vi.fn((pos, kind, item) => {
    current = { pos, kind, item };
    polls = 0;
    game.pickups.push(current);
    events.push(['spawn', item, pos.x]);
  });
  const context = createContext({ window: { __game: game } });
  const ops = {
    evaluate: vi.fn(async (expression) => {
      if (held) {
        events.push(['poll', current.item, ++polls]);
        onPoll(game, current, polls);
      }
      return runInContext(expression, context);
    }),
    clickSel: vi.fn(),
    key: vi.fn(async (code, vk, down) => {
      events.push(['key', code, vk, down]);
      held = down ? code : null;
    }),
    sleep: vi.fn(async (ms) => { events.push(['sleep', ms]); }),
  };
  return { game, ops, events, held: () => held, ...createPromoActions(ops) };
}

describe('createPromoActions', () => {
  it('can be imported without a recorder and creates actions without invoking any dependency', () => {
    const ops = Object.fromEntries(['evaluate', 'clickSel', 'key', 'sleep'].map((name) => [name, vi.fn(() => {
      throw new Error('Factory invoked ' + name);
    })]));
    const actions = createPromoActions(ops);
    expect(Object.keys(actions)).toEqual(['choosePlan', 'collectProtections']);
    for (const action of Object.values(actions)) expect(action).toBeTypeOf('function');
    for (const op of Object.values(ops)) expect(op).not.toHaveBeenCalled();
  });
});

describe('choosePlan', () => {
  it.each([true, false])('pays the first fee through clickSel and accepts modified quota, close=%s', async (close) => {
    const h = planHarness();
    const rng = h.game.rng, oldBanRng = h.game.banRng;
    const wallet = h.game.walletMicros;
    const after = await h.choosePlan('ds', { close });
    expect(h.ops.clickSel).toHaveBeenCalledExactlyOnceWith('#weaponGrid .weaponCard[data-plan="ds"]');
    expect(after).toEqual({
      state: 'playing', planId: 'ds', walletMicros: wallet - PLANS.ds.fee * MICROCOINS_PER_COIN,
      tokens: PLANS.ds.quota * 1.5, quotaGranted: PLANS.ds.quota * 1.5,
    });
    expect(h.game.state).toBe('playing');
    expect(h.game.openWeapons).not.toHaveBeenCalled();
    expect(h.game.closeWeapons).not.toHaveBeenCalled();
    expect(h.events).toEqual(['evaluate', 'clickSel', 'evaluate', ...(close ? ['evaluate'] : [])]);
    expect(h.game.rng).toBe(rng);
    expect(rng).not.toHaveBeenCalled();
    expect(h.game.banRng).not.toBe(oldBanRng);
    expect(h.game.banRng()).toBe(1);
    expect(oldBanRng).not.toHaveBeenCalled();
  });

  it.each([true, false])('switches for the full fee and returns the pre-close snapshot, close=%s', async (close) => {
    const h = planHarness({ initial: ACTIVE_PLAN });
    const wallet = h.game.walletMicros;
    const after = await h.choosePlan('claude', { close });
    expect(h.ops.clickSel).toHaveBeenCalledExactlyOnceWith('#weaponGrid .weaponCard[data-plan="claude"]');
    expect(after).toMatchObject({
      state: 'weapons', planId: 'claude', walletMicros: wallet - PLANS.claude.fee * MICROCOINS_PER_COIN,
      tokens: PLANS.claude.quota * 1.5, quotaGranted: PLANS.claude.quota * 1.5,
    });
    expect(h.game.state).toBe(close ? 'playing' : 'weapons');
    expect(h.events).toEqual([
      'evaluate', 'openWeapons', 'clickSel', 'evaluate', ...(close ? ['evaluate', 'closeWeapons'] : []),
    ]);
  });

  it.each([undefined, { close: false }, { close: true }])('does not click, charge, or refill the current plan (%j)', async (options) => {
    const h = planHarness({ initial: ACTIVE_PLAN });
    const wallet = h.game.walletMicros;
    const after = await h.choosePlan('ds', options);
    expect(h.ops.clickSel).not.toHaveBeenCalled();
    expect(after).toEqual({ ...ACTIVE_PLAN, state: 'weapons', walletMicros: wallet });
    expect(h.game.tokens).toBe(ACTIVE_PLAN.tokens);
    expect(h.game.walletMicros).toBe(wallet);
    expect(h.game.closeWeapons).toHaveBeenCalledTimes(options?.close === false ? 0 : 1);
    expect(h.game.state).toBe(options?.close === false ? 'weapons' : 'playing');
    expect(h.game.banRng()).toBe(1);
  });

  it.each([
    ['wrong plan', (g) => { g.planId = 'gpt'; }],
    ['incorrect microcoin charge', (g) => { g.walletMicros++; }],
    ['refunded previous fee', (g) => { g.walletMicros += PLANS.ds.fee * MICROCOINS_PER_COIN; }],
    ['empty grant', (g) => { g.quotaGranted = g.tokens = 0; }],
    ['tokens unequal to grant', (g) => { g.tokens--; }],
    ['unexpected auto-close on switch', (g) => { g.state = 'playing'; }],
  ])('rejects a subscription with %s before closing', async (_name, afterClick) => {
    const h = planHarness({ initial: ACTIVE_PLAN, afterClick });
    await expect(h.choosePlan('claude')).rejects.toThrow('Visible paid subscription failed: claude');
    expect(h.game.closeWeapons).not.toHaveBeenCalled();
  });

  it('requires the first subscription to auto-close even when close is false', async () => {
    const h = planHarness({ afterClick: (g) => { g.state = 'weapons'; } });
    await expect(h.choosePlan('ds', { close: false })).rejects.toThrow('Visible paid subscription failed: ds');
  });

  it.each([
    ['refilled tokens', { tokens: ACTIVE_PLAN.tokens + 1 }],
    ['changed wallet', { walletMicros: 1000 * MICROCOINS_PER_COIN - 1 }],
    ['unexpected state', { state: 'playing' }],
  ])('rejects same-plan %s', async (_name, invalidAfter) => {
    const h = planHarness({ initial: ACTIVE_PLAN });
    const snapshot = { ...ACTIVE_PLAN, walletMicros: h.game.walletMicros };
    h.ops.evaluate.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({
      ...snapshot, state: 'weapons', ...invalidAfter,
    });
    await expect(h.choosePlan('ds')).rejects.toThrow('Visible paid subscription failed: ds');
    expect(h.ops.clickSel).not.toHaveBeenCalled();
    expect(h.game.closeWeapons).not.toHaveBeenCalled();
  });

  it('propagates visible/enabled click validation failures without closing or charging', async () => {
    const h = planHarness({ initial: ACTIVE_PLAN });
    const error = new Error('visible, enabled element not found');
    h.ops.clickSel.mockRejectedValueOnce(error);
    await expect(h.choosePlan('claude')).rejects.toBe(error);
    expect(h.game.walletMicros).toBe(1000 * MICROCOINS_PER_COIN);
    expect(h.game.closeWeapons).not.toHaveBeenCalled();
  });

  it('rejects a confirmation that fails to enter play', async () => {
    const h = planHarness({ initial: ACTIVE_PLAN });
    h.game.closeWeapons.mockImplementation(() => {});
    await expect(h.choosePlan('claude')).rejects.toThrow('Plan confirmation did not enter play');
  });

  it.each([
    'missing', '', 'toString', 'constructor', '__proto__', undefined, null, 0, false, {}, [],
  ].map((id) => ({ id })))('rejects unknown/prototype/nonstring plan $id before any browser operation', async ({ id }) => {
    const h = planHarness();
    await expect(h.choosePlan(id)).rejects.toThrow('Unknown showcase plan: ' + id);
    for (const op of Object.values(h.ops)) expect(op).not.toHaveBeenCalled();
  });

  it('rejects an unsupported game state without clicking', async () => {
    const h = planHarness({ initial: { state: 'paused' } });
    await expect(h.choosePlan('ds')).rejects.toThrow('Cannot select plan from paused');
    expect(h.ops.clickSel).not.toHaveBeenCalled();
  });
});

describe('collectProtections', () => {
  it.each([undefined, 3])('collects in item order with alternating movement and magnet=%s', async (magnet) => {
    const h = pickupHarness({ magnet });
    const wallet = h.game.walletMicros;
    const stacks = { ...h.game.protections };
    await h.collectProtections();
    const offset = Math.max(3, 1.1 * (magnet || 1) * 2.6 + 0.8);
    const expected = PROTECTION_ITEMS.flatMap(({ id }, i) => {
      const direction = i % 2 === 0 ? 1 : -1;
      const code = direction > 0 ? 'KeyD' : 'KeyA', vk = direction > 0 ? 68 : 65;
      expect(h.game.spawnPickup.mock.calls[i]).toEqual([
        { x: 10 + direction * offset, y: 2, z: -4 }, 'protection', id,
      ]);
      expect(h.game.protections[id]).toBe(stacks[id] + 1);
      return [
        ['velocity', 0, 0, 0], ['spawn', id, 10 + direction * offset], ['sleep', 1200],
        ['key', code, vk, true], ['sleep', 100], ['poll', id, 1],
        ['sleep', 100], ['poll', id, 2], ['key', code, vk, false], ['sleep', 650],
      ];
    });
    expect(h.events).toEqual(expected);
    expect(h.game.spawnPickup).toHaveBeenCalledTimes(PROTECTION_ITEMS.length);
    expect(h.game.p.vel.set).toHaveBeenCalledTimes(PROTECTION_ITEMS.length);
    expect(h.game.pickups).toEqual([]);
    expect(h.game.walletMicros).toBe(wallet);
    expect(h.ops.clickSel).not.toHaveBeenCalled();
    expect(h.held()).toBeNull();
  });

  it.each([
    ['pickup still present', (g, pickup) => { g.protections[pickup.item]++; }],
    ['no stack added', (g) => { g.pickups = []; }],
    ['two stacks added', (g, pickup) => { collectPickup(g, pickup); g.protections[pickup.item]++; }],
    ['wallet changed', (g, pickup) => { collectPickup(g, pickup); g.walletMicros++; }],
  ])('times out after 40 polls with %s and releases movement before throwing', async (_name, mutate) => {
    const h = pickupHarness({ onPoll: (g, pickup, poll) => { if (poll === 1) mutate(g, pickup); } });
    await expect(h.collectProtections()).rejects.toThrow('Protection pickup failed: ' + PROTECTION_ITEMS[0].id);
    expect(h.game.spawnPickup).toHaveBeenCalledTimes(1);
    expect(h.events.filter(([type]) => type === 'poll')).toHaveLength(40);
    expect(h.ops.sleep.mock.calls).toEqual([[1200], ...Array.from({ length: 40 }, () => [100])]);
    expect(h.ops.key.mock.calls).toEqual([['KeyD', 68, true], ['KeyD', 68, false]]);
    expect(h.events.slice(0, 4)).toEqual([
      ['velocity', 0, 0, 0], ['spawn', PROTECTION_ITEMS[0].id, 13.66], ['sleep', 1200], ['key', 'KeyD', 68, true],
    ]);
    expect(h.events.at(-1)).toEqual(['key', 'KeyD', 68, false]);
    expect(h.held()).toBeNull();
  });

  it('releases movement immediately after a polling exception and preserves the exception', async () => {
    const error = new Error('poll failed');
    const h = pickupHarness({ onPoll: (_g, _pickup, poll) => { if (poll === 2) throw error; } });
    await expect(h.collectProtections()).rejects.toBe(error);
    expect(h.events.slice(-3)).toEqual([
      ['sleep', 100], ['poll', PROTECTION_ITEMS[0].id, 2], ['key', 'KeyD', 68, false],
    ]);
    expect(h.ops.key.mock.calls).toEqual([['KeyD', 68, true], ['KeyD', 68, false]]);
    expect(h.ops.sleep).not.toHaveBeenCalledWith(650);
    expect(h.held()).toBeNull();
  });

  it('also releases movement if the polling sleep rejects', async () => {
    const error = new Error('sleep failed');
    const h = pickupHarness();
    h.ops.sleep.mockImplementation(async (ms) => {
      h.events.push(['sleep', ms]);
      if (ms === 100) throw error;
    });
    await expect(h.collectProtections()).rejects.toBe(error);
    expect(h.events.slice(-3)).toEqual([
      ['key', 'KeyD', 68, true], ['sleep', 100], ['key', 'KeyD', 68, false],
    ]);
    expect(h.ops.evaluate).toHaveBeenCalledTimes(1);
    expect(h.held()).toBeNull();
  });
});
