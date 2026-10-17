import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCATIONS = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];

/** Convert one CODEOWNERS pattern (gitignore-style) to a regex over repo-relative paths. */
function patternRegex(p: string): RegExp {
  const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
  let body = p.replace(/^\//, '');
  const dirOnly = body.endsWith('/');
  body = body.replace(/\/$/, '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${body}${dirOnly ? '/' : '(?:$|/)'}`);
}

/**
 * Team owners per file from CODEOWNERS. Only `@org/team` handles are kept: individual users
 * and emails are personal data and stay out of the graph.
 */
export function owners(root: string): (path: string) => string[] {
  const file = LOCATIONS.map((l) => join(root, l)).find(existsSync);
  if (!file) return () => [];
  const rules = readFileSync(file, 'utf8').split('\n')
    .map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)
    .map((l) => {
      const [pattern, ...handles] = l.split(/\s+/);
      return { re: patternRegex(pattern), teams: handles.filter((h) => /^@[\w.-]+\/[\w.-]+$/.test(h)) };
    });
  return (path) => {
    let teams: string[] = [];
    for (const r of rules) if (r.re.test(path)) teams = r.teams; // last match wins
    return teams;
  };
}
