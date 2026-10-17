import { z } from 'zod';
import { openIssue, openPr } from './actions/github.js';
import { createFindings, syncLifecycle, syncSdk } from './changes.js';
import { indexRepo } from './indexer/index.js';
import * as T from './tools.js';

// The one list of Avert tools. The MCP server exposes it to coding agents; the watcher and
// migrator agents hand the same definitions to the LLM. Every result carries `path`.

export interface Ctx { agent: string; sessionId: string }
export interface ToolDef {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  write: boolean;            // excluded in read-only mode (hosted demo)
  run: (args: any, ctx: Ctx) => Promise<any>;
}

const def = <S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (args: z.infer<z.ZodObject<S>> & { repo: string }, ctx: Ctx) => Promise<any>, write = false): ToolDef =>
  ({ name, description, shape, write, run: run as ToolDef['run'] });

export const TOOLS: ToolDef[] = [
  def('index_repo', 'Index (or re-index) a repository: routes, functions, call chains and every external API call site.', {},
    ({ repo }) => indexRepo(repo), true),

  def('sync_changes', 'Pull provider changes for the SDKs this repo uses (SDK release diffs + model lifecycle data) and create findings.', {},
    async ({ repo }) => {
      const sdk = await syncSdk(repo);
      const life = await syncLifecycle(repo);
      const findings = await createFindings(repo);
      return { sdk_changes: sdk.length, lifecycle_changes: life.length, findings, changes: [...sdk, ...life].filter((c) => c.kind !== 'added').map((c) => ({ id: c.id, kind: c.kind, summary: c.summary })), path: [] };
    }, true),

  def('list_changes', 'List provider change events that touch this repo (removed, renamed, deprecated, retired, added). Added = notice only.', {
    kind: z.enum(['removed', 'renamed', 'deprecated', 'retired', 'added']).optional(),
    provider: z.string().optional().describe('Provider id: openai, anthropic, stripe, gemini, twilio'),
  }, async (a) => ({ ...(await T.listChanges(a)), path: [] })),

  def('blast_radius', 'Everything one change breaks: call sites (down the API surface, through rolling aliases), then routes and owner teams (up the call chain), each with its path.', {
    change_id: z.string().describe('ChangeEvent id from list_changes'),
  }, (a) => T.blastRadius(a)),

  def('list_findings', 'Findings (one per change x call site) with status open | claimed | done | declined.', {
    status: z.enum(['open', 'claimed', 'done', 'declined']).optional(),
  }, async (a) => ({ ...(await T.listFindings(a)), path: [] })),

  def('explain_path', 'The evidence path for one finding: change -> surface -> call site -> functions -> route -> owner, with file and line.', {
    finding_id: z.string(),
  }, (a) => T.explainPath(a)),

  def('rank_findings', 'Rank findings by severity, urgency (days to effective date) and reach (routes + PageRank centrality of the call chain).', {
    status: z.enum(['open', 'claimed']).optional(),
  }, (a) => T.rankFindings(a)),

  def('migration_batches', 'Group findings into migration batches: connected components (WCC) of findings sharing an owner and a change or function. One batch = one issue.', {},
    (a) => T.migrationBatches(a), true),

  def('claim_finding', 'Atomically claim an open finding so no other agent works on it. Fails if already claimed, naming the holder.', {
    finding_id: z.string(),
  }, (a, ctx) => T.claimFinding({ ...a, agent: ctx.agent }), true),

  def('record_decision', 'Remember a decision about a finding (fix, defer, wontfix, accept_risk, note) so later sessions and other agents see it.', {
    finding_id: z.string(), kind: z.enum(T.DECISION_KINDS), reason: z.string(),
  }, (a, ctx) => T.recordDecision({ ...a, agent: ctx.agent, client: ctx.agent }), true),

  def('recall', 'Recall memory: decisions and sessions (episodic) and migration recipes (procedural, from this repo and the shared graph). With no ids, returns recent history. Call this first.', {
    finding_id: z.string().optional(), change_id: z.string().optional(),
  }, (a, ctx) => T.recall({ ...a, session_id: ctx.sessionId })),

  def('sdk_params', "Params of a finding's operation in the provider's latest SDK, with doc text and deprecation flags. Use it to choose a replacement when a change names none.", {
    finding_id: z.string(),
  }, (a) => T.sdkParams(a)),

  def('save_recipe', 'Save how a change was fixed (from -> to: a param name or literal value, with steps) so the next matching migration reuses it.', {
    change_id: z.string(), from: z.string(), to: z.string(), steps: z.string(), callsite_id: z.string().optional(),
  }, (a, ctx) => T.saveRecipe({ ...a, agent: ctx.agent }), true),

  def('publish_recipe', 'Publish a repo recipe to the shared graph so other repositories hit by the same change are offered it.', {
    recipe_id: z.string(),
  }, (a, ctx) => T.publishRecipe({ ...a, agent: ctx.agent }), true),

  def('open_issue', 'Open one GitHub issue for a migration batch, with every path as evidence.', {
    batch_id: z.string().describe('Batch id from migration_batches'),
  }, (a) => openIssue(a), true),

  def('open_pr', 'Open a GitHub pull request fixing one finding, when the change names a replacement or a recipe covers it. Never merges.', {
    finding_id: z.string(),
  }, (a) => openPr(a), true),
];

export const repoOf = (r?: string) => r ?? process.env.AVERT_REPO ?? process.cwd();
export const repoArg = z.string().optional().describe('Repository: local path or GitHub URL. Defaults to AVERT_REPO or the working directory.');

/** Run a tool by name with validated args; logs the session and the findings it touched. */
export async function callTool(name: string, raw: Record<string, unknown>, ctx: Ctx, opts: { log?: boolean } = {}) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`Unknown tool ${name}`);
  const args: Record<string, any> = z.object({ repo: repoArg, ...t.shape }).parse(raw);
  const repo = repoOf(args.repo as string | undefined);
  const result = await t.run({ ...args, repo }, ctx);
  if (opts.log !== false) {
    const touched = new Set<string>([args.finding_id, result?.finding?.id, result?.finding_id, ...(result?.findings ?? []).slice(0, 20).map((f: any) => f?.id ?? f)].filter((x): x is string => typeof x === 'string'));
    await T.logSession({ repo, session_id: ctx.sessionId, agent: ctx.agent, client: ctx.agent, findings: [...touched] }).catch(() => {});
  }
  return result;
}
