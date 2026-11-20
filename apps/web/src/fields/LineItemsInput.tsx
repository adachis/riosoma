import { faXmark, faPlus } from '@fortawesome/free-solid-svg-icons';
import { LinkPicker } from '../grid/editors/LinkEditor';
import type { DatabaseSession } from '../data';
import { idsOf } from '@riosoma/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { checkCellValue, FieldMeta, newId, type CellValue, type LineItemValue } from '@riosoma/contracts';
import { Button, DatePicker, SortableList, SortableItem } from '@riosoma/ui';
import { editText, formatCell, type FormatContext } from '../grid/format';
import { parseText } from '../grid/parse';
import { SERVER_MESSAGES } from '../messages/server';
import { readClipboard } from '../grid/clipboard/read';
import { ApiError } from '../api';
import './line-items.css';

export interface LineItemsInputProps {
  session?: DatabaseSession;
  field: Extract<FieldMeta, { type: 'lineItems' }>;
  rows: readonly LineItemValue[];
  format: FormatContext;
  readOnly?: boolean;
  onChange(rows: LineItemValue[]): void;
}

export function lineFields(field: LineItemsInputProps['field']): FieldMeta[] {
  return field.options.columns.map((column, position) =>
    FieldMeta.parse({
      ...column,
      tableId: field.options.linkedTableId,
      position,
      createdAt: '',
      updatedAt: '',
    }),
  );
}

