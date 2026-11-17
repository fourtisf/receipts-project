import type { Redis } from 'ioredis';
import type { WsEvent } from '@receipts/shared';

export const EVENTS_CHANNEL = 'events';

/** Publishes indexer changes for the API WebSocket. Failures never break indexing. */
export class Publisher {
  private queue: WsEvent[] = [];
  constructor(private readonly redis: Redis | null) {}

  push(e: WsEvent): void {
    this.queue.push(e);
  }

  async flush(): Promise<void> {
    const items = this.queue;
    this.queue = [];
    if (!this.redis || items.length === 0) return;
    try {
      const pipe = this.redis.pipeline();
      for (const e of items) pipe.publish(EVENTS_CHANNEL, JSON.stringify(e, bigintReplacer));
      await pipe.exec();
    } catch {
      /* websocket push is best-effort */
    }
  }
}

export function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}
