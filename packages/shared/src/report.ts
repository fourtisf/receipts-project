/**
 * Minimal error reporting to Sentry's envelope endpoint (no SDK dependency; works in Node 20 and browsers).
 * DSN format: https://<publicKey>@<host>/<projectId>. Disabled (no-op) when the DSN is empty or malformed.
 * Never pass secrets, private keys, salts or prompts in `extra`.
 */
export interface Reporter {
  enabled: boolean;
  capture(err: unknown, extra?: Record<string, unknown>): Promise<void>;
}

export interface ReporterOptions {
  dsn?: string | undefined;
  service: string; // api | worker | web
  environment?: string;
  release?: string;
  fetchImpl?: typeof fetch;
}

const SECRETY = /(private[_-]?key|secret|salt|password|mnemonic|token|authorization|cookie)/i;

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrub(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRETY.test(k) ? '[redacted]' : scrub(x, depth + 1);
    return out;
  }
  if (typeof v === 'string' && /0x[0-9a-fA-F]{64}/.test(v) && v.length < 80) return v; // tx hashes are public
  return typeof v === 'bigint' ? v.toString() : v;
}

export function makeReporter(opts: ReporterOptions): Reporter {
  const m = /^https:\/\/([^@]+)@([^/]+)\/(\d+)$/.exec(opts.dsn ?? '');
  if (!m) return { enabled: false, capture: async () => undefined };
  const [, key, host, project] = m;
  const url = `https://${host}/api/${project}/envelope/`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    enabled: true,
    async capture(err, extra) {
      const e = err instanceof Error ? err : new Error(String(err));
      const eventId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      const event = {
        event_id: eventId,
        timestamp: Date.now() / 1000,
        platform: 'javascript',
        level: 'error',
        environment: opts.environment ?? 'production',
        release: opts.release,
        tags: { service: opts.service },
        exception: {
          values: [
            { type: e.name, value: e.message.slice(0, 2000), stacktrace: { frames: frames(e.stack) } },
          ],
        },
        extra: scrub(extra ?? {}),
      };
      const body = `${JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
      try {
        await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-sentry-envelope',
            'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${key}, sentry_client=receipts/1.0`,
          },
          body,
        });
      } catch {
        /* reporting must never throw */
      }
    },
  };
}

function frames(stack?: string): { filename: string; function: string; lineno?: number }[] {
  if (!stack) return [];
  return stack
    .split('\n')
    .slice(1, 30)
    .map((l) => {
      const mm = /at (?:(.+?) )?\(?(.+?):(\d+):\d+\)?$/.exec(l.trim());
      return mm
        ? { function: mm[1] ?? '?', filename: mm[2]!, lineno: Number(mm[3]) }
        : { function: l.trim(), filename: '?' };
    })
    .reverse(); // Sentry expects the innermost frame last
}
