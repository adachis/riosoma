import { expect, it, vi } from 'vitest';
import type { ChatRequest, ProviderAdapter, RegistryModel } from '@riosoma/ai';
import { cheapestModel, EvalBudget } from './budget.js';

const model: RegistryModel = {
  providerId: 'fixture',
  model: 'fixture',
  name: 'Fixture',
  tiers: ['everyday'],
  tools: true,
  contextTokens: 32_000,
  price: { input: 1, output: 2 },
};
const request: ChatRequest = {
  model: model.model,
  messages: [{ role: 'user', content: 'Synthetic task' }],
  maxOutputTokens: 100,
};

it('selects by a shared token allowance and refuses unavailable, incapable, or unpriced entries', () => {
  const cheaper = { ...model, model: 'cheaper', price: { input: 0.1, output: 0.5 } };
  const candidates = [
    model,
    { ...cheaper, providerId: 'disabled' },
    { ...cheaper, tools: false },
    { ...cheaper, contextTokens: 100 },
    { ...cheaper, maxOutputTokens: 128 },
    { ...cheaper, price: null },
    { ...cheaper, price: { input: -1, output: 0 } },
    cheaper,
  ];
  expect(cheapestModel(candidates, ['fixture'])).toBe(cheaper);
  expect(cheapestModel(candidates, [])).toBeNull();
});

it('reserves before starting and shares the cap across calls, including failed calls', async () => {
  const start = vi.fn();
  const adapter: ProviderAdapter = {
    id: 'fixture',
    name: 'Fixture',
    local: true,
    async listModels() {
      return [];
    },
    async *stream() {
      start();
      yield { type: 'text', delta: 'Partial' };
      throw new Error('interrupted');
    },
  };
  const budget = new EvalBudget(0.0003);
  const stream = budget.wrap(adapter, model);
  const consume = async () => {
    for await (const part of stream({}, request)) void part;
  };
  await expect(consume()).rejects.toThrow('interrupted');
  expect(budget.chargedUsd).toBeGreaterThan(0);
  await expect(consume()).rejects.toThrow();
  expect(start).toHaveBeenCalledTimes(1);
  expect(budget.chargedUsd).toBeLessThanOrEqual(budget.limitUsd);
});

it('uses final usage to release unused reservations and keeps reservations without usage', async () => {
  const adapter: ProviderAdapter = {
    id: 'fixture',
    name: 'Fixture',
    local: true,
    async listModels() {
      return [];
    },
    async *stream() {
      yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
    },
  };
  const budget = new EvalBudget(0.001);
  for await (const part of budget.wrap(adapter, model)({}, request)) void part;
  expect(budget.chargedUsd).toBeCloseTo(0.00002);
  adapter.stream = async function* () {
    yield { type: 'text', delta: 'Answer' };
  };
  for await (const part of budget.wrap(adapter, model)({}, request)) void part;
  expect(budget.chargedUsd).toBeGreaterThan(0.0002);
});

it.each([0, -1, NaN, Infinity])('rejects an invalid cap %s', (cap) => {
  expect(() => new EvalBudget(cap)).toThrow();
});
