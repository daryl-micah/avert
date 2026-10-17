---
title: Connect Claude Code or Cursor
description: Add Avert's MCP server to the coding agent you already use.
---

Avert's MCP server exposes the [named domain tools](/reference/mcp-tools/). Each client connection is stored as a `Session` in the
graph and linked to the findings it touched, so a second client can `recall` what the first one decided.

## The hosted demo (read-only, nothing to install)

```bash
claude mcp add --transport http avert-demo https://avert-demo.fly.dev/mcp
```

It serves two pre-indexed graphs, `avert:acme` and `avert:flutter-stripe__flutter_stripe`, with the read tools only. Pass one of
those names as `repo`. Write tools (`index_repo`, `claim_finding`, `open_pr` and the rest) are not exposed.

## Your own repositories (local, full tools)

Start FalkorDB first (see the [Quickstart](/quickstart/)), then register the server with an absolute path to your clone:

```bash
claude mcp add avert -e FALKORDB_URL=falkor://localhost:6380 -- npx tsx /abs/path/to/avert/src/cli.ts mcp
```

Add `--read-only` after `mcp` to hide the write tools.

### Cursor

`.cursor/mcp.json` (or the global one):

```json
{
  "mcpServers": {
    "avert": {
      "command": "npx",
      "args": ["tsx", "/abs/path/to/avert/src/cli.ts", "mcp"],
      "env": { "FALKORDB_URL": "falkor://localhost:6380", "AVERT_REPO": "/abs/path/to/your/repo" }
    }
  }
}
```

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector npx tsx /abs/path/to/avert/src/cli.ts mcp
```

## Try the handoff between two clients

`scripts/act3.ts` connects as two differently named clients (`claude-code`, then `cursor`). The first records a `defer` decision;
the second calls `recall` with no hints and gets it back:

```bash
pnpm tsx scripts/act3.ts examples/acme
```

## A good first prompt

> Call `recall`, then `rank_findings`. For the top finding, call `blast_radius` and tell me which route and team it reaches.
