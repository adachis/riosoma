import { HelpDialogTitle } from '../../../docs/HelpDialogTitle';
import { normalizeFilter } from '@riosoma/ui';
import { faXmark, faPaperPlane, faBan, faCopy, faPlus } from '@fortawesome/free-solid-svg-icons';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { personLabel } from '../../../data/people';
import {
  DATABASE_ROLES,
  newId,
  DatabaseRole,
  type Grant,
  type Member,
  type Principal,
  type OrganizationGroup,
  InvitationEmail,
  type SharingAction,
  type SharingInvitations,
} from '@riosoma/contracts';
import {
  Avatar,
  PersonDirectory,
  Button,
  ComboBox,
  Dialog,
  DialogBody,
  ListBoxItem,
  Modal,
  Select,
  Spinner,
  Text,
  Tooltip,
  TooltipTrigger,
  TextField,
} from '@riosoma/ui';
import { api } from '../../../api';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { UnitFilter, unitMatcher, unitsQuery } from '../../settings/units/UnitFilter';
import { anchor, type AnchorProps } from '../../../demos/anchors';
import './ShareDialog.css';

export interface ShareDialogProps {
  databaseId: string;
  resourceKind?: 'database' | 'folder';
  databaseName: string;
  canManage: boolean;
  onClose: () => void;
}

function useRoleLabels() {
  const { t } = useLingui();
  return {
    owner: {
      name: t({ id: 'share.role.owner', message: 'Owner' }),
      detail: t({
        id: 'share.role.owner.detail',
        message: 'Can do everything, including sharing and deleting',
      }),
    },
    creator: {
      name: t({ id: 'share.role.creator', message: 'Creator' }),
      detail: t({ id: 'share.role.creator.detail', message: 'Can change tables, fields, and views' }),
    },
    editor: {
      name: t({ id: 'share.role.editor', message: 'Editor' }),
      detail: t({ id: 'share.role.editor.detail', message: 'Can add and change records' }),
    },
    commenter: {
      name: t({ id: 'share.role.commenter', message: 'Commenter' }),
      detail: t({ id: 'share.role.commenter.detail', message: 'Can view and comment' }),
    },
    reader: {
      name: t({ id: 'share.role.reader', message: 'Reader' }),
      detail: t({ id: 'share.role.reader.detail', message: 'Can view' }),
    },
  };
}

function RoleSelect({
  label,
  role,
  organization = false,
  disabled,
  onChange,
  anchorProps,
}: {
  label: string;
  role: DatabaseRole | null;
  organization?: boolean;
  disabled: boolean;
  onChange: (role: DatabaseRole | null) => void;
  /** Names the control for help */
  anchorProps?: AnchorProps;
}) {
  const { t } = useLingui();
  const roles = useRoleLabels();
  const options = DATABASE_ROLES.filter((role) => !organization || role !== 'owner').map((role) => ({
    id: role,
    ...roles[role],
  }));
  const items = organization
    ? [{ id: 'none', name: t({ id: 'share.noAccess', message: 'No access' }), detail: undefined }, ...options]
    : options;
  return (
    <Select
      {...anchorProps}
      aria-label={label}
      selectedKey={role ?? 'none'}
      isDisabled={disabled}
      isNonModal
      onSelectionChange={(key) => {
        if (key === 'none' && organization) onChange(null);
        else {
          const parsed = DatabaseRole.safeParse(key);
          if (parsed.success) onChange(parsed.data);
        }
      }}
    >
      {items.map((item) => (
        <ListBoxItem key={item.id} id={item.id} textValue={item.name} description={item.detail}>
          {item.name}
        </ListBoxItem>
      ))}
    </Select>
  );
}

/** Access a folder gives.  It changes with the folder's roles, so it can't be changed here. */
function InheritedGrant({ name, folder, role }: { name: string; folder: string | undefined; role: string }) {
  const { t } = useLingui();
  return (
    <li className="rio-share__row">
      <div className="rio-share__identity">
        <strong>{name}</strong>
        <Text>
          {folder === undefined
            ? t({ id: 'share.fromPrivateFolder', message: "From a folder you can't see" })
            : t({ id: 'share.fromFolder', message: `From the folder ${folder}` })}
        </Text>
      </div>
      <Text>{role}</Text>
    </li>
  );
}

