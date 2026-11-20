import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { RecordLockPolicy, type FieldMeta, type TableMeta } from '@riosoma/contracts';
import { Banner, Button, ListBoxItem, Select, TextField } from '@riosoma/ui';
import type { DatabaseSession } from '../../../data';
import { FilterEditor } from '../view/FilterEditor';

export function RecordLockSettings({
  session,
  table,
  fields,
}: {
  session: DatabaseSession;
  table: TableMeta;
  fields: readonly FieldMeta[];
}) {
  const { t } = useLingui();
  const [policy, setPolicy] = useState(() => RecordLockPolicy.parse(table.recordLock ?? {}));
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <section className="rio-permissions__section">
      <h3>{t({ id: 'locks.table.title', message: 'Record locks' })}</h3>
      <p>
        {t({
          id: 'locks.table.help',
          message:
            'Matching records cannot be edited or trashed.  Clear the condition to stop automatic locking.',
        })}
      </p>
      <FilterEditor
        session={session}
        fields={fields}
        value={policy.condition}
        onChange={(condition) => setPolicy({ ...policy, condition })}
        readOnly={pending}
        readOnlyReason={t({ id: 'locks.saving', message: 'Record lock settings are being saved.' })}
      />
      <TextField
        label={t({ id: 'locks.reason', message: 'Lock reason' })}
        value={policy.reason}
        onChange={(reason) => setPolicy({ ...policy, reason })}
      />
      <Select
        label={t({ id: 'locks.bypass', message: 'Who can change locked records' })}
        selectedKey={policy.bypass}
        onSelectionChange={(key) => setPolicy({ ...policy, bypass: key as RecordLockPolicy['bypass'] })}
      >
        <ListBoxItem id="owners">{t({ id: 'locks.owners', message: 'Owners only' })}</ListBoxItem>
        <ListBoxItem id="creators">{t({ id: 'locks.creators', message: 'Owners and creators' })}</ListBoxItem>
        <ListBoxItem id="nobody">{t({ id: 'locks.nobody', message: 'Nobody' })}</ListBoxItem>
      </Select>
      {failed && (
        <Banner tone="danger">
          {t({
            id: 'locks.saveFailed',
            message: 'The lock settings could not be saved.  Review the condition and try again.',
          })}
        </Banner>
      )}
      <Button
        isDisabled={pending}
        onPress={() => {
          setPending(true);
          setFailed(false);
          void session
            .run([{ kind: 'table.update', tableId: table.id, recordLock: policy }])
            .done.then((result) => setFailed(Boolean(result.rejected)))
            .catch(() => setFailed(true))
            .finally(() => setPending(false));
        }}
      >
        {t({ id: 'locks.save', message: 'Apply record locks' })}
      </Button>
    </section>
  );
}
