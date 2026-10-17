import { callTool } from '../registry.js';
import { logSession } from '../tools.js';
import { hasLlm, runAgent } from './llm.js';

// Watcher: pulls provider changes into the graph, turns impacted call sites into open findings,
// then (with an LLM) triages them using the graph tools and leaves a note for the migrators.

const SYSTEM = `You are Avert's watcher agent. Provider API changes were just ingested into a code graph.
Use the tools to: rank the findings, group them into migration batches, and check memory (recall) for earlier decisions.
Then write a short triage for the team: the most urgent finding with its evidence path (file:line -> route -> owner team),
how many batches exist, and anything earlier sessions already decided. Record one 'note' decision on the most urgent finding
explaining why it is first. Do not claim findings or open issues; the migrator agents do that. Copy finding ids exactly as the tools return them. Be concise and factual; only state what the tools returned.`;

export async function watch(repo: string, opts: { agent?: string } = {}) {
  const ctx = { agent: opts.agent ?? 'watcher', sessionId: `session:watcher:${Date.now().toString(36)}` };
  const synced = await callTool('sync_changes', { repo }, ctx);
  console.log(`watcher: ${synced.sdk_changes} SDK changes, ${synced.lifecycle_changes} lifecycle changes, ${synced.findings} findings`);
  if (!hasLlm()) {
    const ranked = await callTool('rank_findings', { repo }, ctx);
    const batches = await callTool('migration_batches', { repo }, ctx);
    const summary = `Ranked ${ranked.findings.length} findings into ${batches.batches.length} batches. Top: ${ranked.findings[0]?.change.summary ?? 'none'}.`;
    console.log(summary);
    await logSession({ repo, session_id: ctx.sessionId, agent: ctx.agent, client: 'avert-cli', summary });
    return { summary, calls: [] };
  }
  const run = await runAgent({
    repo, ctx, system: SYSTEM,
    task: `Repository ${repo}. New changes: ${JSON.stringify(synced.changes)}. Triage them.`,
    tools: ['rank_findings', 'migration_batches', 'recall', 'explain_path', 'blast_radius', 'list_changes', 'record_decision'],
  });
  await logSession({ repo, session_id: ctx.sessionId, agent: ctx.agent, client: 'avert-cli', summary: run.text.slice(0, 2000) });
  console.log(`\n${run.text}`);
  return { summary: run.text, calls: run.calls };
}
