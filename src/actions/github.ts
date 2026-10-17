import { execFileSync } from 'node:child_process';
import { graph, run } from '../db.js';
import { render, type Step } from '../path.js';
import { explainPath, migrationBatches, recall, setStatus } from '../tools.js';

// Actions: one GitHub issue per migration batch, and a pull request when the fix is mechanical
// (the change names a replacement value or param, or a saved recipe covers it).

function token(): string {
  const t = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (t) return t;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); } catch { throw new Error('Set GITHUB_TOKEN (or log in with `gh auth login`) to open issues and pull requests.'); }
}

async function gh(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** owner/name of the GitHub repo for a repo graph: AVERT_GITHUB_REPO overrides the indexed URL. */
async function githubRepo(repo: string): Promise<string> {
  if (process.env.AVERT_GITHUB_REPO) return process.env.AVERT_GITHUB_REPO;
  const [r] = await run(await graph(repo), `MATCH (r:Repo) RETURN r.url AS url LIMIT 1`);
  const m = String(r?.url ?? '').match(/github\.com[/:]([^/]+\/[^/.]+)/);
  if (!m) throw new Error(`${repo} is not a GitHub repository; set AVERT_GITHUB_REPO=owner/name to choose where issues and PRs go.`);
  return m[1];
}

const fence = (path: Step[]) => '```\n' + render(path) + '\n```';

export async function openIssue(args: { repo: string; batch_id: string }) {
  const { batches } = await migrationBatches({ repo: args.repo });
  const batch = batches.find((b) => b.id === args.batch_id);
  if (!batch) throw new Error(`No batch ${args.batch_id}; run migration_batches first.`);
  const sections: string[] = [];
  let firstPath: Step[] = [];
  for (const id of batch.findings) {
    const { finding, path } = await explainPath({ repo: args.repo, finding_id: id });
    if (!firstPath.length) firstPath = path;
    sections.push(`### ${finding.change.summary}\n\n\`${finding.callsite.file}:${finding.callsite.line}\` reaches ${finding.routes.map((r: string) => `\`${r}\``).join(', ') || 'no known route'}.\n\nSource: ${finding.change.source_url}\n\n${fence(path)}`);
  }
  const target = await githubRepo(args.repo);
  const issue = await gh('POST', `/repos/${target}/issues`, {
    title: `Avert: ${batch.changes[0]}${batch.changes.length > 1 ? ` (+${batch.changes.length - 1} more)` : ''}`,
    body: [
      `Avert traced ${batch.size} finding${batch.size > 1 ? 's' : ''} for ${batch.owners.join(', ') || 'this repository'} to routes ${batch.routes.map((r) => `\`${r}\``).join(', ') || '(none found)'}.`,
      `Each path below runs from the provider change, down the API surface to the call site, then up the call chain to the route and owning team.`,
      ...sections,
      `---\n_Opened by [Avert](https://github.com/daryl-micah/avert). Batch \`${batch.id}\`._`,
    ].join('\n\n'),
  });
  for (const id of batch.findings) await setStatus(args.repo, id, 'claimed', issue.html_url);
  return { url: issue.html_url, batch_id: batch.id, findings: batch.findings, path: firstPath };
}

export interface Edit { from: string; to: string; kind: 'value' | 'param' }

/**
 * The mechanical edit for a finding: a REPLACEMENT value/param on the change, or a saved recipe
 * (repo or shared). Returns undefined when neither exists; then only an issue is possible.
 */
export async function plannedEdit(repo: string, findingId: string): Promise<(Edit & { source: string; recipe?: string }) | undefined> {
  const g = await graph(repo);
  const [r] = await run(g, `
    MATCH (f:Finding {id: $id})-[:CAUSED_BY]->(c:ChangeEvent)-[:AFFECTS]->(t)
    OPTIONAL MATCH (c)-[:REPLACEMENT]->(rep)
    OPTIONAL MATCH (f)-[:AT]->(:CallSite)-[:PASSES]->(alias:Value)-[:RESOLVES_TO]->(t)
    RETURN t, rep, alias`, { id: findingId });
  if (r?.rep) {
    const t = r.t.properties, rep = r.rep.properties;
    if (r.t.labels[0] === 'Value') return { kind: 'value', from: r.alias?.properties.value ?? t.value, to: rep.value, source: 'replacement' }; // the call site may pass an alias that resolves to the retired value
    if (r.t.labels[0] === 'Param') return { kind: 'param', from: t.name, to: rep.name, source: 'replacement' };
  }
  const { recipes } = await recall({ repo, finding_id: findingId });
  const rec = recipes[0];
  if (rec) return { kind: /^[a-z_]+$/.test(rec.from) ? 'param' : 'value', from: rec.from, to: rec.to, source: `recipe (${rec.scope})`, recipe: rec.id };
  return undefined;
}

