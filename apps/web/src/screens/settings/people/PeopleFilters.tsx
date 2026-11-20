import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';
import { useLingui } from '@lingui/react/macro';
import { ListBoxItem, Select } from '@riosoma/ui';
import type { Invitation, Member } from '@riosoma/contracts';
import { setAdminSearch, useAdminSearch } from '../admin-search';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'organization',
  page: 'people',
  label: msg({ id: 'settings.nav.people', message: 'People' }),
  roles: ['people'],
});

export function usePeopleFilters() {
  const search = useAdminSearch();
  const role = search.get('role') ?? 'all';
  const status = search.get('status') ?? 'all';
  return {
    role,
    status,
    member: (member: Member) =>
      (role === 'all' || member.kind === role) &&
      (status === 'all' || status === (member.deactivated ? 'deactivated' : 'active')),
    invitation: (invitation: Invitation) =>
      (role === 'all' || invitation.kind === role) && (status === 'all' || status === 'invited'),
  };
}

export function PeopleFilters({
  members,
  invitations = [],
}: {
  members: readonly Member[];
  invitations?: readonly Invitation[];
}) {
  const { t } = useLingui();
  const filters = usePeopleFilters();
  const roles = [
    { id: 'all', label: t({ id: 'people.filters.allRoles', message: 'All roles' }) },
    { id: 'owner', label: t({ id: 'people.kind.owner', message: 'Owner' }) },
    { id: 'member', label: t({ id: 'people.kind.member', message: 'Member' }) },
    { id: 'guest', label: t({ id: 'people.kind.guest', message: 'Guest' }) },
  ];
  const statuses = [
    { id: 'all', label: t({ id: 'people.filters.allStatuses', message: 'All statuses' }) },
    { id: 'active', label: t({ id: 'people.filters.active', message: 'Active' }) },
    { id: 'deactivated', label: t({ id: 'people.deactivated', message: 'Deactivated' }) },
    { id: 'invited', label: t({ id: 'people.filters.invited', message: 'Invited' }) },
  ];
  const active = members.filter((member) => !member.deactivated).length;
  const deactivated = members.length - active;
  const invited = invitations.length;
  return (
    <div className="rio-people__filters">
      <Setting
        page={settingsPage}
        id="role-filter"
        label={msg({ id: 'people.filters.role', message: 'Filter by role' })}
      >
        <Select
          label={t({ id: 'people.filters.role', message: 'Filter by role' })}
          selectedKey={filters.role}
          onSelectionChange={(key) => setAdminSearch({ role: key === 'all' ? undefined : String(key) })}
        >
          {roles.map(({ id, label }) => (
            <ListBoxItem key={id} id={id}>
              {label}
            </ListBoxItem>
          ))}
        </Select>
      </Setting>
      <Setting
        page={settingsPage}
        id="status-filter"
        label={msg({ id: 'people.filters.status', message: 'Filter by status' })}
      >
        <Select
          label={t({ id: 'people.filters.status', message: 'Filter by status' })}
          selectedKey={filters.status}
          onSelectionChange={(key) => setAdminSearch({ status: key === 'all' ? undefined : String(key) })}
        >
          {statuses.map(({ id, label }) => (
            <ListBoxItem key={id} id={id}>
              {label}
            </ListBoxItem>
          ))}
        </Select>
      </Setting>
      <p role="status">
        {t({
          id: 'people.filters.counts',
          message: `${active} active, ${deactivated} deactivated, and ${invited} invited`,
        })}
      </p>
    </div>
  );
}
