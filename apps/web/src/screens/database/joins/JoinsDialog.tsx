import { useLingui } from '@lingui/react/macro';
import { newId, type JoinSuggestion, type JoinSuggestions } from '@riosoma/contracts';
import { Banner, Button, Dialog, DialogBody, DialogTitle, Modal, Spinner, toast } from '@riosoma/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { api, ApiError } from '../../../api';
import { useSchema } from '../../../data/hooks';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { useServerMessage } from '../../../messages/useServerMessage';
import './joins.css';

const keyOf = (suggestion: JoinSuggestion) => `${suggestion.fromFieldId}>${suggestion.toFieldId}`;

/** The names a suggestion talks about, or null once one of them is gone from the schema. */
function namesOf(schema: SchemaState, suggestion: JoinSuggestion) {
  const fromTable = schema.tableById.get(suggestion.fromTableId)?.name;
  const toTable = schema.tableById.get(suggestion.toTableId)?.name;
  const fromField = schema.fieldById.get(suggestion.fromFieldId)?.name;
  const toField = schema.fieldById.get(suggestion.toFieldId)?.name;
  return fromTable && toTable && fromField && toField ? { fromTable, toTable, fromField, toField } : null;
}

/**
 * Suggested links between tables, from fields whose values match records elsewhere.  Linking one
 * creates a link field that follows the matching values, through the ordinary `field.create`.
 */
