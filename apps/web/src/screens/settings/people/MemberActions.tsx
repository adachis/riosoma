import { useRef, useState, type RefObject } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { faEllipsis } from '@fortawesome/free-solid-svg-icons';
import {
  MEMBER_KINDS,
  type Member,
  type MemberKind,
  type OrganizationCommandResult,
  type SecondStepProof,
} from '@riosoma/contracts';
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  ListBoxItem,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  Select,
  TextField,
  Tooltip,
  TooltipTrigger,
  toast,
} from '@riosoma/ui';
import { api } from '../../../api';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { useServerMessage } from '../../../messages/useServerMessage';
import { ProofForm, proofMethods } from '../../mfa/ProofDialog';
import { mfaOverviewQuery } from '../../mfa/overview';
import { setAdminSearch, useAdminSearch } from '../admin-search';
import { AccountSecurityActions } from './AccountSecurityActions';
import { canRemoveAccount, RemoveAccount } from './RemoveAccount';
import { canResetSecondSteps, ResetSecondSteps } from './ResetSecondSteps';

export function MemberActions({
  member,
  lastOwner = member.lastOwner ?? false,
  resetAllowed,
}: {
  member: Member;
  lastOwner?: boolean;
  resetAllowed?: boolean;
}) {
  const { t } = useLingui();
  const session = useSession();
  const noticeRef = useRef<string | null>(null);
  const search = useAdminSearch();
  const action = search.get('person') === member.id ? search.get('action') : null;
  const owner = session?.membership.kind === 'owner';
  const name = member.name || member.email;
  const more = t({ id: 'people.actions.named', message: `Actions for ${name}` });
  const close = () => setAdminSearch({ person: undefined, action: undefined });
  const open = (action: string) => setAdminSearch({ person: member.id, action });
  const account = !member.deactivated && (member.kind !== 'owner' || owner);
  const reset = resetAllowed ?? canResetSecondSteps(session, member);
  // Each item declares its label and action in one place, so another account action is one entry.
  const items = [
    { id: 'role', label: t({ id: 'people.actions.role', message: 'Change role' }), show: true },
    {
      id: member.deactivated ? 'reactivate' : 'deactivate',
      label: member.deactivated
        ? t({ id: 'people.actions.reactivate', message: 'Reactivate' })
        : t({ id: 'people.actions.deactivate', message: 'Deactivate' }),
      show: true,
    },
    {
      id: 'make-owner',
      label: t({ id: 'people.actions.makeOwner', message: 'Make owner' }),
      show: owner && member.kind !== 'owner',
    },
    {
      id: 'transfer',
      label: t({ id: 'people.actions.transfer', message: 'Transfer ownership' }),
      show: owner && member.id !== session?.user.id,
    },
    {
      id: 'admin-roles',
      label: t({ id: 'adminRoles.title', message: 'Admin roles' }),
      show: owner && member.kind === 'member',
    },
    {
      id: 'password-reset',
      label: t({ id: 'auth.reset.admin', message: 'Reset password' }),
      show: account && member.id !== session?.user.id,
    },
    {
      id: 'sessions',
      label: t({ id: 'auth.sessions.adminEnd', message: 'End all sessions' }),
      show: account,
    },
    { id: 'reset', label: t({ id: 'mfa.people.reset', message: 'Reset second steps' }), show: reset },
    {
      id: 'remove',
      label: t({ id: 'people.remove', message: 'Remove account' }),
      show: canRemoveAccount(session, member),
    },
  ].filter((item) => item.show);
  if (!session || member.canManage === false) return null;
  return (
    <>
      <MenuTrigger>
        <TooltipTrigger>
          <Button variant="quiet" size="sm" icon={faEllipsis} aria-label={more} />
          <Tooltip>{more}</Tooltip>
        </TooltipTrigger>
        <Menu
          aria-label={more}
          onAction={(id) =>
            ['password-reset', 'sessions'].includes(String(id))
              ? setAdminSearch({
                  member: member.id,
                  'account-action': String(id),
                  person: undefined,
                  action: undefined,
                })
              : id === 'admin-roles'
                ? setAdminSearch({ member: member.id, person: undefined, action: undefined })
                : open(String(id))
          }
        >
          {items.map((item) => (
            <MenuItem key={item.id} id={item.id} textValue={item.label}>
              {item.label}
            </MenuItem>
          ))}
        </Menu>
      </MenuTrigger>
      <AccountSecurityActions member={member} menu />
      {action === 'reset' && reset ? <ResetSecondSteps member={member} open onClose={close} /> : null}
      {action === 'remove' && canRemoveAccount(session, member) ? (
        <RemoveAccount member={member} open onClose={close} />
      ) : null}
      {['role', 'make-owner', 'deactivate', 'reactivate', 'transfer'].includes(action ?? '') ? (
        <MemberActionDialog
          key={`${member.id}-${action}`}
          member={member}
          action={action!}
          lastOwner={lastOwner}
          onClose={close}
          noticeRef={noticeRef}
        />
      ) : null}
    </>
  );
}

