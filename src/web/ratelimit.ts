import type { MiddlewareHandler } from 'hono';

// Fixed-window limiter, in memory, per client. The hosted demo runs one small machine, so a shared store would be overkill.
// Behind Fly the client is `Fly-Client-IP` (set by the proxy); anywhere else every request shares one bucket.

export function rateLimit(limit: number, windowMs: number, now = () => Date.now()): MiddlewareHandler {
  const hits = new Map<string, { count: number; reset: number }>();
  return async (c, next) => {
    const t = now();
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
    const key = c.req.header('fly-client-ip') ?? 'local';
    const h = hits.get(key) ?? { count: 0, reset: t + windowMs };
    hits.set(key, h);
    if (++h.count > limit) {
      c.header('Retry-After', String(Math.ceil((h.reset - t) / 1000)));
      return c.json({ error: 'rate limited' }, 429);
    }
    await next();
  };
}
