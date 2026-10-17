import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fetchPackage, type Ecosystem } from './fetch.js';
import { ids, provider as providerInfo } from './providers.js';
import { pySurface } from './sdk-py.js';
import { tsSurface } from './sdk-ts.js';
import type { Surface, SurfaceOp } from './surface.js';

export type ChangeKind = 'removed' | 'renamed' | 'deprecated' | 'retired' | 'added';
export const SEVERITY: Record<ChangeKind, string> = { removed: 'high', renamed: 'high', retired: 'high', deprecated: 'medium', added: 'info' };

export interface Change {
  id: string;
  kind: ChangeKind;
  severity: string;
  provider: string;
  summary: string;
  source: string;            // "npm:stripe@22.0.0..23.0.0" | "lifecycle:anthropic"
  source_url: string;
  effective_date: string | null;
  target: { level: 'operation' | 'param' | 'value'; resource: string[]; method: string; param?: string; value?: string };
  replacement?: { level: 'operation' | 'param' | 'value'; resource: string[]; method: string; param?: string; value?: string };
  release?: { ecosystem: Ecosystem; package: string; from: string; version: string; date?: string };
}

const SURFACE_FORMAT = 3;

/** Extract (and cache next to the unpacked package) the public surface of one SDK version. */
export async function surfaceOf(providerId: string, eco: Ecosystem, version: string): Promise<Surface> {
  const p = providerInfo(providerId);
  const pkg = eco === 'npm' ? p.npm : p.pypi;
  const dir = await fetchPackage(eco, pkg, version);
  const cache = join(dirname(dir), `surface.v${SURFACE_FORMAT}.json`);
  if (existsSync(cache)) return new Map(JSON.parse(readFileSync(cache, 'utf8')));
  const rootModule = Object.keys(p.py.imports)[0];
  const s = eco === 'npm' ? await tsSurface(dir, p.sdk.ts) : await pySurface(dir, p.sdk.py, rootModule);
  writeFileSync(cache, JSON.stringify([...s]));
  return s;
}

/**
 * Compare two surfaces. Operations and params that disappear are `removed`; when exactly one param
 * disappears and one appears on the same operation it is a `renamed` with a replacement.
 * Newly deprecated operations/params are `deprecated`; new operations/params are `added`.
 */
export function diffSurfaces(before: Surface, after: Surface): Omit<Change, 'id' | 'provider' | 'source' | 'source_url' | 'effective_date' | 'severity' | 'summary'>[] {
  const out: ReturnType<typeof diffSurfaces> = [];
  const op = (o: SurfaceOp) => ({ resource: o.resource, method: o.method });
  for (const [key, b] of before) {
    const a = after.get(key);
    if (!a) { out.push({ kind: 'removed', target: { level: 'operation', ...op(b) } }); continue; }
    if (a.deprecated && !b.deprecated) out.push({ kind: 'deprecated', target: { level: 'operation', ...op(b) } });
    const gone = Object.keys(b.params).filter((p) => !(p in a.params));
    const added = Object.keys(a.params).filter((p) => !(p in b.params));
    // a removed param is `renamed` when its replacement is unambiguous: the only add, or the only add whose name extends it
    // (stripe 23: payment_method_types -> allowed_payment_method_types)
    const replacedBy = new Map<string, string>();
    for (const p of gone) {
      const named = added.filter((x) => x.endsWith('_' + p) || x.startsWith(p + '_'));
      const r = gone.length === 1 && added.length === 1 ? added[0] : named.length === 1 ? named[0] : undefined;
      if (r && ![...replacedBy.values()].includes(r)) replacedBy.set(p, r);
    }
    for (const p of gone) {
      const r = replacedBy.get(p);
      // removed in favour of a param that already existed: still `removed`, but with a replacement
      const existing = Object.keys(a.params).filter((x) => b.params[x] && (x.endsWith('_' + p) || x.startsWith(p + '_')));
      if (r) out.push({ kind: 'renamed', target: { level: 'param', ...op(b), param: p }, replacement: { level: 'param', ...op(a), param: r } });
      else if (existing.length === 1) out.push({ kind: 'removed', target: { level: 'param', ...op(b), param: p }, replacement: { level: 'param', ...op(a), param: existing[0] } });
      else out.push({ kind: 'removed', target: { level: 'param', ...op(b), param: p } });
    }
    for (const p of added) if (![...replacedBy.values()].includes(p)) out.push({ kind: 'added', target: { level: 'param', ...op(a), param: p } });
    for (const p of Object.keys(b.params)) {
      if (a.params[p]?.deprecated && !b.params[p].deprecated) out.push({ kind: 'deprecated', target: { level: 'param', ...op(b), param: p } });
    }
  }
  for (const [key, a] of after) if (!before.has(key)) out.push({ kind: 'added', target: { level: 'operation', ...op(a) } });
  return out;
}

export function targetId(provider: string, t: Change['target']): string {
  const opId = ids.operation(provider, t.resource, t.method);
  if (t.level === 'operation') return opId;
  const param = ids.param(opId, t.param!);
  return t.level === 'param' ? param : ids.value(param, t.value!);
}

function describe(c: Pick<Change, 'kind' | 'target' | 'replacement'>, provider: string): string {
  const what = targetId(provider, c.target);
  if (c.kind === 'renamed') return `${what} renamed to ${c.replacement!.param}`;
  return `${what} ${c.kind}${c.replacement?.param ? `; use ${c.replacement.param}` : ''}`;
}

/** Diff two published versions of a provider's SDK and describe each change. */
export async function diffReleases(providerId: string, eco: Ecosystem, from: string, to: string): Promise<Change[]> {
  const p = providerInfo(providerId);
  const pkg = eco === 'npm' ? p.npm : p.pypi;
  const [before, after] = await Promise.all([surfaceOf(providerId, eco, from), surfaceOf(providerId, eco, to)]);
  const url = eco === 'npm' ? `https://www.npmjs.com/package/${pkg}/v/${to}` : `https://pypi.org/project/${pkg}/${to}/`;
  return diffSurfaces(before, after).map((c) => ({
    ...c,
    id: `sdk:${eco}:${pkg}@${to}:${c.kind}:${targetId(providerId, c.target)}`,
    provider: providerId,
    severity: SEVERITY[c.kind],
    summary: describe(c, providerId),
    source: `${eco}:${pkg}@${from}..${to}`,
    source_url: url,
    effective_date: null,
    release: { ecosystem: eco, package: pkg, from, version: to },
  }));
}
