// Every Cypher query and graph algorithm call Avert depends on, in one place.
// Each export is documented with its purpose and the tool or component that uses it;
// docs/queries.md is generated from these comments (`pnpm docs:queries`).

// ---------------------------------------------------------------------------
// Indexer writes (code structure). All MERGE on stable ids and stamp `seen`,
// so re-indexing is idempotent and stale nodes are removed afterwards.
// ---------------------------------------------------------------------------

/** Upsert the Repo node. Used by: indexer. */
export const UPSERT_REPO = `
MERGE (r:Repo {id: $id}) SET r.url = $url, r.indexed_at = $run, r.seen = $run`;

/** Upsert files and link them to the repo. Used by: indexer. */
export const UPSERT_FILES = `
UNWIND $rows AS row
MATCH (r:Repo {id: $repo})
MERGE (f:File {id: row.id}) SET f.path = row.path, f.lang = row.lang, f.seen = $run
MERGE (r)-[:CONTAINS]->(f)`;

/** Upsert functions and the file that defines them. Used by: indexer. */
export const UPSERT_FUNCTIONS = `
UNWIND $rows AS row
MATCH (f:File {id: row.file})
MERGE (fn:Function {id: row.id}) SET fn.name = row.name, fn.file = row.path, fn.line = row.line, fn.seen = $run
MERGE (f)-[:DEFINES]->(fn)`;

/** Function-to-function call edges. `via` is "import" (resolved) or "name" (unique-name heuristic). Used by: indexer. */
export const UPSERT_CALLS = `
UNWIND $rows AS row
MATCH (a:Function {id: row.from}), (b:Function {id: row.to})
MERGE (a)-[c:CALLS]->(b) SET c.line = row.line, c.via = row.via, c.seen = $run`;

/** Routes and their handler functions. Used by: indexer. */
export const UPSERT_ROUTES = `
UNWIND $rows AS row
MATCH (fn:Function {id: row.handler})
MERGE (rt:Route {id: row.id}) SET rt.method = row.method, rt.path = row.path, rt.file = row.file, rt.line = row.line, rt.seen = $run
MERGE (rt)-[h:HANDLED_BY]->(fn) SET h.seen = $run`;

/** CODEOWNERS team handles and the files they own. Used by: indexer. */
export const UPSERT_OWNERS = `
UNWIND $rows AS row
MATCH (f:File {id: row.file})
MERGE (t:Team {id: row.team}) SET t.handle = row.team, t.seen = $run
MERGE (t)-[o:OWNS]->(f) SET o.seen = $run`;

/**
 * API surface, created on demand by the indexer and in full by the SDK differ; both MERGE the same ids:
 * Provider -HAS-> Resource (-HAS-> Resource)* -HAS-> Operation -HAS-> Param -HAS-> Value.
 * Resources are written one depth level per call so each parent already exists.
 * Used by: indexer, SDK differ.
 */
export const UPSERT_PROVIDERS = `
UNWIND $rows AS row
MERGE (p:Provider {id: row.id}) SET p.name = row.name`;

export const UPSERT_RESOURCES = `
UNWIND $rows AS row
MERGE (r:Resource {id: row.id}) SET r.name = row.name, r.provider = row.provider
WITH row, r
OPTIONAL MATCH (pp:Provider {id: row.parent})
OPTIONAL MATCH (pr:Resource {id: row.parent})
WITH r, coalesce(pp, pr) AS parent
MERGE (parent)-[:HAS]->(r)`;

export const UPSERT_OPERATIONS = `
UNWIND $rows AS row
MATCH (r:Resource {id: row.parent})
MERGE (o:Operation {id: row.id}) SET o.name = row.name, o.provider = row.provider
MERGE (r)-[:HAS]->(o)`;

export const UPSERT_PARAMS = `
UNWIND $rows AS row
MATCH (o:Operation {id: row.op})
MERGE (pa:Param {id: row.id}) SET pa.name = row.name
MERGE (o)-[:HAS]->(pa)`;

