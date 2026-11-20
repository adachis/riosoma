import { faPen } from '@fortawesome/free-solid-svg-icons';
import { useSettingsSection, useSettingsDraft, useSettingsLeaveGuard } from '../SettingsDraft';
import { Trans, useLingui } from '@lingui/react/macro';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  DATABASE_ROLES,
  type AccessLoss,
  type DatabaseRole,
  type OrganizationFolder,
  type OrganizationGroup,
} from '@riosoma/contracts';
import {
  Button,
  Checkbox,
  FilterableList,
  ConfirmDialog,
  Form,
  Heading,
  ListBoxItem,
  Select,
  TextField,
} from '@riosoma/ui';
import { api, ApiError } from '../../../api';
import { databasesQuery } from '../../../data/databases';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import '../scim/scim.css';

export const organizationFoldersQuery = queryOptions({
  queryKey: ['org', 'folders'],
  queryFn: () => api<OrganizationFolder[]>('/api/org/folders'),
});

export const organizationGroupsQuery = queryOptions({
  queryKey: ['org', 'groups'],
  queryFn: () => api<OrganizationGroup[]>('/api/org/groups'),
});

/**
 * Folders and their group roles.  A unit's People admin sees only the folders people in their
 * units own, and can change those but not make new ones, which are the organization's.
 */
