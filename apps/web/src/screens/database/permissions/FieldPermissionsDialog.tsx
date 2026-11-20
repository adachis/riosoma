import { useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Collaborator, FieldMeta, PermissionAudience } from '@riosoma/contracts';
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Modal,
  Spinner,
  Switch,
  Text,
} from '@riosoma/ui';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { AudiencePicker } from './AudiencePicker';
import { emptyAudience, permissionsKey, saveFieldPermissions, useTablePermissions } from './api';
import './permissions.css';

export interface FieldPermissionsDialogProps {
  field: FieldMeta;
  collaborators: ReadonlyMap<string, Collaborator>;
  onClose(): void;
}

/**
 * Who can see a field and who can change its values.  Opened from the field's menu by people who
 * can change the schema.  Saving reloads every open tab of the database, since what people may see
 * has changed.
 */
export function FieldPermissionsDialog({ field, collaborators, onClose }: FieldPermissionsDialogProps) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const current = useTablePermissions(field.tableId);
  const stored = current.data?.fields.find((rules) => rules.fieldId === field.id);
  const [draft, setDraft] = useState<{
    restricted: PermissionAudience | null;
    locked: PermissionAudience | null;
  } | null>(null);
  const value = draft ?? { restricted: stored?.restricted ?? null, locked: stored?.locked ?? null };
  const save = useMutation({
    mutationFn: () => saveFieldPermissions(field.id, value),
    onSuccess: async (saved) => {
      queryClient.setQueryData(permissionsKey(field.tableId), saved);
      onClose();
    },
  });
  const name = field.name;
  const set = (next: Partial<typeof value>) => setDraft({ ...value, ...next });
  return (
    <Modal
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>{t({ id: 'permissions.field.title', message: `Permissions for ${name}` })}</DialogTitle>
        <DialogBody className="rio-permissions">
          <ErrorBanner error={errorInfo(current.error)} />
          <ErrorBanner error={errorInfo(save.error)} />
          {current.isPending ? <Spinner /> : null}
          {current.data ? (
            <>
              <Text>
                {t({
                  id: 'permissions.field.owners',
                  message: 'The database’s owners always see and change every field.',
                })}
              </Text>
              <section className="rio-permissions__section">
                <Switch
                  isSelected={value.restricted !== null}
                  onChange={(on) => set({ restricted: on ? emptyAudience() : null })}
                  description={t({
                    id: 'permissions.field.restrictHelp',
                    message:
                      'Everyone else never receives its values or its name, nor anything computed from it, such as a formula, lookup, or rollup that uses it.',
                  })}
                >
                  {t({ id: 'permissions.field.restrict', message: 'Restrict who can see this field' })}
                </Switch>
                {value.restricted ? (
                  <AudiencePicker
                    label={t({ id: 'permissions.field.seeWho', message: 'Who can see this field' })}
                    value={value.restricted}
                    collaborators={collaborators}
                    onChange={(restricted) => set({ restricted })}
                  />
                ) : null}
              </section>
              <section className="rio-permissions__section">
                <Switch
                  isSelected={value.locked !== null}
                  onChange={(on) => set({ locked: on ? emptyAudience() : null })}
                  description={t({
                    id: 'permissions.field.lockHelp',
                    message:
                      'Everyone who can see it still sees its values, but only these people change them.',
                  })}
                >
                  {t({ id: 'permissions.field.lock', message: 'Lock who can change its values' })}
                </Switch>
                {value.locked ? (
                  <AudiencePicker
                    label={t({ id: 'permissions.field.changeWho', message: 'Who can change its values' })}
                    value={value.locked}
                    collaborators={collaborators}
                    onChange={(locked) => set({ locked })}
                  />
                ) : null}
              </section>
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button isDisabled={save.isPending} onPress={onClose}>
            {t({ id: 'permissions.cancel', message: 'Cancel' })}
          </Button>
          <Button
            variant="primary"
            isDisabled={!current.data || save.isPending}
            isPending={save.isPending}
            onPress={() => save.mutate()}
          >
            {t({ id: 'permissions.save', message: 'Save' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
