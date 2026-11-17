import { z } from 'zod';
import type { SignalOut } from './types.js';

/** Strict JSON answer expected from the model (WORKER.md §3). */
export const aiAnswerSchema = z.object({
  action: z.enum(['buy', 'sell', 'hold']),
  asset: z.string(),
  sizeBps: z.number().int().min(0).max(10_000),
  reason: z.string().max(2000),
});
export type AiAnswer = z.infer<typeof aiAnswerSchema>;

export interface AiInputs {
  assets: string[];
  headlines: { asset: string; title: string; source: string; publishedAt: string }[];
  prices: Record<string, { t: number; c: number }[]>;
  holdings: Record<string, number>;
  asOf: string;
}

/** Builds the exact prompt text that is hashed and committed (promptHash covers prompt + "\n" + JSON(inputs)). */
export function buildAiPrompt(template: string, inputs: AiInputs): string {
  return template.replaceAll('{assets}', inputs.assets.join(', ')).trim();
}

/** Parses the model output; anything that is not strict valid JSON for the allowed assets becomes "hold". */
export function parseAiAnswer(
  raw: string,
  allowedAssets: readonly string[],
): { answer: AiAnswer; signal: SignalOut | null } {
  const hold = (reason: string): { answer: AiAnswer; signal: null } => ({
    answer: { action: 'hold', asset: allowedAssets[0] ?? '', sizeBps: 0, reason },
    signal: null,
  });
  let parsed: unknown;
  try {
    const trimmed = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/, '');
    parsed = JSON.parse(trimmed);
  } catch {
    return hold('Model output was not valid JSON.');
  }
  const r = aiAnswerSchema.safeParse(parsed);
  if (!r.success) return hold('Model output did not match the required schema.');
  const a = r.data;
  if (a.action === 'hold' || a.sizeBps === 0) return { answer: a, signal: null };
  if (!allowedAssets.includes(a.asset))
    return hold(`Model chose ${a.asset}, which this strategy does not trade.`);
  return {
    answer: a,
    signal: {
      side: a.action === 'buy' ? 'BUY' : 'SELL',
      asset: a.asset,
      sizeBps: a.sizeBps,
      reason: a.reason,
    },
  };
}
