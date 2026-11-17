import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { Redis } from 'ioredis';
import { z } from 'zod';

const EVENTS_CHANNEL = 'events';
const subMsg = z.object({ sub: z.string().regex(/^(receipts|strategy:\d+|vault:0x[0-9a-fA-F]{40})$/) });

interface Client {
  socket: WebSocket;
  subs: Set<string>;
}

/** Topics an event belongs to: receipts, strategy:<id>, vault:<address>. */
export function topicsOf(e: { type: string; data: Record<string, unknown> }): string[] {
  const t: string[] = [];
  if (e.type.startsWith('receipt.')) t.push('receipts');
  if (e.data.strategyId !== undefined) t.push(`strategy:${String(e.data.strategyId)}`);
  if (typeof e.data.vault === 'string') t.push(`vault:${e.data.vault.toLowerCase()}`);
  return t;
}

/** GET /ws — clients send {"sub":"receipts"|"strategy:<id>"|"vault:<address>"}; backed by Redis pub/sub. */
export async function wsRoutes(app: FastifyInstance): Promise<void> {
  const clients = new Set<Client>();
  let sub: Redis | null = null;
  if (app.deps.redis) {
    sub = app.deps.redis.duplicate();
    await sub.subscribe(EVENTS_CHANNEL);
    sub.on('message', (_ch, raw) => {
      let e: { type: string; data: Record<string, unknown> };
      try {
        e = JSON.parse(raw);
      } catch {
        return;
      }
      const topics = topicsOf(e);
      for (const c of clients) {
        if (topics.some((t) => c.subs.has(t)) && c.socket.readyState === 1) c.socket.send(raw);
      }
    });
    app.addHook('onClose', async () => {
      await sub?.quit().catch(() => undefined);
    });
  }

  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    const client: Client = { socket, subs: new Set() };
    clients.add(client);
    socket.on('message', (raw: Buffer) => {
      try {
        const m = subMsg.parse(JSON.parse(raw.toString()));
        if (client.subs.size < 20) client.subs.add(m.sub.toLowerCase());
        socket.send(JSON.stringify({ type: 'subscribed', data: { sub: m.sub } }));
      } catch {
        socket.send(
          JSON.stringify({
            type: 'error',
            data: { message: 'Send {"sub":"receipts"} or strategy:<id> / vault:<address>.' },
          }),
        );
      }
    });
    socket.on('close', () => clients.delete(client));
  });
}
