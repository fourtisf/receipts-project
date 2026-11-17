import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Validates the response against the shared zod schema, sets cache headers and sends it. */
export function send<T extends z.ZodTypeAny>(
  reply: FastifyReply,
  schema: T,
  data: unknown,
  maxAgeSec?: number,
) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    reply.log.error({ issues: parsed.error.issues.slice(0, 5) }, 'response failed schema validation');
    throw new ApiError(500, 'BAD_RESPONSE', 'Internal error. Try again in a moment.');
  }
  if (maxAgeSec !== undefined) reply.header('Cache-Control', `public, max-age=${maxAgeSec}`);
  return reply.send(parsed.data);
}
