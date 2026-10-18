import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { graph, run } from '../db.js';
import { render, type Step } from '../path.js';
import { explainPath, listChanges, listFindings, migrationBatches, recall, setStatus } from '../tools.js';

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

/**
 * owner/name of the GitHub repo that issues and PRs go to. It must be named explicitly in AVERT_GITHUB_REPO: the indexed
 * URL is often someone else's public repo, and Avert never writes to a repo just because it indexed it.
 */
async function githubRepo(repo: string): Promise<string> {
  const target = process.env.AVERT_GITHUB_REPO;
  if (!target || !/^[\w.-]+\/[\w.-]+$/.test(target)) throw new Error(`Set AVERT_GITHUB_REPO=owner/name to the repo you own where issues and PRs for ${repo} may go.`);
  return target;
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

// Recipes can come from an LLM or the shared graph, so an edit may only write an identifier or a model-id-like literal into code.
const PARAM = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

/** Apply an edit to file text near the call site: a quoted literal value, or a param key (`key:` / `key=`). */
export function applyEdit(text: string, line: number, e: Edit): string | undefined {
  const ok = e.kind === 'param' ? PARAM.test(e.from) && PARAM.test(e.to) : VALUE.test(e.to);
  if (!ok) throw new Error(`Refusing ${e.kind} edit ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)}: not a plain ${e.kind === 'param' ? 'identifier' : 'model id or literal'}.`);
  const lines = text.split('\n');
  if (e.kind === 'value') {
    // The literal inside the call; failing that, the file's only occurrence (a module constant the call passes). Never every match.
    const re = new RegExp(`(["'\`])${e.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`);
    const near = lines.findIndex((l, i) => i >= line - 1 && i < line + 40 && re.test(l));
    const hits = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
    const at = near >= 0 ? near : hits.length === 1 ? hits[0] : -1;
    if (at < 0) return undefined;
    lines[at] = lines[at].replace(re, (_m, q) => `${q}${e.to}${q}`);
    return lines.join('\n');
  }
  // param: rename the key inside the call that starts at `line` (scan forward to the closing paren)
  for (let i = line - 1; i < Math.min(lines.length, line + 40); i++) {
    const re = new RegExp(`(^|[\\s,{(])${e.from}(\\s*[:=])`);
    if (re.test(lines[i])) {
      lines[i] = lines[i].replace(re, (_m, pre, post) => `${pre}${e.to}${post}`);
      return lines.join('\n');
    }
  }
  return undefined;
}

const VERB: Record<string, string> = { removed: 'remove', renamed: 'rename', deprecated: 'deprecate', retired: 'retire' };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

interface ChangeRef { id: string; kind: string; provider: string }

/**
 * Deterministic branch for a change event: `avert/<provider>/<verb>-<subject>`, at most 60 chars, derived only
 * from the event. Events that slugify identically all get a stable 6-char hash of their id, whatever the run order.
 */
export function branchName(c: ChangeRef, all: ChangeRef[]): string {
  const make = (x: ChangeRef, suffix = '') => {
    const head = `avert/${slug(x.provider)}/${VERB[x.kind] ?? slug(x.kind)}-`;
    const subject = slug(x.id.slice(x.id.lastIndexOf(':') + 1).replace(new RegExp(`^${x.provider}\\.`, 'i'), ''));
    const room = 60 - head.length - suffix.length;
    const cut = subject.length > room ? subject.slice(0, room + 1).replace(/-[^-]*$/, '') : subject; // whole words only
    return head + cut + suffix;
  };
  const name = make(c);
  return all.some((o) => o.id !== c.id && make(o) === name) ? make(c, '-' + createHash('sha256').update(c.id).digest('hex').slice(0, 6)) : name;
}

/**
 * One branch and one PR per change event, covering every call site of that change. Re-running rebuilds Avert's one commit on
 * the base and updates the open PR instead of opening another. It never replaces a commit a person pushed to the branch, and
 * never reopens a PR someone closed.
 */
export async function openPr(args: { repo: string; finding_id: string }) {
  const { finding, path } = await explainPath({ repo: args.repo, finding_id: args.finding_id });
  if (finding.kind === 'added') throw new Error('Added capabilities produce notices, never pull requests.');
  const edit = await plannedEdit(args.repo, args.finding_id);
  if (!edit) throw new Error(`No replacement or recipe for "${finding.change.summary}"; open an issue instead (open_issue) or save a recipe first.`);
  const target = await githubRepo(args.repo);
  const prefix = process.env.AVERT_GITHUB_PATH_PREFIX ?? '';
  const meta = await gh('GET', `/repos/${target}`);
  const base = meta.default_branch;

  // This finding first (its edit must apply), then every other call site of the same change.
  const siblings = (await listFindings({ repo: args.repo })).findings.filter((f) => f.change.id === finding.change.id && f.id !== finding.id);
  const files = new Map<string, { original: string; text: string }>();
  const sites: string[] = [];
  for (const f of [finding, ...siblings]) {
    const e = f === finding ? edit : await plannedEdit(args.repo, f.id);
    if (!e) continue;
    const filePath = prefix + f.callsite.file;
    if (!files.has(filePath)) {
      const file = await gh('GET', `/repos/${target}/contents/${encodeURI(filePath)}?ref=${base}`);
      const original = Buffer.from(file.content, 'base64').toString('utf8');
      files.set(filePath, { original, text: original });
    }
    const entry = files.get(filePath)!;
    const updated = applyEdit(entry.text, f.callsite.line, e);
    if (updated) { entry.text = updated; sites.push(`${filePath}:${f.callsite.line}`); }
    else if (f === finding) throw new Error(`Could not find \`${e.from}\` near ${filePath}:${f.callsite.line} on ${base}.`);
  }

  const changes = (await listChanges({ repo: args.repo })).changes;
  const branch = branchName(changes.find((c) => c.id === finding.change.id) ?? { id: finding.change.id, kind: finding.kind, provider: 'provider' }, changes);
  const prior = (await gh('GET', `/repos/${target}/pulls?head=${target.split('/')[0]}:${encodeURIComponent(branch)}&state=all`)).filter((p: any) => !p.merged_at);
  const open = prior.find((p: any) => p.state === 'open');
  if (!open && prior.length) throw new Error(`PR #${prior[0].number} for ${branch} was closed without merging; Avert does not reopen it or open another.`);

  const sha = (await gh('GET', `/repos/${target}/git/ref/heads/${base}`)).object.sha;
  const head: string | undefined = await gh('GET', `/repos/${target}/git/ref/heads/${branch}`).then((r) => r.object.sha, () => undefined);
  if (head) {
    // Avert's commits carry an Avert-Change trailer (earlier ones only the subject); anything else on the branch is a person's.
    const ours = (m: string) => m.includes(`\nAvert-Change: ${finding.change.id}`) || (/^fix: .+ -> .+ \(.*\)$/.test(m) && m.endsWith(`(${finding.change.summary})`));
    const foreign = (await gh('GET', `/repos/${target}/compare/${base}...${head}`)).commits.filter((c: any) => !ours(c.commit.message));
    if (foreign.length) throw new Error(`${branch} has ${foreign.length} commit(s) Avert did not make; leaving the branch alone.`);
  }
  // One commit on the base, built with the git data API so the branch never equals the base (GitHub would close the PR).
  const baseTree = (await gh('GET', `/repos/${target}/git/commits/${sha}`)).tree.sha;
  const modes = new Map<string, string>((await gh('GET', `/repos/${target}/git/trees/${baseTree}?recursive=1`)).tree.map((e: any) => [e.path, e.mode]));
  const tree = await gh('POST', `/repos/${target}/git/trees`, {
    base_tree: baseTree,
    tree: [...files].filter(([, f]) => f.text !== f.original).map(([filePath, f]) => ({ path: filePath, mode: modes.get(filePath) ?? '100644', type: 'blob', content: f.text })),
  });
  const commit = await gh('POST', `/repos/${target}/git/commits`, {
    message: `fix: ${edit.from} -> ${edit.to} (${finding.change.summary})\n\nAvert-Change: ${finding.change.id}`, tree: tree.sha, parents: [sha],
  });
  if (head) await gh('PATCH', `/repos/${target}/git/refs/heads/${branch}`, { sha: commit.sha, force: true });
  else await gh('POST', `/repos/${target}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });

  const pull = {
    title: `Avert: replace ${edit.from} with ${edit.to}`,
    body: [
      `**Change:** ${finding.change.summary} ([source](${finding.change.source_url}))`,
      `**Fix:** \`${edit.from}\` → \`${edit.to}\` at ${sites.map((x) => `\`${x}\``).join(', ')} (from ${edit.source}).`,
      `**Reaches:** ${finding.routes.map((r: string) => `\`${r}\``).join(', ') || 'no known route'}${finding.owners.length ? `, owned by ${finding.owners.join(', ')}` : ''}.`,
      `### Path\n\n${fence(path)}`,
      `---\n_Opened by [Avert](https://github.com/daryl-micah/avert). Nothing is merged automatically; review before merging._`,
    ].join('\n\n'),
  };
  const pr = open ? await gh('PATCH', `/repos/${target}/pulls/${open.number}`, pull) : await gh('POST', `/repos/${target}/pulls`, { ...pull, head: branch, base });
  await setStatus(args.repo, args.finding_id, 'done', pr.html_url);
  return { url: pr.html_url, branch, updated: !!open, edit, finding_id: args.finding_id, path };
}
