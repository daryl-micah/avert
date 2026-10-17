---
title: Limits and roadmap
description: What Avert cannot see yet, and what is next.
---

Avert is built to be right about what it reports. These are the cases it does not catch, so you know where to still look.

## What the indexer cannot see

- **Dynamic dispatch and dependency injection.** A call through an injected or reflected client is not resolved to a provider.
- **Values built at runtime.** A model id assembled from config or string operations is recorded as dynamic, not as a literal.
- **Wrappers more than one module deep.** Client re-exports are followed across files in two passes, not through arbitrary chains.
- **Router libraries.** Routes are recognised for Express/Fastify-style `app.verb('/path', handler)`, the Next.js app router, and
  FastAPI and Flask decorators. Other routers are not.
- **Provider-default changes.** If a provider changes a default and your code leaves the parameter out, there is no call-site
  evidence to trace.
- **Ownership.** Owners come from `CODEOWNERS` team handles (`@org/team`) only. No individual users, no git history.
- **Languages.** Python and TypeScript.

## What detection covers

- **SDK changes:** the diff between the version your manifest declares and the latest release, for operations your code calls.
  Deprecations are read from `@deprecated` markers.
- **Model lifecycle:** hand-curated YAML from each provider's public deprecation page, dated and linked to its source. It is only as
  current as its `retrieved` date.
- **Renames:** a removed parameter is only called `renamed` when exactly one candidate replaces it. Otherwise it is `removed`
  and the replacement is left to a recipe or the agent.

## Not in this release

OpenAPI spec diffs, and raw HTTP calls made without an SDK. Both are on the roadmap.

## Roadmap

- Publish to npm for a one-line `npx` install.
- OpenAPI diffs and raw HTTP call detection.
- More providers and more lifecycle sources.
- Additional languages for the indexer.
