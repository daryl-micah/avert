---
title: MCP tools
description: The named domain tools Avert's MCP server exposes, generated from src/registry.ts.
---

Generated from [`src/registry.ts`](https://github.com/daryl-micah/avert/blob/main/src/registry.ts) by `pnpm docs:gen`. Do not edit by hand.
The MCP server and the built-in agents use this same list. Every tool takes an optional `repo` (a local path or GitHub URL; defaults
to `AVERT_REPO` or the working directory). Results carry a `path`: the ordered steps from the change to the route, with file and line.

Tools marked **write** change the graph or call GitHub, so the hosted read-only endpoint does not expose them.

| Tool | Access | What it does |
|---|---|---|
| `index_repo` | write | Index (or re-index) a repository: routes, functions, call chains and every external API call site. |
| `sync_changes` | write | Pull provider changes for the SDKs this repo uses (SDK release diffs + model lifecycle data) and create findings. |
| `list_changes` | read | List provider change events that touch this repo (removed, renamed, deprecated, retired, added). Added = notice only. |
| `blast_radius` | read | Everything one change breaks: call sites (down the API surface, through rolling aliases), then routes and owner teams (up the call chain), each with its path. |
| `list_findings` | read | Findings (one per change x call site) with status open \| claimed \| done \| declined. |
| `explain_path` | read | The evidence path for one finding: change -> surface -> call site -> functions -> route -> owner, with file and line. |
| `rank_findings` | read | Rank findings by severity, urgency (days to effective date) and reach (routes + PageRank centrality of the call chain). |
| `migration_batches` | write | Group findings into migration batches: connected components (WCC) of findings sharing an owner and a change or function. One batch = one issue. |
| `claim_finding` | write | Atomically claim an open finding so no other agent works on it. Fails if already claimed, naming the holder. |
| `record_decision` | write | Remember a decision about a finding (fix, defer, wontfix, accept_risk, note) so later sessions and other agents see it. |
| `recall` | read | Recall memory: decisions and sessions (episodic) and migration recipes (procedural, from this repo and the shared graph). With no ids, returns recent history. Call this first. |
| `sdk_params` | write | Params of a finding's operation in the provider's latest SDK, with doc text and deprecation flags. Use it to choose a replacement when a change names none. |
| `save_recipe` | write | Save how a change was fixed (from -> to: a param name or literal value, with steps) so the next matching migration reuses it. |
| `publish_recipe` | write | Publish a repo recipe to the shared graph so other repositories hit by the same change are offered it. |
| `open_issue` | write | Open one GitHub issue for a migration batch, with every path as evidence. |
| `open_pr` | write | Open a GitHub pull request fixing one finding, when the change names a replacement or a recipe covers it. Never merges. |

## Arguments

### `index_repo`

Index (or re-index) a repository: routes, functions, call chains and every external API call site.

No arguments besides `repo`.

### `sync_changes`

Pull provider changes for the SDKs this repo uses (SDK release diffs + model lifecycle data) and create findings.

No arguments besides `repo`.

### `list_changes`

List provider change events that touch this repo (removed, renamed, deprecated, retired, added). Added = notice only.

- `kind`: `removed` | `renamed` | `deprecated` | `retired` | `added`
- `provider`: string — Provider id: openai, anthropic, stripe, gemini, twilio

### `blast_radius`

Everything one change breaks: call sites (down the API surface, through rolling aliases), then routes and owner teams (up the call chain), each with its path.

- `change_id` (required): string — ChangeEvent id from list_changes

### `list_findings`

Findings (one per change x call site) with status open | claimed | done | declined.

- `status`: `open` | `claimed` | `done` | `declined`

### `explain_path`

The evidence path for one finding: change -> surface -> call site -> functions -> route -> owner, with file and line.

- `finding_id` (required): string

### `rank_findings`

Rank findings by severity, urgency (days to effective date) and reach (routes + PageRank centrality of the call chain).

- `status`: `open` | `claimed`

### `migration_batches`

Group findings into migration batches: connected components (WCC) of findings sharing an owner and a change or function. One batch = one issue.

No arguments besides `repo`.

### `claim_finding`

Atomically claim an open finding so no other agent works on it. Fails if already claimed, naming the holder.

- `finding_id` (required): string

### `record_decision`

Remember a decision about a finding (fix, defer, wontfix, accept_risk, note) so later sessions and other agents see it.

- `finding_id` (required): string
- `kind` (required): `fix` | `defer` | `wontfix` | `accept_risk` | `note`
- `reason` (required): string

### `recall`

Recall memory: decisions and sessions (episodic) and migration recipes (procedural, from this repo and the shared graph). With no ids, returns recent history. Call this first.

- `finding_id`: string
- `change_id`: string

### `sdk_params`

Params of a finding's operation in the provider's latest SDK, with doc text and deprecation flags. Use it to choose a replacement when a change names none.

- `finding_id` (required): string

### `save_recipe`

Save how a change was fixed (from -> to: a param name or literal value, with steps) so the next matching migration reuses it.

- `change_id` (required): string
- `from` (required): string
- `to` (required): string
- `steps` (required): string
- `callsite_id`: string

### `publish_recipe`

Publish a repo recipe to the shared graph so other repositories hit by the same change are offered it.

- `recipe_id` (required): string

### `open_issue`

Open one GitHub issue for a migration batch, with every path as evidence.

- `batch_id` (required): string — Batch id from migration_batches

### `open_pr`

Open a GitHub pull request fixing one finding, when the change names a replacement or a recipe covers it. Never merges.

- `finding_id` (required): string
