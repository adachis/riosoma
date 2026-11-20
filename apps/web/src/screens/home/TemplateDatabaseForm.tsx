import { Trans, useLingui } from '@lingui/react/macro';
import { LIMITS, newId, type DatabaseSchema } from '@riosoma/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Banner, Button, DialogBody, DialogFooter, TextField } from '@riosoma/ui';
import { useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import { useCelebrations } from '../../features/celebrations/useCelebrations';
import type { TemplateSummary } from './TemplatePicker';
import { databaseCreationFolder, fileCreatedDatabase } from './folders';

export function TemplateDatabaseForm({
  template,
  onClose,
  onPendingChange,
}: {
  template: TemplateSummary;
  onClose(): void;
  onPendingChange(pending: boolean): void;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(template.name);
  const [id] = useState(() => newId('database'));
  const [created, setCreated] = useState<DatabaseSchema | null>(null);
  const destination = useRef<{ folderId: string | null } | null>(null);
  const submitting = useRef(false);
  const { observe } = useCelebrations();
  const create = useMutation({
    mutationFn: async (folderId: string | null) => {
      const schema =
        created ??
        (await api<DatabaseSchema>('/api/databases/from-template', {
          method: 'POST',
          body: { id, templateId: template.id, name: name.trim() },
        }));
      // A filing failure must retry the saved database with its original name and destination.
      setCreated(schema);
      await fileCreatedDatabase(schema.database.id, folderId);
      return schema;
    },
    onSuccess: async (schema) => {
      // A database made from a template is the person's own, so its tables can be their first.
      if (schema.tables?.length) observe('firstTable', 'you', true);
      void queryClient.invalidateQueries({ queryKey: ['databases'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      onClose();
      void navigate({ to: `/${schema.database.id}` });
    },
    onSettled: () => {
      submitting.current = false;
      onPendingChange(false);
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (submitting.current || !name.trim()) return;
        submitting.current = true;
        destination.current ??= { folderId: databaseCreationFolder() };
        onPendingChange(true);
        create.mutate(destination.current.folderId);
      }}
    >
      <DialogBody className="rio-new-database__fields">
        <TextField
          label={t({ id: 'home.dialog.name', message: 'Name' })}
          value={name}
          onChange={setName}
          maxLength={LIMITS.nameLength}
          isRequired
          isDisabled={create.isPending}
          isReadOnly={created !== null}
        />
        {create.isPending ? (
          <p role="status">{t({ id: 'home.template.creating', message: `Creating ${name}` })}</p>
        ) : null}
        {create.error ? (
          <Banner tone="danger">
            {message(
              create.error instanceof ApiError ? create.error.info.messageKey : 'errors.internal',
              create.error instanceof ApiError ? create.error.info.params : undefined,
            )}
          </Banner>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button onPress={onClose} isDisabled={create.isPending}>
          <Trans id="home.dialog.cancel">Cancel</Trans>
        </Button>
        <Button type="submit" variant="primary" isPending={create.isPending} isDisabled={!name.trim()}>
          <Trans id="home.dialog.create">Create</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
