import { getPlan, PROTECTION_ITEMS, MICROCOINS_PER_COIN } from '../src/subscriptions.js';

export function createPromoActions({ evaluate, clickSel, key, sleep }) {
  // 通过可见按钮走真实 subscribe() 交易；不直接改计划、额度或保护物品。
  async function choosePlan(id, { close = true } = {}) {
    const plan = getPlan(id);
    if (!plan) throw new Error('Unknown showcase plan: ' + id);
    const before = await evaluate(`(() => { const g = window.__game;
      // 战斗无敌不保护虚构封号；录制使用独立 RNG 排除意外终局。
      g.banRng = () => 1;
      if (g.state === 'playing') g.openWeapons();
      if (g.state !== 'weapons') throw new Error('Cannot select plan from ' + g.state);
      return { planId: g.planId, walletMicros: g.walletMicros, tokens: g.tokens }; })()`);
    const changed = before.planId !== id;
    if (changed) await clickSel(`#weaponGrid .weaponCard[data-plan="${id}"]`);
    const after = await evaluate(`(() => { const g = window.__game; return {
      state: g.state, planId: g.planId, walletMicros: g.walletMicros,
      tokens: g.tokens, quotaGranted: g.quotaGranted }; })()`);
    if (after.planId !== id
      || after.walletMicros !== before.walletMicros - (changed ? plan.fee * MICROCOINS_PER_COIN : 0)
      || (changed ? after.quotaGranted < 1 || after.tokens !== after.quotaGranted : after.tokens !== before.tokens)
      || after.state !== (changed && before.planId === null ? 'playing' : 'weapons')) {
      throw new Error('Visible paid subscription failed: ' + id + ' ' + JSON.stringify({ before, after }));
    }
    // 当前计划不重复点击 / 补额度；首次确认自动关闭，后续切换按分镜决定是否关闭。
    if (close) await evaluate(`(() => { const g = window.__game;
      if (g.state === 'weapons') g.closeWeapons();
      if (g.state !== 'playing') throw new Error('Plan confirmation did not enter play');
      return 1; })()`);
    return after;
  }

  async function collectProtections() {
    for (const [i, item] of PROTECTION_ITEMS.entries()) {
      const direction = i % 2 === 0 ? 1 : -1;
      const before = await evaluate(`(() => { const g = window.__game;
        g.p.vel.set(0, 0, 0);
        const pos = g.p.pos.clone();
        pos.x += ${direction} * Math.max(3, 1.1 * (g.loadout.mods.magnet?.mul || 1) * 2.6 + 0.8);
        g.spawnPickup(pos, 'protection', '${item.id}');
        return { stacks: g.protections['${item.id}'].length, walletMicros: g.walletMicros }; })()`);
      await sleep(1200);
      const code = direction > 0 ? 'KeyD' : 'KeyA', vk = direction > 0 ? 68 : 65;
      let collected = false;
      await key(code, vk, true);
      try {
        for (let j = 0; j < 40; j++) {
          await sleep(100);
          collected = await evaluate(`(() => { const g = window.__game;
            return !g.pickups.some(p => p.kind === 'protection' && p.item === '${item.id}')
              && g.protections['${item.id}'].length === ${before.stacks + 1}
              && g.walletMicros === ${before.walletMicros}; })()`);
          if (collected) break;
        }
      } finally { await key(code, vk, false); }
      if (!collected) throw new Error('Protection pickup failed: ' + item.id);
      await sleep(650);
    }
  }

  return { choosePlan, collectProtections };
}
