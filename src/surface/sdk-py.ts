import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse, walk, type Node } from '../indexer/parse.js';
import { snake } from './providers.js';
import { docText, MAX_DEPTH, MAX_OPS, SKIP_MEMBERS, type ParamInfo, type Surface } from './surface.js';

// Public surface of a PyPI SDK, read from its wheel by walking from the root client class.

interface PyMember { name: string; types: string[]; deprecated: boolean; doc?: string }
interface PyMethod { name: string; params: { name: string; types: string[] }[]; deprecated: boolean }
interface PyClass { name: string; file: string; bases: string[]; props: PyMember[]; methods: PyMethod[]; fields: PyMember[] }

const SKIP_PARAMS = new Set(['self', 'cls', 'extra_headers', 'extra_query', 'extra_body', 'timeout', 'options', 'request_options', 'callback']);
const NOT_TYPES = new Set(['Optional', 'Union', 'List', 'Dict', 'Iterable', 'Sequence', 'Literal', 'NotRequired', 'Required', 'Mapping', 'Type', 'Any', 'None', 'NotGiven', 'Omit', 'Annotated', 'Callable', 'Awaitable', 'Tuple', 'TypedDict', 'RequestOptions', 'str', 'int', 'float', 'bool', 'object']);

/** Class names mentioned in an annotation, e.g. `Optional["chat.Chat"]` -> ["Chat"]. */
function typeNames(annotation: string | undefined): string[] {
  if (!annotation) return [];
  return [...annotation.replace(/["']/g, '').matchAll(/(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)/g)].map((m) => m[1]).filter((n) => !NOT_TYPES.has(n) && /^[A-Z]/.test(n));
}

const decorators = (fn: Node) => fn.parent?.type === 'decorated_definition'
  ? fn.parent.namedChildren.filter((c) => c?.type === 'decorator').map((c) => c!.text) : [];

function readClasses(file: string, root: Node): PyClass[] {
  const out: PyClass[] = [];
  walk(root, (n) => {
    if (n.type !== 'class_definition') return;
    const cls: PyClass = {
      name: n.childForFieldName('name')!.text, file, props: [], methods: [], fields: [],
      bases: (n.childForFieldName('superclasses')?.namedChildren ?? []).flatMap((b) => (b ? typeNames(b.text) : [])),
    };
    for (const stmt of n.childForFieldName('body')!.namedChildren) {
      if (!stmt) continue;
      const def = stmt.type === 'decorated_definition' ? stmt.childForFieldName('definition') : stmt;
      if (def?.type === 'function_definition') {
        if (def.children.some((c) => c?.type === 'async')) continue;
        const name = def.childForFieldName('name')!.text;
        const decs = decorators(def);
        const deprecated = decs.some((d) => /deprecated/i.test(d));
        if (decs.some((d) => /^@(cached_property|property|functools\.cached_property)/.test(d))) {
          cls.props.push({ name, types: typeNames(def.childForFieldName('return_type')?.text), deprecated });
        } else {
          const params: PyMethod['params'] = [];
          for (const p of def.childForFieldName('parameters')!.namedChildren) {
            if (!p || /splat|separator/.test(p.type)) continue;
            const pname = (p.childForFieldName('name') ?? (p.type === 'identifier' ? p : p.namedChildren[0]))?.text;
            if (pname && !SKIP_PARAMS.has(pname)) params.push({ name: pname.replace(/_$/, ''), types: typeNames(p.childForFieldName('type')?.text) });
          }
          cls.methods.push({ name, params, deprecated });
          if (name === '__init__') {
            // self.x = Service(...) assignments expose sub-resources
            walk(def, (a) => {
              if (a.type !== 'assignment') return;
              const left = a.childForFieldName('left')?.text ?? '';
              const right = a.childForFieldName('right');
              const m = left.match(/^self\.([a-z]\w*)$/);
              if (m && right?.type === 'call') cls.props.push({ name: m[1], types: typeNames(right.childForFieldName('function')!.text), deprecated: false });
            });
          }
        }
      } else if (stmt.type === 'expression_statement' && stmt.namedChildren[0]?.type === 'assignment') {
        const a = stmt.namedChildren[0]!;
        const left = a.childForFieldName('left');
        const t = a.childForFieldName('type');
        if (left?.type === 'identifier' && t) {
          const next = stmt.nextNamedSibling;
          const doc = next?.type === 'expression_statement' && next.namedChildren[0]?.type === 'string' ? docText(next.text) : undefined;
          const m: PyMember = { name: left.text, types: typeNames(t.text), deprecated: false, ...(doc ? { doc } : {}) };
          cls.fields.push(m);
          cls.props.push(m);
        }
      }
    }
    out.push(cls);
  });
  return out;
}

/** `from .resources.messages import Messages` -> Messages: "pkg/resources/messages" (path prefix, repo-relative). */
function readImports(file: string, root: Node): Map<string, string> {
  const out = new Map<string, string>();
  walk(root, (n) => {
    if (n.type !== 'import_from_statement') return;
    const mod = n.childForFieldName('module_name')!.text;
    const dots = mod.match(/^\.*/)![0].length;
    let base = file.split('/').slice(0, -1);
    if (dots) base = base.slice(0, base.length - (dots - 1));
    else base = [];
    const path = [...base, ...mod.slice(dots).split('.').filter(Boolean)].join('/');
    for (const c of n.childrenForFieldName('name')) {
      if (!c) continue;
      const local = c.type === 'aliased_import' ? c.childForFieldName('alias')!.text : c.text;
      out.set(local, path);
    }
    return false;
  });
  return out;
}

function pyFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!/^(tests?|_vendor|\w+\.dist-info)$/.test(e.name)) out.push(...pyFiles(p)); }
    else if (e.name.endsWith('.py') && statSync(p).size < 4_000_000) out.push(p);
  }
  return out;
}

