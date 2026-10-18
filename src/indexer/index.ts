import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, relative, resolve, sep } from 'node:path';
import { ensureSchema, graph, graphName, run } from '../db.js';
import * as Q from '../queries.js';
import { ids, isPinned, provider as providerInfo } from '../surface/providers.js';
import { writeSurface } from '../surface/write.js';
import { owners } from './owners.js';
import { extractPy } from './py.js';
import { extractTs } from './ts.js';
import type { FileFacts, ImportFact, ImportedClients } from './types.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'venv', '.venv', 'env', '__pycache__', 'site-packages', 'coverage', '.turbo', 'vendor']);
const TS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts'];
const COMMON_NAMES = new Set(['get', 'set', 'run', 'main', 'init', 'create', 'update', 'delete', 'list', 'send', 'call', 'handle', 'render', 'parse', 'load', 'save', 'close', 'open', 'start', 'stop', 'json', 'then', 'catch', 'push', 'map', 'filter', 'find', 'post', 'put', 'patch', 'use']);

export interface IndexResult { graph: string; files: number; functions: number; routes: number; callSites: number; ms: number }

/** Clone a GitHub URL (shallow) into the cache, or return the local path. */
export function checkout(repo: string): { root: string; url: string } {
  if (!/^https?:\/\/|^git@/.test(repo)) return { root: resolve(repo), url: resolve(repo) };
  repo = repo.replace(/\/+$/, '');
  const dir = join(process.env.AVERT_CACHE ?? join(homedir(), '.cache', 'avert', 'repos'), graphName(repo).slice('avert:'.length));
  if (existsSync(dir)) {
    // The cache is keyed by graph name, so make sure this checkout really is the repo asked for before pulling into it.
    const origin = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    if (origin.replace(/\.git$/, '') !== repo.replace(/\.git$/, '')) throw new Error(`${dir} is a checkout of ${origin}, not ${repo}; set AVERT_CACHE or remove it.`);
    execFileSync('git', ['-C', dir, 'pull', '--ff-only', '-q'], { stdio: 'ignore' });
  } else execFileSync('git', ['clone', '--depth', '1', '-q', repo, dir], { stdio: 'ignore' });
  return { root: dir, url: repo.replace(/\.git$/, '') };
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue; // a cloned repo could link a source file to anything on this machine
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) visit(join(dir, e.name)); continue; }
      if (e.name.endsWith('.d.ts')) continue;
      if (e.name.endsWith('.py') || TS_EXT.some((x) => e.name.endsWith(x))) {
        if (statSync(join(dir, e.name)).size < 1_000_000) out.push(relative(root, join(dir, e.name)).split(sep).join('/'));
      }
    }
  };
  visit(root);
  return out;
}

