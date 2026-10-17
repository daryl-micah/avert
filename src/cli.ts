#!/usr/bin/env node
import { createFindings, syncLifecycle, syncSdk } from './changes.js';
import { close } from './db.js';
import { indexRepo } from './indexer/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { migrate } from './agents/migrator.js';
import { watch } from './agents/watcher.js';
import { buildServer } from './mcp.js';
import { startWeb } from './web/server.js';
import { render } from './path.js';
import { blastRadius, listChanges } from './tools.js';

const [cmd, ...args] = process.argv.slice(2);
const repo = () => args[0] ?? '.';

async function main() {
  switch (cmd) {
    case 'index': {
      const r = await indexRepo(repo());
      console.log(`${r.graph}: ${r.files} files, ${r.functions} functions, ${r.routes} routes, ${r.callSites} call sites (${r.ms} ms)`);
      break;
    }
    case 'sync': {
      const sdk = await syncSdk(repo());
      const life = await syncLifecycle(repo());
      const findings = await createFindings(repo());
      console.log(`${sdk.length} SDK changes, ${life.length} lifecycle changes, ${findings} findings`);
      for (const c of [...sdk, ...life].filter((c) => c.kind !== 'added')) console.log(`  [${c.kind}] ${c.summary}`);
      break;
    }
    case 'changes': {
      for (const c of (await listChanges({ repo: repo() })).changes) console.log(`[${c.kind}] ${c.id}\n    ${c.summary}`);
      break;
    }
    case 'blast': {
      const r = await blastRadius({ repo: repo(), change_id: args[1] });
      console.log(`${r.call_sites} call sites; routes: ${r.routes.join(', ') || '-'}; owners: ${r.owners.join(', ') || '-'}`);
      for (const i of r.impacts) console.log('\n' + render(i.path));
      break;
    }
    case 'watch': {
      await watch(repo());
      break;
    }
    case 'migrate': {
      const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
      const r = await migrate(repo(), { agent: flag('--agent'), limit: flag('--limit') ? Number(flag('--limit')) : undefined, dryRun: args.includes('--dry-run') });
      if (args.includes('--json')) console.log(JSON.stringify(r));
      break;
    }
    case 'web': {
      startWeb();
      return 'keep-open';
    }
    case 'mcp': {
      // stdio MCP server; the connection stays open, so skip the closing `finally`
      await buildServer({ readOnly: args.includes('--read-only') }).connect(new StdioServerTransport());
      return 'keep-open';
    }
    default:
      console.log('usage: avert <index|sync|watch|migrate|changes|blast|mcp|web> [repo] [change_id] [--agent name] [--limit n] [--dry-run]');
      process.exitCode = 1;
  }
}

main().then(async (r) => { if (r !== 'keep-open') await close(); }).catch(async (e) => { console.error(e); process.exitCode = 1; await close(); });
