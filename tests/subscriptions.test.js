import { describe, expect, it, vi } from 'vitest';
import {
  PLANS, PLAN_IDS, REFERENCE_DATE, MICROCOINS_PER_COIN, TOKENS_PER_CALL,
  STARTING_COINS, getPlan, pricingFromReference, coinsToMicros, microsToCoins,
  formatCoins, quoteSubscription, quoteUsage, settleInvocation,
  PROTECTION_ITEMS, getProtection, protectionStacks, banChance, rollProtection,
} from '../src/subscriptions.js';
import { computeLoadout, applyCards, cardEffects } from '../src/rules.js';

const prices = [
  ['claude', 150, 1250, 160, 160000],
  ['gpt', 60, 1000, 80, 80000],
  ['qwen', 45, 1200, 50, 50000],
  ['glm', 44, 1600, 36.5, 36500],
  ['ds', 15, 2000, 9.75, 9750],
];

describe('五计划与有日期的独立参考', () => {
  it('只有五个可订阅 ID，初始预算不是永久免费武器', () => {
    expect(PLAN_IDS).toEqual(['claude', 'gpt', 'qwen', 'glm', 'ds']);
    expect(STARTING_COINS).toBe(180);
    expect(TOKENS_PER_CALL).toBe(32);
    expect(Object.isFrozen(PLANS)).toBe(true);
    expect(getPlan('codex')).toBeNull();
  });

  it.each(prices)('%s 的统一公式给出准确费用/额度/微金币单价', (id, fee, quota, coinsPerK, rate) => {
    const plan = getPlan(id);
    expect(plan).toMatchObject({ id, fee, quota, coinsPerK, tokenPriceMicros: rate, tokensPerCall: id === 'claude' ? 100 : 32 });
    expect(pricingFromReference(plan.reference.inputUsd, plan.reference.outputUsd, quota)).toMatchObject({ fee, coinsPerK, tokenPriceMicros: rate });
    expect(quoteSubscription(id)).toEqual({ feeMicros: fee * MICROCOINS_PER_COIN, quota });
    expect(plan.reference.date).toBe(REFERENCE_DATE);
    expect(plan.reference.url.startsWith('https://')).toBe(true);
    expect(plan.reference.capabilityUrl).toContain('artificialanalysis.ai');
    expect(plan.reference.score).toBeGreaterThan(0);
    expect(Object.isFrozen(plan.reference)).toBe(true);
    expect(plan.fee).toBeGreaterThan(0);
  });

  it('价格口径保留地区、短上下文、峰时限定，不假装聊天会员包含 API 额度', () => {
    expect(PLANS.gpt.reference.scope).toContain('短上下文');
    expect(PLANS.qwen.reference.scope).toContain('International');
    expect(PLANS.ds.reference.scope).toContain('峰时');
    expect(PLANS.ds.reference.scope).toContain('半价');
  });

  it('所有订阅/调用入口拒绝未知与原型属性 ID', () => {
    for (const id of [undefined, null, '', 'Codex', 'missing', 'toString', 'constructor', '__proto__', {}, []]) {
      expect(getPlan(id)).toBeNull();
      expect(quoteSubscription(id)).toBeNull();
      expect(quoteUsage(id, 100)).toBeNull();
      expect(settleInvocation(1e9, 100, id)).toBeNull();
    }
  });

  it('畸形/溢出参考价格不生成可交易报价', () => {
    for (const args of [[-1, 1, 1000], [1, NaN, 1000], [Infinity, 1, 1000], ['4', 20, 1000], [4, 20, 0], [4, 20, 1.5], [1e308, 1e308, 1000]]) {
      expect(pricingFromReference(...args)).toBeNull();
    }
  });
});

