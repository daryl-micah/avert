import { connect, graph, graphName, run, SHARED_GRAPH } from './db.js';
import { backward, forward, join, step, type GNode, type Step } from './path.js';
import * as Q from './queries.js';
import { latest } from './surface/fetch.js';
import { provider as providerInfo } from './surface/providers.js';
import { surfaceOf } from './surface/sdk-diff.js';

// Domain tools. The MCP server, the agents and the hosted demo all call these functions,
// so there is one implementation of every graph operation.

export interface Impact {
  callsite: { id: string; file: string; line: number; snippet: string; provider: string };
  routes: string[];
  owners: string[];
  path: Step[];              // change -> surface -> call site -> function chain -> route
}

/** Change -> call sites (down the surface), then call site -> routes and owners (up the call chain). */
export async function impactOf(repo: string, changeId: string): Promise<Impact[]> {
  const g = await graph(repo);
  const down = await run(g, Q.IMPACT_DOWN, { change: changeId });
  // a call site can be reached several ways (operation, param, value); keep the most specific (longest surface walk)
  const best = new Map<string, (typeof down)[number]>();
  for (const r of down) {
    const prev = best.get(r.callsite);
    if (!prev || r.down.length > prev.down.length) best.set(r.callsite, r);
  }
  const out: Impact[] = [];
  for (const [csId, r] of best) {
    const changeStep = { ...step(r.c), edge: '-AFFECTS->' };
    const surface = forward(r.down, r.downEdges);
    const toCallSite = backward(r.via, r.viaEdges); // leaf <- (alias) <- call site
    const ups = await run(g, Q.IMPACT_UP, { callsite: csId });
    const cs = ups[0].cs.properties;
    const fnStep = (n: GNode) => step(n);
    const routes: string[] = [];
    let upPath: Step[] = [];
    for (const u of ups) {
      if (!u.up) continue;
      routes.push(`${u.r.properties.method} ${u.r.properties.path}`);
      const seg = backward(u.up.nodes, u.up.edges); // function <- ... <- handler <- route
      if (!upPath.length || seg.length > upPath.length) upPath = seg;
    }
    if (!upPath.length) upPath = [fnStep(ups[0].f)];
    const owners: string[] = ups[0].owners ?? [];
    const path = join([changeStep, ...surface], toCallSite, [{ ...step(ups[0].cs), edge: '<-HAS_CALL_SITE-' }, ...upPath]);
    if (owners.length) {
      path[path.length - 1] = { ...path[path.length - 1], edge: `(file ${cs.file}) <-OWNS-` };
      path.push({ kind: 'Team', id: owners[0], label: owners.join(', ') });
    }
    out.push({ callsite: { id: csId, file: cs.file, line: cs.line, snippet: cs.snippet, provider: cs.provider }, routes: [...new Set(routes)], owners, path });
  }
  return out.sort((a, b) => b.routes.length - a.routes.length || a.callsite.id.localeCompare(b.callsite.id));
}

export async function listChanges(args: { repo: string; kind?: string; provider?: string }) {
  const g = await graph(args.repo);
  const rows = await run(g, Q.LIST_CHANGES, { kind: args.kind ?? null, provider: args.provider ?? null });
  return {
    changes: rows.map((r) => {
      const c = r.c.properties;
      return { id: c.id, kind: c.kind, severity: c.severity, provider: c.provider, summary: c.summary, effective_date: c.effective_date ?? null, source: c.source, source_url: c.source_url, targets: r.targets, replacements: r.replacements, release: r.release ?? null };
    }),
  };
}

export async function blastRadius(args: { repo: string; change_id: string }) {
  const impacts = await impactOf(args.repo, args.change_id);
  return {
    change_id: args.change_id,
    call_sites: impacts.length,
    routes: [...new Set(impacts.flatMap((i) => i.routes))],
    owners: [...new Set(impacts.flatMap((i) => i.owners))],
    impacts,
    path: impacts[0]?.path ?? [],
  };
}

// ---------------------------------------------------------------------------
// Findings, ranking, batching
// ---------------------------------------------------------------------------

const SEVERITY_WEIGHT: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 };

function findingSummary(r: any) {
  const f = r.f.properties, cs = r.cs.properties, c = r.c.properties;
  return {
    id: f.id, status: f.status, claimed_by: f.claimed_by ?? null, kind: f.kind, severity: f.severity, batch: f.batch ?? null,
    change: { id: c.id, summary: c.summary, effective_date: c.effective_date ?? null, source_url: c.source_url },
    callsite: { id: cs.id, file: cs.file, line: cs.line, snippet: cs.snippet },
    routes: f.routes ?? [], owners: f.owners ?? [], url: f.url ?? null,
  };
}

export async function listFindings(args: { repo: string; status?: string }) {
  const g = await graph(args.repo);
  return { findings: (await run(g, Q.LIST_FINDINGS, { status: args.status ?? null, id: null })).map(findingSummary) };
}

async function getFinding(repo: string, id: string) {
  const rows = await run(await graph(repo), Q.LIST_FINDINGS, { status: null, id });
  if (!rows.length) throw new Error(`No finding ${id} in ${repo}`);
  return findingSummary(rows[0]);
}

