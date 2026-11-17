import { pino } from 'pino';

/** Structured logs. Keys, salts before reveal and prompts before reveal must never be logged. */
export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      '*.privateKey',
      '*.salt',
      '*.saltEnc',
      '*.signalEnc',
      '*.prompt',
      'env.EXECUTOR_PRIVATE_KEY',
      'env.SIGNER_PRIVATE_KEYS',
      'env.SALT_ENCRYPTION_KEY',
      'env.AI_API_KEY',
      'env.MARKET_DATA_API_KEY',
      'env.TELEGRAM_BOT_TOKEN',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof log;
