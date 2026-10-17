// Generates the two reference pages from the source of truth: src/queries.ts (Cypher + algorithm calls,
// with their doc comments) and src/registry.ts (the MCP tools). Run: pnpm docs:gen
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { TOOLS } from '../src/registry.js';

const out = (name: string) => new URL(`../site/src/content/docs/reference/${name}`, import.meta.url);

// --- queries ---------------------------------------------------------------
const src = readFileSync(new URL('../src/queries.ts', import.meta.url), 'utf8');
const section = /\/\/ -{10,}\n((?:\/\/ .*\n)+)\/\/ -{10,}\n/g;
const query = /(?:\/\*\*([\s\S]*?)\*\/\s*)?export const (\w+) = ([\s\S]*?);\n(?=\n|$)/g;
const heads = [...src.matchAll(section)].map((m) => ({ at: m.index!, text: m[1].replace(/^\/\/ ?/gm, '').trim() }));

let md = `---
title: Query reference
description: Every Cypher query and graph algorithm call Avert depends on, generated from src/queries.ts.
---

Generated from [\`src/queries.ts\`](https://github.com/daryl-micah/avert/blob/main/src/queries.ts) by \`pnpm docs:gen\`. Do not edit by hand.
Each entry says what the query is for and which tool or component uses it. Graph algorithms are FalkorDB's built-ins
(\`algo.pageRank\`, \`algo.WCC\`).
`;
let lastHead = '';
for (const m of src.matchAll(query)) {
  const head = [...heads].reverse().find((h) => h.at < m.index!);
  if (head && head.text !== lastHead) {
    const [title, ...rest] = head.text.replace(/\n/g, ' ').split(/\.\s+/);
    md += `\n## ${title.replace(/\.$/, '')}\n\n${rest.join('. ')}\n`;
    lastHead = head.text;
  }
  const doc = (m[1] ?? '').replace(/^\s*\* ?/gm, '').trim().replace(/\n+/g, ' ');
  let body = m[3].trim();
  if (body.startsWith('[')) body = body.replace(/^\[\s*|\s*\]$/g, '').split(/`,\s*`/).map((q) => q.replace(/^`|`$/g, '').trim()).join('\n\n// next statement\n');
  else body = body.replace(/^`|`$/g, '').trim();
  md += `\n### ${m[2]}\n\n${doc}\n\n\`\`\`cypher\n${body}\n\`\`\`\n`;
}
writeFileSync(out('queries.md'), md);

// --- tools -----------------------------------------------------------------
let t = `---
title: MCP tools
description: The named domain tools Avert's MCP server exposes, generated from src/registry.ts.
---

Generated from [\`src/registry.ts\`](https://github.com/daryl-micah/avert/blob/main/src/registry.ts) by \`pnpm docs:gen\`. Do not edit by hand.
The MCP server and the built-in agents use this same list. Every tool takes an optional \`repo\` (a local path or GitHub URL; defaults
to \`AVERT_REPO\` or the working directory). Results carry a \`path\`: the ordered steps from the change to the route, with file and line.

Tools marked **write** change the graph or call GitHub, so the hosted read-only endpoint does not expose them.

| Tool | Access | What it does |
|---|---|---|
${TOOLS.map((x) => `| \`${x.name}\` | ${x.write ? 'write' : 'read'} | ${x.description.replace(/\|/g, '\\|')} |`).join('\n')}

## Arguments
`;
for (const x of TOOLS) {
  const schema = z.toJSONSchema(z.object(x.shape)) as { properties?: Record<string, any>; required?: string[] };
  const props = Object.entries(schema.properties ?? {});
  t += `\n### \`${x.name}\`\n\n${x.description}\n\n`;
  t += props.length
    ? props.map(([k, v]) => `- \`${k}\`${schema.required?.includes(k) ? ' (required)' : ''}: ${v.enum ? v.enum.map((e: string) => `\`${e}\``).join(' | ') : v.type}${v.description ? ` — ${v.description}` : ''}`).join('\n') + '\n'
    : 'No arguments besides `repo`.\n';
}
writeFileSync(out('mcp-tools.md'), t);
console.log(`wrote queries.md (${[...src.matchAll(query)].length} queries) and mcp-tools.md (${TOOLS.length} tools)`);