export async function explainPath(args: { repo: string; finding_id: string }) {
  const f = await getFinding(args.repo, args.finding_id);
  const hit = (await impactOf(args.repo, f.change.id)).find((i) => i.callsite.id === f.callsite.id);
  return { finding: f, path: hit?.path ?? [] };
}

/**
 * Score = severity x urgency x reach. Reach counts routes and adds the PageRank of the most central
 * function on the call chain, so a shared helper on many paths outranks a leaf.
 */
export async function rankFindings(args: { repo: string; status?: string }) {
  const g = await graph(args.repo);
  const pr = new Map((await run(g, Q.PAGERANK)).map((r) => [r.id as string, r.score as number]));
  const findings = (await listFindings({ repo: args.repo, status: args.status })).findings.filter((f) => f.status !== 'done');
  const now = Date.now();
  const ranked = [];
  for (const f of findings) {
    const [chain] = await run(g, Q.CHAIN_FUNCTIONS, { callsite: f.callsite.id });
    const fns = chain ? [chain.fn, ...chain.callers] : [];
    const centrality = Math.max(0, ...fns.map((id: string) => pr.get(id) ?? 0));
    const days = f.change.effective_date ? Math.round((Date.parse(f.change.effective_date) - now) / 86_400_000) : null;
    const urgency = days === null ? 1 : days <= 0 ? 3 : days <= 30 ? 2.5 : days <= 90 ? 2 : 1;
    const severity = SEVERITY_WEIGHT[f.severity] ?? 1;
    const reach = 1 + f.routes.length + centrality * 10;
    const score = Math.round(severity * urgency * reach * 100) / 100;
    ranked.push({ ...f, score, breakdown: { severity, urgency, days_until_effective: days, routes: f.routes.length, max_pagerank: Math.round(centrality * 1000) / 1000 } });
  }
  ranked.sort((a, b) => b.score - a.score);
  const top = ranked[0] ? await explainPath({ repo: args.repo, finding_id: ranked[0].id }) : undefined;
  return { findings: ranked, path: top?.path ?? [] };
}

/** Group open findings into batches with weakly connected components over SAME_FIX edges. */
export async function migrationBatches(args: { repo: string }) {
  const g = await graph(args.repo);
  for (const q of Q.REBUILD_SAME_FIX) await run(g, q);
  const comps = await run(g, Q.WCC_BATCHES);
  const findings = new Map((await listFindings({ repo: args.repo })).findings.map((f) => [f.id, f]));
  const batches = comps.map((c) => {
    const items = (c.findings as string[]).map((id) => findings.get(id)!).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
    const id = 'batch:' + shortHash(items[0].id);
    return {
      id, size: items.length,
      changes: [...new Set(items.map((f) => f.change.summary))],
      owners: [...new Set(items.flatMap((f) => f.owners))],
      routes: [...new Set(items.flatMap((f) => f.routes))],
      files: [...new Set(items.map((f) => `${f.callsite.file}:${f.callsite.line}`))],
      findings: items.map((f) => f.id),
    };
  }).filter((b) => b.size);
  await run(g, Q.SET_BATCH, { rows: batches.flatMap((b) => b.findings.map((id) => ({ id, batch: b.id }))) });
  const first = batches[0] ? await explainPath({ repo: args.repo, finding_id: batches[0].findings[0] }) : undefined;
  return { batches, path: first?.path ?? [] };
}

