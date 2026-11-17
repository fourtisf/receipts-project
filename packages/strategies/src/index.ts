// Strategy templates are implemented in M5 (see HANDOFF §8). Placeholder export keeps the package buildable.
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
