'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { PUBLIC_API_BASE, PUBLIC_WS_URL } from '@/lib/env';

/**
 * Subscribes to the API WebSocket (`{"sub": topic}`) and re-renders the server components when a
 * matching event arrives. Silent on failure: the page still works without live updates.
 */
export function LiveRefresh({ topic }: { topic: string }) {
  const router = useRouter();
  useEffect(() => {
    if (typeof WebSocket === 'undefined') return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry = 0;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const url =
      PUBLIC_WS_URL ??
      `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${PUBLIC_API_BASE}/ws`;

    const connect = () => {
      try {
        ws = new WebSocket(url);
      } catch {
        return;
      }
      ws.onopen = () => {
        retry = 0;
        ws?.send(JSON.stringify({ sub: topic }));
      };
      ws.onmessage = (ev: MessageEvent<string>) => {
        let raw: unknown;
        try {
          raw = JSON.parse(ev.data);
        } catch {
          return;
        }
        // receipt.* / vault.event pushes (shape: wsEventSchema in @receipts/shared); ignore acks and errors
        const type = typeof raw === 'object' && raw !== null ? (raw as { type?: unknown }).type : undefined;
        if (typeof type !== 'string' || !(type.startsWith('receipt.') || type === 'vault.event')) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => router.refresh(), 1200);
      };
      ws.onclose = () => {
        if (stopped || retry >= 6) return;
        reconnect = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(reconnect);
      clearTimeout(debounce);
      ws?.close();
    };
  }, [topic, router]);
  return null;
}
