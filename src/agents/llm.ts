import OpenAI from 'openai';
import { z } from 'zod';
import { callTool, TOOLS, type Ctx } from '../registry.js';

// A plain tool-use loop over Avert's own tools, on Groq's OpenAI-compatible API.
// The model chooses which tools to call; every call goes through the same registry the MCP server uses.

export const hasLlm = () => !!process.env.GROQ_API_KEY;

function client(): OpenAI {
  if (!process.env.GROQ_API_KEY) throw new Error('Set GROQ_API_KEY to run the agents with an LLM.');
  return new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: process.env.AVERT_LLM_BASE_URL ?? 'https://api.groq.com/openai/v1' });
}
export const model = () => process.env.AVERT_MODEL ?? 'openai/gpt-oss-120b';

/** Keep tool results small for the model: drop long paths to their labels. */
function compact(result: unknown): string {
  const json = JSON.stringify(result, (k, v) => (k === 'path' && Array.isArray(v) ? v.map((s: any) => `${s.kind}: ${s.label}${s.file ? ` (${s.file}:${s.line})` : ''}`) : v));
  return json.length > 8000 ? json.slice(0, 8000) + '…(truncated)' : json;
}

type JsonSchema = { properties?: Record<string, { type?: string | string[]; enum?: unknown[] }>; required?: string[] } & Record<string, unknown>;

/** Models often send null for optional args and Groq validates tool calls strictly, so accept null on every optional property. */
function nullableOptionals(schema: JsonSchema, hide: string[] = []): JsonSchema {
  for (const k of hide) { delete schema.properties?.[k]; schema.required &&= schema.required.filter((r) => r !== k); }
  for (const [k, p] of Object.entries(schema.properties ?? {})) {
    if (schema.required?.includes(k) || typeof p.type !== 'string') continue;
    p.type = [p.type, 'null'];
    p.enum &&= [...p.enum, null];
  }
  return schema;
}

export interface AgentRun { text: string; calls: { tool: string; args: unknown; ok: boolean }[] }

export async function runAgent(opts: { repo: string; system: string; task: string; tools: string[]; fixed?: Record<string, string>; ctx: Ctx; maxSteps?: number; log?: (s: string) => void }): Promise<AgentRun> {
  const log = opts.log ?? ((s) => console.log(s));
  const defs = TOOLS.filter((t) => opts.tools.includes(t.name)).map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: nullableOptionals(z.toJSONSchema(z.object(t.shape)) as JsonSchema, Object.keys(opts.fixed ?? {})) },
  }));
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: opts.system }, { role: 'user', content: opts.task }];
  const calls: AgentRun['calls'] = [];
  for (let step = 0; step < (opts.maxSteps ?? 12); step++) {
    const res = await client().chat.completions.create({ model: model(), messages, tools: defs, tool_choice: 'auto', temperature: 0.2 });
    const msg = res.choices[0].message;
    messages.push(msg);
    if (!msg.tool_calls?.length) return { text: msg.content ?? '', calls };
    for (const tc of msg.tool_calls) {
      if (tc.type !== 'function') continue;
      let content: string;
      let ok = true;
      let args: Record<string, unknown> = {};
      try {
        args = Object.fromEntries(Object.entries(JSON.parse(tc.function.arguments || '{}')).filter(([, v]) => v !== null));
        log(`  → ${tc.function.name}(${JSON.stringify(args)})`);
        content = compact(await callTool(tc.function.name, { ...args, ...opts.fixed, repo: opts.repo }, opts.ctx));
      } catch (e) {
        ok = false;
        content = `Error: ${(e as Error).message}`;
        log(`    ! ${content.slice(0, 200)}`);
      }
      calls.push({ tool: tc.function.name, args, ok });
      messages.push({ role: 'tool', tool_call_id: tc.id, content });
    }
  }
  return { text: '(stopped: step limit)', calls };
}