/** Call sites, the operation they invoke, the params they use and the literal values they pass. Used by: indexer. */
export const UPSERT_CALL_SITES = `
UNWIND $rows AS row
MATCH (fn:Function {id: row.fn}), (o:Operation {id: row.op})
MERGE (cs:CallSite {id: row.id})
SET cs.file = row.file, cs.line = row.line, cs.snippet = row.snippet, cs.provider = row.provider,
    cs.sdk_version = row.sdk_version, cs.binding = row.binding, cs.seen = $run
MERGE (fn)-[h:HAS_CALL_SITE]->(cs) SET h.seen = $run
MERGE (cs)-[i:INVOKES]->(o) SET i.seen = $run`;

/** Param use by a call site; `binding` is literal | dynamic. Used by: indexer. */
export const UPSERT_USES = `
UNWIND $rows AS row
MATCH (cs:CallSite {id: row.cs}), (pa:Param {id: row.param})
MERGE (cs)-[u:USES]->(pa) SET u.binding = row.binding, u.seen = $run`;

/** Literal values passed by a call site; `role` primary | fallback and `order` form the fallback chain. Used by: indexer. */
export const UPSERT_PASSES = `
UNWIND $rows AS row
MATCH (cs:CallSite {id: row.cs}), (pa:Param {id: row.param})
MERGE (v:Value {id: row.id}) SET v.value = row.value, v.pinned = row.pinned
MERGE (pa)-[:HAS]->(v)
MERGE (cs)-[e:PASSES]->(v) SET e.role = row.role, e.order = row.order, e.seen = $run`;

/** Remove code-layer nodes and edges not seen in this run (deleted files, moved lines). Used by: indexer. */
export const DELETE_STALE = [
  `MATCH (n) WHERE (n:File OR n:Function OR n:Route OR n:CallSite OR n:Team) AND n.seen <> $run DETACH DELETE n`,
  `MATCH ()-[e:CALLS|HANDLED_BY|OWNS|HAS_CALL_SITE|INVOKES|USES|PASSES]->() WHERE e.seen <> $run DELETE e`,
];

// ---------------------------------------------------------------------------
// Change layer. ChangeEvents attach to any surface level (Operation, Param, Value),
// so a change reaches every call site beneath its target.
// ---------------------------------------------------------------------------

/** Upsert a change event and the release that introduced it. Used by: SDK differ, lifecycle sync. */
export const UPSERT_CHANGE = `
MERGE (c:ChangeEvent {id: $id})
SET c.kind = $kind, c.severity = $severity, c.summary = $summary, c.provider = $provider,
    c.source = $source, c.source_url = $source_url, c.effective_date = $effective_date, c.seen_at = $now
WITH c
MATCH (t {id: $target})
WHERE t:Operation OR t:Param OR t:Value
MERGE (c)-[:AFFECTS]->(t)`;

/** Link a change to its SDK release. Used by: SDK differ. */
export const UPSERT_RELEASE = `
MATCH (c:ChangeEvent {id: $change})
MERGE (r:SdkRelease {id: $id}) SET r.package = $package, r.ecosystem = $ecosystem, r.version = $version, r.from = $from
MERGE (r)-[:INTRODUCES]->(c)`;

/** Link a change to what replaces it (a param or value). Used by: SDK differ, lifecycle sync. */
export const UPSERT_REPLACEMENT = `
MATCH (c:ChangeEvent {id: $change}), (t {id: $target})
WHERE t:Operation OR t:Param OR t:Value
MERGE (c)-[:REPLACEMENT]->(t)`;

/** Operations invoked anywhere in this repo, so SDK diffs only ingest changes that can matter. Used by: watcher. */
export const USED_OPERATIONS = `
MATCH (cs:CallSite)-[:INVOKES]->(o:Operation)
RETURN DISTINCT o.id AS id, o.provider AS provider, collect(DISTINCT cs.sdk_version) AS versions, collect(DISTINCT cs.file) AS files`;

