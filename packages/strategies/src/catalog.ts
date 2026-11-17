/**
 * Strategy template catalog (HANDOFF §8). Parameter ranges are the contract between the create-strategy form,
 * the API validation and the runner. All templates are long-only against USDG.
 */
export type ParamType = 'number' | 'percent' | 'hours' | 'days' | 'assets' | 'select' | 'text';

export interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  min?: number;
  max?: number;
  step?: number;
  default: number | string | string[];
  options?: string[];
  help?: string;
}

export interface TemplateDef {
  id: TemplateId;
  name: string;
  description: string;
  ai: boolean;
  assets: { min: number; max: number; allowed: string[] };
  params: ParamDef[];
}

export const TEMPLATE_IDS = [
  'momentum',
  'meanrev',
  'ma_cross',
  'rsi',
  'dip',
  'rebalance',
  'rotation',
  'ai_news',
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const CRYPTO = ['WETH', 'cbBTC'];
export const STOCKS = ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'GOOGL', 'META', 'SPY', 'QQQ', 'COIN'];
export const ALL_ASSETS = [...CRYPTO, ...STOCKS];

const size = (def = 100): ParamDef => ({
  key: 'size',
  label: 'Position size',
  type: 'percent',
  min: 10,
  max: 100,
  step: 5,
  default: def,
  help: 'Share of the allocation moved by each buy signal.',
});

export const TEMPLATES: readonly TemplateDef[] = [
  {
    id: 'momentum',
    name: 'Momentum',
    description: 'Buys a breakout above the recent high, exits on a trailing stop.',
    ai: false,
    assets: { min: 1, max: 1, allowed: ALL_ASSETS },
    params: [
      { key: 'window', label: 'Breakout window', type: 'hours', min: 6, max: 168, step: 1, default: 48 },
      {
        key: 'trailingStop',
        label: 'Trailing stop',
        type: 'percent',
        min: 1,
        max: 30,
        step: 0.5,
        default: 8,
      },
      size(),
    ],
  },
  {
    id: 'meanrev',
    name: 'Mean reversion',
    description:
      'Buys when price falls a number of standard deviations below its moving average, sells at the mean.',
    ai: false,
    assets: { min: 1, max: 1, allowed: ALL_ASSETS },
    params: [
      { key: 'maWindow', label: 'Moving average', type: 'hours', min: 10, max: 200, step: 1, default: 48 },
      {
        key: 'entrySigma',
        label: 'Entry (σ below MA)',
        type: 'number',
        min: 0.5,
        max: 4,
        step: 0.1,
        default: 2,
      },
      { key: 'stop', label: 'Stop loss', type: 'percent', min: 1, max: 50, step: 0.5, default: 10 },
      size(),
    ],
  },
  {
    id: 'ma_cross',
    name: 'MA crossover',
    description: 'Buys when the fast moving average crosses above the slow one, sells on the cross back.',
    ai: false,
    assets: { min: 1, max: 1, allowed: ALL_ASSETS },
    params: [
      { key: 'fast', label: 'Fast MA', type: 'hours', min: 2, max: 100, step: 1, default: 12 },
      { key: 'slow', label: 'Slow MA', type: 'hours', min: 5, max: 400, step: 1, default: 48 },
      { key: 'stop', label: 'Stop loss', type: 'percent', min: 1, max: 50, step: 0.5, default: 10 },
      { key: 'takeProfit', label: 'Take profit', type: 'percent', min: 1, max: 100, step: 1, default: 25 },
      size(),
    ],
  },
  {
    id: 'rsi',
    name: 'RSI reversal',
    description: 'Buys when RSI is oversold, sells when it is overbought.',
    ai: false,
    assets: { min: 1, max: 1, allowed: ALL_ASSETS },
    params: [
      { key: 'period', label: 'RSI period', type: 'number', min: 5, max: 50, step: 1, default: 14 },
      { key: 'buyBelow', label: 'Buy below', type: 'number', min: 5, max: 45, step: 1, default: 30 },
      { key: 'sellAbove', label: 'Sell above', type: 'number', min: 55, max: 95, step: 1, default: 70 },
      { key: 'stop', label: 'Stop loss', type: 'percent', min: 1, max: 50, step: 0.5, default: 12 },
      size(),
    ],
  },
  {
    id: 'dip',
    name: 'Buy the dip in uptrend',
    description: 'In an uptrend, buys short dips below the recent mean and exits on a trailing stop.',
    ai: false,
    assets: { min: 1, max: 1, allowed: ALL_ASSETS },
    params: [
      { key: 'trend', label: 'Trend window', type: 'hours', min: 48, max: 400, step: 1, default: 168 },
      { key: 'dipWindow', label: 'Dip window', type: 'hours', min: 10, max: 100, step: 1, default: 24 },
      {
        key: 'depthSigma',
        label: 'Dip depth (σ)',
        type: 'number',
        min: 0.5,
        max: 4,
        step: 0.1,
        default: 1.5,
      },
      {
        key: 'trailingStop',
        label: 'Trailing stop',
        type: 'percent',
        min: 1,
        max: 30,
        step: 0.5,
        default: 6,
      },
      size(),
    ],
  },
  {
    id: 'rebalance',
    name: 'Equal-weight rebalance',
    description: 'Holds the chosen assets in equal weight and rebalances when any drifts past the threshold.',
    ai: false,
    assets: { min: 2, max: 10, allowed: ALL_ASSETS },
    params: [
      { key: 'schedule', label: 'Schedule', type: 'select', options: ['weekly', 'daily'], default: 'weekly' },
      { key: 'drift', label: 'Drift threshold', type: 'percent', min: 0.5, max: 20, step: 0.5, default: 2 },
    ],
  },
  {
    id: 'rotation',
    name: 'Trend rotation',
    description: 'Holds the asset with the strongest trend over the lookback; checks on schedule.',
    ai: false,
    assets: { min: 2, max: 6, allowed: ALL_ASSETS },
    params: [
      { key: 'lookback', label: 'Lookback', type: 'days', min: 5, max: 60, step: 1, default: 20 },
      { key: 'schedule', label: 'Schedule', type: 'select', options: ['weekly', 'daily'], default: 'weekly' },
    ],
  },
  {
    id: 'ai_news',
    name: 'AI news',
    description:
      'A language model reads headlines and prices and decides. The model id and the full prompt are committed as hashes and published at reveal.',
    ai: true,
    assets: { min: 1, max: 5, allowed: ALL_ASSETS },
    params: [
      { key: 'model', label: 'Model', type: 'text', default: 'configured-by-operator' },
      {
        key: 'promptTemplate',
        label: 'Prompt template',
        type: 'text',
        default:
          'You manage a long-only position in {assets} against USDG. Given the headlines and hourly prices, answer strictly as JSON {"action":"buy|sell|hold","asset":"SYMBOL","sizeBps":0-10000,"reason":"..."}.',
      },
      size(50),
    ],
  },
];

