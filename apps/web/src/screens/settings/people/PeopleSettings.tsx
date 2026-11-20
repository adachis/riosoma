import { msg } from '@lingui/core/macro';
import { Setting, SettingItem, defineSettingsPage, defineSettingItems } from '../Setting';

import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { faTrash } from '@fortawesome/free-solid-svg-icons';
import { InvitePeople, type Invitation, type InviteResult, type Member } from '@riosoma/contracts';
import {
  Avatar,
  Button,
  ConfirmDialog,
  Form,
  FormActions,
  Heading,
  ListBoxItem,
  Select,
  Spinner,
  Text,
  TextArea,
  Tooltip,
  TooltipTrigger,
  toast,
} from '@riosoma/ui';
import { api } from '../../../api';
import { canManagePeople, useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { MemberActions } from './MemberActions';
import { PeopleFilters, usePeopleFilters } from './PeopleFilters';
import { FolderSettings, organizationFoldersQuery, organizationGroupsQuery } from './FolderSettings';
import { databasesQuery } from '../../../data/databases';
import { organizationRole, peopleWithin, reachOf, reaches } from '../units/access';
import { UnitFilter, unitMatcher, unitsQuery } from '../units/UnitFilter';
import './PeopleSettings.css';
import { AdminRoles } from './AdminRoles';
import { setAdminSearch, useAdminSearch } from '../admin-search';
import '../administration.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'organization',
  page: 'people',
  label: msg({ id: 'settings.nav.people', message: 'People' }),
  roles: ['people'],
  keywords: msg({
    id: 'settings.search.keywords.people',
    message: 'people members guests invitations roles',
  }),
});
const childSettings = defineSettingItems(settingsPage, {
  folders: { label: msg({ id: 'scim.folders', message: 'Folders and group roles' }) },
  'admin-roles': { label: msg({ id: 'adminRoles.title', message: 'Admin roles' }), roles: ['owner'] },
  'unit-filter': {
    label: msg({ id: 'orgUnits.filter', message: 'Organizational unit' }),
    requiredRoles: ['units-existing'],
  },
});

// The screen that shows the list and the places that hide the way into it ask the same question.
export { canManagePeople };

export function PeopleSettings() {
  const session = useSession();
  if (!canManagePeople(session)) return <ErrorBanner error={{ key: 'errors.adminOnly' }} />;
  // A unit's People admin sees the people in their units, and does the rest in Organizational units.
  return (
    <Setting page={settingsPage} id="overview" label={msg({ id: 'settings.nav.people', message: 'People' })}>
      {organizationRole(session, 'people') ? <PeopleForm /> : <UnitPeopleList />}
    </Setting>
  );
}

