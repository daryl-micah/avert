import type { Graph } from 'falkordb';
import { run } from '../db.js';
import * as Q from '../queries.js';
import { ids, provider as providerInfo, snake } from './providers.js';

export interface OpRef { provider: string; resource: string[]; method: string; params: string[] }

/** MERGE the Provider -> Resource* -> Operation -> Param path for each operation. Shared by indexer and SDK differ. */
export async function writeSurface(g: Graph, ops: OpRef[]): Promise<void> {
  const provs = new Map<string, { id: string; name: string }>();
  const levels: Map<string, { id: string; name: string; parent: string; provider: string }>[] = [];
  const operations = new Map<string, { id: string; name: string; parent: string; provider: string }>();
  const params = new Map<string, { id: string; name: string; op: string }>();

  for (const o of ops) {
    provs.set(o.provider, { id: o.provider, name: providerInfo(o.provider).name });
    let parent = ids.provider(o.provider);
    o.resource.forEach((seg, i) => {
      const id = ids.resource(o.provider, o.resource.slice(0, i + 1));
      (levels[i] ??= new Map()).set(id, { id, name: snake(seg), parent, provider: o.provider });
      parent = id;
    });
    const opId = ids.operation(o.provider, o.resource, o.method);
    operations.set(opId, { id: opId, name: snake(o.method), parent, provider: o.provider });
    for (const p of o.params) params.set(ids.param(opId, p), { id: ids.param(opId, p), name: snake(p), op: opId });
  }

  await run(g, Q.UPSERT_PROVIDERS, { rows: [...provs.values()] });
  for (const level of levels) await run(g, Q.UPSERT_RESOURCES, { rows: [...level.values()] });
  await run(g, Q.UPSERT_OPERATIONS, { rows: [...operations.values()] });
  if (params.size) await run(g, Q.UPSERT_PARAMS, { rows: [...params.values()] });
}
