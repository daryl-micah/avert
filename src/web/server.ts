import { readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { listRepoGraphs } from '../db.js';
import { explainPath, listFindings } from '../tools.js';

// Hosted demo: a read-only view of the graphs. No writes, no LLM calls, no GitHub actions.
// Only graphs that exist are served, so the repo parameter cannot reach anything else.

export function buildApp(): Hono {
  const app = new Hono();
  const known = async (c: { req: { query(k: string): string | undefined } }) => {
    const repo = c.req.query('repo') ?? '';
    return (await listRepoGraphs()).includes(repo) ? repo : undefined;
  };

  app.get('/', async (c) => c.html(await readFile(new URL('./index.html', import.meta.url), 'utf8')));
  app.get('/api/repos', async (c) => c.json(await listRepoGraphs()));
  app.get('/api/findings', async (c) => {
    const repo = await known(c);
    return repo ? c.json((await listFindings({ repo })).findings) : c.json({ error: 'unknown repo' }, 404);
  });
  app.get('/api/path', async (c) => {
    const repo = await known(c);
    const id = c.req.query('finding');
    if (!repo || !id) return c.json({ error: 'unknown repo or finding' }, 404);
    try { return c.json(await explainPath({ repo, finding_id: id })); } catch { return c.json({ error: 'unknown finding' }, 404); }
  });
  return app;
}

export function startWeb(port = Number(process.env.PORT ?? 8787)) {
  serve({ fetch: buildApp().fetch, port, hostname: process.env.HOST ?? '0.0.0.0' });
  console.log(`avert web: http://localhost:${port}`);
}
