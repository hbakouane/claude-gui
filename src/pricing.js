// Anthropic API list prices in USD per million tokens (checked November 2026): [input, output, cache read].
const PRICES = new Map([
  ['claude-fable-5-2', [8, 40, 0.2]],
  ['claude-mythos-5-2', [8, 40, 0.2]],
  ['claude-fable-5-1', [10, 50, 0.25]],
  ['claude-mythos-5-1', [10, 50, 0.25]],
  ['claude-fable-5', [10, 50, 1]],
  ['claude-mythos-5', [10, 50, 1]],
  ['claude-opus-5-5', [4, 20, 0.2]],
  ['claude-opus-5', [5, 25, 0.5]],
  ['claude-opus-4-8', [5, 25, 0.5]],
  ['claude-opus-4-7', [5, 25, 0.5]],
  ['claude-opus-4-6', [5, 25, 0.5]],
  ['claude-sonnet-5-5', [2, 10, 0.1]],
  ['claude-sonnet-5', [2, 10, 0.2]],
  ['claude-sonnet-4-6', [3, 15, 0.3]],
  ['claude-haiku-5-5', [0.1, 0.5, 0.01]],
  ['claude-haiku-4-5', [1, 5, 0.1]],
]);
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const FAST_MODE = 2;

export function priceFor(model) {
  const id = String(model ?? '').toLowerCase()
    .replace(/^(?:[a-z]{2}\.)?anthropic\./, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '');
  const price = PRICES.get(id);

  return price ? { input: price[0], output: price[1], cacheRead: price[2] } : null;
}

export function summarizeUsage(entries) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const models = new Set();
  let cost = 0;
  let priced = 0;
  let unpriced = 0;

  for (const { model, usage } of entries) {
    if (!model || model === '<synthetic>' || !usage) {
      continue;
    }
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const cacheWrite1h = Math.min(cacheWrite, usage.cache_creation?.ephemeral_1h_input_tokens ?? 0);
    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    models.add(model);

    const price = priceFor(model);
    if (!price) {
      unpriced++;
      continue;
    }
    priced++;
    const perMillion = input * price.input
      + output * price.output
      + cacheRead * price.cacheRead
      + (cacheWrite - cacheWrite1h) * price.input * CACHE_WRITE_5M
      + cacheWrite1h * price.input * CACHE_WRITE_1H;
    cost += (usage.speed === 'fast' ? FAST_MODE : 1) * perMillion / 1e6;
  }

  return {
    ...totals,
    models: [...models].sort(),
    cost: priced ? Math.round(cost * 10000) / 10000 : null,
    costIsPartial: priced > 0 && unpriced > 0,
  };
}