/** A repeatable section also works before a form has created its parent record. */
export function LineItemsInput({ field, rows, format, readOnly, session, onChange }: LineItemsInputProps) {
  const { t, i18n } = useLingui();
  const [error, setError] = useState('');
  const latestRows = useRef(rows);
  useEffect(() => {
    latestRows.current = rows;
  }, [rows]);
  const columns = lineFields(field);
  function move(id: string, index: number) {
    const next = [...rows];
    const from = next.findIndex((row) => row.id === id);
    if (from < 0 || index < 0 || index >= next.length) return;
    const [row] = next.splice(from, 1);
    next.splice(index, 0, row!);
    onChange(next);
  }
  function change(rowId: string, column: FieldMeta, input: unknown) {
    const parsed =
      column.type === 'checkbox' || column.type === 'singleSelect'
        ? checkCellValue(column, input)
        : parseText(column, String(input), format);
    const checked = parsed.ok === true ? checkCellValue(column, parsed.value) : parsed;
    if (checked.ok !== true) {
      return i18n._(
        SERVER_MESSAGES[
          'messageKey' in checked
            ? checked.messageKey
            : 'reason' in checked
              ? checked.reason
              : 'errors.validationFailed'
        ] ?? SERVER_MESSAGES['errors.validationFailed']!,
      );
    }
    setError('');
    onChange(
      rows.map((row) =>
        row.id === rowId ? { ...row, values: { ...row.values, [column.id]: checked.value } } : row,
      ),
    );
  }
  async function paste(text: string) {
    // Spreadsheet quoting is shared with the main grid, including tabs and line breaks inside cells.
    const cells = readClipboard({ text });
    const added: LineItemValue[] = [];
    try {
      for (const values of cells) {
        const row: LineItemValue = { id: newId('record'), values: {} };
        for (const [index, column] of columns.entries()) {
          if (column.type === 'link') {
            const names = (values[index] ?? '')
              .split(/[\n\r,]+/)
              .map((name) => name.trim())
              .filter(Boolean);
            const ids: string[] = [];
            for (const name of names) {
              const matches = session ? await session.searchRecords(column.options.linkedTableId, name) : [];
              const exact = matches.filter(
                (match) =>
                  match.name.toLocaleLowerCase(format.locale) === name.toLocaleLowerCase(format.locale),
              );
              if (exact.length !== 1) {
                setError(i18n._(SERVER_MESSAGES['data.link.unknownRecord']!));
                return;
              }
              if (!ids.includes(exact[0]!.id)) ids.push(exact[0]!.id);
            }
            const checked = checkCellValue(column, ids);
            if (!checked.ok) {
              setError(
                i18n._(SERVER_MESSAGES[checked.messageKey] ?? SERVER_MESSAGES['errors.validationFailed']!),
              );
              return;
            }
            row.values[column.id] = checked.value;
            continue;
          }
          const parsed = parseText(column, values[index] ?? '', format);
          if (parsed.ok !== true) {
            setError(
              i18n._(
                SERVER_MESSAGES['reason' in parsed ? parsed.reason : 'errors.validationFailed'] ??
                  SERVER_MESSAGES['errors.validationFailed']!,
              ),
            );
            return;
          }
          row.values[column.id] = parsed.value;
        }
        added.push(row);
      }
    } catch (error) {
      setError(
        i18n._(
          SERVER_MESSAGES[error instanceof ApiError ? error.info.messageKey : 'errors.offline'] ??
            SERVER_MESSAGES['errors.validationFailed']!,
        ),
      );
      return;
    }
    setError('');
    onChange([...latestRows.current, ...added]);
  }
  return (
    <div
      className="rio-line-items"
      role="group"
      aria-label={field.name}
      onPaste={(event) => {
        const text = event.clipboardData.getData('text/plain');
        if (!readOnly && /[\t\n]/.test(text)) {
          event.preventDefault();
          void paste(text);
        }
      }}
    >
      <SortableList
        items={rows.map((row, index) => ({
          id: row.id,
          name: t({ id: 'lineItems.line', message: `Line ${index + 1}` }),
          handleLabel: t({ id: 'lineItems.reorder', message: `Reorder line ${index + 1}` }),
        }))}
        disabledReason={
          readOnly
            ? t({ id: 'lineItems.readOnly', message: 'You need permission to edit these lines.' })
            : undefined
        }
        onMove={(from, to) => move(rows[from]!.id, to)}
      >
        <div className="rio-line-items__scroll" role="region" aria-label={field.name} tabIndex={0}>
          <table aria-label={field.name}>
            <thead>
              <tr>
                <th scope="col">{t({ id: 'lineItems.order', message: 'Order' })}</th>
                {columns.map((column) => (
                  <th scope="col" key={column.id}>
                    {column.name}
                  </th>
                ))}
                <th scope="col">{t({ id: 'lineItems.actions', message: 'Actions' })}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <SortableItem key={row.id} id={row.id} as="tr" altMoveScope="row">
                  <td>
                    <span>{index + 1}</span>
                  </td>
                  {columns.map((column) => {
                    const label = t({ id: 'lineItems.cell', message: `${column.name}, line ${index + 1}` });
                    const value = row.values[column.id] ?? null;
                    return (
                      <td key={column.id} data-label={column.name}>
                        {readOnly ? (
                          formatCell(column, value, format)
                        ) : column.type === 'link' ? (
                          <LinkPicker
                            field={column}
                            selected={idsOf(value)}
                            format={format}
                            session={session}
                            readOnly={false}
                            expanded={false}
                            onChange={(ids) =>
                              onChange(
                                rows.map((item) =>
                                  item.id === row.id
                                    ? { ...item, values: { ...item.values, [column.id]: ids } }
                                    : item,
                                ),
                              )
                            }
                          />
                        ) : column.type === 'date' ? (
                          <DatePicker
                            aria-label={label}
                            value={typeof value === 'string' ? value : null}
                            includeTime={column.options.includeTime}
                            timeZone={
                              column.options.timeZone === 'client' ? format.timeZone : column.options.timeZone
                            }
                            onChange={(next) =>
                              onChange(
                                rows.map((item) =>
                                  item.id === row.id
                                    ? { ...item, values: { ...item.values, [column.id]: next } }
                                    : item,
                                ),
                              )
                            }
                          />
                        ) : column.type === 'checkbox' ? (
                          <input
                            type="checkbox"
                            aria-label={label}
                            checked={value === true}
                            onChange={(event) => change(row.id, column, event.target.checked)}
                          />
                        ) : column.type === 'singleSelect' ? (
                          <select
                            aria-label={label}
                            value={typeof value === 'string' ? value : ''}
                            onChange={(event) => change(row.id, column, event.target.value || null)}
                          >
                            <option value="">
                              {t({ id: 'lineItems.emptyChoice', message: 'Select an option' })}
                            </option>
                            {column.options.choices.map((choice) => (
                              <option key={choice.id} value={choice.id}>
                                {choice.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <LineCell
                            key={`${row.id}:${column.id}`}
                            label={label}
                            column={column}
                            value={value}
                            format={format}
                            onSave={(text) => change(row.id, column, text)}
                          />
                        )}
                      </td>
                    );
                  })}
                  <td>
                    <Button
                      size="sm"
                      variant="quiet"
                      isDisabled={readOnly}
                      aria-label={t({ id: 'lineItems.removeLabel', message: `Remove line ${index + 1}` })}
                      onPress={() => onChange(rows.filter((item) => item.id !== row.id))}
                      icon={faXmark}
                    />
                  </td>
                </SortableItem>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{t({ id: 'lineItems.total', message: 'Total' })}</th>
                {columns.map((column) => (
                  <td key={column.id} data-label={column.name}>
                    {column.type === 'number' || column.type === 'currency'
                      ? formatCell(
                          column,
                          rows.reduce(
                            (total, row) =>
                              total +
                              (typeof row.values[column.id] === 'number'
                                ? (row.values[column.id] as number)
                                : 0),
                            0,
                          ),
                          format,
                        )
                      : ''}
                  </td>
                ))}
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </SortableList>
      {!readOnly && (
        <Button
          size="sm"
          onPress={() => onChange([...rows, { id: newId('record'), values: {} }])}
          aria-label={t({ id: 'lineItems.add', message: 'Add line' })}
          icon={faPlus}
        />
      )}
      <div role="status" aria-live="polite">
        {error}
      </div>
      {!readOnly && (
        <p className="rio-line-items__help">
          {t({
            id: 'lineItems.keyboardHelp',
            message:
              'Drag the row, press and hold on touch, or use the movement menu to reorder.  Press Alt+Up or Alt+Down on the move control to reorder with the keyboard.  Paste spreadsheet cells to add lines.',
          })}
        </p>
      )}
    </div>
  );
}

function LineCell({
  label,
  column,
  value,
  format,
  onSave,
}: {
  label: string;
  column: FieldMeta;
  value: CellValue;
  format: FormatContext;
  onSave(text: string): string | undefined;
}) {
  const errorId = useId();
  const [error, setError] = useState('');
  const stored = editText(column, value, format);
  const [draft, setDraft] = useState({ stored, text: stored });
  if (draft.stored !== stored) {
    setDraft({ stored, text: stored });
    setError('');
  }
  const text = draft.text;
  return (
    <div className="rio-line-items__cell">
      <input
        aria-label={label}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        value={text}
        type={column.type === 'date' ? 'date' : 'text'}
        inputMode={column.type === 'number' || column.type === 'currency' ? 'decimal' : undefined}
        onChange={(event) => setDraft({ stored, text: event.target.value })}
        onBlur={() => setError(onSave(text) ?? '')}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            setError(onSave(text) ?? '');
          }
        }}
      />
      <div id={errorId} className="rio-line-items__error" aria-live="polite">
        {error}
      </div>
    </div>
  );
}
