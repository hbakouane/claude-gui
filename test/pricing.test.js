import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { priceFor, summarizeUsage } from '../src/pricing.js';

describe('priceFor', () => {
  it('matches model ids exactly, ignoring dates, context suffixes and cloud prefixes', () => {
    assert.deepEqual(priceFor('claude-opus-5-5'), { input: 4, output: 20, cacheRead: 0.2 });
    assert.deepEqual(priceFor('claude-fable-5'), { input: 10, output: 50, cacheRead: 1 });
    assert.deepEqual(priceFor('claude-fable-5-2'), { input: 8, output: 40, cacheRead: 0.2 });
    assert.deepEqual(priceFor('claude-sonnet-4-6[1m]'), { input: 3, output: 15, cacheRead: 0.3 });
    assert.deepEqual(priceFor('claude-haiku-4-5-20251001'), { input: 1, output: 5, cacheRead: 0.1 });
    assert.deepEqual(priceFor('us.anthropic.claude-opus-4-8'), { input: 5, output: 25, cacheRead: 0.5 });
  });

  it('returns null for unknown models', () => {
    assert.equal(priceFor('claude-opus-4-1'), null);
    assert.equal(priceFor(undefined), null);
  });
});

describe('summarizeUsage', () => {
  it('prices input, output, cache reads and both cache write lifetimes', () => {
    const summary = summarizeUsage([{
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 2e6, cache_creation: { ephemeral_1h_input_tokens: 1e6, ephemeral_5m_input_tokens: 1e6 } },
    }]);

    assert.equal(summary.cost, 3 + 15 + 0.3 + 3 * 1.25 + 3 * 2);
    assert.deepEqual(summary.models, ['claude-sonnet-4-6']);
  });

  it('doubles the price of fast mode turns', () => {
    const usage = { input_tokens: 1e6, output_tokens: 0 };

    assert.equal(summarizeUsage([{ model: 'claude-opus-5-5', usage: { ...usage, speed: 'fast' } }]).cost, 8);
  });

  it('counts tokens for unknown models but flags the cost as partial', () => {
    const summary = summarizeUsage([
      { model: 'claude-opus-4-1', usage: { input_tokens: 100, output_tokens: 100 } },
      { model: 'claude-opus-5-5', usage: { input_tokens: 1e6, output_tokens: 0 } },
    ]);

    assert.equal(summary.input, 1e6 + 100);
    assert.equal(summary.cost, 4);
    assert.equal(summary.costIsPartial, true);
  });

  it('has no cost when nothing is priced, and skips synthetic messages', () => {
    const summary = summarizeUsage([
      { model: '<synthetic>', usage: { input_tokens: 5 } },
      { model: 'claude-opus-4-1', usage: { input_tokens: 5 } },
    ]);

    assert.equal(summary.cost, null);
    assert.equal(summary.costIsPartial, false);
    assert.equal(summary.input, 5);
  });
});
