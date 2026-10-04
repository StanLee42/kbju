// Проверка учёта расхода: токены, пиковые часы, прогноз, бюджет.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PRICES, budgetState, computeCost, isOffPeak, normalizeUsage, projectMonth, summarize,
} from '../js/usage.js';

const usage = {
  prompt_tokens: 1110,
  completion_tokens: 474,
  prompt_cache_hit_tokens: 128,
  prompt_cache_miss_tokens: 982,
  completion_tokens_details: { reasoning_tokens: 120 },
};

test('токены приводятся к единому виду, включая размышления', () => {
  const tokens = normalizeUsage(usage);
  assert.deepEqual(tokens, { input: 1110, output: 474, hit: 128, miss: 982, reasoning: 120 });
});

test('попадание в кэш считается по своей, более дешёвой цене', () => {
  const at = new Date('2026-10-04T09:00:00Z'); // непиковое окно закрыто
  const { cost, offPeak, tokens } = computeCost({ usage, at, prices: DEFAULT_PRICES });
  assert.equal(offPeak, false);
  const expected = (982 / 1_000_000) * 0.15 + (128 / 1_000_000) * 0.02 + (474 / 1_000_000) * 1.1;
  assert.ok(Math.abs(cost - expected) < 1e-9, `стоимость ${cost} не совпала с ${expected}`);
  assert.equal(tokens.miss, 982);
});

test('непиковое окно уменьшает стоимость вдвое', () => {
  const peak = computeCost({ usage, at: new Date('2026-10-04T12:00:00Z'), prices: DEFAULT_PRICES });
  const off = computeCost({ usage, at: new Date('2026-10-04T20:00:00Z'), prices: DEFAULT_PRICES });
  assert.equal(peak.offPeak, false);
  assert.equal(off.offPeak, true);
  assert.ok(Math.abs(off.cost * 2 - peak.cost) < 1e-12);
});

test('окно скидки определяется по UTC и переживает полночь', () => {
  const window = { fromMinutesUtc: 16 * 60 + 30, toMinutesUtc: 30, factor: 0.5 };
  assert.equal(isOffPeak(new Date('2026-10-04T17:00:00Z'), window), true);
  assert.equal(isOffPeak(new Date('2026-10-04T00:10:00Z'), window), true);
  assert.equal(isOffPeak(new Date('2026-10-04T10:00:00Z'), window), false);
});

test('стоимость помечена датой, на которую действуют цены', () => {
  const { pricesAsOf, currency } = computeCost({ usage, prices: DEFAULT_PRICES });
  assert.equal(pricesAsOf, DEFAULT_PRICES.asOf);
  assert.equal(currency, 'USD');
});

test('сводка считает суммы по видам запросов и по дням', () => {
  const rows = [
    { at: '2026-10-03T09:00:00.000Z', kind: 'photo', cost: 0.002, tokens: { input: 1000, output: 400 } },
    { at: '2026-10-03T14:00:00.000Z', kind: 'chat', cost: 0.01, tokens: { input: 3000, output: 900 } },
    { at: '2026-10-04T09:00:00.000Z', kind: 'photo', cost: 0.001, tokens: { input: 1000, output: 300 } },
  ];

  const all = summarize(rows);
  assert.equal(all.requests, 3);
  assert.ok(Math.abs(all.total - 0.013) < 1e-9);
  assert.ok(Math.abs(all.byKind.photo - 0.003) < 1e-9);
  assert.ok(Math.abs(all.byKind.chat - 0.01) < 1e-9);
  assert.equal(Object.keys(all.byDay).length, 2);
  assert.equal(all.tokens.input, 5000);

  const onlyThird = summarize(rows, { since: '2026-10-03', until: '2026-10-03' });
  assert.equal(onlyThird.requests, 2);
});

test('прогноз месяца считается по своей средней стоимости', () => {
  const projection = projectMonth({ averageCost: 0.001, levels: [5, 15, 40], days: 30 });
  assert.deepEqual(projection, [
    { perDay: 5, perMonth: 0.15 },
    { perDay: 15, perMonth: 0.45 },
    { perDay: 40, perMonth: 1.2 },
  ]);
});

test('бюджет предупреждает на порогах', () => {
  assert.equal(budgetState({ spent: 10, budget: 100 }).level, 'ok');
  assert.equal(budgetState({ spent: 50, budget: 100 }).level, 'warn');
  assert.equal(budgetState({ spent: 85, budget: 100 }).level, 'critical');
  assert.equal(budgetState({ spent: 130, budget: 100 }).level, 'over');
  assert.equal(budgetState({ spent: 10, budget: 0 }).level, 'none');
});