/** Declared SDK version per (directory, package), from package.json / requirements*.txt / pyproject.toml. */
function manifests(root: string, files: string[]): (file: string, pkg: string) => string | undefined {
  const byDir = new Map<string, Record<string, string>>();
  const dirs = new Set(files.map((f) => posix.dirname(f)));
  for (const d of [...dirs].flatMap((d) => d.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))).concat('.')) {
    if (byDir.has(d)) continue;
    const deps: Record<string, string> = {};
    const base = join(root, d);
    try {
      const pj = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
      Object.assign(deps, pj.devDependencies, pj.dependencies);
    } catch { /* none */ }
    for (const f of existsSync(base) ? readdirSync(base) : []) {
      if (!/^requirements.*\.txt$|^pyproject\.toml$/.test(f)) continue;
      for (const m of readFileSync(join(base, f), 'utf8').matchAll(/^\s*"?([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*((?:[=<>~!^]=?|\s=\s*")\s*[^"\s,;#]+)?/gm)) {
        deps[m[1].toLowerCase()] ??= (m[2] ?? '*').replace(/[\s"=]*$/,'').replace(/^\s*=\s*"/, '').trim() || '*';
      }
    }
    byDir.set(d, deps);
  }
  return (file, pkg) => {
    for (let d = posix.dirname(file); ; d = posix.dirname(d)) {
      const v = byDir.get(d)?.[pkg];
      if (v) return v;
      if (d === '.' || d === '/' || d === '') return byDir.get('.')?.[pkg];
    }
  };
}

/** Resolve an import to a repo file, or undefined for third-party modules. */
function resolveModule(from: FileFacts, imp: ImportFact, all: Set<string>): string | undefined {
  if (from.lang === 'ts') {
    const spec = imp.module;
    const candidates: string[] = [];
    if (spec.startsWith('.')) candidates.push(posix.normalize(posix.join(posix.dirname(from.path), spec)));
    else if (spec.startsWith('@/') || spec.startsWith('~/')) candidates.push('src/' + spec.slice(2), spec.slice(2));
    else return undefined;
    for (const c of candidates) {
      const stem = c.replace(/\.(m?js|jsx)$/, '');
      for (const x of [c, ...TS_EXT.map((e) => stem + e), ...TS_EXT.map((e) => `${stem}/index${e}`)]) if (all.has(x)) return x;
    }
    return undefined;
  }
  // python: absolute dotted module (match by path suffix) or relative (.mod / ..mod)
  const m = imp.module.match(/^(\.*)(.*)$/)!;
  const parts = m[2] ? m[2].split('.') : [];
  const sub = imp.imported !== '*' ? [...parts, imp.imported] : parts; // `from app import billing` may name a module
  const tryPaths = (segs: string[], base?: string) => {
    const rel = segs.join('/');
    const opts = [`${rel}.py`, `${rel}/__init__.py`];
    if (base !== undefined) return opts.map((o) => posix.normalize(posix.join(base, o))).find((o) => all.has(o));
    return [...all].filter((f) => opts.some((o) => f === o || f.endsWith('/' + o))).sort((a, b) => a.length - b.length)[0];
  };
  if (m[1]) {
    let base = posix.dirname(from.path);
    for (let i = 1; i < m[1].length; i++) base = posix.dirname(base);
    return tryPaths(sub, base) ?? tryPaths(parts, base);
  }
  return tryPaths(sub) ?? tryPaths(parts);
}

export async function indexRepo(repo: string): Promise<IndexResult> {
  const t0 = Date.now();
  const { root, url } = checkout(repo);
  const gname = graphName(repo);
  const files = sourceFiles(root);
  const all = new Set(files);
  const read = (f: string) => readFileSync(join(root, f), 'utf8');
  const extract = (f: string, imported: ImportedClients) => (f.endsWith('.py') ? extractPy(f, read(f), imported) : extractTs(f, read(f), imported));

  // Pass 1: extract every file. Pass 2: re-extract files that import a client another file exports.
  const facts = new Map<string, FileFacts>();
  for (const f of files) {
    try { facts.set(f, await extract(f, new Map())); } catch (e) { console.error(`skip ${f}: ${(e as Error).message}`); }
  }
  const exported = new Map([...facts].filter(([, ff]) => ff.exportedClients.length).map(([f, ff]) => [f, ff.exportedClients]));
  for (const ff of [...facts.values()]) {
    const imported: ImportedClients = new Map();
    for (const imp of ff.imports) {
      const target = resolveModule(ff, imp, all);
      const clients = target ? exported.get(target) : undefined;
      if (!clients) continue;
      if (imp.imported === '*') for (const c of clients) imported.set(`${imp.local}.${c.name}`, c.provider);
      else {
        const c = clients.find((c) => c.name === imp.imported);
        if (c) imported.set(imp.local, c.provider);
      }
    }
    if (imported.size) facts.set(ff.path, await extract(ff.path, imported));
  }

  // --- resolve functions, calls, routes
  const fnId = (file: string, name: string) => `${file}::${name}`;
  const fnsByFile = new Map([...facts].map(([f, ff]) => [f, new Set(ff.functions.map((x) => x.name))]));
  const byShortName = new Map<string, string[]>();
  for (const [f, ff] of facts) for (const fn of ff.functions) {
    const short = fn.name.split('.').pop()!;
    byShortName.set(short, [...(byShortName.get(short) ?? []), fnId(f, fn.name)]);
  }
  const lookup = (file: string | undefined, name: string) => (file && fnsByFile.get(file)?.has(name) ? fnId(file, name) : undefined);

  const resolveCallee = (ff: FileFacts, from: string, callee: string[]): { to: string; via: string } | undefined => {
    const [head, ...rest] = callee;
    if (callee.length === 1) {
      const local = lookup(ff.path, head);
      if (local) return { to: local, via: 'local' };
      const imp = ff.imports.find((i) => i.local === head);
      if (imp) {
        const target = resolveModule(ff, imp, all);
        const name = imp.imported === 'default' ? head : imp.imported;
        const hit = lookup(target, name);
        if (hit) return { to: hit, via: 'import' };
      }
    } else if ((head === 'self' || head === 'this') && callee.length === 2) {
      const cls = from.split('.')[0];
      const hit = lookup(ff.path, `${cls}.${rest[0]}`);
      if (hit) return { to: hit, via: 'local' };
    } else if (callee.length === 2) {
      const imp = ff.imports.find((i) => i.local === head);
      if (imp) {
        const target = resolveModule(ff, imp, all);
        const hit = lookup(target, rest[0]);
        if (hit) return { to: hit, via: 'import' };
      }
      const cls = lookup(ff.path, `${head}.${rest[0]}`); // Class.method / static
      if (cls) return { to: cls, via: 'local' };
    }
    // last resort: a method name that exists exactly once in the repo
    const short = callee[callee.length - 1];
    const cands = byShortName.get(short);
    if (callee.length > 1 && short.length >= 4 && !COMMON_NAMES.has(short) && cands?.length === 1) return { to: cands[0], via: 'name' };
    return undefined;
  };

  const owned = owners(root);
  const version = manifests(root, files);
  const run_ = new Date().toISOString();
  const rows = { files: [] as any[], fns: [] as any[], calls: [] as any[], routes: [] as any[], owners: [] as any[], sites: [] as any[], uses: [] as any[], passes: [] as any[] };

  for (const [f, ff] of facts) {
    const fileId = f;
    rows.files.push({ id: fileId, path: f, lang: ff.lang });
    for (const t of owned(f)) rows.owners.push({ file: fileId, team: t });
    for (const fn of ff.functions) rows.fns.push({ id: fnId(f, fn.name), file: fileId, path: f, name: fn.name, line: fn.line });
    for (const c of ff.calls) {
      const r = resolveCallee(ff, c.from, c.callee);
      if (r && r.to !== fnId(f, c.from)) rows.calls.push({ from: fnId(f, c.from), to: r.to, line: c.line, via: r.via });
    }
    for (const rt of ff.routes) {
      const h = resolveCallee(ff, '<module>', rt.handler.split('.'));
      const handler = lookup(f, rt.handler) ?? h?.to;
      if (handler) rows.routes.push({ id: `${f}:${rt.method} ${rt.path}`, method: rt.method, path: rt.path, file: f, line: rt.line, handler });
    }
    for (const s of ff.callSites) {
      const op = ids.operation(s.provider, s.resource, s.method);
      const id = `${f}:${s.line}:${op}`;
      const p = providerInfo(s.provider);
      const literal = s.args.some((a) => a.binding === 'literal' && a.values.length);
      rows.sites.push({
        id, fn: fnId(f, s.fn), op, file: f, line: s.line, snippet: s.snippet, provider: s.provider,
        sdk_version: version(f, ff.lang === 'py' ? p.pypi : p.npm) ?? null, binding: literal ? 'literal' : s.args.length ? 'dynamic' : 'absent',
        _site: s,
      });
      for (const a of s.args) {
        const param = ids.param(op, a.name);
        rows.uses.push({ cs: id, param, op, name: a.name, binding: a.binding });
        a.values.forEach((v, i) => {
          const order = s.fallbackDepth + i;
          rows.passes.push({ cs: id, param, id: ids.value(param, v), value: v, pinned: isPinned(v), role: order === 0 ? 'primary' : 'fallback', order });
        });
      }
    }
  }

  // --- write
  const g = await graph(repo);
  // Two repos can map to one graph name (same directory name, say); never mix them or let re-indexing one delete the other.
  const [prev] = await run(g, `MATCH (r:Repo) RETURN r.url AS url LIMIT 1`);
  if (prev && prev.url !== url) throw new Error(`${gname} already holds ${prev.url}; ${url} would overwrite it. Index it from a differently named directory.`);
  await ensureSchema(g);
  await run(g, Q.UPSERT_REPO, { id: gname, url, run: run_ });
  await writeSurface(g, rows.sites.map((s) => ({ provider: s._site.provider, resource: s._site.resource, method: s._site.method, params: s._site.args.map((a: any) => a.name) })));
  const batches: [string, any[]][] = [
    [Q.UPSERT_FILES, rows.files], [Q.UPSERT_FUNCTIONS, rows.fns], [Q.UPSERT_CALLS, rows.calls], [Q.UPSERT_ROUTES, rows.routes],
    [Q.UPSERT_OWNERS, rows.owners], [Q.UPSERT_CALL_SITES, rows.sites.map(({ _site, ...r }) => r)], [Q.UPSERT_USES, rows.uses], [Q.UPSERT_PASSES, rows.passes],
  ];
  for (const [q, data] of batches) for (let i = 0; i < data.length; i += 500) await run(g, q, { rows: data.slice(i, i + 500), repo: gname, run: run_ });
  for (const q of Q.DELETE_STALE) await run(g, q, { run: run_ });

  return { graph: gname, files: facts.size, functions: rows.fns.length, routes: rows.routes.length, callSites: rows.sites.length, ms: Date.now() - t0 };
}