function PeopleForm() {
  const { t, i18n } = useLingui();
  const session = useSession();
  const memberId = useAdminSearch().get('member');
  const filters = usePeopleFilters();
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [kind, setKind] = useState<'member' | 'guest'>('member');
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const unitFilter = useAdminSearch().get('unit') ?? 'all';
  const setUnitFilter = (unit: string) => setAdminSearch({ unit: unit === 'all' ? undefined : unit });
  const members = useQuery({
    queryKey: ['org', 'members'],
    queryFn: () => api<Member[]>('/api/org/members'),
  });
  const units = useQuery({ ...unitsQuery, enabled: Boolean(session?.hasUnits) });
  const matches = unitMatcher(units.data, unitFilter);
  const shown = members.data?.filter((member) => matches(member.unitId) && filters.member(member));
  const invitations = useQuery({
    queryKey: ['org', 'invitations'],
    queryFn: () => api<Invitation[]>('/api/org/invitations'),
  });
  const groups = useQuery(organizationGroupsQuery);
  const folders = useQuery(organizationFoldersQuery);
  const databases = useQuery(databasesQuery);
  const emails = [
    ...new Set(
      input
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((email) => email.toLowerCase()),
    ),
  ];
  const count = emails.filter((email) => !InvitePeople.shape.emails.element.safeParse(email).success).length;
  const valid = InvitePeople.safeParse({ emails, kind }).success;
  const invite = useMutation({
    mutationFn: (body: InvitePeople) => api<InviteResult>('/api/org/invitations', { body }),
    onSuccess: (result) => {
      const count = result.invited.length;
      const emails = result.alreadyMembers.join(', ');
      toast.show({
        tone: 'success',
        title: t({
          id: 'people.invite.sent',
          message: plural(count, { one: 'Invited # person', other: 'Invited # people' }),
        }),
        ...(emails
          ? {
              description: t({ id: 'people.invite.skipped', message: `Already members: ${emails}` }),
              timeout: 0,
            }
          : {}),
      });
      setInput('');
      return queryClient.invalidateQueries({ queryKey: ['org', 'invitations'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/org/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['org', 'invitations'] }),
  });
  const revokeTitle = (email: string) =>
    t({ id: 'people.pending.revokeTitle', message: `Revoke the invitation to ${email}?` });
  const kinds = {
    owner: t({ id: 'people.kind.owner', message: 'Owner' }),
    member: t({ id: 'people.kind.member', message: 'Member' }),
    guest: t({ id: 'people.kind.guest', message: 'Guest' }),
  };

  const selectedMember = members.data?.find((member) => member.id === memberId && member.kind === 'member');
  if (session?.membership.kind === 'owner' && selectedMember)
    return (
      <SettingItem definition={childSettings['admin-roles']}>
        <AdminRoles key={selectedMember.id} member={selectedMember} />
        <MemberActions key={`security-${selectedMember.id}`} member={selectedMember} />
      </SettingItem>
    );

  // Lists share a column with the invitation form, so initial data arrives before controls appear.
  if (
    members.isPending ||
    invitations.isPending ||
    groups.isPending ||
    folders.isPending ||
    databases.isPending ||
    (session?.hasUnits && units.isPending)
  )
    return <Spinner label={t({ id: 'people.loading', message: 'Loading people' })} />;

  return (
    <div className="rio-people">
      <SettingItem definition={childSettings.folders}>
        <FolderSettings />
      </SettingItem>
      <section aria-labelledby="people-members">
        <Heading level={2} id="people-members">
          <Trans id="people.members">Members</Trans>
        </Heading>
        {members.isPending ? <Spinner /> : null}
        <ErrorBanner error={errorInfo(members.error)} />
        <PeopleFilters members={members.data ?? []} invitations={invitations.data ?? []} />
        <SettingItem definition={childSettings['unit-filter']}>
          <UnitFilter value={unitFilter} onChange={setUnitFilter} />
        </SettingItem>
        <SettingItem definition={childSettings['admin-roles']}>
          <ul className="rio-people__list">
            {shown?.map((member) => (
              <li className="rio-people__row rio-people__person" key={member.id}>
                <Avatar
                  personId={member.id}
                  pictureUrl={member.pictureUrl}
                  deactivated={member.deactivated}
                  name={member.name || member.email}
                  color="blue"
                />
                <div className="rio-people__identity">
                  <strong>{member.name}</strong>
                  <Text>{member.email}</Text>
                  <Text>{kinds[member.kind]}</Text>
                  {member.deactivated ? (
                    <Text>
                      <Trans id="people.deactivated">Deactivated</Trans>
                    </Text>
                  ) : null}
                  {member.deactivated && !member.managed ? (
                    <Text>
                      <Trans id="people.automations.continue">Owned automations keep running.</Trans>
                    </Text>
                  ) : null}
                  {member.managed ? (
                    <>
                      <Text>
                        <Trans id="scim.managed">Managed by SCIM</Trans>
                      </Text>
                      <details>
                        <summary>
                          <Trans id="scim.profile">Provisioned profile</Trans>
                        </summary>
                        <dl>
                          <dt>
                            <Trans id="scim.profile.userName">Directory user name</Trans>
                          </dt>
                          <dd>{member.profile?.userName}</dd>
                          <dt>
                            <Trans id="scim.profile.externalId">External ID</Trans>
                          </dt>
                          <dd>{member.profile?.externalId}</dd>
                          <dt>
                            <Trans id="scim.profile.givenName">Given name</Trans>
                          </dt>
                          <dd>{member.profile?.givenName}</dd>
                          <dt>
                            <Trans id="scim.profile.familyName">Family name</Trans>
                          </dt>
                          <dd>{member.profile?.familyName}</dd>
                          <dt>
                            <Trans id="scim.profile.department">Department</Trans>
                          </dt>
                          <dd>{member.profile?.department}</dd>
                          <dt>
                            <Trans id="scim.profile.employeeNumber">Employee number</Trans>
                          </dt>
                          <dd>{member.profile?.employeeNumber}</dd>
                          <dt>
                            <Trans id="scim.profile.manager">Manager</Trans>
                          </dt>
                          <dd>
                            {member.profile?.manager?.displayName ??
                              members.data?.find((person) => person.id === member.profile?.manager?.value)
                                ?.name ??
                              member.profile?.manager?.value}
                          </dd>
                        </dl>
                      </details>
                    </>
                  ) : null}
                </div>
                <MemberActions
                  member={member}
                  lastOwner={
                    member.lastOwner ??
                    (member.kind === 'owner' &&
                      members.data?.filter((person) => person.kind === 'owner' && !person.deactivated)
                        .length === 1)
                  }
                />
              </li>
            ))}
          </ul>
        </SettingItem>
      </section>
      <section>
        <Heading level={2}>
          <Trans id="scim.groups">Groups</Trans>
        </Heading>
        <ErrorBanner error={errorInfo(groups.error)} />
        <ul className="rio-people__list">
          {groups.data?.map((group) => (
            <li key={group.id} className="rio-people__row">
              <strong>{group.name}</strong>
              {group.managed ? (
                <Text>
                  <Trans id="scim.managed">Managed by SCIM</Trans>
                </Text>
              ) : null}
              <Text>
                {group.members
                  .map((id) => members.data?.find((member) => member.id === id)?.name ?? id)
                  .join(', ')}
              </Text>
            </li>
          ))}
        </ul>
      </section>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !invite.isPending) invite.mutate(InvitePeople.parse({ emails, kind }));
        }}
      >
        <Heading level={2}>
          <Trans id="people.invite.title">Invite people</Trans>
        </Heading>
        <Setting
          page={settingsPage}
          id="emails"
          label={msg({ id: 'people.invite.emails', message: 'Email addresses' })}
        >
          <TextArea
            label={t({ id: 'people.invite.emails', message: 'Email addresses' })}
            value={input}
            onChange={setInput}
            isRequired
            isDisabled={invite.isPending}
            validationBehavior="aria"
            isInvalid={count > 0 || emails.length > 50}
            errorMessage={
              count > 0
                ? t({
                    id: 'people.invite.bad',
                    message: plural(count, {
                      one: '# address isn’t valid.',
                      other: '# addresses aren’t valid.',
                    }),
                  })
                : emails.length > 50
                  ? t({ id: 'people.invite.limit', message: 'Invite up to 50 people at a time.' })
                  : undefined
            }
          />
        </Setting>
        <Setting page={settingsPage} id="as" label={msg({ id: 'people.invite.as', message: 'Invite as' })}>
          <Select
            label={t({ id: 'people.invite.as', message: 'Invite as' })}
            selectedKey={kind}
            isDisabled={invite.isPending}
            onSelectionChange={(key) => {
              if (key === 'member' || key === 'guest') setKind(key);
            }}
          >
            <ListBoxItem id="member">{t({ id: 'people.invite.member', message: 'Member' })}</ListBoxItem>
            <ListBoxItem id="guest">{t({ id: 'people.invite.guest', message: 'Guest' })}</ListBoxItem>
          </Select>
        </Setting>
        <ErrorBanner error={errorInfo(invite.error)} />
        <FormActions>
          <Button type="submit" variant="primary" isDisabled={!valid} isPending={invite.isPending}>
            <Trans id="people.invite.submit">Invite</Trans>
          </Button>
        </FormActions>
      </Form>
      <section aria-labelledby="people-pending">
        <Heading level={2} id="people-pending">
          <Trans id="people.pending.title">Waiting to join</Trans>
        </Heading>
        {invitations.isPending ? <Spinner /> : null}
        <ErrorBanner error={errorInfo(invitations.error)} />
        {invitations.data?.length === 0 ? (
          <Text>
            <Trans id="people.pending.none">No one is waiting to join.</Trans>
          </Text>
        ) : null}
        <ul className="rio-people__list">
          {invitations.data?.filter(filters.invitation).map((invitation) => {
            const date = i18n.date(new Date(invitation.expiresAt), { dateStyle: 'medium' });
            return (
              <li className="rio-people__row" key={invitation.id}>
                <div className="rio-people__identity">
                  <strong>{invitation.email}</strong>
                  <Text>
                    <Trans id="people.pending.expires">Expires {date}</Trans>
                  </Text>
                </div>
                <TooltipTrigger>
                  <Button
                    variant="quiet"
                    size="sm"
                    icon={faTrash}
                    aria-label={revokeTitle(invitation.email)}
                    onPress={() => {
                      revoke.reset();
                      setRevoking(invitation);
                    }}
                  />
                  <Tooltip>{revokeTitle(invitation.email)}</Tooltip>
                </TooltipTrigger>
              </li>
            );
          })}
        </ul>
      </section>
      {revoking ? (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={revokeTitle(revoking.email)}
          message={
            <>
              <Trans id="people.pending.revokeBody">The link in their email stops working.</Trans>
              <ErrorBanner error={errorInfo(revoke.error)} />
            </>
          }
          confirmLabel={t({ id: 'people.pending.revoke', message: 'Revoke' })}
          onOpenChange={(open) => {
            if (!open) setRevoking(null);
          }}
          onConfirm={() => revoke.mutateAsync(revoking.id)}
        />
      ) : null}
    </div>
  );
}

