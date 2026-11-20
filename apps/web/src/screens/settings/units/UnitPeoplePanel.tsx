import { useSettingsSection, useSettingsLeaveGuard } from '../SettingsDraft';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  UNIT_ADMIN_ROLES,
  type Member,
  type OrgUnit,
  type UnitAdmin,
  type UnitAdminRole,
} from '@riosoma/contracts';
import { Button, Checkbox, CheckboxGroup, ComboBox, Heading, ListBoxItem, Text, toast } from '@riosoma/ui';
import { api } from '../../../api';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { ResetSecondSteps } from '../people/ResetSecondSteps';
import { peopleWithin, reachOf, reaches, rolesAt } from './access';
import { roleLabels } from './labels';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'organization',
  page: 'org-units',
  label: msg({ id: 'settings.nav.orgUnits', message: 'Organizational units' }),
  roles: ['people'],
  requiredRoles: ['units-existing'],
});

export const membersQuery = {
  queryKey: ['org', 'members'],
  queryFn: ({ signal }: { signal?: AbortSignal }) => api<Member[]>('/api/org/members', { signal }),
};

function PersonPicker({
  label,
  people,
  value,
  onChange,
  isDisabled,
}: {
  label: string;
  people: readonly Member[];
  value: string | null;
  onChange: (id: string | null) => void;
  isDisabled?: boolean;
}) {
  return (
    <ComboBox
      label={label}
      selectedKey={value}
      isDisabled={isDisabled}
      onSelectionChange={(key) => onChange(key === null ? null : String(key))}
    >
      {people.map((person) => (
        <ListBoxItem
          key={person.id}
          id={person.id}
          textValue={`${person.name} ${person.email}`}
          description={person.email}
        >
          {person.name || person.email}
        </ListBoxItem>
      ))}
    </ComboBox>
  );
}

/**
 * Who is placed in a unit, and who administers it.  Placing people takes the People role for this
 * unit, and choosing its admins takes the People role for a unit above it, with only the roles
 * held there.
 */
