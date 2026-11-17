'use client';

import type { z } from 'zod';
import { errorSchema } from '@receipts/shared';
import { PUBLIC_API_BASE } from './env';

export class ClientApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Browser-side GET through `/api` (same origin), parsed with the shared zod schema. */
export async function fetchApi<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  let res: Response;
  try {
    res = await fetch(`${PUBLIC_API_BASE}${path}`, { headers: { accept: 'application/json' }, signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ClientApiError(
      0,
      'NETWORK',
      'Could not reach the server. Check your connection and try again.',
    );
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const parsed = errorSchema.safeParse(body);
    throw new ClientApiError(
      res.status,
      parsed.success ? parsed.data.error.code : `HTTP_${res.status}`,
      parsed.success
        ? parsed.data.error.message
        : `The server answered ${res.status}. Try again in a moment.`,
    );
  }
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) {
    throw new ClientApiError(
      502,
      'BAD_RESPONSE',
      'The server sent an unexpected response. Try again in a moment.',
    );
  }
  return parsed.data;
}