/**
 * The people a unit's People admin reaches: everyone placed in their units.  Placing people and
 * choosing unit admins happen in Organizational units, and resetting second steps here takes the
 * Security role for the person's unit too.
 */
function UnitPeopleList() {
  const { t } = useLingui();
  const session = useSession();
  const unitFilter = useAdminSearch().get('unit') ?? 'all';
  const setUnitFilter = (unit: string) => setAdminSearch({ unit: unit === 'all' ? undefined : unit });
  const members = useQuery({
    queryKey: ['org', 'members'],
    queryFn: () => api<Member[]>('/api/org/members'),
  });
  const units = useQuery(unitsQuery);
  const tree = units.data ?? [];
  const matches = unitMatcher(units.data, unitFilter);
  const security = reachOf(session, tree, 'security');
  const filters = usePeopleFilters();
  const shown = peopleWithin(members.data ?? [], reachOf(session, tree, 'people')).filter(
    (member) => matches(member.unitId) && filters.member(member),
  );
  const kinds = {
    owner: t({ id: 'people.kind.owner', message: 'Owner' }),
    member: t({ id: 'people.kind.member', message: 'Member' }),
    guest: t({ id: 'people.kind.guest', message: 'Guest' }),
  };
  return (
    <div className="rio-people">
      <SettingItem definition={childSettings.folders}>
        <FolderSettings canCreate={false} />
      </SettingItem>
      <section aria-labelledby="people-members">
        <Heading level={2} id="people-members">
          <Trans id="people.unitMembers">People in your units</Trans>
        </Heading>
        {members.isPending || units.isPending ? <Spinner /> : null}
        <ErrorBanner error={errorInfo(members.error ?? units.error)} />
        <PeopleFilters members={peopleWithin(members.data ?? [], reachOf(session, tree, 'people'))} />
        <SettingItem definition={childSettings['unit-filter']}>
          <UnitFilter value={unitFilter} onChange={setUnitFilter} />
        </SettingItem>
        <ul className="rio-people__list">
          {shown.map((member) => (
            <li className="rio-people__row rio-people__person" key={member.id}>
              <Avatar
                personId={member.id}
                pictureUrl={member.pictureUrl}
                deactivated={member.deactivated}
                name={member.name || member.email}
                color="blue"
              />
              <div className="rio-people__identity">
                <strong>{member.name}</strong>
                <Text>{member.email}</Text>
                <Text>{kinds[member.kind]}</Text>
                {member.deactivated ? (
                  <Text>
                    <Trans id="people.deactivated">Deactivated</Trans>
                  </Text>
                ) : null}
                {member.managed ? (
                  <Text>
                    <Trans id="scim.managed">Managed by SCIM</Trans>
                  </Text>
                ) : null}
                {member.deactivated && !member.managed ? (
                  <Text>
                    <Trans id="people.automations.continue">Owned automations keep running.</Trans>
                  </Text>
                ) : null}
                <Text variant="muted">{tree.find((unit) => unit.id === member.unitId)?.name}</Text>
              </div>
              <MemberActions
                member={member}
                resetAllowed={
                  member.id !== session?.user.id &&
                  !member.deactivated &&
                  reaches(security, member.unitId ?? null)
                }
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