/** Model values a repo passes for one provider (lifecycle data matches against these). Used by: lifecycle sync. */
export const MODEL_VALUES = `
MATCH (o:Operation {provider: $provider})-[:HAS]->(pa:Param {name: $param})-[:HAS]->(v:Value)
RETURN v.id AS id, v.value AS value, pa.id AS param`;

/** Record what a rolling alias resolves to; the target is a pinned Value under the same Param. Used by: lifecycle sync. */
export const UPSERT_ALIAS = `
MATCH (alias:Value {id: $alias}), (pa:Param {id: $param})
MERGE (t:Value {id: $target}) SET t.value = $value, t.pinned = true
MERGE (pa)-[:HAS]->(t)
MERGE (alias)-[r:RESOLVES_TO]->(t) SET r.source_url = $source_url`;

/** Ensure a Value node exists (replacement targets). Used by: lifecycle sync. */
export const UPSERT_VALUE = `
MATCH (pa:Param {id: $param})
MERGE (v:Value {id: $id}) SET v.value = $value, v.pinned = $pinned
MERGE (pa)-[:HAS]->(v)`;

// ---------------------------------------------------------------------------
// Impact: the multi-hop join.
//   down:  ChangeEvent -AFFECTS-> surface node -HAS*-> ... <-[RESOLVES_TO]- alias <-USES|PASSES|INVOKES- CallSite
//   up:    CallSite <-HAS_CALL_SITE- Function <-CALLS*- Function <-HANDLED_BY- Route ; File <-OWNS- Team
// ---------------------------------------------------------------------------

/**
 * Call sites a change reaches, walking down the surface hierarchy (and through rolling aliases).
 * Returns the downward path (change -> ... -> call site). Used by: blast_radius, watcher.
 */
export const IMPACT_DOWN = `
MATCH (c:ChangeEvent {id: $change})-[:AFFECTS]->(s)
MATCH down = (s)-[:HAS*0..4]->(leaf)
MATCH via = (cs:CallSite)-[:INVOKES|USES|PASSES]->()-[:RESOLVES_TO*0..1]->(leaf)
RETURN c, cs.id AS callsite, nodes(down) AS down, relationships(down) AS downEdges, nodes(via) AS via, relationships(via) AS viaEdges`;

/**
 * Routes and owners above a call site: every route whose handler reaches the call site's function.
 * Used by: blast_radius, explain_path, rank_findings.
 */
export const IMPACT_UP = `
MATCH (cs:CallSite {id: $callsite})<-[:HAS_CALL_SITE]-(f:Function)
OPTIONAL MATCH up = (r:Route)-[:HANDLED_BY]->(:Function)-[:CALLS*0..8]->(f)
OPTIONAL MATCH (t:Team)-[:OWNS]->(:File {path: cs.file})
RETURN cs, f, r, up, collect(DISTINCT t.handle) AS owners`;

/** Change events in this repo graph, optionally filtered. Used by: list_changes. */
export const LIST_CHANGES = `
MATCH (c:ChangeEvent)
WHERE ($kind IS NULL OR c.kind = $kind) AND ($provider IS NULL OR c.provider = $provider)
OPTIONAL MATCH (c)-[:AFFECTS]->(t)
OPTIONAL MATCH (c)-[:REPLACEMENT]->(rep)
OPTIONAL MATCH (rel:SdkRelease)-[:INTRODUCES]->(c)
RETURN c, collect(DISTINCT t.id) AS targets, collect(DISTINCT rep.id) AS replacements, rel.id AS release
ORDER BY c.severity, c.id`;

// ---------------------------------------------------------------------------
// Findings: one per (change, call site). Created by the watcher, claimed by migrators.
// ---------------------------------------------------------------------------

