// Several migrator processes race to claim the same findings. Each claim is one conditional write
// (`WHERE f.status = 'open' SET f.status = 'claimed'`); FalkorDB applies writes to a graph one at a time,
// so every finding must end up claimed exactly once. Usage: tsx scripts/concurrency.ts [repo] [agents]
import { spawn } from 'node:child_process';
import { close, graph, run } from '../src/db.js';

const repo = process.argv[2] ?? 'examples/acme';
const n = Number(process.argv[3] ?? 5);
const g = await graph(repo);
await run(g, `MATCH (f:Finding) SET f.status = 'open', f.claimed_by = null`);
const total = (await run(g, `MATCH (f:Finding) RETURN count(f) AS n`))[0].n as number;
console.log(`${n} migrators racing for ${total} findings in ${repo}`);

const results = await Promise.all(Array.from({ length: n }, (_, i) => new Promise<{ agent: string; claimed: string[] }>((resolve, reject) => {
  const agent = `migrator-${i + 1}`;
  const p = spawn('npx', ['tsx', 'src/cli.ts', 'migrate', repo, '--agent', agent, '--dry-run', '--json'], { env: { ...process.env, GROQ_API_KEY: '' } });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('exit', (code) => {
    if (code) return reject(new Error(`${agent} exited ${code}`));
    const json = JSON.parse(out.trim().split('\n').pop()!);
    resolve({ agent, claimed: json.map((r: any) => r.finding) });
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
