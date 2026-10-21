---
title: Connect Claude Code or Cursor
description: Add Avert's MCP server to the coding agent you already use.
---

Avert's MCP server exposes the [named domain tools](/reference/mcp-tools/). Each client connection is stored as a `Session` in the
graph and linked to the findings it touched, so a second client can `recall` what the first one decided.

## The hosted demo (read-only, nothing to install)

```bash
claude mcp add --transport http avert-demo https://avert-web.bravetree-b234f308.uaenorth.azurecontainerapps.io/mcp
```

It serves pre-indexed graphs with the read tools only: the synthetic `avert:acme` service and `avert:flutter-stripe__flutter_stripe`,
plus three small public Python repos with real findings (`avert:whapi-cloud__python-whatsapp-chatbot`, `avert:kentemman__messengergpt`
and `avert:alonlavian__ragent`). Pass one of those names as `repo`. Write tools (`index_repo`, `claim_finding`, `open_pr` and the rest) are not exposed. Each client is limited
to 60 requests a minute across `/mcp` and `/api`; beyond that the server answers `429` with a `Retry-After` header.

## Your own repositories (local, full tools)

Avert is on npm as [`avert-mcp`](https://www.npmjs.com/package/avert-mcp). Start FalkorDB, then register the server:

```bash
docker run -d -p 127.0.0.1:6380:6379 falkordb/falkordb:v4.22.1
claude mcp add avert -e FALKORDB_URL=falkor://localhost:6380 -- npx -y avert-mcp mcp
```

Add `--read-only` after `mcp` to hide the write tools.

### Cursor

`.cursor/mcp.json` (or the global one):

```json
{
  "mcpServers": {
    "avert": {
      "command": "npx",
      "args": ["-y", "avert-mcp", "mcp"],
      "env": { "FALKORDB_URL": "falkor://localhost:6380", "AVERT_REPO": "/abs/path/to/your/repo" }
    }
  }
}
```

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector npx -y avert-mcp mcp
```

## Try the handoff between two clients

`scripts/act3.ts` connects as two differently named clients (`claude-code`, then `cursor`). The first records a `defer` decision;
the second calls `recall` with no hints and gets it back:

```bash
pnpm tsx scripts/act3.ts examples/acme
```

## A good first prompt

> Call `recall`, then `rank_findings`. For the top finding, call `blast_radius` and tell me which route and team it reaches.
