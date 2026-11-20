import { describe, expect, it } from 'vitest';
import { KnowledgeSettings } from '@riosoma/contracts';
import { findElectricityMix } from '@riosoma/ecologits';
import { estimateServiceFootprint } from './knowledge-usage.js';

describe('service footprint', () => {
  it('converts allocated power and duration to energy and regional carbon', () => {
    const estimate = estimateServiceFootprint({ powerWatts: 3600, durationMs: 1000, zone: 'USA' });
    expect(estimate).toEqual({
      energyWh: { min: 1, max: 1 },
      gwpG: { min: findElectricityMix('USA')!.gwp, max: findElectricityMix('USA')!.gwp },
      method: 'service-power-v1',
      zone: 'USA',
    });
    expect(estimateServiceFootprint({ powerWatts: 3600, durationMs: 2000, zone: 'USA' })?.energyWh.min).toBe(
      2,
    );
    expect(estimateServiceFootprint({ powerWatts: 3600, durationMs: 1000, zone: 'FRA' })?.gwpG.min).not.toBe(
      estimate?.gwpG.min,
    );
  });

  it('keeps unknown or invalid power and duration unestimated', () => {
    for (const powerWatts of [undefined, null, 0, -1, NaN, Infinity])
      expect(estimateServiceFootprint({ powerWatts, durationMs: 1000, zone: 'WOR' })).toBeNull();
    for (const durationMs of [-1, NaN, Infinity])
      expect(estimateServiceFootprint({ powerWatts: 100, durationMs, zone: 'WOR' })).toBeNull();
    expect(estimateServiceFootprint({ powerWatts: 100, durationMs: 1000, zone: 'unknown' })).toBeNull();
  });

  it('accepts optional positive power and rejects invalid settings', () => {
    expect(KnowledgeSettings.parse({}).search.powerWatts).toBeUndefined();
    expect(KnowledgeSettings.parse({ search: { powerWatts: null } }).search.powerWatts).toBeNull();
    for (const powerWatts of [0, -1, NaN, Infinity, 1_000_001])
      expect(KnowledgeSettings.safeParse({ search: { powerWatts } }).success).toBe(false);
  });
});