export function UnitPeoplePanel({ unit, tree }: { unit: OrgUnit; tree: readonly OrgUnit[] }) {
  const { t, i18n } = useLingui();
  const session = useSession();
  const cache = useQueryClient();
  const members = useQuery(membersQuery);
  const admins = useQuery({
    queryKey: ['org', 'units', unit.id, 'admins'],
    queryFn: ({ signal }) =>
      api<UnitAdmin[]>(`/api/org/units/${encodeURIComponent(unit.id)}/admins`, { signal }),
  });
  const [person, setPerson] = useState<string | null>(null);
  const requestLeave = useSettingsLeaveGuard();
  const [candidate, setCandidate] = useState<string | null>(null);
  const [roles, setRoles] = useState<UnitAdminRole[]>([]);
  const people = reachOf(session, tree, 'people');
  const parent = unit.parentId;
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: ['org'] });
    await cache.invalidateQueries({ queryKey: ['session'] });
  };
  const move = useMutation({
    mutationFn: ({ userId, unitId }: { userId: string; unitId: string | null }) =>
      api(`/api/org/members/${encodeURIComponent(userId)}/unit`, { method: 'PUT', body: { unitId } }),
    onSuccess: async () => {
      setPerson(null);
      await refresh();
    },
  });
  const grant = useMutation({
    mutationFn: ({ userId, next }: { userId: string; next: UnitAdminRole[] }) =>
      api(`/api/org/units/${encodeURIComponent(unit.id)}/admins/${encodeURIComponent(userId)}`, {
        method: 'PUT',
        body: { roles: next },
      }),
    onSuccess: async () => {
      setCandidate(null);
      setRoles([]);
      await refresh();
      toast.show({
        tone: 'success',
        title: t({ id: 'orgUnits.admins.saved', message: 'Saved the unit’s admins' }),
      });
    },
  });
  const everyone = members.data ?? [];
  const placed = everyone.filter((member) => member.unitId === unit.id);
  // Only people the admin's own People role reaches can be moved, and never the owner.
  const movable = peopleWithin(everyone, people).filter(
    (member) => member.kind !== 'owner' && member.unitId !== unit.id,
  );
  // Choosing admins is for a unit above, with the roles held there.
  const grantable = rolesAt(session, tree, unit.id, UNIT_ADMIN_ROLES, true);
  const canChooseAdmins = grantable.includes('people');
  const eligible = peopleWithin(everyone, people).filter((member) => member.kind === 'member');
  const nameOf = (id: string) => {
    const found = everyone.find((member) => member.id === id);
    return found ? found.name || found.email : id;
  };
  const parentName = parent ? tree.find((item) => item.id === parent)?.name : null;
  useSettingsSection({
    dirty: Boolean(
      candidate &&
      JSON.stringify([...roles].sort()) !==
        JSON.stringify([...(admins.data?.find((person) => person.userId === candidate)?.roles ?? [])].sort()),
    ),
    stored: admins.data,
    discard: () => {
      setCandidate(null);
      setRoles([]);
    },
    save: async () => {
      if (candidate) await grant.mutateAsync({ userId: candidate, next: roles });
    },
  });
  return (
    <Setting
      page={settingsPage}
      id="unit-people"
      label={msg({ id: 'orgUnits.people.title', message: 'People' })}
    >
      <section className="rio-units__panel" aria-labelledby={`people-${unit.id}`}>
        <Heading level={3} id={`people-${unit.id}`}>
          <Trans id="orgUnits.people.title">People</Trans>
        </Heading>
        <ErrorBanner error={errorInfo(members.error ?? move.error)} />
        {placed.length ? (
          <ul className="rio-units__list">
            {placed.map((member) => (
              <li key={member.id} className="rio-units__row">
                <span className="rio-units__grow">{member.name || member.email}</span>
                {reaches(people, parent) ? (
                  <Button
                    size="sm"
                    variant="quiet"
                    isDisabled={move.isPending}
                    onPress={() => move.mutate({ userId: member.id, unitId: parent })}
                  >
                    {parentName
                      ? t({ id: 'orgUnits.people.moveUp', message: `Move to ${parentName}` })
                      : t({ id: 'orgUnits.people.moveOut', message: 'Take out of every unit' })}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Text variant="muted">
            <Trans id="orgUnits.people.none">Nobody is placed in this unit yet.</Trans>
          </Text>
        )}
        <div className="rio-units__row">
          <PersonPicker
            label={t({ id: 'orgUnits.people.add', message: 'Place someone here' })}
            people={movable}
            value={person}
            onChange={setPerson}
            isDisabled={move.isPending}
          />
          <Button
            isDisabled={!person}
            isPending={move.isPending}
            onPress={() => person && move.mutate({ userId: person, unitId: unit.id })}
          >
            <Trans id="orgUnits.people.place">Place here</Trans>
          </Button>
        </div>
        <Heading level={4}>
          <Trans id="orgUnits.admins.title">Unit admins</Trans>
        </Heading>
        <ErrorBanner error={errorInfo(admins.error ?? grant.error)} />
        {admins.data?.length ? (
          <ul className="rio-units__list">
            {admins.data.map((admin) => (
              <li key={admin.userId} className="rio-units__row">
                <span className="rio-units__grow">{nameOf(admin.userId)}</span>
                <Text variant="muted">{admin.roles.map((role) => i18n._(roleLabels[role])).join(', ')}</Text>
                {canChooseAdmins ? (
                  <Button
                    size="sm"
                    variant="quiet"
                    onPress={() => {
                      void requestLeave().then((accepted) => {
                        if (accepted) {
                          setCandidate(admin.userId);
                          setRoles(admin.roles);
                        }
                      });
                    }}
                  >
                    <Trans id="orgUnits.admins.edit">Change roles</Trans>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Text variant="muted">
            <Trans id="orgUnits.admins.none">This unit has no admins of its own.</Trans>
          </Text>
        )}
        {canChooseAdmins ? (
          <div className="rio-units__grant">
            <PersonPicker
              label={t({ id: 'orgUnits.admins.person', message: 'Admin' })}
              people={eligible}
              value={candidate}
              onChange={(id) => {
                void requestLeave().then((accepted) => {
                  if (accepted) {
                    setCandidate(id);
                    setRoles(admins.data?.find((admin) => admin.userId === id)?.roles ?? []);
                  }
                });
              }}
            />
            <CheckboxGroup
              label={t({ id: 'orgUnits.admins.roles', message: 'Roles in this unit and the units below it' })}
              orientation="horizontal"
              value={roles}
              onChange={(next) => setRoles(next as UnitAdminRole[])}
            >
              {UNIT_ADMIN_ROLES.map((role) => (
                <Checkbox key={role} value={role} isDisabled={!grantable.includes(role)}>
                  {i18n._(roleLabels[role])}
                </Checkbox>
              ))}
            </CheckboxGroup>
            <Text variant="small">
              <Trans id="orgUnits.admins.help">
                {
                  'You can give or take away only the roles you hold above this unit.  Saving no roles removes the admin.'
                }
              </Trans>
            </Text>
          </div>
        ) : null}
      </section>
    </Setting>
  );
}

/**
 * Resetting the second steps of the people placed in a unit, for someone with the Security role
 * there.  Nobody resets their own here, and the owner's are for another owner.
 */
export function UnitSecurityPanel({ unit }: { unit: OrgUnit }) {
  const session = useSession();
  const members = useQuery(membersQuery);
  const placed = (members.data ?? []).filter(
    (member) => member.unitId === unit.id && member.id !== session?.user.id && member.kind !== 'owner',
  );
  return (
    <section className="rio-units__panel" aria-labelledby={`security-${unit.id}`}>
      <Heading level={3} id={`security-${unit.id}`}>
        <Trans id="orgUnits.security.title">Second steps</Trans>
      </Heading>
      <ErrorBanner error={errorInfo(members.error)} />
      {placed.length ? (
        <ul className="rio-units__list">
          {placed.map((member) => (
            <li key={member.id} className="rio-units__row">
              <span className="rio-units__grow">{member.name || member.email}</span>
              {member.deactivated ? null : <ResetSecondSteps member={member} />}
            </li>
          ))}
        </ul>
      ) : (
        <Text variant="muted">
          <Trans id="orgUnits.people.none">Nobody is placed in this unit yet.</Trans>
        </Text>
      )}
    </section>
  );
}
