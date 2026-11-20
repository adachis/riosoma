import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { checkComputedOverride, type FieldMeta, type RowData } from '@riosoma/contracts';
import { Button, TextField } from '@riosoma/ui';
import type { DatabaseSession } from '../../../data';
import { reportError } from '../../../grid/view/actions';

export function ComputedPin({
  field,
  row,
  session,
}: {
  field: FieldMeta;
  row: RowData;
  session: DatabaseSession;
}) {
  const { t } = useLingui();
  const value = row.values[field.id] ?? null;
  const [text, setText] = useState(
    typeof value === 'string' ? value : value === null ? '' : JSON.stringify(value),
  );
  const [pending, setPending] = useState(false);
  const resultType =
    field.type === 'lookup' ? 'array' : 'resultType' in field.options ? field.options.resultType : 'text';
  let input: unknown = text || null;
  let parsed = true;
  if (text && resultType === 'number') input = Number(text);
  if (text && (resultType === 'array' || resultType === 'boolean')) {
    try {
      input = JSON.parse(text);
    } catch {
      parsed = false;
    }
  }
  const valid = parsed && checkComputedOverride(field, input).ok;
  const name = field.name;
  async function save() {
    if (!valid) return;
    setPending(true);
    try {
      await session.run([
        {
          kind: 'record.update',
          tableId: field.tableId,
          records: [{ id: row.id, values: { [field.id]: input } }],
        },
      ]).done;
    } catch (error) {
      reportError(error);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="rio-joined-form">
      <TextField
        label={t({ id: 'overrides.pinValue', message: `Pinned value for ${name}` })}
        value={text}
        onChange={setText}
        description={
          resultType === 'array' || resultType === 'boolean'
            ? t({
                id: 'overrides.structured',
                message: 'Enter a JSON list, true, or false, as appropriate for this field.',
              })
            : undefined
        }
        isInvalid={!valid}
        errorMessage={t({
          id: 'overrides.invalidValue',
          message: 'Enter a value that matches this field’s result type.',
        })}
      />
      <Button
        size="sm"
        isPending={pending}
        isDisabled={!valid}
        onPress={() => {
          void save();
        }}
      >
        {t({ id: 'overrides.pin', message: 'Pin value' })}
      </Button>
    </div>
  );
}
