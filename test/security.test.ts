import { describe, expect, it } from 'vitest';
import { applyEdit } from '../src/actions/github.js';
import { buildApp } from '../src/web/server.js';

describe('applyEdit', () => {
  it('replaces a model id literal and renames a param key', () => {
    expect(applyEdit(`m = "claude-3-5-sonnet-latest"`, 1, { kind: 'value', from: 'claude-3-5-sonnet-latest', to: 'claude-sonnet-4-5-20250929' })).toBe(`m = "claude-sonnet-4-5-20250929"`);
    expect(applyEdit(`create({ max_tokens: 5 })`, 1, { kind: 'param', from: 'max_tokens', to: 'max_completion_tokens' })).toBe(`create({ max_completion_tokens: 5 })`);
  });
  it('changes only the literal in the call, or a single module constant, never every match in the file', () => {
    const e = { kind: 'value' as const, from: 'gpt-4', to: 'gpt-5' };
    const text = ['a = create(model="gpt-4")', ...Array(50).fill(''), 'b = create(model="gpt-4")'].join('\n');
    expect(applyEdit(text, 52, e)!.split('\n')).toEqual(['a = create(model="gpt-4")', ...Array(50).fill(''), 'b = create(model="gpt-5")']);
    const constant = ['MODEL = "gpt-4"', ...Array(50).fill(''), 'create(model=MODEL)'].join('\n');
    expect(applyEdit(constant, 52, e)!.split('\n')[0]).toBe('MODEL = "gpt-5"');
    expect(applyEdit(['A = "gpt-4"', 'B = "gpt-4"', ...Array(50).fill(''), 'create(model=A)'].join('\n'), 53, e)).toBeUndefined();
  });
  it('refuses a recipe that would write code instead of a value or identifier', () => {
    expect(() => applyEdit(`m = "gpt-4"`, 1, { kind: 'value', from: 'gpt-4', to: `gpt-5"); require('child_process').exec('x'); ("` })).toThrow(/Refusing/);
    expect(() => applyEdit(`f(a=1)`, 1, { kind: 'param', from: 'a', to: '$&b' })).toThrow(/Refusing/);
    expect(() => applyEdit(`f(a=1)`, 1, { kind: 'param', from: 'a|.*', to: 'b' })).toThrow(/Refusing/);
  });
});

describe('local web server', () => {
  it('rejects requests addressed to another host (DNS rebinding)', async () => {
    const app = buildApp({ localOnly: true });
    expect((await app.request('http://evil.example/api/repos', { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await app.request('http://evil.example/mcp', { method: 'POST', headers: { host: 'evil.example:8787' } })).status).toBe(403);
  });
});
