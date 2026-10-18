---
title: Agents and memory
description: How the watcher and migrator agents coordinate through the graph, and what is remembered.
---

Avert ships two agents. Both call the same tools as the MCP server, through a plain tool-use loop on Groq's OpenAI-compatible
API (`GROQ_API_KEY`, model from `AVERT_MODEL`). They never talk to each other: the only handoff is the graph.

## Watcher: `avert watch <repo>`

1. Runs `sync_changes`, which turns provider changes into findings.
2. Triages with `rank_findings`, `migration_batches`, `recall`, `explain_path` and `blast_radius`.
3. Records a `note` decision on the most urgent finding and logs a `Session`.

Without a key it prints a deterministic ranking instead.

## Migrator: `avert migrate <repo> --agent <name>`

For each open finding, in ranked order:

1. **Claim it atomically.** The claim is a single write, `WHERE f.status='open' SET f.status='claimed'`. FalkorDB serialises writes
   per graph, so two migrators cannot both win; the loser is told who holds it. `scripts/concurrency.ts` runs several processes
   against one repo and asserts there are no double claims.
2. **Recall.** An earlier `wontfix`, `defer` or `accept_risk` decision means the finding is skipped and marked `declined`.
3. **Fix.** If the change names a replacement, or a recipe covers it, it opens a pull request. Otherwise the model calls
   `sdk_params` to read the new SDK's parameters, chooses the replacement from the docs, saves it with `save_recipe`, and opens the
   pull request. The migrator publishes the recipe to `avert:shared` only after that pull request opens. If no pull request is
   possible it opens an issue for the batch. The model's tools are pinned to the claimed finding, its change and its batch, so text
   in a tool result cannot point it at another finding.
4. **Record** a `fix` decision. If the run fails for any reason, the claim is released (`claimed → open`) for another agent.

Finding status moves `open → claimed → done | declined`. Pass `--dry-run` to claim and release without acting.

## Pull requests are stable

Branches are named from the change event, never the clock: `avert/<provider>/<verb>-<subject>`, for example
`avert/stripe/remove-payment-intents-create-payment-method`. Names use `a-z`, `0-9` and `-`, are capped at 60 characters, and events
that slugify identically get a stable 6-character hash suffix. One change is one branch and one pull request covering every call
site. Re-running rebuilds Avert's single commit on the base and updates the existing pull request instead of opening another.
If someone pushed a commit to the branch, Avert leaves the branch alone, and it never reopens a pull request that was closed without
merging.
Nothing is ever merged automatically.

## What is remembered

| Memory | Stored as | Used for |
|---|---|---|
| Episodic | `Decision` (`fix`, `defer`, `wontfix`, `accept_risk`, `note`) with agent, client and time, linked `ON` a finding | `recall`; the migrator skips what was already ruled out |
| Conversations | `Session` per client connection, linked `DISCUSSED` to the findings it touched | A new session sees what earlier ones, from any client, did |
| Procedural | `Recipe` (`from → to`, steps), saved per repo and optionally published to `avert:shared` | A repository hit by the same change is offered the fix |

`recall` with no arguments returns recent decisions and sessions, which is how a second agent client picks up where the first
left off without being told.