export function templateById(id: string): TemplateDef | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export type ParamValues = Record<string, number | string | string[]>;

/** Validates params against the template ranges; returns normalized params or a list of human-readable errors. */
export function validateParams(
  template: TemplateDef,
  params: ParamValues,
  assets: readonly string[],
): { ok: true; params: ParamValues } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const out: ParamValues = {};
  const uniq = new Set(assets);
  if (uniq.size !== assets.length) errors.push('Assets must not repeat.');
  if (assets.length < template.assets.min || assets.length > template.assets.max) {
    errors.push(
      template.assets.min === template.assets.max
        ? `${template.name} trades exactly ${template.assets.min} asset.`
        : `${template.name} needs ${template.assets.min}–${template.assets.max} assets.`,
    );
  }
  for (const a of assets) if (!template.assets.allowed.includes(a)) errors.push(`${a} is not tradable here.`);
  for (const p of template.params) {
    const v = params[p.key] ?? p.default;
    if (p.type === 'select') {
      if (typeof v !== 'string' || !p.options?.includes(v))
        errors.push(`${p.label} must be one of ${p.options?.join(', ')}.`);
      else out[p.key] = v;
    } else if (p.type === 'text') {
      if (typeof v !== 'string' || v.length > 4000)
        errors.push(`${p.label} must be text under 4000 characters.`);
      else out[p.key] = v;
    } else {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) errors.push(`${p.label} must be a number.`);
      else if ((p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max)) {
        errors.push(`${p.label} must be between ${p.min} and ${p.max}.`);
      } else out[p.key] = n;
    }
  }
  if (
    template.id === 'ma_cross' &&
    typeof out.fast === 'number' &&
    typeof out.slow === 'number' &&
    out.fast >= out.slow
  ) {
    errors.push('Fast MA must be shorter than slow MA.');
  }
  if (
    template.id === 'dip' &&
    typeof out.dipWindow === 'number' &&
    typeof out.trend === 'number' &&
    out.dipWindow >= out.trend
  ) {
    errors.push('Dip window must be shorter than the trend window.');
  }
  return errors.length ? { ok: false, errors } : { ok: true, params: out };
}
