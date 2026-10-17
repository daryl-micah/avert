import { describe, expect, it } from 'vitest';
import { branchName } from '../src/actions/github.js';

const stripe = { id: 'sdk:npm:stripe@23.0.0:removed:stripe.payment_intents.create#payment_method_types', kind: 'removed', provider: 'stripe' };
const model = { id: 'lifecycle:anthropic:claude-3-5-sonnet-20241022', kind: 'retired', provider: 'anthropic' };

describe('branchName', () => {
  it('is provider/verb-subject, lowercase, hyphenated, and ignores the version', () => {
    expect(branchName(stripe, [stripe])).toBe('avert/stripe/remove-payment-intents-create-payment-method');
    expect(branchName(model, [model])).toBe('avert/anthropic/retire-claude-3-5-sonnet-20241022');
  });
  it('is stable across calls and caps at 60 chars with no trailing hyphen', () => {
    const long = { ...stripe, id: stripe.id + '_and_some_much_longer_parameter_name_here' };
    const a = branchName(long, [long]);
    expect(a).toBe(branchName(long, [long]));
    expect(a.length).toBeLessThanOrEqual(60);
    expect(a).toMatch(/^[a-z0-9/-]+$/);
    expect(a.endsWith('-')).toBe(false);
  });
  it('appends a stable hash to every event that slugifies the same, whatever the order', () => {
    const twin = { ...stripe, id: 'sdk:pypi:stripe@9.0.0:removed:stripe.payment_intents.create#payment_method_types' };
    const [a, b] = [branchName(stripe, [stripe, twin]), branchName(twin, [stripe, twin])];
    expect(a).not.toBe(b);
    expect(a).toMatch(/-[0-9a-f]{6}$/);
    expect(a).toBe(branchName(stripe, [twin, stripe]));
    expect(a.length).toBeLessThanOrEqual(60);
  });
});