describe('整数微金币与原子 Token 报价', () => {
  it('金币转换保留小额精度，显示不会把有效小额余额藏成 0', () => {
    expect(MICROCOINS_PER_COIN).toBe(1_000_000);
    for (const coins of [0, 0.000001, 0.312, 1.168, 5.12, 180]) expect(microsToCoins(coinsToMicros(coins))).toBe(coins);
    expect(formatCoins(0.312)).toBe('0.312');
    expect(formatCoins(0.000001)).toBe('0.000001');
    for (const value of [0, 0.025, 0.254475, 4.96, 1000, 1234567.123456, '180']) {
      expect(formatCoins(value)).toBe(Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 6 }));
    }
    for (const invalid of [-1, NaN, Infinity, '1', undefined, Number.MAX_SAFE_INTEGER]) expect(() => coinsToMicros(invalid)).toThrow();
    for (const invalid of [-1, NaN, Infinity, 0.1, '1', Number.MAX_SAFE_INTEGER + 1]) expect(() => microsToCoins(invalid)).toThrow();
  });

  it.each(prices)('%s 全额度内一次调用只用套餐 Token，不花钱包金币', (id) => {
    const tpc = PLANS[id].tokensPerCall;
    expect(settleInvocation(0, 100, id)).toMatchObject({
      tokens: tpc, includedTokens: tpc, meteredTokens: 0, costMicros: 0,
      walletMicros: 0, remainingTokens: 100 - tpc,
    });
  });

  it.each(prices)('%s 超额/混合部分逐 Token 精确计价', (id, _fee, _quota, _coinsPerK, rate) => {
    const tpc = PLANS[id].tokensPerCall;
    expect(quoteUsage(id, 0)).toMatchObject({ tokens: tpc, includedTokens: 0, meteredTokens: tpc, costMicros: tpc * rate });
    const charged = settleInvocation(tpc * rate, 20, id);
    expect(charged).toMatchObject({ includedTokens: 20, meteredTokens: tpc - 20, costMicros: (tpc - 20) * rate, walletMicros: 20 * rate, remainingTokens: 0 });
    expect(settleInvocation((tpc - 20) * rate - 1, 20, id)).toBeNull();
  });

  it('余额与部分额度凑不够时整笔拒绝，原输入状态不变', () => {
    const state = Object.freeze({ walletMicros: 116999, tokens: 20 });
    expect(settleInvocation(state.walletMicros, state.tokens, 'ds')).toBeNull();
    expect(state).toEqual({ walletMicros: 116999, tokens: 20 });
    expect(settleInvocation(117000, 20, 'ds')).toMatchObject({ walletMicros: 0, remainingTokens: 0, costMicros: 117000 });
  });

  it('一万次 DS 按量调用精确扣完3120金币，无累计浮点欠费', () => {
    let balance = coinsToMicros(3120);
    for (let i = 0; i < 10000; i++) {
      const paid = settleInvocation(balance, 0, 'ds');
      expect(paid).not.toBeNull();
      balance = paid.walletMicros;
    }
    expect(balance).toBe(0);
    expect(settleInvocation(balance, 0, 'ds')).toBeNull();
  });

  it('拒绝负数/小数额度、畸形余额和非法倍率', () => {
    for (const bad of [-1, 0.5, NaN, Infinity, '32', Number.MAX_SAFE_INTEGER + 1]) {
      expect(quoteUsage('ds', bad)).toBeNull();
      expect(settleInvocation(bad, 100, 'ds')).toBeNull();
    }
    for (const bad of [0, -1, NaN, Infinity, '0.9']) {
      expect(quoteUsage('ds', 100, { tokenCostMul: bad })).toBeNull();
      expect(quoteUsage('ds', 100, { meteredCostMul: bad })).toBeNull();
      expect(quoteSubscription('ds', { quotaMul: bad })).toBeNull();
    }
    expect(quoteUsage('ds', 0, { tokenCostMul: 1e308 })).toBeNull();
    expect(quoteSubscription('ds', { quotaMul: 1e308 })).toBeNull();
  });

  it('四张经济卡分别控制用量/下次额度/按量折扣/返现，无弹药属性', () => {
    for (let n = 0; n <= 3; n++) {
      const lo = applyCards(computeLoadout('ds'), cardEffects({ c_reload: n, c_mag: n, c_ammo: n }));
      expect(quoteUsage('ds', 0, lo).tokens).toBe([32, 29, 26, 23][n]);
      expect(quoteUsage('ds', 0, lo).rateMicros).toBe([9750, 8775, 7800, 6825][n]);
      expect(quoteSubscription('ds', lo)).toEqual({ quota: 2000 + 500 * n, feeMicros: 15_000_000 });
      for (const old of ['magSize', 'reloadTime', 'ammoPickupMul']) expect(lo).not.toHaveProperty(old);
    }
    expect(quoteUsage('ds', 100, { tokenCostMul: 0.000001 }).tokens).toBe(1);
    expect(cardEffects({ r_ammoBack: 2 }).mods).toHaveProperty('cashback', 0.5);
    expect(cardEffects({ r_ammoBack: 2 }).mods).not.toHaveProperty('ammoBack');
  });
});

