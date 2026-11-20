import { DuplicateDialog } from './DuplicateDialog';
import { useSchema } from '../../../data/hooks';
import { useEffect, useRef, useState } from 'react';
import {
  needsFieldConversion,
  newId,
  type ConversionPreview,
  type FieldMeta,
  type FieldSpec,
  type FieldType,
} from '@riosoma/contracts';
import { api, ApiError } from '../../../api';
import type { CommandInput, DatabaseSession, SessionEvent } from '../../../data/types';
import type { FormatContext } from '../../../grid/format';
import { dateOrderFor } from '../../../grid/parse';
import { useServerMessage } from '../../../messages/useServerMessage';
import { FieldDialog } from '../fields/FieldDialog';
import { useAiUnavailable } from '../../../features/ai-fields/hooks';

export function FieldOverlay({
  session,
  fields,
  tableId,
  viewId,
  primaryFieldId,
  fieldId,
  index,
  format,
  initialType,
  onClose,
}: {
  session: DatabaseSession;
  fields: readonly FieldMeta[];
  tableId: string;
  viewId: string;
  primaryFieldId: string;
  fieldId: string | null;
  index?: number;
  format: FormatContext;
  /** The type a new field starts as, or an AI field */
  initialType?: FieldType | 'ai';
  onClose(): void;
}) {
  // Link, lookup, rollup, and formula options pick from the database's tables and fields.
  const schema = useSchema(session);
  const initial = fields.find((field) => field.id === fieldId);
  const [conversion, setConversion] = useState<ConversionPreview | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [duplicates, setDuplicates] = useState<{ values: string[]; href: string }>();
  const request = useRef<AbortController | null>(null);
  const message = useServerMessage();
  const aiUnavailable = useAiUnavailable(tableId);
  useEffect(() => () => request.current?.abort(), []);
  async function preview(spec: FieldSpec) {
    request.current?.abort();
    if (!initial || !needsFieldConversion(initial, spec)) {
      setConversion(null);
      setPending(false);
      setError(undefined);
      return;
    }
    const abort = new AbortController();
    request.current = abort;
    setPending(true);
    setConversion(null);
    setError(undefined);
    try {
      const next = await api<ConversionPreview>(`/api/fields/${initial.id}/conversion-preview`, {
        method: 'POST',
        body: { to: spec, dateOrder: dateOrderFor(format.locale), timeZone: format.timeZone },
        signal: abort.signal,
      });
      if (!abort.signal.aborted) setConversion(next);
    } catch (error) {
      if (!abort.signal.aborted)
        setError(message(error instanceof ApiError ? error.info.messageKey : 'errors.internal'));
    } finally {
      if (!abort.signal.aborted) setPending(false);
    }
  }
  if (duplicating && initial)
    return (
      <DuplicateDialog
        kind="field"
        id={initial.id}
        name={initial.name}
        existingNames={fields.map((field) => field.name)}
        session={session}
        onClose={onClose}
      />
    );
  return (
    <FieldDialog
      mode={initial ? 'edit' : 'create'}
      schema={schema ?? undefined}
      tableId={tableId}
      initial={initial}
      isPrimary={initial?.id === primaryFieldId}
      existingNames={fields.map((field) => field.name)}
      conversion={conversion}
      isSaving={pending}
      error={error}
      duplicates={duplicates}
      aiUnavailable={aiUnavailable}
      initialType={initialType}
      onTypeChange={(spec) => {
        void preview(spec);
      }}
      onDuplicate={initial ? () => setDuplicating(true) : undefined}
      onCancel={onClose}
      onSubmit={async ({ name, description, spec, ai }) => {
        if (pending || (initial && needsFieldConversion(initial, spec) && !conversion)) return;
        try {
          const commands: CommandInput[] = initial
            ? [
                ...(needsFieldConversion(initial, spec)
                  ? [
                      {
                        kind: 'field.convert' as const,
                        fieldId: initial.id,
                        to: spec,
                        dateOrder: dateOrderFor(format.locale),
                        timeZone: format.timeZone,
                      },
                    ]
                  : []),
                {
                  kind: 'field.update',
                  fieldId: initial.id,
                  name,
                  description,
                  options: spec.options,
                  // Saving an AI field's settings makes this person the one its runs act as.
                  ...(ai !== undefined ? { ai } : {}),
                },
              ]
            : [
                {
                  kind: 'field.create',
                  tableId,
                  field: { id: newId('field'), name, description, ...spec, ...(ai ? { ai } : {}) },
                  placement: { viewId, index: index ?? fields.length },
                },
              ];
          const refusals: Extract<SessionEvent, { kind: 'rejected' }>[] = [];
          const unsubscribe = session.subscribeEvents((event) => {
            if (event.kind === 'rejected') refusals.push(event);
          });
          setPending(true);
          setError(undefined);
          setDuplicates(undefined);
          try {
            const result = await session.run(commands, { handlesRefusal: true }).done;
            if (!result.rejected) onClose();
            else {
              const refusal = refusals.at(-1);
              setError(message(refusal?.messageKey ?? 'errors.internal', refusal?.params));
              if (
                typeof refusal?.params?.duplicates === 'string' &&
                typeof refusal.params.dedupe === 'string'
              ) {
                const rows = JSON.parse(refusal.params.duplicates) as Array<{ value: unknown }>;
                setDuplicates({ values: rows.map((row) => String(row.value)), href: refusal.params.dedupe });
              }
            }
          } finally {
            unsubscribe();
            setPending(false);
          }
        } catch (error) {
          setError(message(error instanceof ApiError ? error.info.messageKey : 'errors.internal'));
        }
      }}
    />
  );
}
