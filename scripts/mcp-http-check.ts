// Smoke test for the hosted read-only MCP endpoint. Usage: tsx scripts/mcp-http-check.ts <url> [repo]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2] ?? 'http://localhost:8787/mcp';
const repo = process.argv[3] ?? 'avert:acme';
const c = new Client({ name: 'http-check', version: '1.0.0' });
await c.connect(new StreamableHTTPClientTransport(new URL(url)));

const names = (await c.listTools()).tools.map((t) => t.name);
console.log(`tools (${names.length}): ${names.join(', ')}`);
const writes = ['index_repo', 'sync_changes', 'claim_finding', 'record_decision', 'save_recipe', 'publish_recipe', 'open_issue', 'open_pr', 'migration_batches', 'sdk_params'];
const leaked = writes.filter((w) => names.includes(w));
if (leaked.length) throw new Error(`write tools exposed: ${leaked.join(', ')}`);

const call = async (name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as any;
const ok = await call('list_findings', { repo });
console.log('list_findings:', ok.isError ? 'ERROR ' + ok.content[0].text : `${ok.structuredContent.findings.length} findings`);
const bad = await call('list_findings', { repo: '/etc' });
console.log('bad repo:', bad.isError ? 'rejected — ' + bad.content[0].text : 'ACCEPTED (bug)');
if (!bad.isError) throw new Error('arbitrary repo accepted');
const mem = await call('recall', { repo });
console.log('recall:', mem.isError ? 'ERROR ' + mem.content[0].text : `${mem.structuredContent.decisions.length} decisions, ${mem.structuredContent.recipes.length} recipes, ${mem.structuredContent.sessions.length} sessions`);
await c.close();
