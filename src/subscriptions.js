// 本地游戏规则，不调用模型 API，也不收集账号、支付或身份资料。
// 价格与 AA 指数是有日期的静态参考；套餐、战斗属性和封号概率均为游戏设计。
export const REFERENCE_DATE = '2026-11-15';
export const CAPABILITY_SOURCE = 'https://artificialanalysis.ai/leaderboards/models';
export const MICROCOINS_PER_COIN = 1_000_000;
export const STARTING_COINS = 180;
export const TOKENS_PER_CALL = 32;

// 同口径：美元 / 百万 Token，非缓存输入；1:3 输入/输出混合价。
export function pricingFromReference(inputUsd, outputUsd, quota) {
  if (![inputUsd, outputUsd].every((v) => Number.isFinite(v) && v >= 0)
    || !Number.isSafeInteger(quota) || quota <= 0) return null;
  const tokenPriceMicros = Math.round((inputUsd + 3 * outputUsd) / 4 * 10 * MICROCOINS_PER_COIN / 1000);
  if (!Number.isSafeInteger(tokenPriceMicros) || !Number.isSafeInteger(quota * tokenPriceMicros)) return null;
  const coinsPerK = tokenPriceMicros * 1000 / MICROCOINS_PER_COIN;
  const fee = Math.ceil(quota * tokenPriceMicros * 0.75 / MICROCOINS_PER_COIN);
  return { blendedUsd: coinsPerK / 10, coinsPerK, tokenPriceMicros, fee };
}

const definitions = {
  claude: {
    label: 'Claude', tag: '精准重击 · 自带穿透 · 高价高风险', accent: 0xd97757,
    quota: 1000, banChance: 0.005,
    reference: { model: 'Claude Opus 5.5', inputUsd: 4, outputUsd: 20, score: 59, effort: 'Max / Default Fallback', scope: '标准非缓存 API', url: 'https://platform.claude.com/docs/en/about-claude/pricing' },
    model: 'rifle', damage: 68, rpm: 420, pellets: 1, intrinsicPierce: 1,
    bulletSpeed: 95, spreadBase: 0.006, range: 54, falloffStart: 32, falloffEnd: 54, falloffMin: 0.8,
  },
  gpt: {
    label: 'GPT', tag: '均衡高输出 · 小概率封号', accent: 0x10a37f,
    quota: 1000, banChance: 0.0005,
    reference: { model: 'GPT-6.1 Sol', inputUsd: 2, outputUsd: 10, score: 55, effort: 'Max', scope: '标准短上下文 API', url: 'https://developers.openai.com/api/docs/pricing.md' },
    model: 'rifle', damage: 45, rpm: 600, pellets: 1, intrinsicPierce: 0,
    bulletSpeed: 85, spreadBase: 0.01, range: 44, falloffStart: 25, falloffEnd: 44, falloffMin: 0.7,
  },
  qwen: {
    label: 'Qwen', tag: '高频连续调用 · 无游戏封号', accent: 0x615ced,
    quota: 1200, banChance: 0,
    reference: { model: 'Qwen3.8-Max / 0902', inputUsd: 2, outputUsd: 6, score: 34, effort: '默认', scope: 'International 部署 API', url: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing' },
    model: 'rifle', damage: 21, rpm: 780, pellets: 1, intrinsicPierce: 0,
    bulletSpeed: 74, spreadBase: 0.016, range: 34, falloffStart: 18, falloffEnd: 34, falloffMin: 0.55,
  },
  glm: {
    label: 'GLM', tag: '近距散射爆发 · 一次调用五发', accent: 0x3b82f6,
    quota: 1600, banChance: 0,
    reference: { model: 'GLM-5.3', inputUsd: 1.4, outputUsd: 4.4, score: 32, effort: 'Max', scope: '标准非缓存 API', url: 'https://docs.z.ai/guides/overview/pricing.md' },
    model: 'shotgun', damage: 17, rpm: 180, pellets: 5, intrinsicPierce: 0, pelletSpread: 0.1,
    bulletSpeed: 60, spreadBase: 0.035, range: 22, falloffStart: 11, falloffEnd: 22, falloffMin: 0.35,
  },
  ds: {
    label: 'DS', tag: '低价长续航 · 无游戏封号', accent: 0x4d8bff,
    quota: 2000, banChance: 0,
    reference: { model: 'DeepSeek V4.1-Flash-1017', inputUsd: 0.3, outputUsd: 1.2, score: 33, effort: 'Max', scope: '峰时、输入 cache miss；谷时半价，游戏不动态变价', url: 'https://api-docs.deepseek.com/quick_start/pricing' },
    model: 'rifle', damage: 34, rpm: 480, pellets: 1, intrinsicPierce: 0,
    bulletSpeed: 80, spreadBase: 0.012, range: 42, falloffStart: 24, falloffEnd: 42, falloffMin: 0.65,
  },
};

export const PLANS = Object.freeze(Object.fromEntries(Object.entries(definitions).map(([id, plan]) => [id, Object.freeze({
  ...plan, id, tokensPerCall: TOKENS_PER_CALL,
  ...pricingFromReference(plan.reference.inputUsd, plan.reference.outputUsd, plan.quota),
  reference: Object.freeze({ ...plan.reference, date: REFERENCE_DATE, capabilityUrl: CAPABILITY_SOURCE }),
})])));
export const PLAN_IDS = Object.freeze(Object.keys(PLANS));

export function getPlan(id) {
  return typeof id === 'string' && Object.hasOwn(PLANS, id) ? PLANS[id] : null;
}

export function coinsToMicros(coins) {
  const micros = Math.round(coins * MICROCOINS_PER_COIN);
  if (typeof coins !== 'number' || !Number.isFinite(coins) || coins < 0 || !Number.isSafeInteger(micros)) {
    throw new RangeError('金币金额必须是非负、安全范围内的数字');
  }
  return micros === 0 ? 0 : micros;
}

export function microsToCoins(micros) {
  if (!Number.isSafeInteger(micros) || micros < 0) throw new RangeError('微金币必须是非负安全整数');
  return micros / MICROCOINS_PER_COIN;
}

// 最多六位小数，不把 0.312 之类的有效余额显示成 0；不影响内部整数结算。
const coinFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 });
export function formatCoins(coins) {
  return coinFormatter.format(Number(coins));
}

