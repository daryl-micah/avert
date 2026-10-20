import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { rateLimit } from '../src/web/ratelimit.js';

const app = (t: { v: number }) => new Hono().use('*', rateLimit(2, 1000, () => t.v)).get('/', (c) => c.text('ok'));
const get = (a: Hono, ip: string) => a.request('/', { headers: { 'x-forwarded-for': ip } });

describe('rateLimit', () => {
  it('allows the limit, then 429 with Retry-After, per client', async () => {
    const a = app({ v: 0 });
    expect((await get(a, '1.1.1.1')).status).toBe(200);
    expect((await get(a, '1.1.1.1')).status).toBe(200);
    const r = await get(a, '1.1.1.1');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('1');
    expect((await get(a, '2.2.2.2')).status).toBe(200);
  });
  it('keys on the right-most X-Forwarded-For entry, so a forged left-most one changes nothing', async () => {
    const a = app({ v: 0 });
    for (const forged of ['9.9.9.1', '9.9.9.2', '9.9.9.3']) await get(a, `${forged}, 1.1.1.1`);
    expect((await get(a, '9.9.9.4, 1.1.1.1')).status).toBe(429);
  });
  it('resets after the window', async () => {
    const t = { v: 0 };
    const a = app(t);
    for (let i = 0; i < 3; i++) await get(a, '1.1.1.1');
    t.v = 1001;
    expect((await get(a, '1.1.1.1')).status).toBe(200);
  });
});
