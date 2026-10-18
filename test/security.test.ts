import { describe, expect, it } from 'vitest';
import { applyEdit } from '../src/actions/github.js';

describe('applyEdit', () => {
  it('replaces a model id literal and renames a param key', () => {
    expect(applyEdit(`m = "claude-3-5-sonnet-latest"`, 1, { kind: 'value', from: 'claude-3-5-sonnet-latest', to: 'claude-sonnet-4-5-20250929' })).toBe(`m = "claude-sonnet-4-5-20250929"`);
    expect(applyEdit(`create({ max_tokens: 5 })`, 1, { kind: 'param', from: 'max_tokens', to: 'max_completion_tokens' })).toBe(`create({ max_completion_tokens: 5 })`);
  });
  it('refuses a recipe that would write code instead of a value or identifier', () => {
    expect(() => applyEdit(`m = "gpt-4"`, 1, { kind: 'value', from: 'gpt-4', to: `gpt-5"); require('child_process').exec('x'); ("` })).toThrow(/Refusing/);
    expect(() => applyEdit(`f(a=1)`, 1, { kind: 'param', from: 'a', to: '$&b' })).toThrow(/Refusing/);
    expect(() => applyEdit(`f(a=1)`, 1, { kind: 'param', from: 'a|.*', to: 'b' })).toThrow(/Refusing/);
  });
});
