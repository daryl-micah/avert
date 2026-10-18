// Several migrator processes race to claim the same findings. Each claim is one conditional write
// (`WHERE f.status = 'open' SET f.status = 'claimed'`); FalkorDB applies writes to a graph one at a time,
// so every finding must end up claimed exactly once. Usage: tsx scripts/concurrency.ts [repo] [agents]
// Each racer is a separate process that claims every finding through the `claim_finding` tool and keeps what it wins
// (a migrator dry run releases its claims, which would legitimately let another process claim the same finding again).
import { spawn } from 'node:child_process';
import { close, graph, run } from '../src/db.js';
import { callTool } from '../src/registry.js';

if (process.argv[2] === '--worker') {
  const [, , , repo, agent] = process.argv;
  const ctx = { agent, sessionId: `session:${agent}` };
  const open = (await callTool('list_findings', { repo, status: 'open' }, ctx, { log: false })).findings as { id: string }[];
  const claimed: string[] = [];
  for (const f of open) if ((await callTool('claim_finding', { repo, finding_id: f.id }, ctx, { log: false })).claimed) claimed.push(f.id);
  console.log(JSON.stringify(claimed));
  await close();
  process.exit(0);
}

const repo = process.argv[2] ?? 'examples/acme';
const n = Number(process.argv[3] ?? 5);
const g = await graph(repo);
await run(g, `MATCH (f:Finding) SET f.status = 'open', f.claimed_by = null`);
const total = (await run(g, `MATCH (f:Finding) RETURN count(f) AS n`))[0].n as number;
console.log(`${n} migrators racing for ${total} findings in ${repo}`);

const results = await Promise.all(Array.from({ length: n }, (_, i) => new Promise<{ agent: string; claimed: string[] }>((resolve, reject) => {
  const agent = `migrator-${i + 1}`;
  const p = spawn('npx', ['tsx', 'scripts/concurrency.ts', '--worker', repo, agent]);
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('exit', (code) => {
    if (code) return reject(new Error(`${agent} exited ${code}`));
    const json = JSON.parse(out.trim().split('\n').pop()!);
    resolve({ agent, claimed: json });
  });
})));

const claims = results.flatMap((r) => r.claimed);
for (const r of results) console.log(`  ${r.agent}: ${r.claimed.length} claimed`);
const holders = await run(g, `MATCH (f:Finding) RETURN f.id AS id, f.status AS status, f.claimed_by AS by`);
const dupes = claims.length - new Set(claims).size;
const unclaimed = holders.filter((h) => h.status !== 'claimed').length;
const mismatched = holders.filter((h) => !results.find((r) => r.agent === h.by)?.claimed.includes(h.id)).length;
console.log(`claims: ${claims.length}/${total}, double claims: ${dupes}, unclaimed: ${unclaimed}, holder mismatches: ${mismatched}`);
await run(g, `MATCH (f:Finding) SET f.status = 'open', f.claimed_by = null`);
await close();
if (dupes || unclaimed || mismatched || claims.length !== total) process.exit(1);
