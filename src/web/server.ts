import { readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { publicGraphs } from '../db.js';
import { buildServer } from '../mcp.js';
import { explainPath, listFindings } from '../tools.js';
import { rateLimit } from './ratelimit.js';

// Hosted demo: a read-only view of the graphs (page, JSON API and MCP). No writes, no LLM calls, no GitHub actions.
// Only the public graphs (AVERT_PUBLIC_GRAPHS) are served, so the repo parameter cannot reach anything else.

export function buildApp(opts: { localOnly?: boolean } = {}): Hono {
  const app = new Hono();
  // Bound to loopback, answer only requests addressed to it: a page on another site cannot reach the API or MCP through DNS rebinding.
  if (opts.localOnly) app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').replace(/:\d+$/, '');
    return ['localhost', '127.0.0.1', '[::1]'].includes(host) ? next() : c.json({ error: 'forbidden host' }, 403);
  });
  const limit = rateLimit(60, 60_000); // per client per minute, shared by the API and MCP
  app.use('/api/*', limit);
  app.use('/pr', limit);
  app.use('/mcp', limit, bodyLimit({ maxSize: 64 * 1024 }));
  const known = async (c: { req: { query(k: string): string | undefined } }) => {
    const repo = c.req.query('repo') ?? '';
    return (await publicGraphs()).includes(repo) ? repo : undefined;
  };

  app.get('/', async (c) => c.html(await readFile(new URL('./index.html', import.meta.url), 'utf8')));
  app.get('/api/repos', async (c) => c.json(await publicGraphs()));
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

  // Redirect to the pull request (or issue) Avert opened for a finding; the URL comes from the graph, never from the request.
  app.get('/pr', async (c) => {
    const repo = await known(c);
    const url = repo && (await listFindings({ repo })).findings.find((f: any) => f.id === c.req.query('finding'))?.url;
    return typeof url === 'string' && url.startsWith('https://github.com/') ? c.redirect(url, 302) : c.json({ error: 'no pull request for this finding' }, 404);
  });

  // Read-only MCP over streamable HTTP, stateless: a fresh server per request, so nothing is held between calls.
  app.all('/mcp', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await buildServer({ readOnly: true }).connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  return app;
}

export function startWeb(port = Number(process.env.PORT ?? 8787)) {
  const hostname = process.env.HOST ?? '127.0.0.1'; // the Docker image sets HOST=0.0.0.0 for the hosted demo
  serve({ fetch: buildApp({ localOnly: ['127.0.0.1', 'localhost', '::1'].includes(hostname) }).fetch, port, hostname });
  console.log(`avert web: http://localhost:${port}`);
}
