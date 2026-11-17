import type { z } from 'zod';
import { errorSchema } from '@receipts/shared';

/** Server-side API origin (internal network). Never sent to the browser. */
const API = (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/**
 * GET a public API path from a server component and parse it with the shared zod schema.
 * `revalidate` seconds feed Next's data cache (the API sets the same max-age).
 */
export async function apiGet<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  revalidate = 10,
): Promise<z.output<S>> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      headers: { accept: 'application/json' },
      next: { revalidate },
    });
  } catch {
    throw new ApiError(503, 'API_UNREACHABLE', 'The data service is unreachable. Try again in a moment.');
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const parsed = errorSchema.safeParse(body);
    throw new ApiError(
      res.status,
      parsed.success ? parsed.data.error.code : 'HTTP_' + res.status,
      parsed.success ? parsed.data.error.message : `The data service answered ${res.status}.`,
    );
  }
  const json: unknown = await res.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.error(`[api] ${path} failed schema validation`, parsed.error.issues.slice(0, 3));
    throw new ApiError(502, 'BAD_RESPONSE', 'The data service sent an unexpected response.');
  }
  return parsed.data;
}

/** Like apiGet, but never throws: pages render honest empty/error states instead of crashing. */
export async function apiTry<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  revalidate = 10,
): Promise<Result<z.output<S>>> {
  try {
    return { ok: true, data: await apiGet(path, schema, revalidate) };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof ApiError ? e : new ApiError(500, 'UNKNOWN', 'Something went wrong loading data.'),
    };
  }
}