export function JoinsDialog({
  session,
  tableId,
  onClose,
}: {
  session: DatabaseSession;
  /** Suggestions involving this table, or every table when left out */
  tableId?: string;
  onClose(): void;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const schema = useSchema(session);
  const id = useId();
  const [linked, setLinked] = useState<ReadonlySet<string>>(new Set());
  const locale = i18n.locale || 'en-US';
  const percentOf = (value: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(value);
  const confidenceText = (value: number) => {
    const percent = percentOf(value);
    return t({ id: 'joins.confidence', message: `${percent} confident` });
  };
  const coverageText = (value: number) => {
    const percent = percentOf(value);
    return t({ id: 'joins.coverage', message: `${percent} of values found` });
  };
  const uniquenessText = (value: number) => {
    const percent = percentOf(value);
    return t({ id: 'joins.uniqueness', message: `${percent} of matches are unique` });
  };
  const examplesText = (examples: JoinSuggestion['examples']) => {
    const values = new Intl.ListFormat(locale, { style: 'short', type: 'unit' }).format(
      examples.map((example) => example.value),
    );
    return t({ id: 'joins.examples', message: `For example: ${values}` });
  };
  const found = useQuery({
    queryKey: [
      'join-suggestions',
      session.databaseId,
      tableId ?? null,
      schema?.tables.map((table) => `${table.id}:${table.source?.status.lastSuccessAt ?? ''}`).join(',') ??
        '',
    ],
    queryFn: ({ signal }) =>
      api<JoinSuggestions>(`/api/databases/${session.databaseId}/join-suggestions`, {
        method: 'POST',
        body: tableId ? { tableIds: [tableId] } : {},
        signal,
      }),
    // Copy completion and table creation can make an earlier empty result useful immediately.
    gcTime: 0,
    enabled: Boolean(schema),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const link = useMutation({
    mutationFn: async (suggestion: JoinSuggestion) => {
      const current = session.getSchema();
      const names = namesOf(current, suggestion);
      if (!names) return false;
      // Named after the linked table, numbered when the table already has a field by that name.
      const taken = new Set(
        (current.fields.get(suggestion.fromTableId) ?? []).map((field) => field.name.trim().toLowerCase()),
      );
      const name = names.toTable;
      let fieldName = name;
      for (let number = 2; taken.has(fieldName.toLowerCase()); number++)
        fieldName = t({ id: 'field.dialog.numberedName', message: `${name} ${number}` });
      const result = await session.run([
        {
          kind: 'field.create',
          tableId: suggestion.fromTableId,
          field: {
            id: newId('field'),
            name: fieldName,
            type: 'link',
            options: {
              linkedTableId: suggestion.toTableId,
              match: { fieldId: suggestion.fromFieldId, linkedFieldId: suggestion.toFieldId },
            },
          },
        },
      ]).done;
      // A refusal reaches the person through the session's own message.
      return result.rejected === 0;
    },
    onSuccess: (done, suggestion) => {
      const names = schema && namesOf(schema, suggestion);
      if (!done || !names) return;
      setLinked((previous) => new Set(previous).add(keyOf(suggestion)));
      const { fromTable, toTable } = names;
      toast.show({
        title: t({ id: 'joins.linked', message: `Linked ${fromTable} to ${toTable}` }),
        tone: 'success',
      });
    },
  });
  const items = (found.data?.suggestions ?? []).flatMap((suggestion) => {
    const names = schema && namesOf(schema, suggestion);
    return names && !linked.has(keyOf(suggestion)) ? [{ suggestion, names }] : [];
  });
  const searching = t({ id: 'joins.searching', message: 'Comparing fields…' });
  const error = found.error ?? link.error;
  return (
    <Modal
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>{t({ id: 'joins.title', message: 'Suggested links' })}</DialogTitle>
        <DialogBody>
          <p className="rio-joins-intro">
            {t({
              id: 'joins.intro',
              message:
                'Fields whose values match records in another table.  Linking them keeps the links up to date as values change.',
            })}
          </p>
          {error && (
            <Banner tone="danger">
              {message(error instanceof ApiError ? error.info.messageKey : 'errors.internal')}
            </Banner>
          )}
          {found.isPending && (
            <div className="rio-joins-searching">
              <Spinner size="sm" label={searching} />
              <span aria-hidden="true">{searching}</span>
            </div>
          )}
          {found.data && !items.length && (
            <p>
              {linked.size
                ? t({ id: 'joins.allLinked', message: 'Every suggested link is made.' })
                : t({
                    id: 'joins.none',
                    message:
                      'Nothing obvious to link.  Values in one table don’t match values in another closely enough.',
                  })}
            </p>
          )}
          {items.length > 0 && (
            <ul className="rio-joins-list">
              {items.map(({ suggestion, names }, index) => {
                const { fromField, fromTable, toField, toTable } = names;
                const pairId = `${id}-${index}`;
                const confidence = confidenceText(suggestion.confidence);
                const pending =
                  link.isPending && link.variables && keyOf(link.variables) === keyOf(suggestion);
                return (
                  <li key={keyOf(suggestion)} className="rio-joins-suggestion">
                    <p id={pairId} className="rio-joins-pair">
                      {t({
                        id: 'joins.suggestion',
                        message: `From ${fromField} in ${fromTable} to ${toField} in ${toTable}`,
                      })}
                    </p>
                    <div
                      className="rio-joins-meter"
                      role="meter"
                      aria-valuenow={Math.round(suggestion.confidence * 100)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuetext={confidence}
                      aria-labelledby={pairId}
                    >
                      <span>{confidence}</span>
                      <span className="rio-joins-meter__track" aria-hidden="true">
                        <span
                          className="rio-joins-meter__fill"
                          style={{ inlineSize: `${Math.round(suggestion.confidence * 100)}%` }}
                        />
                      </span>
                    </div>
                    <ul className="rio-joins-facts">
                      <li>{coverageText(suggestion.coverage)}</li>
                      <li>{uniquenessText(suggestion.uniqueness)}</li>
                      {suggestion.examples.length > 0 && <li>{examplesText(suggestion.examples)}</li>}
                    </ul>
                    <Button
                      size="sm"
                      variant="primary"
                      aria-describedby={pairId}
                      isPending={Boolean(pending)}
                      isDisabled={link.isPending}
                      onPress={(event) => {
                        // The suggestion leaves the list once it's linked, so keep the focus in the dialog.
                        event.target.closest<HTMLElement>('[role="dialog"]')?.focus();
                        link.mutate(suggestion);
                      }}
                    >
                      {t({ id: 'joins.link', message: 'Link them' })}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogBody>
      </Dialog>
    </Modal>
  );
}