describe('四种虚构保护物品与封号下限', () => {
  it('四类等强度叠加，只读取合法自有计数', () => {
    expect(PROTECTION_ITEMS.map((it) => it.label)).toEqual(['美国手机号', '美国信用卡', '美国住宅IP', 'KYC验证']);
    for (const it of PROTECTION_ITEMS) {
      expect(getProtection(it.id)).toBe(it);
      expect(banChance('claude', { [it.id]: [99] })).toBeCloseTo(0.05 * 0.8);
    }
    expect(protectionStacks({ us_phone: [99, 99], us_credit: [99, 99, 99], us_ip: [99, 99, 99, 99], kyc: [99, 99, 99, 99, 99], unrelated: 999 })).toBe(14);
    expect(protectionStacks(Object.create({ us_phone: [99] }))).toBe(0);
    expect(protectionStacks({ us_phone: -1, us_ip: '20', kyc: 1.1 })).toBe(0);
    for (const id of ['__proto__', 'constructor', 'toString', 'missing', null, {}]) expect(getProtection(id)).toBeNull();
  });

  it('Claude/GPT 基础风险相差10倍，叠加有正数地板，其他计划永远为0', () => {
    expect(banChance('claude')).toBe(0.05);
    expect(banChance('gpt')).toBe(0.0005);
    expect(banChance('claude', { us_phone: Array(13).fill(99) })).toBeGreaterThan(0.0025);
    expect(banChance('claude', { us_phone: Array(14).fill(99) })).toBeCloseTo(0.0025);
    expect(banChance('gpt', { kyc: Array(10000).fill(99) })).toBe(0.000025);
    for (const id of ['ds', 'qwen', 'glm', 'missing']) expect(banChance(id, { us_phone: [99] })).toBe(0);
    expect(1 - (1 - banChance('claude')) ** 200).toBeGreaterThan(0.99);
    expect(1 - (1 - banChance('gpt')) ** 200).toBeCloseTo(0.095, 3);
  });

  it.each([['brawler', false, 0.02], ['brawler', true, 0.06], ['boss', false, 0.15], ['boss', true, 0.15]])('%s elite=%s 掉落概率边界为%s', (type, elite, chance) => {
    const miss = vi.fn(() => chance);
    expect(rollProtection(miss, type, elite)).toBeNull();
    expect(miss).toHaveBeenCalledTimes(1);
    const hit = vi.fn().mockReturnValueOnce(chance - 1e-9).mockReturnValueOnce(0);
    expect(rollProtection(hit, type, elite)).toBe('us_phone');
    expect(hit).toHaveBeenCalledTimes(2);
  });

  it('命中额外掉落后四类等权选择', () => {
    for (let i = 0; i < 4; i++) {
      const rng = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce((i + 0.5) / 4);
      expect(rollProtection(rng, 'brawler')).toBe(PROTECTION_ITEMS[i].id);
    }
  });
});