const validMultiplier = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
const validCount = (n) => Number.isSafeInteger(n) && n >= 0;

export function quoteSubscription(id, effects = {}) {
  const plan = getPlan(id);
  const multiplier = effects?.quotaMul ?? 1;
  if (!plan || !validMultiplier(multiplier)) return null;
  const quota = Math.floor(plan.quota * multiplier);
  if (!validCount(quota) || quota < 1) return null;
  return { feeMicros: coinsToMicros(plan.fee), quota };
}

export function quoteUsage(id, remainingTokens, effects = {}) {
  const plan = getPlan(id);
  const tokenMul = effects?.tokenCostMul ?? 1;
  const priceMul = effects?.meteredCostMul ?? 1;
  if (!plan || !validCount(remainingTokens) || !validMultiplier(tokenMul) || !validMultiplier(priceMul)) return null;
  const tokens = Math.max(1, Math.ceil(plan.tokensPerCall * tokenMul));
  const includedTokens = Math.min(remainingTokens, tokens);
  const meteredTokens = tokens - includedTokens;
  const rateMicros = Math.max(1, Math.round(plan.tokenPriceMicros * priceMul));
  const costMicros = meteredTokens * rateMicros;
  if (![tokens, rateMicros, costMicros].every(validCount)) return null;
  return { tokens, includedTokens, meteredTokens, rateMicros, costMicros };
}

// 不修改传入状态：调用方只能在非 null 时一次性提交余额与额度。
export function settleInvocation(walletMicros, remainingTokens, id, effects = {}) {
  if (!validCount(walletMicros)) return null;
  const quote = quoteUsage(id, remainingTokens, effects);
  if (!quote || quote.costMicros > walletMicros) return null;
  return {
    ...quote,
    walletMicros: walletMicros - quote.costMicros,
    remainingTokens: remainingTokens - quote.includedTokens,
  };
}

export const PROTECTION_ITEMS = Object.freeze([
  Object.freeze({ id: 'us_phone', label: '美国手机号', icon: '号', color: 0x86dfba }),
  Object.freeze({ id: 'us_credit', label: '美国信用卡', icon: '卡', color: 0xffd95e }),
  Object.freeze({ id: 'us_ip', label: '美国住宅IP', icon: 'IP', color: 0x89b9ff }),
  Object.freeze({ id: 'kyc', label: 'KYC验证', icon: '验', color: 0xc4a1ff }),
]);
export const PROTECTION_BY_ID = Object.freeze(Object.fromEntries(PROTECTION_ITEMS.map((it) => [it.id, it])));

export function getProtection(id) {
  return typeof id === 'string' && Object.hasOwn(PROTECTION_BY_ID, id) ? PROTECTION_BY_ID[id] : null;
}

export function protectionStacks(protections = {}) {
  return PROTECTION_ITEMS.reduce((total, it) => {
    const n = protections && Object.hasOwn(protections, it.id) ? protections[it.id] : 0;
    return total + (validCount(n) ? n : 0);
  }, 0);
}

export function banChance(id, protections = {}) {
  const base = getPlan(id)?.banChance ?? 0;
  if (base === 0) return 0; // 不给本来零风险的计划套用正数下限
  return base * Math.max(0.05, 0.8 ** protectionStacks(protections));
}

// 与工资/福利/回血独立的一次额外抽取；Boss 优先于精英倍率。
export function rollProtection(rng, enemyType, elite = false) {
  const chance = enemyType === 'boss' ? 0.6 : elite ? 0.25 : 0.12;
  if (rng() >= chance) return null;
  return PROTECTION_ITEMS[Math.min(PROTECTION_ITEMS.length - 1, Math.floor(rng() * PROTECTION_ITEMS.length))]?.id ?? null;
}
