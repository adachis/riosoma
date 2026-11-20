// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.  If a copy
// of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ELECTRICITY_ZONES,
  estimate,
  hasModel,
  isElectricityZone,
  METHOD_VERSION,
  SOURCE,
  type Range,
} from './index.js';
import { listModels } from './models.js';

type Bounds = { min: number; max: number };
interface ReferenceCase {
  provider: string;
  model: string;
  outputTokens: number;
  zone: string | null;
  requestLatencySeconds: number | null;
  result:
    | { error: string }
    | { energyKwh: Bounds; gwpKgCo2eq: Bounds; adpeKgSbEq: Bounds; peMj: Bounds; warnings: string[] };
}
const reference = JSON.parse(
  readFileSync(join(import.meta.dirname, '../fixtures/reference.json'), 'utf8'),
) as { ecologits: string; cases: ReferenceCase[] };

/** Within 1% of the reference, end by end. */
function close(actual: Range, expected: Bounds, scale: number, label: string) {
  for (const end of ['min', 'max'] as const) {
    const want = expected[end] * scale;
    expect(Math.abs(actual[end] - want), `${label} ${end}`).toBeLessThanOrEqual(Math.abs(want) * 0.01);
  }
}

const label = (c: ReferenceCase) =>
  `${c.provider}/${c.model}, ${c.outputTokens} tokens, zone ${c.zone ?? 'default'}, latency ${c.requestLatencySeconds ?? 'none'}`;

describe('the port against the Python reference', () => {
  it('was generated from the release the port follows', () => {
    expect(reference.ecologits).toBe(SOURCE.version);
    expect(METHOD_VERSION).toBe(`EcoLogits ${SOURCE.version}`);
    expect(reference.cases.length).toBeGreaterThan(200);
  });

  it.each(reference.cases.map((c) => [label(c), c] as const))('matches within 1%%: %s', (_name, c) => {
    const result = estimate({
      provider: c.provider,
      model: c.model,
      outputTokens: c.outputTokens,
      ...(c.zone === null ? {} : { zone: c.zone }),
      ...(c.requestLatencySeconds === null ? {} : { requestLatencyMs: c.requestLatencySeconds * 1000 }),
    });
    if ('error' in c.result) {
      expect(result).toEqual({
        kind: 'none',
        reason: c.result.error === 'zone-not-registered' ? 'unknownZone' : 'unknownModel',
        method: METHOD_VERSION,
      });
      return;
    }
    if (result.kind !== 'estimate') throw new Error(`No estimate for ${label(c)}`);
    close(result.energyWh, c.result.energyKwh, 1000, 'energy');
    close(result.gwpGCo2eq, c.result.gwpKgCo2eq, 1000, 'GWP');
    close(result.adpeKgSbEq, c.result.adpeKgSbEq, 1, 'ADPe');
    close(result.peMj, c.result.peMj, 1, 'PE');
    expect(result.warnings).toEqual(c.result.warnings);
    expect(result.method).toBe(METHOD_VERSION);
  });

  it('covers a mixture-of-experts model with a range of active parameters', () => {
    const moe = listModels().filter(
      (model) =>
        model.architecture.type === 'moe' &&
        typeof model.architecture.parameters === 'object' &&
        'active' in model.architecture.parameters &&
        typeof model.architecture.parameters.active === 'object',
    );
    const covered = reference.cases.filter(
      (c) => !('error' in c.result) && moe.some((m) => m.provider === c.provider && m.name === c.model),
    );
    expect(covered.length).toBeGreaterThan(20);
    for (const c of covered) {
      if ('error' in c.result) continue;
      expect(c.result.energyKwh.max).toBeGreaterThan(c.result.energyKwh.min);
    }
  });
});