export function FolderSettings({ canCreate = true }: { canCreate?: boolean }) {
  const { t } = useLingui();
  const cache = useQueryClient();
  const requestLeave = useSettingsLeaveGuard();
  const [losses, setLosses] = useState<AccessLoss[] | null>(null);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const folders = useQuery(organizationFoldersQuery);
  const databases = useQuery(databasesQuery);
  const groups = useQuery(organizationGroupsQuery);
  const refresh = () => cache.invalidateQueries({ queryKey: ['org', 'folders'] });
  const save = useMutation({
    mutationFn: (confirmedLosses: string[] = []) =>
      api(`/api/org/folders${editing ? `/${encodeURIComponent(editing)}` : ''}`, {
        method: editing ? 'PUT' : 'POST',
        body: { name, databases: chosen, confirmedLosses },
      }),
    onError: (error) => {
      if (
        error instanceof ApiError &&
        error.info.messageKey === 'home.folders.confirmLoss' &&
        typeof error.info.params?.losses === 'string'
      ) {
        const people: unknown = JSON.parse(error.info.params.losses);
        if (
          Array.isArray(people) &&
          people.every((person) => typeof person?.id === 'string' && typeof person?.name === 'string')
        )
          setLosses(people as AccessLoss[]);
      }
    },
    onSuccess: () => {
      setLosses(null);
      setConfirmed([]);
      setName('');
      setChosen([]);
      setEditing(null);
      return refresh();
    },
  });
  const grant = useMutation({
    mutationFn: ({
      folderId,
      groupId,
      role,
    }: {
      folderId: string;
      groupId: string;
      role: DatabaseRole | null;
    }) =>
      api(`/api/org/folders/${encodeURIComponent(folderId)}/grants`, {
        method: 'PUT',
        body: { groupId, role },
      }),
    onSuccess: refresh,
  });
  const grants = useSettingsDraft(folders.data ?? [], async (values) => {
    for (const folder of values) {
      const before = folders.data?.find((entry) => entry.id === folder.id);
      const groupIds = new Set([
        ...(before?.grants ?? []).map((entry) => entry.groupId),
        ...folder.grants.map((entry) => entry.groupId),
      ]);
      for (const groupId of groupIds) {
        const role = folder.grants.find((entry) => entry.groupId === groupId)?.role ?? null;
        if (role !== (before?.grants.find((entry) => entry.groupId === groupId)?.role ?? null))
          await grant.mutateAsync({ folderId: folder.id, groupId, role });
      }
    }
  });
  const stored = folders.data?.find((folder) => folder.id === editing);
  const [validated, setValidated] = useState(false);
  const pageDraft = useSettingsSection({
    dirty:
      name !== (stored?.name ?? '') ||
      JSON.stringify([...chosen].sort()) !== JSON.stringify([...(stored?.databases ?? [])].sort()),
    stored,
    discard: () => {
      setValidated(false);
      setName(stored?.name ?? '');
      setChosen(stored?.databases ?? []);
      setLosses(null);
      setConfirmed([]);
    },
    validate: () => {
      setValidated(true);
      return name.trim() ? null : t({ id: 'scim.folderNameRequired', message: 'Enter a folder name.' });
    },
    save: () => save.mutateAsync(confirmed),
  });
  const labels: Record<DatabaseRole, string> = {
    owner: t({ id: 'share.role.owner', message: 'Owner' }),
    creator: t({ id: 'share.role.creator', message: 'Creator' }),
    editor: t({ id: 'share.role.editor', message: 'Editor' }),
    commenter: t({ id: 'share.role.commenter', message: 'Commenter' }),
    reader: t({ id: 'share.role.reader', message: 'Reader' }),
  };
  return (
    <section className="rio-scim">
      <Heading level={2}>
        <Trans id="scim.folders">Folders and group roles</Trans>
      </Heading>
      <p>
        <Trans id="scim.folders.help">
          {
            'A folder’s group roles apply to every database in it.  You can include only databases whose sharing you manage.  Each database belongs to at most one folder.  Only a folder’s owners can change its group roles.'
          }
        </Trans>
      </p>
      <ErrorBanner
        error={errorInfo(folders.error ?? databases.error ?? groups.error ?? save.error ?? grant.error)}
      />
      {canCreate || editing ? (
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            setConfirmed([]);
            void pageDraft.save?.();
          }}
        >
          <TextField
            label={t({ id: 'scim.folderName', message: 'Folder name' })}
            value={name}
            onChange={setName}
            isRequired
            maxLength={120}
            isInvalid={(validated || Boolean(name)) && !name.trim()}
            errorMessage={t({ id: 'scim.folderNameRequired', message: 'Enter a folder name.' })}
          />
          {(databases.data?.length ?? 0) > 10 ? (
            <FilterableList
              label={t({ id: 'scim.folderDatabases', message: 'Databases in this folder' })}
              listId="settings.folder.databases"
              items={(databases.data ?? []).filter((database) => database.role === 'owner')}
              selectionMode="multiple"
              selectedKeys={chosen}
              onSelectionChange={(keys) => setChosen([...keys].map(String))}
            />
          ) : (
            databases.data
              ?.filter((database) => database.role === 'owner')
              .map((database) => (
                <Checkbox
                  key={database.id}
                  isSelected={chosen.includes(database.id)}
                  onChange={(checked) =>
                    setChosen((current) =>
                      checked ? [...current, database.id] : current.filter((id) => id !== database.id),
                    )
                  }
                >
                  {database.name}
                </Checkbox>
              ))
          )}

          {editing ? (
            <Button
              onPress={() => {
                setEditing(null);
                setName('');
                setChosen([]);
              }}
            >
              <Trans id="scim.folderCancel">Cancel editing</Trans>
            </Button>
          ) : null}
        </Form>
      ) : null}
      <ul className="rio-scim__list">
        {grants.value.map((folder) => (
          <li key={folder.id}>
            <strong>{folder.name}</strong>
            <span>
              {folder.databases
                .map((id) => databases.data?.find((database) => database.id === id)?.name ?? id)
                .join(', ')}
            </span>
            <Button
              onPress={() => {
                void requestLeave().then((accepted) => {
                  if (accepted) {
                    setEditing(folder.id);
                    setName(folder.name);
                    setChosen(folder.databases);
                  }
                });
              }}
              aria-label={t({ id: 'scim.folderEdit', message: 'Edit folder' })}
              icon={faPen}
            />
            {groups.data?.map((group) => (
              <Select
                key={group.id}
                label={group.name}
                selectedKey={folder.grants.find((entry) => entry.groupId === group.id)?.role ?? 'none'}
                isDisabled={grant.isPending || !folder.canGrant}
                onSelectionChange={(key) => {
                  if (key === 'none' || DATABASE_ROLES.includes(key as DatabaseRole))
                    grants.setValue((current) =>
                      current.map((entry) =>
                        entry.id !== folder.id
                          ? entry
                          : {
                              ...entry,
                              grants: [
                                ...entry.grants.filter((grant) => grant.groupId !== group.id),
                                ...(key === 'none' ? [] : [{ groupId: group.id, role: key as DatabaseRole }]),
                              ],
                            },
                      ),
                    );
                }}
              >
                <ListBoxItem id="none">
                  <Trans id="share.noAccess">No access</Trans>
                </ListBoxItem>
                {DATABASE_ROLES.map((role) => (
                  <ListBoxItem key={role} id={role}>
                    {labels[role]}
                  </ListBoxItem>
                ))}
              </Select>
            ))}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        isOpen={Boolean(losses)}
        onOpenChange={(open) => {
          if (!open) setLosses(null);
        }}
        title={t({ id: 'home.folders.confirmMove', message: 'Confirm move' })}
        message={t({
          id: 'home.folders.adminLosses',
          message: `These people will lose access or have a lower role: ${[...new Set(losses?.map((person) => person.name))].join(', ')}`,
        })}
        confirmLabel={t({ id: 'home.folders.confirmMove', message: 'Confirm move' })}
        onConfirm={async () => {
          const next = [...confirmed, ...(losses?.map((person) => person.id) ?? [])];
          setConfirmed(next);
          setLosses(null);
          try {
            await save.mutateAsync(next);
          } catch {
            /* A later move may need another access review. */
          }
        }}
      />
    </section>
  );
}
