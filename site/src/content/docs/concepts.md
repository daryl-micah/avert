---
title: Concepts
description: The graph model, the join, and why every result carries a path.
---

## Four layers in one graph

Each repository has its own FalkorDB graph, `avert:<owner>__<repo>`. A separate graph, `avert:shared`, holds published recipes.

**Code structure** comes from the indexer: `Repo`, `File`, `Function`, `Route`, `Team` and `CallSite`, joined by `CONTAINS`,
`DEFINES`, `CALLS`, `HANDLED_BY`, `HAS_CALL_SITE` and `OWNS`.

**API surface** is a hierarchy, `Provider → Resource → Operation → Param → Value`, joined by a single edge type, `HAS`. A call site
`INVOKES` an operation, `USES` params and `PASSES` literal values (with a `role` of primary or fallback and an `order`). Because the
surface is a hierarchy, a change attached at any level reaches every call site beneath it.

**Changes** are `ChangeEvent` nodes (kind `removed`, `renamed`, `deprecated`, `retired` or `added`) that `AFFECTS` a surface node,
with `REPLACEMENT` edges to what replaces it and `INTRODUCES` edges from the `SdkRelease` that caused it.

**Memory** is `Finding`, `Decision`, `Recipe` and `Session`, joined by `AT`, `CAUSED_BY`, `ON`, `FIXES`, `WORKED_AT`, `DISCUSSED`
and `SAME_FIX`.

## The join

A finding is one change at one call site. Two queries produce it (see the [query reference](/reference/queries/)):

1. **Down:** from the `ChangeEvent`, along `AFFECTS`, down `HAS*0..4` to every leaf, then to the `CallSite` that invokes, uses or
   passes it. A hop over `RESOLVES_TO*0..1` lets a change to a pinned model reach calls that pass a rolling alias.
2. **Up:** from the call site, along `HAS_CALL_SITE` and `CALLS*0..8` back to the `Function` a `Route` is `HANDLED_BY`, and to the
   `Team` that `OWNS` the file.

Without the graph this is two joins across a surface hierarchy and a call graph of unknown depth. With it, it is two traversals.

## Every result returns its path

Each tool result carries `path`: an ordered list of steps `{kind, id, label, file?, line?, edge}`. The CLI prints it, the web view
draws it, and issue and pull request bodies embed it, so a finding is never an unexplained claim.

## What the graph does that a table would not

- **Reach:** `rank_findings` scores severity × urgency × reach, where reach counts routes and adds the PageRank
  (`algo.pageRank`) of the most central function on the chain.
- **Batches:** `migration_batches` runs `algo.WCC` over `SAME_FIX` edges between findings that share an owner and a change or a
  function. One batch becomes one issue.
- **Cross-repo memory:** change ids are identical across graphs, so a recipe published to `avert:shared` is found by any repository
  hit by the same change. FalkorDB cannot query across graphs, so Avert merges the surface and change nodes a repo needs into its own graph.
