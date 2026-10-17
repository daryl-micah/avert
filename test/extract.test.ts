import { describe, expect, it } from 'vitest';
import { extractPy } from '../src/indexer/py.js';
import { extractTs } from '../src/indexer/ts.js';

describe('python extractor', () => {
  it('resolves clients, params, literal values and constants', async () => {
    const f = await extractPy('app.py', `
from openai import OpenAI
MODEL = "gpt-4o-2024-08-06"
client = OpenAI()
def ask(q):
    return client.chat.completions.create(model=MODEL, messages=q)
`, new Map());
    expect(f.callSites).toHaveLength(1);
    const s = f.callSites[0];
    expect([s.provider, s.resource, s.method, s.fn]).toEqual(['openai', ['chat', 'completions'], 'create', 'ask']);
    expect(s.args).toEqual([
      { name: 'model', binding: 'literal', values: ['gpt-4o-2024-08-06'] },
      { name: 'messages', binding: 'dynamic', values: [] },
    ]);
  });

  it('marks except-clause calls as fallbacks and expands literal model lists', async () => {
    const f = await extractPy('llm.py', `
import anthropic
claude = anthropic.Anthropic()
def run(p):
    try:
        return claude.messages.create(model="claude-sonnet-5-5", messages=p)
    except Exception:
        for m in ["claude-haiku-5-5", "claude-3-5-haiku-latest"]:
            return claude.messages.create(model=m, messages=p)
`, new Map());
    expect(f.callSites.map((s) => s.fallbackDepth)).toEqual([0, 1]);
    expect(f.callSites[1].args[0].values).toEqual(['claude-haiku-5-5', 'claude-3-5-haiku-latest']);
  });

  it('handles module clients, stripe legacy resources, self attributes and routes', async () => {
    const f = await extractPy('svc.py', `
import stripe
from google import genai
from fastapi import APIRouter
router = APIRouter()
class Svc:
    def __init__(self):
        self.ai = genai.Client()
    def gen(self):
        return self.ai.models.generate_content(model="gemini-3-pro-preview", contents="x")
@router.post("/pay")
def pay():
    return stripe.PaymentIntent.create(params={"amount": 1, "currency": "usd"})
`, new Map());
    expect(f.callSites.map((s) => `${s.provider}.${s.resource.join('.')}.${s.method}`)).toEqual(['gemini.models.generate_content', 'stripe.PaymentIntents.create']);
    expect(f.callSites[0].fn).toBe('Svc.gen');
    expect(f.callSites[1].args.map((a) => a.name)).toEqual(['amount', 'currency']);
    expect(f.routes).toEqual([{ method: 'POST', path: '/pay', handler: 'pay', line: 11 }]);
  });

  it('uses clients imported from other repo modules', async () => {
    const f = await extractPy('a.py', `from app.clients import oa\ndef f():\n    oa.responses.create(model="gpt-6-luna")\n`, new Map([['oa', 'openai']]));
    expect(f.callSites[0].provider).toBe('openai');
  });
});

describe('typescript extractor', () => {
  it('finds clients, object params and exported bindings', async () => {
    const f = await extractTs('lib.ts', `
import Stripe from 'stripe';
export const stripe = new Stripe(process.env.KEY!);
export async function charge(amount: number) {
  return stripe.paymentIntents.create({ amount, currency: 'usd', payment_method_types: ['card'] });
}
`, new Map());
    expect(f.exportedClients).toEqual([{ name: 'stripe', provider: 'stripe' }]);
    expect(f.callSites[0].args.map((a) => [a.name, a.binding])).toEqual([['amount', 'dynamic'], ['currency', 'literal'], ['payment_method_types', 'dynamic']]);
  });

  it('extracts express routes with inline handlers, class methods, and catch fallbacks', async () => {
    const f = await extractTs('server.ts', `
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
const MODELS = ['gpt-6-luna', 'gpt-5.6-sol'] as const;
class Bot {
  private client = new OpenAI();
  private ai = new GoogleGenAI({});
  async reply(q: string) {
    try {
      for (const model of MODELS) return await this.client.responses.create({ model, input: q });
    } catch {
      return this.ai.models.generateContent({ model: 'gemini-3-flash-preview', contents: q });
    }
  }
}
app.post('/chat', async (req, res) => res.json(await new Bot().reply(req.body)));
`, new Map());
    expect(f.routes).toEqual([{ method: 'POST', path: '/chat', handler: 'POST /chat', line: 16 }]);
    expect(f.callSites.map((s) => [s.provider, s.fn, s.fallbackDepth, s.args[0].values])).toEqual([
      ['openai', 'Bot.reply', 0, ['gpt-6-luna', 'gpt-5.6-sol']],
      ['gemini', 'Bot.reply', 1, ['gemini-3-flash-preview']],
    ]);
  });

  it('extracts Next.js app router routes', async () => {
    const f = await extractTs('app/api/(chat)/[id]/route.ts', `export async function POST(req: Request) { return new Response('ok'); }`, new Map());
    expect(f.routes.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/:id']);
  });
});
