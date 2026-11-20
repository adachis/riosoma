import { useLingui } from '@lingui/react/macro';
import { queryOptions, useQuery } from '@tanstack/react-query';
import type { OrgUnit } from '@riosoma/contracts';
import { ListBoxItem, Select } from '@riosoma/ui';
import { api } from '../../../api';
import { useSession } from '../../../session';
import { isDemoSession } from '../../../demo';
import { ordered, subtree } from './access';

export const unitsQuery = queryOptions({
  queryKey: ['org', 'units'],
  queryFn: async ({ signal }) => (isDemoSession() ? [] : api<OrgUnit[]>('/api/org/units', { signal })),
});

/** Everyone, the people placed directly in the organization, or a unit's ID */
export type UnitFilterValue = string;

/** Whether someone placed in a unit shows under a filter.  A unit includes the units below it. */
export function unitMatcher(
  tree: readonly OrgUnit[] | undefined,
  value: UnitFilterValue,
): (unitId: string | null | undefined) => boolean {
  if (value === 'all') return () => true;
  if (value === 'organization') return (unitId) => !unitId;
  const within = subtree(tree ?? [], value);
  return (unitId) => Boolean(unitId && within.has(unitId));
}

/**
 * Filters a list of people by unit.  It shows nothing, and asks for nothing, until the
 * organization has its first unit.
 */
export function UnitFilter({
  value,
  onChange,
}: {
  value: UnitFilterValue;
  onChange: (value: UnitFilterValue) => void;
}) {
  const { t } = useLingui();
  const session = useSession();
  const shown = Boolean(session?.hasUnits && session.membership.kind !== 'guest');
  const units = useQuery({ ...unitsQuery, enabled: shown });
  if (!shown || !units.data?.length) return null;
  const everyone = t({ id: 'orgUnits.filter.all', message: 'Everyone' });
  const unplaced = t({ id: 'orgUnits.filter.organization', message: 'Not in a unit' });
  return (
    <Select
      label={t({ id: 'orgUnits.filter', message: 'Organizational unit' })}
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key))}
    >
      <ListBoxItem id="all" textValue={everyone}>
        {everyone}
      </ListBoxItem>
      <ListBoxItem id="organization" textValue={unplaced}>
        {unplaced}
      </ListBoxItem>
      {ordered(units.data).map(({ unit, depth }) => (
        <ListBoxItem id={unit.id} key={unit.id} textValue={unit.name}>
          {`${' '.repeat(depth)}${unit.name}`}
        </ListBoxItem>
      ))}
    </Select>
  );
}
