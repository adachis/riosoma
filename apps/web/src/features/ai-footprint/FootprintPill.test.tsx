import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiFootprintMine, AiUsageTotals } from '@riosoma/contracts';
import { json, renderSharing } from '../../screens/database/share/testing';
import { FootprintPill } from './FootprintPill';

const clients: Array<() => void> = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});

const totals = (over: Partial<AiUsageTotals> = {}): AiUsageTotals => ({
  calls: 0,
  estimatedCalls: 0,
  pricedCalls: 0,
  costUsd: 0,
  energyWh: { min: 0, max: 0 },
  gwpG: { min: 0, max: 0 },
  ...over,
});

function start(mine: AiFootprintMine) {
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/ai/footprint/mine') return json(mine);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const rendered = renderSharing(<FootprintPill />);
  clients.push(() => rendered.client.clear());
  return { ...rendered, fetcher, user: userEvent.setup() };
}

describe('the AI footprint pill', () => {
  it('shows this month’s cost and estimated carbon, and opens where they come from', async () => {
    const rio = totals({
      calls: 12,
      estimatedCalls: 12,
      pricedCalls: 12,
      costUsd: 0.4,
      energyWh: { min: 5, max: 12 },
      gwpG: { min: 2.4, max: 5.8 },
    });
    const fields = totals({
      calls: 3,
      estimatedCalls: 1,
      pricedCalls: 3,
      costUsd: 0.02,
      energyWh: { min: 0.3, max: 0.6 },
      gwpG: { min: 0.1, max: 0.2 },
    });
    const app = start({
      used: true,
      month: '2026-09-01',
      calls: 15,
      estimatedCalls: 13,
      pricedCalls: 15,
      costUsd: 0.42,
      energyWh: { min: 5.3, max: 12.6 },
      gwpG: { min: 2.5, max: 6 },
      byFeature: [
        { feature: 'aiFields', ...fields },
        { feature: 'rio', ...rio },
      ],
    });
    const pill = await screen.findByRole('button', { name: 'Your AI use this month: $0.42 · 2.5–6 g CO2e' });
    expect(pill.textContent).toBe('$0.42 · 2.5–6 g CO2e');
    await app.user.click(pill);
    const breakdown = await screen.findByRole('dialog', { name: 'Your AI use this month' });
    const items = within(breakdown).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'AI fields3 uses · $0.02 · 0.3 to 0.6 Wh · 0.1 to 0.2 g CO2e',
      'Rio replies12 uses · $0.40 · 5 to 12 Wh · 2.4 to 5.8 g CO2e',
    ]);
    expect(breakdown.textContent).toContain('Energy and carbon are estimates, shown as ranges.');
    expect(breakdown.textContent).toContain(
      '2 uses have no estimate, because the method has no data for their models or they generated nothing.',
    );
    expect(within(breakdown).getByRole('button', { name: 'How it’s estimated' })).toBeDefined();
    // It reports and never compares, ranks, or warns.
    expect(breakdown.textContent).not.toMatch(/average|more than|too much|warning/i);
  });

  it('stays hidden for someone who hasn’t used AI', async () => {
    const app = start({ used: false, month: '2026-09-01', ...totals(), byFeature: [] });
    await vi.waitFor(() => expect(app.fetcher).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('counts uses when nothing had a known price or an estimate', async () => {
    start({
      used: true,
      month: '2026-09-01',
      ...totals({ calls: 2 }),
      byFeature: [{ feature: 'diagnose', ...totals({ calls: 2 }) }],
    });
    expect((await screen.findByRole('button', { name: /Your AI use this month/ })).textContent).toBe(
      '2 AI uses',
    );
  });
});
