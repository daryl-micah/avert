---
title: Contributing
description: Add a provider, a model lifecycle file, an extractor rule or a recipe.
---

```bash
git clone https://github.com/daryl-micah/avert && cd avert
pnpm install && docker compose up -d
pnpm test && pnpm typecheck
```

Tests use fixtures and do not need FalkorDB for the extractor and differ suites.

## Add a provider

Providers are data. Add an entry to [`data/providers.yaml`](https://github.com/daryl-micah/avert/blob/main/data/providers.yaml):

```yaml
acme:
  name: Acme
  npm: "@acme/sdk"          # package whose releases are diffed
  pypi: acme                # same on PyPI
  ts:
    imports: { "@acme/sdk": { ctors: [Acme, default] } }   # how a client is created in TypeScript
  py:
    imports: { acme: { ctors: [Acme, AsyncAcme] } }        # and in Python
  sdk: { ts: Acme, py: Acme }                              # root client class the differ walks
```

`new X(...)` clients use `ctors`; set `call: true` for a factory function (`stripe(...)`), and `module_client: true` when the module
itself is the client (`openai.chat.completions.create`). The SDK differ walks the public surface from the root class of the latest
package and diffs it against the version your manifest declares.

## Add model lifecycle data

Add `data/lifecycle/<provider>.yaml` with one row per dated model id, a `source_url` and a `retrieved` date:

```yaml
provider: acme
param: model
source_url: https://example.com/deprecations
retrieved: 2026-10-16
models:
  - { id: acme-1-20250101, announced: 2026-06-01, retires: 2026-12-01, replacement: acme-2 }
aliases:
  - { id: acme-1-latest, resolves_to: acme-1-20250101 }
```

A model past its `retires` date becomes `retired`; before it, `deprecated` with an `effective_date`. Aliases let a change to a
pinned model reach calls that pass the rolling alias. Only add rows you can point to a public page for.

## Add or fix an extractor rule

The indexers are [`src/indexer/py.ts`](https://github.com/daryl-micah/avert/blob/main/src/indexer/py.ts) and
[`ts.ts`](https://github.com/daryl-micah/avert/blob/main/src/indexer/ts.ts), on tree-sitter. Add a case to
`test/extract.test.ts` that shows the call site, route or fallback you expect, then make it pass.

## Add a recipe

Recipes come from real fixes: call `save_recipe` (and `publish_recipe`) from an agent session, or let the migrator do it. A recipe is a
`from → to` param name or literal value, so it is only offered where the same change applies.

## Conventions

- Every Cypher query lives in `src/queries.ts` with a doc comment naming who uses it. `pnpm docs:gen` rebuilds the reference pages
  from it and from the tool registry, so edit the source, not the generated pages.
- New tools go in `src/registry.ts`: one definition serves both the MCP server and the agents.
- Every tool result should return its `path`.