function MemberActionDialog({
  member,
  action,
  lastOwner,
  onClose,
  noticeRef,
}: {
  member: Member;
  action: string;
  lastOwner: boolean;
  onClose(): void;
  noticeRef: RefObject<string | null>;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const session = useSession();
  const cache = useQueryClient();
  const [role, setRole] = useState<MemberKind>(action === 'make-owner' ? 'owner' : member.kind);
  const [password, setPassword] = useState('');
  const overview = useQuery({ ...mfaOverviewQuery, enabled: action === 'transfer' });
  const roles = {
    owner: t({ id: 'people.kind.owner', message: 'Owner' }),
    member: t({ id: 'people.kind.member', message: 'Member' }),
    guest: t({ id: 'people.kind.guest', message: 'Guest' }),
  };
  const labels = {
    role: t({ id: 'people.actions.role', message: 'Change role' }),
    'make-owner': t({ id: 'people.actions.makeOwner', message: 'Make owner' }),
    deactivate: t({ id: 'people.actions.deactivate', message: 'Deactivate' }),
    reactivate: t({ id: 'people.actions.reactivate', message: 'Reactivate' }),
    transfer: t({ id: 'people.actions.transfer', message: 'Transfer ownership' }),
  };
  const name = member.name || member.email;
  const title = t({
    id: 'people.actions.title',
    message: `${labels[action as keyof typeof labels]}: ${name}`,
  });
  const roleChange = action === 'role' || action === 'make-owner';
  const owner = session?.membership.kind === 'owner';
  const guard =
    action === 'transfer' && member.id === session?.user.id
      ? 'people.guard.transferSelf'
      : member.managed
        ? 'people.guard.directory'
        : lastOwner && (action === 'deactivate' || (roleChange && role !== 'owner'))
          ? 'people.guard.lastOwner'
          : (member.kind === 'owner' || (roleChange && role === 'owner')) && !owner
            ? 'people.guard.ownerReach'
            : member.deactivated && ((roleChange && role === 'owner') || action === 'transfer')
              ? 'people.guard.inactiveOwner'
              : roleChange &&
                  role === 'guest' &&
                  (member.guestRoleBlocked || (member.adminRoles.length > 0 && !owner))
                ? 'people.guard.adminGuest'
                : null;
  const statements = {
    owner: t({
      id: 'people.role.ownerHelp',
      message: 'Owners manage the organization and all administration areas.',
    }),
    member: t({
      id: 'people.role.memberHelp',
      message:
        'Members can use resources shared with the organization and keep their assigned administration areas.',
    }),
    guest: t({
      id: 'people.role.guestHelp',
      message:
        'Guests can use only resources shared with them by name and cannot administer the organization.',
    }),
  };
  const body = roleChange
    ? statements[role]
    : action === 'deactivate'
      ? t({
          id: 'people.deactivate.body',
          message:
            'Their sessions, API tokens, and connected apps stop working immediately.  Their shares, records, comments, and history stay.  Their automations keep running, with a notice to administrators.',
        })
      : action === 'reactivate'
        ? t({
            id: 'people.reactivate.body',
            message: 'They can sign in again.  Ended sessions, tokens, and connected apps stay ended.',
          })
        : t({
            id: 'people.transfer.body',
            message:
              'They become an owner, and you become a Member in one step.  Confirm with your password or a second step.  This cannot be undone.',
          });
  const refresh = () =>
    Promise.all([
      cache.invalidateQueries({ queryKey: ['org'] }),
      cache.invalidateQueries({ queryKey: ['session'] }),
    ]);
  const run = useMutation({
    mutationFn: (proof?: SecondStepProof) =>
      action === 'transfer'
        ? api<OrganizationCommandResult>(
            `/api/org/members/${encodeURIComponent(member.id)}/transfer-ownership`,
            { body: proof ? { proof } : { password } },
          )
        : api<OrganizationCommandResult>(
            `/api/org/members/${encodeURIComponent(member.id)}/${roleChange ? 'role' : 'status'}`,
            {
              method: 'PATCH',
              body: roleChange ? { role } : { deactivated: action === 'deactivate' },
            },
          ),
    onSuccess: async (result) => {
      if (noticeRef.current !== null) toast.dismiss(noticeRef.current);
      noticeRef.current = null;
      onClose();
      await refresh();
      noticeRef.current = toast.show({
        tone: 'success',
        title: t({ id: 'people.actions.saved', message: `Updated access for ${name}` }),
        ...(result.undoable
          ? {
              timeout: 0,
              action: {
                label: t({ id: 'people.actions.undo', message: 'Undo' }),
                onPress: () => {
                  void api(`/api/org/members/${encodeURIComponent(member.id)}/undo`, {
                    body: { eventId: result.eventId },
                  })
                    .then(refresh)
                    .catch((error: unknown) => {
                      const info = errorInfo(error);
                      toast.show({
                        tone: 'danger',
                        title: message(info?.key ?? 'errors.internal', info?.params),
                      });
                    });
                },
              },
            }
          : {}),
      });
    },
  });
  return (
    <Modal
      isOpen
      size="sm"
      isDismissable={!run.isPending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>{title}</DialogTitle>
        <DialogBody>
          {guard ? <p role="status">{message(guard)}</p> : null}
          {roleChange && action !== 'make-owner' ? (
            <Select
              label={t({ id: 'people.role.label', message: 'Role' })}
              selectedKey={role}
              onSelectionChange={(key) => {
                if (MEMBER_KINDS.includes(key as MemberKind)) setRole(key as MemberKind);
              }}
            >
              {MEMBER_KINDS.map((kind) => (
                <ListBoxItem key={kind} id={kind}>
                  {roles[kind]}
                </ListBoxItem>
              ))}
            </Select>
          ) : null}
          {action === 'transfer' && overview.data && proofMethods(overview.data).length && !guard ? (
            <ProofForm
              message={body}
              confirmLabel={labels.transfer}
              overview={overview.data}
              onProof={(proof) => run.mutateAsync(proof)}
              onCancel={onClose}
            />
          ) : (
            <>
              <p>{body}</p>
              {action === 'transfer' ? (
                <TextField
                  type="password"
                  autoComplete="current-password"
                  label={t({ id: 'people.transfer.password', message: 'Current password' })}
                  value={password}
                  onChange={setPassword}
                />
              ) : null}
            </>
          )}
          <ErrorBanner error={errorInfo(run.error ?? overview.error)} />
        </DialogBody>
        {!(action === 'transfer' && overview.data && proofMethods(overview.data).length && !guard) ? (
          <DialogFooter>
            <Button onPress={onClose} isDisabled={run.isPending}>
              {t({ id: 'ui.confirm.cancel', message: 'Cancel' })}
            </Button>
            <Button
              variant={action === 'deactivate' ? 'danger' : 'primary'}
              isPending={run.isPending}
              isDisabled={
                Boolean(guard) ||
                (roleChange && role === member.kind) ||
                (action === 'transfer' && (!password || overview.isPending))
              }
              onPress={() => run.mutate(undefined)}
            >
              {labels[action as keyof typeof labels]}
            </Button>
          </DialogFooter>
        ) : null}
      </Dialog>
    </Modal>
  );
}
