---
title: Quickstart
description: Index a repository, find what a provider change breaks, and connect an agent.
---

You need Node 22+, pnpm and Docker. This page works from a clone, because the demo service lives in the repository. To use Avert on
your own code without cloning, see [Connect an agent](/connect/): it runs as `npx -y avert-mcp mcp`.

## 1. Install and start FalkorDB

```bash
git clone https://github.com/daryl-micah/avert && cd avert
pnpm install
docker compose up -d        # FalkorDB on localhost:6380
```

Avert reads `FALKORDB_URL` (default `falkor://localhost:6380`). Use `falkors://user:password@host:port` (TLS) for a hosted instance, or `falkor://` if it has no TLS; Avert warns when a password would travel unencrypted.

## 2. Index the demo service

```bash
pnpm avert index examples/acme
# avert:acme: 6 files, 11 functions, 2 routes, 3 call sites
```

`examples/acme` is a synthetic service: a TypeScript checkout API and a Python support API. You can also pass any GitHub URL.
Each repository gets its own graph, named `avert:<owner>__<repo>` (or `avert:<dirname>` for a local path).

## 3. Pull in provider changes

```bash
pnpm avert sync examples/acme
# 28 SDK changes, 3 lifecycle changes, 3 findings
#   [removed] stripe.payment_intents.create#payment_method_types removed
#   [retired] claude-3-5-sonnet-20241022 retired on 2025-10-28; replacement claude-sonnet-5-5
#   [deprecated] gpt-4o-2024-08-06 retires on 2027-01-14; replacement gpt-6-luna
```

The first run downloads the SDK packages from npm and PyPI to diff them, which takes a few seconds per SDK. Results are cached.
Only changes to operations your code calls become findings.

## 4. See what a change breaks

```bash
pnpm avert changes examples/acme              # list change ids
pnpm avert blast examples/acme <change_id>    # call sites, routes, owners, with the path
```

Or open the same view in a browser:

```bash
pnpm avert web      # http://localhost:8787, read-only path view
```

## 5. Let agents act

Set a [Groq](https://console.groq.com) key, then run the watcher and a migrator. The migrator opens a pull request on the repo named
by `AVERT_GITHUB_REPO`, and only there: it never writes to a repo just because it indexed it (it uses `GITHUB_TOKEN`, or `gh auth token`):

```bash
export GROQ_API_KEY=...
export AVERT_GITHUB_REPO=your-org/your-repo
pnpm avert watch examples/acme
pnpm avert migrate examples/acme --agent claude-code
```

Without `GROQ_API_KEY` both fall back to a deterministic path that opens a pull request when the fix is mechanical and an issue
otherwise. Continue with [Connect Claude Code or Cursor](/connect/) and [Agents and memory](/agents/).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FALKORDB_URL` | `falkor://localhost:6380` | FalkorDB connection |
| `GROQ_API_KEY` | none | Agents use Groq's OpenAI-compatible API |
| `AVERT_MODEL` | `openai/gpt-oss-120b` | Model for the agents |
| `AVERT_LLM_BASE_URL` | Groq | Any OpenAI-compatible endpoint |
| `AVERT_GITHUB_REPO` | none (required for issues and PRs) | The only repo issues and PRs go to |
| `AVERT_GITHUB_PATH_PREFIX` | empty | Prefix when the repo is a subdirectory of the GitHub repo |
| `AVERT_REPO` | working directory | Default `repo` for MCP tools |
| `AVERT_CACHE` | `~/.cache/avert` | Cloned repos and extracted SDK surfaces |
| `PORT` | `8787` | `avert web` port |
| `HOST` | `127.0.0.1` | `avert web` bind address; the Docker image sets `0.0.0.0` |
| `AVERT_PUBLIC_GRAPHS` | every graph, or none when `NODE_ENV=production` | Comma-separated graphs `avert web` and `mcp --read-only` may serve |
