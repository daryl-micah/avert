import { plannedEdit } from '../actions/github.js';
import { callTool } from '../registry.js';
import { logSession, recall, setStatus } from '../tools.js';
import { hasLlm, runAgent } from './llm.js';

// Migrator: takes open findings in ranked order, claims each one atomically (so parallel migrators
// never collide), then fixes it: reuse a recipe or replacement -> pull request; otherwise ask the
// LLM to work out the fix from the SDK docs and memory, save it as a recipe, and open the PR or an issue.

const SYSTEM = `You are an Avert migrator agent. You have claimed one finding: a provider API change that reaches a call site.
Steps: (1) call recall for the finding to reuse earlier decisions and recipes; (2) if the change names no replacement and no recipe exists,
call sdk_params and choose the replacement param or value from the SDK docs; save it with save_recipe (from = old param name or old literal value,
to = the new one); (3) call open_pr for the finding; if a PR is not possible, call open_issue for its batch;
(4) call record_decision with kind 'fix' and a one-sentence reason. Only use facts from tool results. Finish with one line saying what you did.`;

export async function migrate(repo: string, opts: { agent?: string; limit?: number; dryRun?: boolean } = {}) {
  const agent = opts.agent ?? `migrator-${process.pid}`;
  const ctx = { agent, sessionId: `session:${agent}:${Date.now().toString(36)}` };
  const ranked = await callTool('rank_findings', { repo, status: 'open' }, ctx, { log: false });
  const done: { finding: string; result: string }[] = [];
  const batchOf = async (f: any): Promise<string | undefined> => f.batch ?? (await callTool('migration_batches', { repo }, ctx)).batches.find((b: any) => b.findings.includes(f.id))?.id;
  for (const f of ranked.findings.slice(0, opts.limit ?? Infinity)) {
    const claim = await callTool('claim_finding', { repo, finding_id: f.id }, ctx);
    if (!claim.claimed) { console.log(`${agent}: skip ${f.id} (held by ${claim.claimed_by})`); continue; }
    console.log(`${agent}: claimed ${f.change.summary} at ${f.callsite.file}:${f.callsite.line}`);
    const mem = await recall({ repo, finding_id: f.id });
    const blocking = mem.decisions.find((d: any) => d.kind === 'wontfix' || d.kind === 'defer' || d.kind === 'accept_risk');
    if (blocking) {
      console.log(`  memory: ${blocking.kind} by ${blocking.agent} — "${blocking.reason}"; leaving it`);
      await setStatus(repo, f.id, 'declined');
      done.push({ finding: f.id, result: `skipped: earlier ${blocking.kind}` });
      continue;
    }
    if (opts.dryRun) { await setStatus(repo, f.id, 'open'); done.push({ finding: f.id, result: 'claimed and released (dry run)' }); continue; }
    const edit = await plannedEdit(repo, f.id);
    if (!hasLlm()) {
      // deterministic path: PR when the edit is known, otherwise an issue for the batch
      try {
        const r = edit ? await callTool('open_pr', { repo, finding_id: f.id }, ctx) : await callTool('open_issue', { repo, batch_id: await batchOf(f) }, ctx);
        await callTool('record_decision', { repo, finding_id: f.id, kind: 'fix', reason: edit ? `PR ${edit.from} -> ${edit.to} (${edit.source})` : 'No mechanical fix; issue opened for the owners' }, ctx);
        done.push({ finding: f.id, result: r.url });
      } catch (e) {
        await setStatus(repo, f.id, 'open');
        done.push({ finding: f.id, result: `released: ${(e as Error).message}` });
      }
      continue;
    }
    let run: Awaited<ReturnType<typeof runAgent>>;
    try {
      run = await runAgent({
        // Every id the model could aim at is pinned to the claimed finding: tool results carry untrusted text (code, SDK docs, other agents' memory).
        repo, ctx, system: SYSTEM, fixed: { finding_id: f.id, change_id: f.change.id, batch_id: await batchOf(f), kind: 'fix' },
        task: `Finding ${f.id}\nChange: ${f.change.summary} (${f.change.source_url})\nCall site: ${f.callsite.file}:${f.callsite.line} \`${f.callsite.snippet}\`\nRoutes: ${f.routes.join(', ')}\nKnown edit: ${edit ? `${edit.from} -> ${edit.to} from ${edit.source}` : 'none'}`,
        tools: ['recall', 'explain_path', 'sdk_params', 'save_recipe', 'open_pr', 'open_issue', 'record_decision'],
      });
    } catch (e) {
      await setStatus(repo, f.id, 'open'); // release the claim before surfacing the failure (e.g. a rate limit)
      throw e;
    }
    if (!run.calls.some((c) => (c.tool === 'open_pr' || c.tool === 'open_issue') && c.ok)) await setStatus(repo, f.id, 'open'); // release for another agent
    // Share a recipe only once it produced a pull request for this finding, never on the model's say-so.
    const used = run.calls.some((c) => c.tool === 'open_pr' && c.ok) && (await plannedEdit(repo, f.id));
    if (used && used.recipe && used.source === 'recipe (repo)') await callTool('publish_recipe', { repo, recipe_id: used.recipe }, ctx);
    console.log(`  ${run.text}`);
    done.push({ finding: f.id, result: run.text });
  }
  await logSession({ repo, session_id: ctx.sessionId, agent, client: 'avert-cli', findings: done.map((d) => d.finding), summary: done.map((d) => `${d.finding}: ${d.result}`).join('\n').slice(0, 2000) });
  return done;
}
