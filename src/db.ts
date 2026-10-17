import { FalkorDB, type Graph } from 'falkordb';

// Every node carries a stable string `id`; these are the labels we index on it.
export const LABELS = [
  'Repo', 'File', 'Function', 'Route', 'Team', 'CallSite',
  'Provider', 'Resource', 'Operation', 'Param', 'Value',
  'ChangeEvent', 'SdkRelease',
  'Finding', 'Decision', 'Recipe', 'Session',
] as const;

const EXTRA_INDEXES: [string, string][] = [
  ['ChangeEvent', 'kind'],
  ['Finding', 'status'],
  ['Value', 'value'],
];

export const SHARED_GRAPH = 'avert:shared';

let client: FalkorDB | undefined;

export async function connect(): Promise<FalkorDB> {
  if (client) return client;
  const url = process.env.FALKORDB_URL ?? 'falkor://localhost:6380';
  const u = new URL(url);
  client = await FalkorDB.connect({
    socket: { host: u.hostname, port: Number(u.port || 6379), tls: u.protocol === 'falkors:' },
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  });
  return client;
}

export async function close(): Promise<void> {
  await client?.close();
  client = undefined;
}

/** One graph per repository: `avert:<owner>__<name>`, or `avert:<dirname>` for local paths. */
export function graphName(repo: string): string {
  if (repo.startsWith('avert:')) return repo;
  const gh = repo.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  const slug = gh ? `${gh[1]}__${gh[2]}` : repo.replace(/\/+$/, '').split('/').pop()!;
  return `avert:${slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
}

export async function graph(repo: string): Promise<Graph> {
  return (await connect()).selectGraph(graphName(repo));
}

export async function listRepoGraphs(): Promise<string[]> {
  const all = await (await connect()).list();
  return all.filter((g) => g.startsWith('avert:') && g !== SHARED_GRAPH);
}

export async function ensureSchema(g: Graph): Promise<void> {
  const specs: [string, string][] = [...LABELS.map((l) => [l, 'id'] as [string, string]), ...EXTRA_INDEXES];
  for (const [label, prop] of specs) {
    try {
      await g.query(`CREATE INDEX FOR (n:${label}) ON (n.${prop})`);
    } catch (e) {
      if (!/already indexed/i.test((e as Error).message)) throw e;
    }
  }
}

export type Row = Record<string, any>;

export async function run(g: Graph, cypher: string, params: Record<string, unknown> = {}): Promise<Row[]> {
  const res = await g.query<Row>(cypher, { params: params as any });
  return res.data ?? [];
}
