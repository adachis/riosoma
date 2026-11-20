import { faXmark, faPlus } from '@fortawesome/free-solid-svg-icons';
import { useSettingsDraft } from '../SettingsDraft';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrgUnit, ScimUnitMapping } from '@riosoma/contracts';
import { Button, Heading, ListBoxItem, Select, Text, TextField, toast } from '@riosoma/ui';
import { api } from '../../../api';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { ordered } from './access';
import { msg } from '@lingui/core/macro';
import { SettingItem, defineSettingsPage, defineSettingItems } from '../Setting';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'organization',
  page: 'org-units',
  label: msg({ id: 'settings.nav.orgUnits', message: 'Organizational units' }),
  roles: ['security'],
  requiredRoles: ['organization-people', 'units-existing'],
});
const settings = defineSettingItems(settingsPage, {
  'unit-mappings': {
    label: msg({ id: 'orgUnits.mapping.title', message: 'Placing people from the directory' }),
  },
});

const KEY = ['org', 'unit-mappings'];

/**
 * Directory provisioning places people by one attribute of their directory record, mapped value
 * by value to units.  It's for organization admins who hold both the Security role, which owns
 * provisioning, and the People role, since it moves people.
 */
export function UnitMappingPanel({ tree }: { tree: readonly OrgUnit[] }) {
  const { t } = useLingui();
  const cache = useQueryClient();
  const mappings = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => api<ScimUnitMapping[]>('/api/admin/scim/unit-mappings', { signal }),
  });
  const save = useMutation({
    mutationFn: (body: ScimUnitMapping[]) =>
      api<ScimUnitMapping[]>('/api/admin/scim/unit-mappings', { method: 'PUT', body }),
    onSuccess: async (saved) => {
      cache.setQueryData(KEY, saved);
      await cache.invalidateQueries({ queryKey: ['org', 'members'] });
      toast.show({
        tone: 'success',
        title: t({ id: 'orgUnits.mapping.saved', message: 'Saved the provisioning mappings' }),
      });
    },
  });
  const departmentError = t({
    id: 'orgUnits.mapping.valueRequired',
    message: 'Enter the department from the directory.',
  });
  const unitError = t({ id: 'orgUnits.mapping.unitRequired', message: 'Choose a unit for this department.' });
  const draft = useSettingsDraft(
    { rows: mappings.data ?? [], value: '', unitId: null as string | null },
    (draft) =>
      save.mutateAsync(
        draft.value.trim() && draft.unitId
          ? [
              ...draft.rows.filter(
                (item) => item.value.trim().toLowerCase() !== draft.value.trim().toLowerCase(),
              ),
              { attribute: 'department', value: draft.value.trim(), unitId: draft.unitId },
            ]
          : draft.rows,
      ),
    {
      validate: (draft) => {
        if (!draft.value && !draft.unitId) return null;
        if (!draft.value.trim()) return departmentError;
        return draft.unitId ? null : unitError;
      },
    },
  );
  const { rows: current, value, unitId } = draft.value;
  const setValue = (value: string) => draft.setValue((previous) => ({ ...previous, value }));
  const setUnitId = (unitId: string) => draft.setValue((previous) => ({ ...previous, unitId }));
  const names = new Map(tree.map((unit) => [unit.id, unit.name]));
  return (
    <SettingItem definition={settings['unit-mappings']}>
      <section className="rio-units__panel" aria-labelledby="unit-mappings">
        <Heading level={2} id="unit-mappings">
          <Trans id="orgUnits.mapping.title">Placing people from the directory</Trans>
        </Heading>
        <Text variant="muted">
          <Trans id="orgUnits.mapping.intro">
            {
              'Map the department in each person’s directory record to a unit.  Once a department is mapped, provisioning places everyone it manages by their record: a mapped department puts them in its unit, and any other takes them out of every unit.  People the directory doesn’t manage stay where you put them.'
            }
          </Trans>
        </Text>
        <ErrorBanner error={errorInfo(mappings.error ?? save.error)} />
        {current.length ? (
          <ul className="rio-units__list">
            {current.map((mapping) => {
              const directory = mapping.value;
              const unitName = names.get(mapping.unitId) ?? mapping.unitId;
              return (
                <li key={`${mapping.attribute}:${mapping.value}`} className="rio-units__row">
                  <span className="rio-units__grow">
                    {t({ id: 'orgUnits.mapping.row', message: `${directory} places people in ${unitName}` })}
                  </span>
                  <Button
                    size="sm"
                    variant="quiet"
                    isDisabled={save.isPending}
                    onPress={() =>
                      draft.setValue((previous) => ({
                        ...previous,
                        rows: previous.rows.filter((item) => item !== mapping),
                      }))
                    }
                    aria-label={t({ id: 'orgUnits.mapping.remove', message: 'Remove' })}
                    icon={faXmark}
                  />
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="rio-units__row">
          <TextField
            label={t({ id: 'orgUnits.mapping.value', message: 'Department in the directory' })}
            value={value}
            onChange={setValue}
            maxLength={255}
            isDisabled={draft.saving}
            isInvalid={Boolean(value || unitId) && !value.trim()}
            errorMessage={departmentError}
          />
          <Select
            label={t({ id: 'orgUnits.mapping.unit', message: 'Unit' })}
            selectedKey={unitId}
            isDisabled={draft.saving}
            isInvalid={Boolean(value.trim()) && !unitId}
            errorMessage={unitError}
            onSelectionChange={(key) => setUnitId(String(key))}
          >
            {ordered(tree).map(({ unit, depth }) => (
              <ListBoxItem key={unit.id} id={unit.id} textValue={unit.name}>
                {`${' '.repeat(depth)}${unit.name}`}
              </ListBoxItem>
            ))}
          </Select>
          <Button
            isDisabled={!value.trim() || !unitId || !mappings.data}
            isPending={save.isPending}
            onPress={() => {
              if (unitId)
                draft.setValue({
                  rows: [
                    ...current.filter(
                      (item) => item.value.trim().toLowerCase() !== value.trim().toLowerCase(),
                    ),
                    { attribute: 'department', value: value.trim(), unitId },
                  ],
                  value: '',
                  unitId: null,
                });
            }}
            aria-label={t({ id: 'orgUnits.mapping.add', message: 'Add mapping' })}
            icon={faPlus}
          />
        </div>
      </section>
    </SettingItem>
  );
}
