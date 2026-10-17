// Act 3: two different MCP clients, one graph. Client A records a decision; client B (a fresh process
// connection with a different client name) calls `recall` with no hints and must get it back.
// Usage: tsx scripts/act3.ts <repo>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = process.argv[2] ?? 'examples/acme';

async function connect(name: string) {
  const c = new Client({ name, version: '1.0.0' });
  await c.connect(new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/cli.ts', 'mcp'], env: process.env as Record<string, string> }));
  return c;
}
const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r: any = await c.callTool({ name, arguments: { repo, ...args } });
  if (r.isError) throw new Error(r.content[0].text);
  return r.structuredContent;
};

const a = await connect('claude-code');
const { findings } = await call(a, 'list_findings', {});
const target = findings.find((f: any) => f.change.summary.includes('gpt-4o')) ?? findings[0];
const reason = 'Keep gpt-4o until the eval suite passes on gpt-6-luna; revisit before 2027-01-14.';
await call(a, 'record_decision', { finding_id: target.id, kind: 'defer', reason });
console.log(`claude-code: deferred "${target.change.summary}" — ${reason}`);
await a.close();

const b = await connect('cursor');
const mem = await call(b, 'recall', {});
await b.close();
const hit = mem.decisions.find((d: any) => d.finding === target.id && d.kind === 'defer');
console.log(`cursor: recall() returned ${mem.decisions.length} decisions, ${mem.sessions.length} sessions`);
if (!hit) throw new Error('cursor did not see the decision made by claude-code');
console.log(`cursor: saw "${hit.kind}" by ${hit.agent}: "${hit.reason}"`);
console.log('sessions:', mem.sessions.map((s: any) => `${s.agent} (${s.at})`).join(', '));
process.exit(0);
