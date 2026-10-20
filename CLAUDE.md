# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Behavioural rules for this repo (surgical changes, no commits or pushes to main unless asked, compaction template) are in
[`AGENTS.md`](AGENTS.md). Follow them.

## What this is

Avert (npm package `avert-mcp`): indexes a repo's external API calls into a FalkorDB graph, diffs provider SDKs / reads model
lifecycle data to detect changes, and joins the two with one graph query to trace a change to call site, route and owning team. An
MCP server and two LLM agents (watcher, migrator) sit on top. FalkorDB is required: with it stopped every tool fails.

## Commands

```bash
pnpm install
docker compose up -d                  # FalkorDB on localhost:6380 (default FALKORDB_URL)
pnpm typecheck                        # tsc --noEmit
pnpm test                             # vitest run
pnpm vitest run test/ratelimit.test.ts            # one file
pnpm vitest run -t "resets after the window"      # one test by name
pnpm build                            # tsc + copies src/web/index.html into dist/web/
pnpm docs:gen                         # regenerate site reference pages from src/queries.ts and src/registry.ts
pnpm avert index examples/acme        # CLI via tsx; also sync, changes, blast, web, mcp, watch, migrate
pnpm tsx scripts/mcp-http-check.ts <url>/mcp      # smoke-test a hosted read-only MCP endpoint
pnpm tsx scripts/concurrency.ts                   # race several migrators; asserts no double claims (needs FalkorDB)
cd site && pnpm install && pnpm dev   # docs site (Astro Starlight), a separate package, not a workspace member
```

Tests use fixtures; the extractor and differ suites don't need FalkorDB. CI (`.github/workflows/publish.yml`) publishes to npm on a
`v*` tag, which must equal `package.json` version. `.github/workflows/deploy.yml` builds the image to GHCR on every push to `main`
or `dev` and updates the matching Azure Container App (see Branches and environments).

## Architecture

- **One entry point per concern.** `src/cli.ts` is a `switch` over subcommands. `src/registry.ts` defines every tool once; the MCP
  server (`src/mcp.ts`) and the agents (`src/agents/`) both consume it, so add new tools there. `src/tools.ts` holds the tool
  implementations.
- **All Cypher lives in `src/queries.ts`**, each query with a doc comment naming who uses it. `pnpm docs:gen` builds the site's
  reference pages from it, so edit the source, never the generated pages. Every tool result should return its `path`
  (rendered by `src/path.ts`).
- **Graph per repo** (`avert:<owner>__<repo>`, plus `avert:shared` for recipes). FalkorDB can't query across graphs, so the
  surface and change nodes a repo needs are merged into its own graph with ids that are identical everywhere. `src/db.ts` owns the
  connection, `graphName()`, `ensureSchema()` and `run()`.
- **Pipeline:** `src/indexer/` (tree-sitter for Python/TS: functions, call chains, routes, CODEOWNERS, SDK call sites; add
  extractor cases in `test/extract.test.ts` first) → `src/surface/` (SDK surface from npm `.d.ts` / PyPI wheels, diffed against the
  version the manifest declares) + `src/changes.ts` (SDK diffs and `data/lifecycle/*.yaml` model data become `ChangeEvent`s and
  `Finding`s) → `src/tools.ts` joins down the API surface to call sites, then up the call chain to routes and owners.
- **Providers are data** in `data/providers.yaml`, lifecycle facts in `data/lifecycle/<provider>.yaml` (each dated, with a source URL).
- **Agents** (`src/agents/`) never talk to each other; the only handoff is finding status in the graph
  (`open → claimed → done | declined`). Claiming is a single write, which FalkorDB serialises per graph. Without `GROQ_API_KEY` they
  use a deterministic path. PR branch names derive from the change event, never the clock, so re-runs update the same PR.
- **Web** (`src/web/server.ts`, Hono): the read-only demo server, serving `/api`, `/mcp` and a single `index.html`. It is
  rate-limited (`ratelimit.ts` keys on the right-most `X-Forwarded-For` entry, the one Azure's ingress appends) and only serves
  graphs listed in `AVERT_PUBLIC_GRAPHS`. In production with no list it serves none.

## Environment

`FALKORDB_URL` (default `falkor://localhost:6380`), `GROQ_API_KEY` / `AVERT_MODEL` / `AVERT_LLM_BASE_URL` (agents),
`GH_TOKEN` / `GITHUB_TOKEN`, `AVERT_PUBLIC_GRAPHS`, `HOST`, `PORT`. Setting `AVERT_READ_ONLY` makes `run()` use `GRAPH.RO_QUERY`, so
the hosted web user can hold no write permission. `.env` is gitignored.

## Branches and environments

Work lands on `dev`; `main` is the public release and is not pushed to directly. Each branch deploys on push:

| Branch | Azure Container App (rg `avert`, uaenorth) | Image tag | Docs site (Vercel project `avert`, root `site/`) |
|---|---|---|---|
| `main` | `avert-web` | `:latest` | avert-agent.vercel.app (production) |
| `dev` | `avert-web-dev` | `:dev` | avert-agent-dev.vercel.app (preview, behind Vercel login) |

Azure access is OIDC: the `avert-deploy` app registration has one federated credential per branch, so a new deploy branch needs a
new credential. Both apps share one FalkorDB Cloud free-tier instance, so load on dev also loads prod's database.

## Hosted demo

Runs on Azure Container Apps, not Fly: `fly.toml` and the `avert-demo.fly.dev` links in the README and `site/` docs are stale and
still to be replaced. Graphs live in FalkorDB Cloud, which has no TLS (`falkor://`) and does not allow
`ACL SETUSER` from the admin user, so the read-only `avert-web` user is created in its dashboard. `PLAN.md` and `DIRECTIVE.md` are
gitignored local planning documents; `PLAN.md` holds the milestone plan (M1 to M6).