/** Create findings idempotently; status starts `open` and is never reset by a re-run. Used by: watcher. */
export const UPSERT_FINDINGS = `
UNWIND $rows AS row
MATCH (c:ChangeEvent {id: row.change}), (cs:CallSite {id: row.callsite})
MERGE (f:Finding {id: row.id})
ON CREATE SET f.status = 'open', f.created_at = $now
SET f.kind = c.kind, f.severity = c.severity, f.routes = row.routes, f.owners = row.owners, f.summary = row.summary
MERGE (f)-[:AT]->(cs)
MERGE (f)-[:CAUSED_BY]->(c)
RETURN count(f) AS n`;

/** Findings with their call site and change. Used by: rank_findings, migration_batches, explain_path, migrator. */
export const LIST_FINDINGS = `
MATCH (f:Finding)-[:AT]->(cs:CallSite), (f)-[:CAUSED_BY]->(c:ChangeEvent)
WHERE ($status IS NULL OR f.status = $status) AND ($id IS NULL OR f.id = $id)
RETURN f, cs, c
ORDER BY f.id`;

// ---------------------------------------------------------------------------
// Algorithms
// ---------------------------------------------------------------------------

/**
 * PageRank over the call graph: functions many paths flow into score higher. A finding's
 * criticality uses the highest-ranked function on its path. Used by: rank_findings.
 */
export const PAGERANK = `
CALL algo.pageRank('Function', 'CALLS') YIELD node, score
RETURN node.id AS id, score`;

/** Functions on the call chain above a call site (for summing criticality). Used by: rank_findings. */
export const CHAIN_FUNCTIONS = `
MATCH (cs:CallSite {id: $callsite})<-[:HAS_CALL_SITE]-(f:Function)
OPTIONAL MATCH (g:Function)-[:CALLS*1..8]->(f)
RETURN f.id AS fn, collect(DISTINCT g.id) AS callers`;

/**
 * Batching edges: two findings belong in one fix when they share an owner team and either the same
 * change or the same function (e.g. a primary call and its fallback, or two changes on one call site). Rebuilt before each batching run. Used by: migration_batches.
 */
export const REBUILD_SAME_FIX = [
  `MATCH ()-[e:SAME_FIX]->() DELETE e`,
  `MATCH (a:Finding)-[:CAUSED_BY]->(c:ChangeEvent)<-[:CAUSED_BY]-(b:Finding)
   WHERE a.id < b.id AND a.owners = b.owners AND a.status <> 'done' AND b.status <> 'done'
   MERGE (a)-[:SAME_FIX {why: 'same change, same owner'}]->(b)`,
  `MATCH (a:Finding)-[:AT]->(:CallSite)<-[:HAS_CALL_SITE]-(fn:Function)-[:HAS_CALL_SITE]->(:CallSite)<-[:AT]-(b:Finding)
   WHERE a.id < b.id AND a.owners = b.owners AND a.status <> 'done' AND b.status <> 'done'
   MERGE (a)-[:SAME_FIX {why: 'same function, same owner'}]->(b)`,
];

/** Weakly connected components over SAME_FIX: each component is one migration batch. Used by: migration_batches. */
export const WCC_BATCHES = `
CALL algo.WCC({nodeLabels: ['Finding'], relationshipTypes: ['SAME_FIX']}) YIELD node, componentId
WHERE node.status <> 'done'
RETURN componentId, collect(node.id) AS findings`;

/** Persist the batch id on each finding. Used by: migration_batches. */
export const SET_BATCH = `
UNWIND $rows AS row MATCH (f:Finding {id: row.id}) SET f.batch = row.batch`;

// ---------------------------------------------------------------------------
// Coordination and memory
// ---------------------------------------------------------------------------

/**
 * Atomic claim: succeeds only if the finding is still open. FalkorDB executes writes to one graph
 * serially, so two agents can never both see `open`. Used by: claim_finding, migrator.
 */
export const CLAIM = `
MATCH (f:Finding {id: $id})
WHERE f.status = 'open'
SET f.status = 'claimed', f.claimed_by = $agent, f.claimed_at = $now
RETURN f.id AS id`;

/** Who holds a finding (for a failed claim's message). Used by: claim_finding. */
export const FINDING_STATUS = `MATCH (f:Finding {id: $id}) RETURN f.status AS status, f.claimed_by AS claimed_by, f.url AS url`;