/** `rootModule` like "openai" or "google.genai" narrows where the root class is looked up. */
export async function pySurface(pkgDir: string, rootClass: string, rootModule: string): Promise<Surface> {
  const byName = new Map<string, PyClass[]>();
  const imports = new Map<string, Map<string, string>>();
  for (const f of pyFiles(pkgDir)) {
    const rel = relative(pkgDir, f).split(sep).join('/');
    const tree = await parse('py', readFileSync(f, 'utf8'));
    imports.set(rel, readImports(rel, tree));
    for (const c of readClasses(rel, tree)) {
      if (/^Async|WithRawResponse$|WithStreamingResponse$|WithStreamedResponse$/.test(c.name)) continue;
      byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
    }
  }
  const resolve = (name: string, hint: string, from?: string): PyClass | undefined => {
    const cands = byName.get(name);
    if (!cands?.length) return undefined;
    if (cands.length === 1) return cands[0];
    const via = from ? imports.get(from)?.get(name) : undefined;
    const imported = via ? cands.find((c) => c.file === `${via}.py` || c.file.startsWith(`${via}/`)) : undefined;
    const shallow = [...cands].sort((a, b) => a.file.split('/').length - b.file.split('/').length);
    return imported ?? cands.find((c) => c.file === from) ?? shallow.find((c) => c.file.includes(snake(hint))) ?? shallow[0];
  };
  const fields = (types: string[], hint: string, from: string, depth = 0, acc = new Map<string, ParamInfo>()) => {
    for (const t of types) {
      const c = depth < 5 ? resolve(t, hint, from) : undefined;
      if (!c) continue;
      for (const f of c.fields) if (!acc.has(f.name)) acc.set(f.name, { deprecated: f.deprecated, ...(f.doc ? { doc: f.doc } : {}) });
      fields(c.bases, hint, c.file, depth + 1, acc);
    }
    return acc;
  };

  const surface: Surface = new Map();
  const visit = (cls: PyClass, path: string[], deprecated: boolean, stack: Set<PyClass>) => {
    if (path.length > MAX_DEPTH || surface.size > MAX_OPS) return;
    const next = new Set(stack).add(cls);
    const chainCls = [cls, ...cls.bases.map((b) => resolve(b, '', cls.file)).filter((b): b is PyClass => !!b && !stack.has(b))];
    for (const c of chainCls) {
      if (path.length) {
        for (const m of c.methods) {
          if (m.name.startsWith('_') || SKIP_MEMBERS.has(m.name)) continue;
          const params = new Map<string, ParamInfo>();
          for (const p of m.params) {
            if (p.name === 'params' && p.types.length) fields(p.types, path[path.length - 1], c.file, 0, params);
            else if (!params.has(p.name)) params.set(p.name, { deprecated: false });
          }
          const key = [...path, m.name].map(snake).join('.');
          const prev = surface.get(key);
          if (prev) { for (const [k, v] of params) prev.params[k] ??= v; }
          else surface.set(key, { resource: path, method: m.name, deprecated: deprecated || m.deprecated, params: Object.fromEntries(params) });
        }
      }
      for (const p of c.props) {
        if (p.name.startsWith('_') || SKIP_MEMBERS.has(p.name)) continue;
        for (const t of p.types) {
          const target = resolve(t, p.name, c.file);
          if (target && !next.has(target) && (target.methods.length || target.props.length)) visit(target, [...path, p.name], deprecated || p.deprecated, next);
        }
      }
    }
  };
  const dir = rootModule.replace(/\./g, '/') + '/';
  const roots = (byName.get(rootClass) ?? []).filter((c) => c.file.startsWith(dir)).sort((a, b) => b.props.length - a.props.length);
  if (!roots.length) throw new Error(`root client class ${rootClass} not found under ${dir}`);
  visit(roots[0], [], false, new Set());
  return surface;
}