function shortHash(s: string): string {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// Coordination and memory
// ---------------------------------------------------------------------------

export async function claimFinding(args: { repo: string; finding_id: string; agent: string }) {
  const g = await graph(args.repo);
  const ok = await run(g, Q.CLAIM, { id: args.finding_id, agent: args.agent, now: new Date().toISOString() });
  if (ok.length) return { claimed: true, finding_id: args.finding_id, agent: args.agent, path: (await explainPath(args)).path };
  const [s] = await run(g, Q.FINDING_STATUS, { id: args.finding_id });
  return { claimed: false, finding_id: args.finding_id, status: s?.status ?? 'missing', claimed_by: s?.claimed_by ?? null, path: [] };
}

export async function setStatus(repo: string, findingId: string, status: 'open' | 'claimed' | 'done' | 'declined', url?: string) {
  await run(await graph(repo), Q.SET_STATUS, { id: findingId, status, url: url ?? null, now: new Date().toISOString() });
}

export const DECISION_KINDS = ['fix', 'defer', 'wontfix', 'accept_risk', 'note'] as const;

export async function recordDecision(args: { repo: string; finding_id: string; kind: string; reason: string; agent: string; client?: string }) {
  const g = await graph(args.repo);
  const id = `decision:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`;
  await run(g, Q.RECORD_DECISION, { id, finding: args.finding_id, kind: args.kind, reason: args.reason, agent: args.agent, client: args.client ?? null, now: new Date().toISOString() });
  if (args.kind === 'wontfix' || args.kind === 'accept_risk') await setStatus(args.repo, args.finding_id, 'declined');
  return { decision_id: id, finding_id: args.finding_id, path: (await explainPath(args)).path };
}

export async function saveRecipe(args: { repo: string; change_id: string; from: string; to: string; steps: string; agent: string; callsite_id?: string }) {
  const g = await graph(args.repo);
  const id = `recipe:${shortHash(args.change_id + args.from + args.to)}`;
  await run(g, Q.SAVE_RECIPE, { id, change: args.change_id, steps: args.steps, from: args.from, to: args.to, agent: args.agent, callsite: args.callsite_id ?? null, now: new Date().toISOString() });
  return { recipe_id: id };
}

/** Copy a repo-local recipe into the shared graph so other repositories hit by the same change can reuse it. */
export async function publishRecipe(args: { repo: string; recipe_id: string; agent: string }) {
  const g = await graph(args.repo);
  const [row] = await run(g, `MATCH (r:Recipe {id: $id})-[:FIXES]->(c:ChangeEvent) RETURN r, c`, { id: args.recipe_id });
  if (!row) throw new Error(`No recipe ${args.recipe_id}`);
  const r = row.r.properties, c = row.c.properties;
  await run(await shared(), Q.PUBLISH_RECIPE, { id: r.id, change: c.id, summary: c.summary, steps: r.steps, from: r.from, to: r.to, agent: args.agent, origin: graphName(args.repo), now: new Date().toISOString() });
  return { published: true, recipe_id: r.id, change_id: c.id };
}

async function shared() {
  return (await connect()).selectGraph(SHARED_GRAPH);
}

/**
 * Recall memory for a finding, a change, or (with neither) the repo's recent history:
 * decisions and sessions (episodic) plus recipes from this repo and the shared graph (procedural).
 */
export async function recall(args: { repo: string; finding_id?: string; change_id?: string; session_id?: string }) {
  const g = await graph(args.repo);
  let findings: string[] = [];
  let changes: string[] = [];
  if (args.finding_id) {
    const f = await getFinding(args.repo, args.finding_id);
    findings = [f.id];
    changes = [f.change.id];
  } else if (args.change_id) {
    changes = [args.change_id];
    findings = (await listFindings({ repo: args.repo })).findings.filter((f) => f.change.id === args.change_id).map((f) => f.id);
  } else {
    changes = (await listFindings({ repo: args.repo })).findings.map((f) => f.change.id);
  }
  const memory = await run(g, Q.RECALL, { findings });
  const recipe = (r: any, scope: string) => ({ id: r.r.properties.id, change: r.change, from: r.r.properties.from, to: r.r.properties.to, steps: r.r.properties.steps, by: r.r.properties.created_by, origin: r.r.properties.origin ?? null, scope });
  const local = (await run(g, Q.RECIPES_FOR, { changes })).map((r) => recipe(r, 'repo'));
  const fromShared = (await run(await shared(), Q.RECIPES_FOR, { changes }).catch(() => [])).map((r) => recipe(r, 'shared')).filter((r) => !local.some((l) => l.id === r.id));
  const sessions = findings.length || args.finding_id ? [] : (await run(g, Q.RECENT_SESSIONS, { exclude: args.session_id ?? '' })).map((r) => ({ ...r.s.properties, findings: r.findings }));
  return {
    decisions: memory.flatMap((m) => m.decisions.map((d: GNode) => ({ finding: m.finding, ...d.properties }))).sort((a: any, b: any) => b.at.localeCompare(a.at)),
    sessions: [...memory.flatMap((m) => m.sessions.map((s: GNode) => ({ finding: m.finding, ...s.properties }))), ...sessions]
      .filter((s, i, all) => all.findIndex((x) => x.id === s.id) === i),
    recipes: [...local, ...fromShared],
    path: args.finding_id ? (await explainPath({ repo: args.repo, finding_id: args.finding_id })).path : [],
  };
}

export async function logSession(args: { repo: string; session_id: string; agent: string; client: string; findings?: string[]; summary?: string }) {
  const g = await graph(args.repo);
  await run(g, Q.UPSERT_SESSION, { id: args.session_id, agent: args.agent, client: args.client, summary: args.summary ?? null, now: new Date().toISOString() });
  if (args.findings?.length) await run(g, Q.SESSION_DISCUSSED, { session: args.session_id, findings: args.findings });
}

/** Params (with doc text and deprecation) of a finding's operation in the latest SDK: context for proposing a fix. */
export async function sdkParams(args: { repo: string; finding_id: string }) {
  const { finding } = await explainPath(args);
  const [opId] = finding.callsite.id.split(':').slice(-1);
  const [provider, ...rest] = opId.split('.');
  const eco = finding.callsite.file.endsWith('.py') ? 'pypi' : 'npm';
  const p = providerInfo(provider);
  const version = await latest(eco, eco === 'npm' ? p.npm : p.pypi);
  const op = (await surfaceOf(provider, eco, version)).get(rest.join('.'));
  return { operation: opId, sdk: `${eco}:${eco === 'npm' ? p.npm : p.pypi}@${version}`, params: op?.params ?? {}, path: [] };
}
