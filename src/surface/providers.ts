import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export interface ImportSpec { ctors: string[]; call?: boolean; module_client?: boolean }
export interface Provider {
  id: string;
  name: string;
  npm: string;
  pypi: string;
  ts: { imports: Record<string, ImportSpec> };
  py: { imports: Record<string, ImportSpec> };
  sdk: { ts: string; py: string };
}

export const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));

let cache: Provider[] | undefined;
export function providers(): Provider[] {
  if (!cache) {
    const raw = parse(readFileSync(DATA_DIR + 'providers.yaml', 'utf8')) as Record<string, Omit<Provider, 'id'>>;
    cache = Object.entries(raw).map(([id, p]) => ({ id, ...p }));
  }
  return cache;
}

export function provider(id: string): Provider {
  const p = providers().find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

/** camelCase / PascalCase -> snake_case, so TS and Python call sites share one surface id. */
export function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
}

// Surface ids. The hierarchy is Provider -> Resource(s) -> Operation -> Param -> Value.
export const ids = {
  provider: (p: string) => p,
  resource: (p: string, path: string[]) => [p, ...path.map(snake)].join('.'),
  operation: (p: string, path: string[], method: string) => [p, ...path.map(snake), snake(method)].join('.'),
  param: (op: string, name: string) => `${op}#${snake(name)}`,
  value: (param: string, v: string) => `${param}=${v}`,
};

/** Dated model ids (and other dated values) are pinned; rolling aliases such as `-latest` are not. */
export function isPinned(v: string): boolean {
  if (/-latest$/.test(v)) return false;
  return /-\d{8}$/.test(v) || /-\d{4}-\d{2}-\d{2}$/.test(v) || /-\d{3}$/.test(v) || /@\d{8}$/.test(v);
}
