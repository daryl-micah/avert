---
title: FalkorDB
description: Why Avert's core question is a graph query, how it uses FalkorDB, and what each piece of the database does.
---

Avert answers one question: *a provider changed something, so which of my routes and teams does that break?* The answer is a path
through several kinds of relationship, and FalkorDB is the part that finds it. With the database stopped, every Avert tool fails.

## The use case

A retired model id, a removed parameter or a sunset API version does not show up in a manifest. To find what it breaks you have to
follow links that already exist in your code and in the provider's API:

```text
change → API surface (provider → resource → operation → param → value)
       → call site that passes that value (even through a rolling alias)
       → function → the functions that call it → route → owning team
```

The first half goes **down** a hierarchy of unknown depth. The second goes **up** a call chain of unknown depth. Both halves are
graph traversals, and the result is a path that can be shown as evidence, not a count.

## How Avert uses it

| Need | FalkorDB feature | Where |
|---|---|---|
| Change → call sites, through aliases | Variable-length match, `[:HAS*0..4]` and `[:RESOLVES_TO*0..1]` | `IMPACT_DOWN` |
| Call site → routes and owners | Variable-length match, `[:CALLS*0..8]`, returning the path | `IMPACT_UP` |
| Rank by how central a function is | `algo.pageRank` over `CALLS` | `rank_findings` |
| Group findings into one issue each | `algo.WCC` over `SAME_FIX` edges | `migration_batches` |
| Two agents never take the same finding | One conditional write, applied serially per graph | `claim_finding` |
| Agents remember across sessions | Decisions, sessions and recipes as nodes next to the findings | `recall`, `record_decision`, `save_recipe` |

The full Cypher for each row is in the [query reference](/reference/queries/), generated from `src/queries.ts`.

## The two halves of the join

Downward, from a change to every call site it reaches:

```cypher
MATCH (c:ChangeEvent {id: $change})-[:AFFECTS]->(s)
MATCH down = (s)-[:HAS*0..4]->(leaf)
MATCH via = (cs:CallSite)-[:INVOKES|USES|PASSES]->()-[:RESOLVES_TO*0..1]->(leaf)
RETURN c, cs.id AS callsite, nodes(down) AS down, relationships(down) AS downEdges, nodes(via) AS via, relationships(via) AS viaEdges
```

Upward, from one call site to the routes and owners above it:

```cypher
MATCH (cs:CallSite {id: $callsite})<-[:HAS_CALL_SITE]-(f:Function)
OPTIONAL MATCH up = (r:Route)-[:HANDLED_BY]->(:Function)-[:CALLS*0..8]->(f)
OPTIONAL MATCH (t:Team)-[:OWNS]->(:File {path: cs.file})
RETURN cs, f, r, up, collect(DISTINCT t.handle) AS owners
```

Both return `nodes(...)` and `relationships(...)`, which is where the evidence path comes from. Avert does not rebuild the path in
application code: it is exactly what the database matched. That is why every tool result carries a `path`, for example:

```text
ChangeEvent  retired: claude-3-5-sonnet-20241022 …   -AFFECTS->
Value        "claude-3-5-sonnet-20241022"            <-RESOLVES_TO-
Value        "claude-3-5-sonnet-latest" (alias)      <-PASSES-
CallSite     claude.messages.create(  support/app/llm.py:19   <-HAS_CALL_SITE-
Function     answer()  →  draft_reply()  →  reply()   <-HANDLED_BY-
Route        POST /support/reply                     <-OWNS-
Team         @acme/support-ai
```

## Why not a table

The same data fits in tables, but the two questions above need joins whose depth is not known in advance: how many functions sit
between a route and the call site, and how many levels a change attaches above its leaves. In a graph that is one pattern. In SQL it
is a recursive query per direction and a second pass to rebuild the path. The ranking and batching steps are also graph algorithms
(PageRank, connected components) that FalkorDB provides directly, so they run next to the data.

## How the data is laid out

- **One graph per repository**, `avert:<owner>__<repo>`, plus `avert:shared` for published recipes. FalkorDB cannot query across
  graphs, so the surface and change nodes a repository needs are merged into its own graph, using ids that are identical everywhere.
- **Indexes** on `id` for every label, and on `ChangeEvent.kind`, `Finding.status` and `Value.value`, created when a graph is first used.
- **Idempotent writes.** Indexing upserts with `MERGE` and stamps each node with the run id. A final sweep deletes nodes the run did
  not see, so a re-index reflects the code as it is now and never duplicates.
- **Serial writes are the coordination primitive.** FalkorDB applies writes to one graph one at a time, so claiming a finding is a
  single `WHERE f.status = 'open' SET f.status = 'claimed'`, with no lock service.
  `scripts/concurrency.ts` races several processes against one repository and asserts no finding is claimed twice.

## Running it

Locally, the repository's `docker-compose.yml` starts a pinned FalkorDB image bound to loopback only:

```bash
docker compose up -d     # FalkorDB on localhost:6380
```

Avert reads `FALKORDB_URL` (default `falkor://localhost:6380`). The hosted demo uses FalkorDB Cloud, passed to the Azure Container App as a
secret. Use `falkors://` if the server supports TLS, because Avert warns when a password would cross the network unencrypted.

The hosted server is read-only: it serves only the graphs on its allowlist (`AVERT_PUBLIC_GRAPHS`), and read queries run with a
15-second `TIMEOUT` so a runaway path or PageRank query cannot hold the database.

Moving data between two FalkorDB deployments works best by re-running `avert index` and `avert sync` against the target. A dump from
one instance did not restore onto another running a different graph module version, and re-indexing a repository takes seconds.
