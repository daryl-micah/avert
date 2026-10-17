import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callTool, repoArg, TOOLS } from './registry.js';

// Avert's MCP server: the named domain tools from the registry. Each client connection is one
// Session in the graph, linked to the findings it touched, so a later session (from any client) can recall it.

export function buildServer(opts: { readOnly?: boolean } = {}): McpServer {
  const server = new McpServer({ name: 'avert', version: '0.1.0' }, {
    instructions:
      'Avert knows every external API call in this repository and which provider changes reach them. ' +
      'Start with `recall` to see earlier decisions and sessions, then `rank_findings` or `list_changes`. ' +
      'Use `blast_radius` / `explain_path` to show evidence, and `record_decision` to remember what was decided.',
  });
  const sessionId = `session:${randomUUID()}`;
  const ctx = () => ({ agent: server.server.getClientVersion()?.name ?? 'unknown', sessionId });

  for (const t of TOOLS) {
    if (t.write && opts.readOnly) continue;
    server.registerTool(t.name, { description: t.description, inputSchema: { repo: repoArg, ...t.shape } }, (async (args: Record<string, unknown>) => {
      try {
        const result = await callTool(t.name, args, ctx(), { log: !opts.readOnly });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], structuredContent: result };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] };
      }
    }) as any);
  }
  return server;
}
