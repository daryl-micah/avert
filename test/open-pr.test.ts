import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const finding = { id: 'f1', kind: 'retired', change: { id: 'c1', summary: 'gpt-4 retired', source_url: 'https://example.com' }, callsite: { file: 'a.py', line: 1 }, routes: [], owners: [] };
vi.mock('../src/db.js', () => ({
  graph: async () => ({}),
  run: async () => [{ t: { labels: ['Value'], properties: { value: 'gpt-4' } }, rep: { properties: { value: 'gpt-5' } }, alias: null }],
}));
vi.mock('../src/tools.js', () => ({
  explainPath: async () => ({ finding, path: [] }),
  listFindings: async () => ({ findings: [finding] }),
  listChanges: async () => ({ changes: [{ id: 'c1', kind: 'retired', provider: 'openai' }] }),
  migrationBatches: async () => ({ batches: [] }),
  recall: async () => ({ recipes: [] }),
  setStatus: async () => {},
}));
const { openPr } = await import('../src/actions/github.js');

// A fake GitHub: `branch` is the head commit's message list (undefined = no branch), `prs` the PRs for the branch.
function github(state: { branch?: string[]; prs: any[] }) {
  const calls: { method: string; path: string; body?: any }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    const path = url.replace('https://api.github.com', '');
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const ok = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (path === '/repos/me/demo') return ok({ default_branch: 'main' });
    if (path.startsWith('/repos/me/demo/contents/')) return ok({ content: Buffer.from('m = "gpt-4"\n').toString('base64') });
    if (path.startsWith('/repos/me/demo/pulls?')) return ok(state.prs);
    if (path === '/repos/me/demo/git/ref/heads/main') return ok({ object: { sha: 'base' } });
    if (path.startsWith('/repos/me/demo/git/ref/heads/')) return state.branch ? ok({ object: { sha: 'head' } }) : new Response('{}', { status: 404 });
    if (path.startsWith('/repos/me/demo/compare/')) return ok({ commits: (state.branch ?? []).map((message) => ({ commit: { message } })) });
    if (path === '/repos/me/demo/git/commits/base') return ok({ tree: { sha: 'tree0' } });
    if (path.startsWith('/repos/me/demo/git/trees/tree0')) return ok({ tree: [{ path: 'a.py', mode: '100755' }] });
    if (method === 'POST' && path === '/repos/me/demo/git/trees') return ok({ sha: 'tree1' });
    if (method === 'POST' && path === '/repos/me/demo/git/commits') return ok({ sha: 'commit1' });
    if (path.includes('/git/refs')) return ok({});
    if (path.startsWith('/repos/me/demo/pulls')) return ok({ html_url: 'https://github.com/me/demo/pull/1', number: 1 });
    return new Response('not found', { status: 404 });
  });
  return calls;
}
const writes = (calls: { method: string }[]) => calls.filter((c) => c.method !== 'GET');

beforeEach(() => { process.env.AVERT_GITHUB_REPO = 'me/demo'; process.env.GITHUB_TOKEN = 'test'; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('openPr', () => {
  it('commits on the base with a trailer, keeping the file mode, and opens a PR', async () => {
    const calls = github({ prs: [] });
    const r = await openPr({ repo: 'acme', finding_id: 'f1' });
    expect(r.url).toBe('https://github.com/me/demo/pull/1');
    const tree = calls.find((c) => c.path === '/repos/me/demo/git/trees' && c.method === 'POST')!.body;
    expect(tree.tree).toEqual([{ path: 'a.py', mode: '100755', type: 'blob', content: 'm = "gpt-5"\n' }]);
    const commit = calls.find((c) => c.path === '/repos/me/demo/git/commits' && c.method === 'POST')!.body;
    expect(commit).toMatchObject({ tree: 'tree1', parents: ['base'] });
    expect(commit.message).toContain('\n\nAvert-Change: c1');
    expect(calls.find((c) => c.path === '/repos/me/demo/git/refs')!.body).toEqual({ ref: 'refs/heads/avert/openai/retire-c1', sha: 'commit1' });
  });
  it("replaces its own earlier commit and updates the open PR without reopening anything", async () => {
    const calls = github({ branch: ['fix: gpt-4 -> gpt-5 (gpt-4 retired)\n\nAvert-Change: c1'], prs: [{ number: 7, state: 'open' }] });
    await openPr({ repo: 'acme', finding_id: 'f1' });
    expect(calls.find((c) => c.path.endsWith('/git/refs/heads/avert/openai/retire-c1'))!.body).toEqual({ sha: 'commit1', force: true });
    expect(calls.find((c) => c.path === '/repos/me/demo/pulls/7')!.body.state).toBeUndefined();
  });
  it('leaves a branch alone when a person pushed to it', async () => {
    const calls = github({ branch: ['fix: gpt-4 -> gpt-5 (gpt-4 retired)', 'handle the new model in tests'], prs: [{ number: 7, state: 'open' }] });
    await expect(openPr({ repo: 'acme', finding_id: 'f1' })).rejects.toThrow(/1 commit\(s\) Avert did not make/);
    expect(writes(calls)).toEqual([]);
  });
  it('does not reopen or replace a PR closed without merging', async () => {
    const calls = github({ prs: [{ number: 7, state: 'closed', merged_at: null }] });
    await expect(openPr({ repo: 'acme', finding_id: 'f1' })).rejects.toThrow(/closed without merging/);
    expect(writes(calls)).toEqual([]);
  });
});
