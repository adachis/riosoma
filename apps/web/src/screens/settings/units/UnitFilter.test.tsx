import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrgUnit } from '@riosoma/contracts';
import { json, renderSharing, session } from '../../database/share/testing';
import { UnitFilter, unitMatcher } from './UnitFilter';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const tree: OrgUnit[] = [
  { id: 'research', parentId: null, name: 'Research' },
  { id: 'materials', parentId: 'research', name: 'Materials' },
  { id: 'operations', parentId: null, name: 'Operations' },
];

describe('the unit filter', () => {
  it('stays invisible, and asks for nothing, before the first unit exists', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    renderSharing(<UnitFilter value="all" onChange={() => {}} />, { ...session, hasUnits: false });
    expect(screen.queryByText('Organizational unit')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('appears once the first unit exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(tree)),
    );
    renderSharing(<UnitFilter value="all" onChange={() => {}} />, { ...session, hasUnits: true });
    expect(await screen.findByText('Organizational unit')).toBeDefined();
  });

  it('never shows to a guest', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    renderSharing(<UnitFilter value="all" onChange={() => {}} />, {
      ...session,
      membership: { kind: 'guest', adminRoles: [] },
      hasUnits: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('matches a unit, the units below it, or the people in no unit', () => {
    const research = unitMatcher(tree, 'research');
    expect(research('research')).toBe(true);
    expect(research('materials')).toBe(true);
    expect(research('operations')).toBe(false);
    expect(research(null)).toBe(false);
    const unplaced = unitMatcher(tree, 'organization');
    expect(unplaced(null)).toBe(true);
    expect(unplaced('research')).toBe(false);
    expect(unitMatcher(tree, 'all')('operations')).toBe(true);
  });
});