/** Apply an edit to file text near the call site: a quoted literal value, or a param key (`key:` / `key=`). */
export function applyEdit(text: string, line: number, e: Edit): string | undefined {
  const lines = text.split('\n');
  if (e.kind === 'value') {
    const re = new RegExp(`(["'\`])${e.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'g');
    const out = text.replace(re, (_m, q) => `${q}${e.to}${q}`);
    return out === text ? undefined : out;
  }
  // param: rename the key inside the call that starts at `line` (scan forward to the closing paren)
  for (let i = line - 1; i < Math.min(lines.length, line + 40); i++) {
    const re = new RegExp(`(^|[\\s,{(])${e.from}(\\s*[:=])`);
    if (re.test(lines[i])) {
      lines[i] = lines[i].replace(re, `$1${e.to}$2`);
      return lines.join('\n');
    }
  }
  return undefined;
}

export async function openPr(args: { repo: string; finding_id: string }) {
  const { finding, path } = await explainPath({ repo: args.repo, finding_id: args.finding_id });
  if (finding.kind === 'added') throw new Error('Added capabilities produce notices, never pull requests.');
  const edit = await plannedEdit(args.repo, args.finding_id);
  if (!edit) throw new Error(`No replacement or recipe for "${finding.change.summary}"; open an issue instead (open_issue) or save a recipe first.`);
  const target = await githubRepo(args.repo);
  const prefix = process.env.AVERT_GITHUB_PATH_PREFIX ?? '';
  const filePath = prefix + finding.callsite.file;
  const meta = await gh('GET', `/repos/${target}`);
  const base = meta.default_branch;
  const file = await gh('GET', `/repos/${target}/contents/${encodeURI(filePath)}?ref=${base}`);
  const original = Buffer.from(file.content, 'base64').toString('utf8');
  const updated = applyEdit(original, finding.callsite.line, edit);
  if (!updated) throw new Error(`Could not find \`${edit.from}\` near ${filePath}:${finding.callsite.line} on ${base}.`);
  const sha = (await gh('GET', `/repos/${target}/git/ref/heads/${base}`)).object.sha;
  const branch = `avert/${finding.change.id.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60)}-${Date.now().toString(36)}`;
  await gh('POST', `/repos/${target}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  await gh('PUT', `/repos/${target}/contents/${encodeURI(filePath)}`, {
    message: `fix: ${edit.from} -> ${edit.to} (${finding.change.summary})`,
    content: Buffer.from(updated).toString('base64'), sha: file.sha, branch,
  });
  const pr = await gh('POST', `/repos/${target}/pulls`, {
    title: `Avert: replace ${edit.from} with ${edit.to}`,
    head: branch, base,
    body: [
      `**Change:** ${finding.change.summary} ([source](${finding.change.source_url}))`,
      `**Fix:** \`${edit.from}\` → \`${edit.to}\` in \`${filePath}\` (from ${edit.source}).`,
      `**Reaches:** ${finding.routes.map((r: string) => `\`${r}\``).join(', ') || 'no known route'}${finding.owners.length ? `, owned by ${finding.owners.join(', ')}` : ''}.`,
      `### Path\n\n${fence(path)}`,
      `---\n_Opened by [Avert](https://github.com/daryl-micah/avert). Nothing is merged automatically; review before merging._`,
    ].join('\n\n'),
  });
  await setStatus(args.repo, args.finding_id, 'done', pr.html_url);
  return { url: pr.html_url, edit, finding_id: args.finding_id, path };
}