export function ShareDialog({
  databaseId,
  databaseName,
  canManage,
  onClose,
  resourceKind = 'database',
}: ShareDialogProps) {
  const { t } = useLingui();
  const roles = useRoleLabels();
  const session = useSession();
  const demo = session?.demo === true;
  const directory = useContext(PersonDirectory);
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [unitFilter, setUnitFilter] = useState('all');
  const [newRole, setNewRole] = useState<DatabaseRole>('editor');
  const [invitationLink, setInvitationLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const grantsKey = [resourceKind === 'folder' ? 'folders' : 'databases', databaseId, 'grants'];
  const path = `/api/${resourceKind === 'folder' ? 'folders' : 'databases'}/${encodeURIComponent(databaseId)}/grants`;
  const grants = useQuery({ queryKey: grantsKey, queryFn: async () => (demo ? [] : api<Grant[]>(path)) });
  const invitationsKey = [...grantsKey, 'invitations'];
  const invitations = useQuery({
    queryKey: invitationsKey,
    queryFn: async (): Promise<SharingInvitations> =>
      demo
        ? {
            pending: [],
            allowed: false,
            refusal: null,
            administratorsOnly: false,
            domains: [],
            kind: 'member',
            mailAvailable: false,
          }
        : api<SharingInvitations>(path.replace(/grants$/, 'invitations')),
    enabled: canManage,
  });
  const invite = useMutation({
    mutationFn: (action: SharingAction) =>
      api<{ invitationLink?: string }>('/api/home/commands', {
        method: 'POST',
        body: { id: newId('command'), action },
      }),
    onSuccess: async (result) => {
      setSearch('');
      setSelectedPerson(null);
      setInvitationLink(
        result.invitationLink ? new URL(result.invitationLink, window.location.origin).href : null,
      );
      setCopied(false);
      setCopyFailed(false);
      await queryClient.invalidateQueries({ queryKey: invitationsKey });
    },
  });
  const members = useQuery({
    queryKey: ['org', 'members'],
    queryFn: async () => (demo ? [] : api<Member[]>('/api/org/members')),
    enabled: canManage,
  });
  const units = useQuery({ ...unitsQuery, enabled: canManage && Boolean(session?.hasUnits) });
  const groups = useQuery({
    queryKey: ['org', 'groups'],
    queryFn: async () => (demo ? [] : api<OrganizationGroup[]>('/api/org/groups')),
    enabled: canManage,
  });
  const change = useMutation({
    mutationFn: ({ principal, role }: { principal: Principal; role: DatabaseRole | null }) =>
      resourceKind === 'folder'
        ? api<void>('/api/home/commands', {
            method: 'POST',
            body: {
              id: newId('command'),
              action: { kind: 'folder.share', folderId: databaseId, principal, role },
            },
          })
        : api<void>(path, {
            method: role === null ? 'DELETE' : 'PUT',
            body: role === null ? { principal } : { principal, role },
          }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: grantsKey });
      await queryClient.invalidateQueries({ queryKey: ['home'] });
    },
  });
  const save = (principal: Principal, role: DatabaseRole | null) => {
    if (canManage && !change.isPending) change.mutate({ principal, role });
  };
  const orgGrant = grants.data?.find((grant) => grant.principal.kind === 'org' && !grant.inheritedFrom);
  const org = orgGrant?.principal.kind === 'org' ? orgGrant.principal.name : (session?.org.name ?? '');
  const everyone = t({ id: 'share.everyone', message: `Everyone in ${org}` });
  const needle = normalizeFilter(search.trim());
  const inUnit = unitMatcher(units.data, unitFilter);
  const candidates =
    members.data?.filter(
      (member) =>
        !member.deactivated &&
        inUnit(member.unitId) &&
        !grants.data?.some(
          (grant) =>
            !grant.inheritedFrom && grant.principal.kind === 'user' && grant.principal.id === member.id,
        ) &&
        normalizeFilter(`${member.name} ${member.email}`).includes(needle),
    ) ?? [];
  const name = databaseName;
  const removeLabel = (name: string) => t({ id: 'share.remove', message: `Remove ${name}` });
  const email = InvitationEmail.safeParse(search);
  const nonmember =
    search.includes('@') &&
    !members.data?.some((member) => member.email.toLowerCase() === search.trim().toLowerCase());
  const domains = invitations.data?.domains ?? [];
  const domainBlocked =
    email.success &&
    domains.length > 0 &&
    !domains.includes(email.data.slice(email.data.lastIndexOf('@') + 1));
  const resource = { kind: resourceKind, id: databaseId };
  const canInvite = nonmember && email.success && invitations.data?.allowed && !domainBlocked;
  const invitationHint = !nonmember
    ? undefined
    : !email.success
      ? t({ id: 'share.invite.invalidEmail', message: 'Enter a valid email address.' })
      : invitations.data && !invitations.data.allowed
        ? invitations.data.refusal === 'administratorsOnly'
          ? t({
              id: 'share.invite.administratorsOnly',
              message: 'Sharing with new people is limited to People administrators.',
            })
          : t({
              id: 'share.invite.membersOnly',
              message:
                'Sharing is limited to members.  A People administrator can invite people from the People page.',
            })
        : domainBlocked
          ? t({
              id: 'share.invite.domainHint',
              message: `Use an email address at an allowed domain: ${domains.join(', ')}.`,
            })
          : t({ id: 'share.invite.pending', message: 'Not a member yet, will be invited' });
  const sendInvite = () => {
    if (canInvite && email.success && !invite.isPending)
      invite.mutate({ kind: 'share.invite', resource, email: email.data, role: newRole });
  };
  const resendLabel = t({ id: 'share.invite.resend', message: 'Resend invitation' });
  const revokeLabel = t({ id: 'share.invite.revoke', message: 'Revoke invitation' });
  const copyLabel = t({ id: 'share.invite.copy', message: 'Copy invitation link' });

  return (
    <Modal
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="lg"
    >
      <Dialog>
        <HelpDialogTitle moduleId="sharing" section="adding-people" anchorId="share.dialog">
          <Trans id="share.title">Share {name}</Trans>
        </HelpDialogTitle>
        <DialogBody className="rio-share">
          <ErrorBanner error={errorInfo(grants.error)} />
          <ErrorBanner error={errorInfo(change.error)} />
          <ErrorBanner error={errorInfo(invite.error)} />
          {grants.isPending ? <Spinner /> : null}
          {grants.data ? (
            <>
              {canManage ? (
                <>
                  <ErrorBanner error={errorInfo(members.error)} />
                  <ErrorBanner error={errorInfo(invitations.error)} />
                  <UnitFilter value={unitFilter} onChange={setUnitFilter} />
                  <ComboBox
                    listId="share.people"
                    {...anchor('share.add')}
                    label={t({ id: 'share.add', message: 'Add people' })}
                    allowsCustomValue
                    description={email.success ? <span role="status">{invitationHint}</span> : undefined}
                    isInvalid={nonmember && !email.success}
                    errorMessage={nonmember && !email.success ? invitationHint : undefined}
                    inputValue={search}
                    onInputChange={(value) => {
                      setSearch(value);
                      setSelectedPerson(null);
                    }}
                    selectedKey={selectedPerson}
                    isDisabled={change.isPending || invite.isPending || !members.data}
                    onSelectionChange={(key) => {
                      if (key === '__invite') {
                        sendInvite();
                        return;
                      }
                      const member = candidates.find((member) => member.id === key);
                      if (member) {
                        setSelectedPerson(member.id);
                        setSearch('');
                        save({ kind: 'user', id: member.id }, 'editor');
                      }
                    }}
                  >
                    {canInvite && email.success ? (
                      <ListBoxItem
                        id="__invite"
                        textValue={email.data}
                        description={t({
                          id: 'share.invite.pending',
                          message: 'Not a member yet, will be invited',
                        })}
                      >
                        {email.data}
                      </ListBoxItem>
                    ) : null}
                    {candidates.map((member) => (
                      <ListBoxItem
                        key={member.id}
                        id={member.id}
                        textValue={`${member.name} ${member.email}`}
                        description={member.email}
                      >
                        {member.name || member.email}
                      </ListBoxItem>
                    ))}
                  </ComboBox>
                  {canInvite && email.success ? (
                    <div className="rio-share__row">
                      <strong className="rio-share__identity">{email.data}</strong>
                      <RoleSelect
                        label={t({ id: 'share.invite.access', message: 'Access for the invited person' })}
                        role={newRole}
                        disabled={invite.isPending}
                        onChange={(role) => {
                          if (role) setNewRole(role);
                        }}
                      />
                      <TooltipTrigger>
                        <Button
                          icon={faPlus}
                          aria-label={t({ id: 'share.invite.add', message: 'Invite and share' })}
                          variant="quiet"
                          isDisabled={invite.isPending}
                          onPress={sendInvite}
                        />
                        <Tooltip>
                          <Trans id="share.invite.add">Invite and share</Trans>
                        </Tooltip>
                      </TooltipTrigger>
                    </div>
                  ) : null}
                  {invitationLink ? (
                    <div className="rio-share__fallback" role="status">
                      <Text>
                        <Trans id="share.invite.noMail">
                          {'Email is not set up.  Copy this invitation link and send it to the person.'}
                        </Trans>
                      </Text>
                      <div className="rio-share__row">
                        <TextField
                          label={t({ id: 'share.invite.link', message: 'Invitation link' })}
                          value={invitationLink}
                          isReadOnly
                        />
                        <TooltipTrigger>
                          <Button
                            icon={faCopy}
                            variant="quiet"
                            aria-label={copyLabel}
                            onPress={() => {
                              setCopyFailed(false);
                              void Promise.resolve()
                                .then(() => navigator.clipboard.writeText(invitationLink))
                                .then(() => setCopied(true))
                                .catch(() => setCopyFailed(true));
                            }}
                          />
                          <Tooltip>{copyLabel}</Tooltip>
                        </TooltipTrigger>
                      </div>
                      {copied ? (
                        <Text>
                          <Trans id="share.invite.copied">Invitation link copied</Trans>
                        </Text>
                      ) : null}
                      {copyFailed ? (
                        <Text role="alert">
                          <Trans id="share.invite.copyFailed">
                            {'Select the invitation link and copy it.  Automatic copying is unavailable.'}
                          </Trans>
                        </Text>
                      ) : null}
                    </div>
                  ) : null}
                  {groups.data?.length ? (
                    <Select
                      label={t({ id: 'scim.shareGroup', message: 'Add a group' })}
                      selectedKey={null}
                      isDisabled={change.isPending}
                      onSelectionChange={(key) => {
                        if (typeof key === 'string') save({ kind: 'group', id: key }, 'reader');
                      }}
                    >
                      {groups.data
                        .filter(
                          (group) =>
                            !grants.data?.some(
                              (grant) =>
                                !grant.inheritedFrom &&
                                grant.principal.kind === 'group' &&
                                grant.principal.id === group.id,
                            ),
                        )
                        .map((group) => (
                          <ListBoxItem id={group.id} key={group.id}>
                            {group.name}
                          </ListBoxItem>
                        ))}
                    </Select>
                  ) : null}
                </>
              ) : null}
              <ul className="rio-share__list" {...anchor('share.people')}>
                {invitations.data?.pending?.map((person) => (
                  <li className="rio-share__row" key={person.id}>
                    <div className="rio-share__identity">
                      <strong>{person.email}</strong>
                      <Text>
                        <Trans id="share.invite.invited">Invited</Trans>
                      </Text>
                    </div>
                    <RoleSelect
                      label={person.email}
                      role={person.role}
                      disabled={invite.isPending}
                      onChange={(role) => {
                        if (role)
                          invite.mutate({ kind: 'share.invite', resource, email: person.email, role });
                      }}
                    />
                    <TooltipTrigger>
                      <Button
                        icon={faPaperPlane}
                        variant="quiet"
                        aria-label={resendLabel}
                        isDisabled={invite.isPending}
                        onPress={() =>
                          invite.mutate({ kind: 'share.resend', resource, invitationId: person.id })
                        }
                      />
                      <Tooltip>{resendLabel}</Tooltip>
                    </TooltipTrigger>
                    <TooltipTrigger>
                      <Button
                        icon={faBan}
                        variant="quiet"
                        aria-label={revokeLabel}
                        isDisabled={invite.isPending}
                        onPress={() => {
                          setInvitationLink(null);
                          invite.mutate({ kind: 'share.revoke', resource, invitationId: person.id });
                        }}
                      />
                      <Tooltip>{revokeLabel}</Tooltip>
                    </TooltipTrigger>
                  </li>
                ))}
                {grants.data.map(({ principal, role, inheritedFrom }, index) =>
                  inheritedFrom ? (
                    <InheritedGrant
                      key={`${inheritedFrom.id ?? index}:${principal.kind}:${'id' in principal ? principal.id : 'org'}`}
                      name={
                        principal.kind === 'user'
                          ? personLabel(directory.get(principal.id), principal.name)
                          : principal.name
                      }
                      folder={inheritedFrom.name}
                      role={roles[role].name}
                    />
                  ) : principal.kind === 'user' ? (
                    <li className="rio-share__row" key={principal.id}>
                      <Avatar personId={principal.id} name={principal.name || principal.email} color="blue" />
                      <div className="rio-share__identity">
                        <strong>
                          {personLabel(directory.get(principal.id), principal.name || principal.email)}
                        </strong>
                        <Text>{directory.get(principal.id)?.email ?? principal.email}</Text>
                      </div>
                      {canManage ? (
                        <>
                          <RoleSelect
                            label={`${principal.name} (${principal.email})`}
                            role={role}
                            disabled={change.isPending}
                            anchorProps={anchor('share.role')}
                            onChange={(role) => save({ kind: 'user', id: principal.id }, role)}
                          />
                          <TooltipTrigger>
                            <Button
                              variant="quiet"
                              icon={faXmark}
                              aria-label={removeLabel(principal.name || principal.email)}
                              isDisabled={change.isPending}
                              onPress={() => save({ kind: 'user', id: principal.id }, null)}
                            />
                            <Tooltip>{removeLabel(principal.name || principal.email)}</Tooltip>
                          </TooltipTrigger>
                        </>
                      ) : (
                        <Text>{roles[role].name}</Text>
                      )}
                    </li>
                  ) : principal.kind === 'group' ? (
                    <li className="rio-share__row" key={principal.id}>
                      <strong className="rio-share__identity">{principal.name}</strong>
                      {canManage ? (
                        <>
                          <RoleSelect
                            label={principal.name}
                            role={role}
                            disabled={change.isPending}
                            onChange={(next) => save({ kind: 'group', id: principal.id }, next)}
                          />
                          <Button
                            variant="quiet"
                            icon={faXmark}
                            aria-label={removeLabel(principal.name)}
                            isDisabled={change.isPending}
                            onPress={() => save({ kind: 'group', id: principal.id }, null)}
                          />
                        </>
                      ) : (
                        <Text>{roles[role].name}</Text>
                      )}
                    </li>
                  ) : null,
                )}
                <li className="rio-share__row">
                  <strong className="rio-share__identity">{everyone}</strong>
                  {canManage ? (
                    <RoleSelect
                      label={everyone}
                      role={orgGrant?.role ?? null}
                      organization
                      anchorProps={anchor('share.everyone')}
                      disabled={change.isPending}
                      onChange={(role) => save({ kind: 'org' }, role)}
                    />
                  ) : (
                    <Text>
                      {orgGrant
                        ? roles[orgGrant.role].name
                        : t({ id: 'share.noAccess', message: 'No access' })}
                    </Text>
                  )}
                </li>
              </ul>
            </>
          ) : null}
        </DialogBody>
      </Dialog>
    </Modal>
  );
}
