import { describe, expect, it } from 'vitest';
import { owners } from '../src/indexer/owners.js';
import { isPinned } from '../src/surface/providers.js';
import { diffSurfaces } from '../src/surface/sdk-diff.js';
import type { Surface } from '../src/surface/surface.js';

const op = (params: Record<string, boolean>, deprecated = false) => ({
  resource: ['payment_intents'], method: 'create', deprecated,
  params: Object.fromEntries(Object.entries(params).map(([k, d]) => [k, { deprecated: d }])),
});

describe('sdk differ', () => {
  it('classifies removed, renamed, deprecated and added surface', () => {
    const before: Surface = new Map([['payment_intents.create', op({ amount: false, payment_method_types: false, allowed_payment_method_types: false, excluded_payment_method_types: false, source: false })], ['charges.create', op({})]]);
    const after: Surface = new Map([['payment_intents.create', op({ amount: true, allowed_payment_method_types: false, excluded_payment_method_types: false, source_id: false })], ['refunds.create', op({})]]);
    const kinds = diffSurfaces(before, after).map((c) => `${c.kind} ${c.target.method}${c.target.param ? '#' + c.target.param : ''}${c.replacement ? ' -> ' + (c.replacement.param ?? '') : ''}`);
    expect(kinds.sort()).toEqual([
      'added create',                                   // refunds.create
      'deprecated create#amount',
      'removed create',                                 // charges.create
      'removed create#payment_method_types',          // ambiguous: allowed_ and excluded_ both match, no replacement guessed
      'renamed create#source -> source_id',
    ]);
  });
});

describe('pinning', () => {
  it('separates dated ids from rolling aliases', () => {
    expect(['gpt-4o-2024-08-06', 'claude-3-5-sonnet-20241022', 'gemini-1.5-pro-002'].map(isPinned)).toEqual([true, true, true]);
    expect(['claude-3-5-sonnet-latest', 'gpt-4o', 'claude-sonnet-5-5'].map(isPinned)).toEqual([false, false, false]);
  });
});

describe('codeowners', () => {
  it('keeps team handles only, last match wins', async () => {
    const own = owners(new URL('../examples/acme', import.meta.url).pathname);
    expect(own('checkout/src/billing.ts')).toEqual(['@acme/payments']);
    expect(own('support/app/llm.py')).toEqual(['@acme/support-ai']);
    expect(own('README.md')).toEqual([]);
  });
});