describe('estimates', () => {
  it('returns no estimate for a model or provider the data lacks, rather than a guess', () => {
    expect(estimate({ provider: 'openai', model: 'a-model-nobody-made', outputTokens: 500 })).toEqual({
      kind: 'none',
      reason: 'unknownModel',
      method: METHOD_VERSION,
    });
    expect(estimate({ provider: 'somewhere', model: 'gpt-4o', outputTokens: 500 })).toMatchObject({
      kind: 'none',
      reason: 'unknownModel',
    });
    // Names match exactly: a close spelling is still unknown.
    expect(estimate({ provider: 'openai', model: 'GPT-4o', outputTokens: 500 }).kind).toBe('none');
    expect(hasModel('openai', 'gpt-4o')).toBe(true);
    expect(hasModel('openai', 'gpt-4o-latest-and-greatest')).toBe(false);
  });

  it('returns no estimate for a zone without an electricity mix', () => {
    expect(
      estimate({ provider: 'openai', model: 'gpt-4o', outputTokens: 500, zone: 'ATLANTIS' }),
    ).toMatchObject({ kind: 'none', reason: 'unknownZone' });
  });

  it('uses the zone it is given, and the provider’s own when none is', () => {
    const world = estimate({ provider: 'openai', model: 'gpt-4o', outputTokens: 500, zone: 'WOR' });
    const france = estimate({ provider: 'openai', model: 'gpt-4o', outputTokens: 500, zone: 'FRA' });
    const own = estimate({ provider: 'openai', model: 'gpt-4o', outputTokens: 500 });
    if (world.kind !== 'estimate' || france.kind !== 'estimate' || own.kind !== 'estimate')
      throw new Error('Expected estimates');
    expect(world.zone).toBe('WOR');
    expect(own.zone).toBe('USA');
    // Energy doesn't depend on the grid, but carbon does.
    expect(france.energyWh).toEqual(world.energyWh);
    expect(france.gwpGCo2eq.max).toBeLessThan(world.gwpGCo2eq.max);
  });

  it('grows with output tokens and caps generation time at the request’s own latency', () => {
    const short = estimate({ provider: 'openai', model: 'gpt-4o', outputTokens: 100, zone: 'WOR' });
    const long = estimate({ provider: 'openai', model: 'gpt-4o', outputTokens: 1000, zone: 'WOR' });
    const quick = estimate({
      provider: 'openai',
      model: 'gpt-4o',
      outputTokens: 1000,
      zone: 'WOR',
      requestLatencyMs: 100,
    });
    if (short.kind !== 'estimate' || long.kind !== 'estimate' || quick.kind !== 'estimate')
      throw new Error('Expected estimates');
    expect(long.energyWh.min).toBeGreaterThan(short.energyWh.min);
    expect(quick.gwpGCo2eq.min).toBeLessThan(long.gwpGCo2eq.min);
  });

  it('refuses token counts and latencies that make no sense', () => {
    expect(() => estimate({ provider: 'openai', model: 'gpt-4o', outputTokens: -1 })).toThrow(RangeError);
    expect(() => estimate({ provider: 'openai', model: 'gpt-4o', outputTokens: Number.NaN })).toThrow();
    expect(() =>
      estimate({ provider: 'openai', model: 'gpt-4o', outputTokens: 1, requestLatencyMs: -5 }),
    ).toThrow(RangeError);
  });

  it('lists the zones it knows, the world and Europe among them', () => {
    expect(ELECTRICITY_ZONES).toContain('WOR');
    expect(ELECTRICITY_ZONES).toContain('EEE');
    expect(ELECTRICITY_ZONES.length).toBeGreaterThan(200);
    expect(isElectricityZone('FRA')).toBe(true);
    expect(isElectricityZone('fra')).toBe(false);
  });
});

describe('the data files', () => {
  it('are unchanged copies of the release’s own', () => {
    for (const [path, file] of Object.entries(SOURCE.files)) {
      const digest = createHash('sha256')
        .update(readFileSync(join(import.meta.dirname, path)))
        .digest('hex');
      expect(digest, path).toBe(file.sha256);
    }
  });
});
