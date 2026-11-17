import type { FastifyInstance } from 'fastify';

/**
 * GET /geo — whether stock-token copy flows are geoblocked for this visitor (HANDOFF §6: Robinhood Stock Tokens are
 * not available to US persons). The country comes from a trusted proxy header: Cloudflare's `CF-IPCountry`, or
 * `X-Country-Code` set by Nginx (geoip2 module). Without either header the country is unknown and the UI shows the
 * notice to everyone (it never claims eligibility it cannot check).
 */
export async function geoRoutes(app: FastifyInstance): Promise<void> {
  const blocked = app.deps.env.GEOBLOCK_STOCKS.split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  app.get('/geo', async (req, reply) => {
    const raw = (req.headers['cf-ipcountry'] ?? req.headers['x-country-code'] ?? '') as string;
    const country = /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : null;
    reply.header('Cache-Control', 'private, max-age=300');
    return {
      country,
      stocksBlocked: country !== null && blocked.includes(country),
      notice: 'Robinhood Stock Tokens are not available to US persons.',
    };
  });
}
