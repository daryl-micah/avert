import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { graph, run } from './db.js';
import * as Q from './queries.js';
import { latest, versions, type Ecosystem } from './surface/fetch.js';
import { DATA_DIR, ids, isPinned, provider as providerInfo, providers } from './surface/providers.js';
import { diffReleases, SEVERITY, targetId, type Change } from './surface/sdk-diff.js';
import { writeSurface } from './surface/write.js';
import { impactOf } from './tools.js';

const today = () => new Date().toISOString().slice(0, 10);

/** Write change events (and the surface nodes they point at) into a repo graph. */
export async function ingestChanges(repo: string, changes: Change[]): Promise<void> {
  const g = await graph(repo);
  const refs = changes.flatMap((c) => [c.target, ...(c.replacement ? [c.replacement] : [])].map((t) => ({ provider: c.provider, resource: t.resource, method: t.method, params: t.param ? [t.param] : [] })));
  await writeSurface(g, refs);
  const now = new Date().toISOString();
  for (const c of changes) {
    await run(g, Q.UPSERT_CHANGE, { id: c.id, kind: c.kind, severity: c.severity, summary: c.summary, provider: c.provider, source: c.source, source_url: c.source_url, effective_date: c.effective_date, target: targetId(c.provider, c.target), now });
    if (c.release) await run(g, Q.UPSERT_RELEASE, { change: c.id, id: `${c.release.ecosystem}:${c.release.package}@${c.release.version}`, ...c.release });
    if (c.replacement) await run(g, Q.UPSERT_REPLACEMENT, { change: c.id, target: targetId(c.provider, c.replacement) });
  }
}

/** Resolve a manifest spec such as "^22.6.0", "==1.40.0" or ">=0.34" to the lowest published version it allows. */
async function minVersion(eco: Ecosystem, pkg: string, spec: string | null): Promise<string | undefined> {
  const clean = spec?.replace(/^[\^~>=<!\s]+/, '').split(/[,\s]/)[0];
  if (!clean || clean === '*' || clean === 'latest') return undefined;
  const all = (await versions(eco, pkg)).map((v) => v.version).filter((v) => !/[a-z]/i.test(v));
  return all.find((v) => v === clean) ?? all.find((v) => v.startsWith(clean + '.'));
}

/**
 * SDK change source: for each provider SDK the repo calls, diff the version its manifest declares
 * against `to` (default: latest) and keep the changes that touch operations the repo invokes.
 */
export async function syncSdk(repo: string, opts: { to?: Record<string, string> } = {}): Promise<Change[]> {
  const g = await graph(repo);
  const used = await run(g, Q.USED_OPERATIONS);
  const usedOps = new Set(used.map((u) => u.id));
  const groups = new Map<string, { provider: string; eco: Ecosystem; spec: string | null }>();
  for (const u of used) {
    for (const file of u.files as string[]) {
      const eco: Ecosystem = file.endsWith('.py') ? 'pypi' : 'npm';
      const key = `${u.provider}:${eco}`;
      if (!groups.has(key)) groups.set(key, { provider: u.provider, eco, spec: (u.versions as string[]).find(Boolean) ?? null });
    }
  }
  const all: Change[] = [];
  for (const { provider, eco, spec } of groups.values()) {
    const p = providerInfo(provider);
    const pkg = eco === 'npm' ? p.npm : p.pypi;
    let changes: Change[];
    try {
      const from = await minVersion(eco, pkg, spec);
      const to = opts.to?.[pkg] ?? (await latest(eco, pkg));
      if (!from || from === to) continue;
      changes = await diffReleases(provider, eco, from, to);
    } catch (e) {
      // e.g. the pinned release has no wheel: skip this SDK diff, lifecycle changes still apply
      console.warn(`sync: skipped ${pkg} SDK diff: ${(e as Error).message}`);
      continue;
    }
    const relevant = changes.filter((c) => usedOps.has(targetId(provider, { ...c.target, level: 'operation' })));
    await ingestChanges(repo, relevant);
    all.push(...relevant);
  }
  return all;
}