/** Move a finding through its lifecycle: open -> claimed -> done | declined. Clears the agent holder: only CLAIM sets one. Used by: migrator, record_decision. */
export const SET_STATUS = `
MATCH (f:Finding {id: $id}) SET f.status = $status, f.updated_at = $now, f.claimed_by = null
WITH f WHERE $url IS NOT NULL SET f.url = $url`;

/** Episodic memory: a decision about a finding, with who made it and from which client. Used by: record_decision. */
export const RECORD_DECISION = `
MATCH (f:Finding {id: $finding})
CREATE (d:Decision {id: $id, kind: $kind, reason: $reason, agent: $agent, client: $client, at: $now})
CREATE (d)-[:ON]->(f)
RETURN d.id AS id`;

/** Procedural memory: a recipe that fixed a change, linked to where it worked. Used by: save_recipe, migrator. */
export const SAVE_RECIPE = `
MATCH (c:ChangeEvent {id: $change})
MERGE (r:Recipe {id: $id})
SET r.steps = $steps, r.from = $from, r.to = $to, r.created_by = $agent, r.at = $now, r.change_summary = c.summary
MERGE (r)-[:FIXES]->(c)
WITH r
OPTIONAL MATCH (cs:CallSite {id: $callsite})
FOREACH (_ IN CASE WHEN cs IS NULL THEN [] ELSE [1] END | MERGE (r)-[:WORKED_AT]->(cs))
RETURN r.id AS id`;

/** Publish a recipe to the shared graph, keyed by change id (ids are identical across repo graphs). A published recipe is never overwritten. Used by: publish_recipe. */
export const PUBLISH_RECIPE = `
MERGE (c:ChangeEvent {id: $change}) SET c.summary = $summary
MERGE (r:Recipe {id: $id})
ON CREATE SET r.steps = $steps, r.from = $from, r.to = $to, r.created_by = $agent, r.at = $now, r.origin = $origin, r.uses = 0
MERGE (r)-[:FIXES]->(c)
RETURN r.id AS id`;

/** Recipe lookup by change id (repo graph or shared graph). Used by: recall, migrator. */
export const RECIPES_FOR = `
MATCH (r:Recipe)-[:FIXES]->(c:ChangeEvent)
WHERE c.id IN $changes
RETURN r, c.id AS change ORDER BY r.at DESC`;

/** Episodic recall: decisions and sessions on the given findings (or the most recent ones). Used by: recall. */
export const RECALL = `
MATCH (f:Finding)
WHERE size($findings) = 0 OR f.id IN $findings
OPTIONAL MATCH (d:Decision)-[:ON]->(f)
OPTIONAL MATCH (s:Session)-[:DISCUSSED]->(f)
WITH f, collect(DISTINCT d) AS decisions, collect(DISTINCT s) AS sessions
WHERE size(decisions) > 0 OR size(sessions) > 0
RETURN f.id AS finding, f.status AS status, f.summary AS summary, decisions, sessions`;

/** Persistent conversation history: one Session per client connection. Used by: MCP server, agents. */
export const UPSERT_SESSION = `
MERGE (s:Session {id: $id})
ON CREATE SET s.started_at = $now
SET s.agent = $agent, s.client = $client, s.at = $now, s.summary = coalesce($summary, s.summary)`;

/** Link a session to findings it touched. Used by: MCP server, agents. */
export const SESSION_DISCUSSED = `
MATCH (s:Session {id: $session}) UNWIND $findings AS fid MATCH (f:Finding {id: fid})
MERGE (s)-[:DISCUSSED]->(f)`;

/** Recent sessions in this repo (for a new session's opening recall). Used by: recall. */
export const RECENT_SESSIONS = `
MATCH (s:Session) WHERE s.id <> $exclude
OPTIONAL MATCH (s)-[:DISCUSSED]->(f:Finding)
RETURN s, collect(f.id) AS findings ORDER BY s.at DESC LIMIT 5`;