interface LifecycleFile {
  provider: string; param: string; source_url: string; retrieved: string;
  models: { id: string; announced?: string; retires: string; replacement?: string }[];
  aliases: { alias: string; resolves_to: string; source_url: string; note?: string }[];
}

export function lifecycleData(): LifecycleFile[] {
  return readdirSync(DATA_DIR + 'lifecycle').filter((f) => f.endsWith('.yaml')).map((f) => parse(readFileSync(DATA_DIR + 'lifecycle/' + f, 'utf8')));
}

/**
 * Lifecycle change source: match the repo's literal model values (and the dated models its aliases
 * resolve to) against published retirement data. Past the retirement date a model is `retired`;
 * before it, `deprecated` with the date as effective_date.
 */
export async function syncLifecycle(repo: string): Promise<Change[]> {
  const g = await graph(repo);
  const out: Change[] = [];
  for (const lf of lifecycleData()) {
    if (!providers().some((p) => p.id === lf.provider)) continue;
    const values = await run(g, Q.MODEL_VALUES, { provider: lf.provider, param: lf.param });
    // aliases: link the unpinned value to the dated model it resolves to
    for (const v of values) {
      const a = lf.aliases?.find((x) => x.alias === v.value);
      if (a) {
        await run(g, Q.UPSERT_ALIAS, { alias: v.id, param: v.param, target: ids.value(v.param, a.resolves_to), value: a.resolves_to, source_url: a.source_url });
        values.push({ id: ids.value(v.param, a.resolves_to), value: a.resolves_to, param: v.param });
      }
    }
    for (const v of values) {
      const m = lf.models.find((x) => x.id === v.value);
      if (!m) continue;
      const kind = m.retires <= today() ? 'retired' : 'deprecated';
      const id = `lifecycle:${lf.provider}:${m.id}`;
      const [resource, method] = [v.param.split('#')[0].split('.').slice(1, -1), v.param.split('#')[0].split('.').pop()!];
      const target = { level: 'value' as const, resource, method, param: lf.param, value: m.id };
      const c: Change = {
        id, kind, severity: SEVERITY[kind], provider: lf.provider,
        summary: `${m.id} ${kind === 'retired' ? `retired on ${m.retires}` : `retires on ${m.retires}`}${m.replacement ? `; replacement ${m.replacement}` : ''}`,
        source: `lifecycle:${lf.provider} (retrieved ${lf.retrieved})`, source_url: lf.source_url, effective_date: String(m.retires),
        target, ...(m.replacement ? { replacement: { ...target, value: m.replacement } } : {}),
      };
      if (m.replacement) await run(g, Q.UPSERT_VALUE, { param: v.param, id: ids.value(v.param, m.replacement), value: m.replacement, pinned: isPinned(m.replacement) });
      await run(g, Q.UPSERT_CHANGE, { id, kind, severity: c.severity, summary: c.summary, provider: lf.provider, source: c.source, source_url: c.source_url, effective_date: c.effective_date, target: v.id, now: new Date().toISOString() });
      if (m.replacement) await run(g, Q.UPSERT_REPLACEMENT, { change: id, target: ids.value(v.param, m.replacement) });
      out.push(c);
    }
  }
  return out;
}

/** One finding per (change, reached call site). `added` changes are notices only and never become findings. */
export async function createFindings(repo: string): Promise<number> {
  const g = await graph(repo);
  const changes = await run(g, `MATCH (c:ChangeEvent) WHERE c.kind <> 'added' RETURN c.id AS id, c.summary AS summary`);
  const rows: any[] = [];
  for (const c of changes) {
    for (const i of await impactOf(repo, c.id)) {
      rows.push({ id: `${c.id}|${i.callsite.id}`, change: c.id, callsite: i.callsite.id, routes: i.routes, owners: i.owners, summary: c.summary });
    }
  }
  if (rows.length) await run(g, Q.UPSERT_FINDINGS, { rows, now: new Date().toISOString() });
  return rows.length;
}
