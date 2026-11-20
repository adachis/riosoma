import { useViewColors } from '../colors/useViewColors';
import { Painted } from '../colors/Painted';
import { CardValue } from '../views/CardValue';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { Cell, Column, Row, Table, TableBody, TableHeader, type Selection } from 'react-aria-components';
import {
  GridConfig,
  safeLink,
  cellValue,
  idsOf,
  type FieldMeta,
  type RecordsBlock,
  type RowData,
} from '@riosoma/contracts';
import { Button, ListBox, ListBoxItem } from '@riosoma/ui';
import { formatCell } from '../../../grid/format';
import { BlockStatus, BlockUnavailable } from './BlockStatus';
import type { BlockContext } from './context';
import { GroupedRecords } from './GroupedRecords';
import { RecordMedia } from './PresentationBlocks';
import { chosenFor, useBlockRecords } from './records';

/** The one record a selection holds. */
function onlyKey(keys: Selection): string | null {
  if (keys === 'all') return null;
  const [key] = keys;
  return typeof key === 'string' ? key : null;
}

/**
 * A records block: one table's records in its view's order, as a list of names or a table, with
 * the block's filter and the page's filter blocks applied on the server.  Picking a record selects
 * it on the page, for the record blocks that follow this one.
 */
export function RecordsBody({
  block,
  name,
  context,
}: {
  block: RecordsBlock;
  name: string;
  context: BlockContext;
}) {
  const { t } = useLingui();
  const { session, schema, format, page } = context;
  // The store compares what's asked by value, so a new object with the same choices reads nothing.
  const records = useBlockRecords(
    session,
    context.interfaceId,
    page.id,
    block,
    chosenFor(page, block, context.filters),
    context.refreshDelay,
  );
  const table = schema.tableById.get(block.source.tableId);
  const view = schema.viewById.get(block.source.viewId);
  const fields = schema.fields.get(block.source.tableId) ?? [];
  const colors = useViewColors(
    session,
    view ?? { id: block.source.viewId, tableId: block.source.tableId, config: GridConfig.parse({}) },
    fields,
    format,
  );
  if (!table || view?.tableId !== table.id) return <BlockUnavailable />;
  const { state } = records;
  if (state.status === 'loading') return <BlockStatus />;
  if (state.status === 'error') return <BlockStatus error={state} onRetry={records.retry} />;
  const primary = fields.find((field) => field.id === table.primaryFieldId);
  const shown = block.fieldIds.flatMap((id) =>
    fields.filter((field) => field.id === id && field.id !== table.primaryFieldId),
  );
  const rows = state.ids.flatMap((id) => {
    const row = records.row(id);
    return row ? [row] : [];
  });
  const untitled = t({ id: 'record.untitled', message: 'Untitled record' });
  const nameOf = (row: RowData) =>
    (primary ? formatCell(primary, cellValue(row, primary), format) : '') || untitled;
  const valueOf = (row: RowData, field: FieldMeta) => formatCell(field, cellValue(row, field), format);
  const selectedFields = block.fieldIds.flatMap((id) => fields.filter((field) => field.id === id));
  const selected = context.selected[block.id];
  const select = (keys: Selection) => {
    const recordId = onlyKey(keys);
    if (recordId) context.onSelect(block.id, recordId);
  };
  const count = state.total;
  return (
    <div className="rio-interface-records" aria-busy={state.refreshing || undefined}>
      {!rows.length ? (
        <p className="rio-interface-records__empty">
          {t({ id: 'interfaces.records.empty', message: 'No records to show.' })}
        </p>
      ) : block.display === 'accordion' || block.display === 'sections' ? (
        <div className={block.display === 'sections' ? 'rio-interface-sections' : 'rio-interface-accordions'}>
          {rows.map((row) => {
            const words = (field: FieldMeta) => (
              <>
                {block.showFieldNames !== false ? <strong>{field.name}: </strong> : null}
                {valueOf(row, field)}
              </>
            );
            const first = selectedFields[0];
            const heading =
              first && (valueOf(row, first).trim() || block.showFieldNames !== false)
                ? words(first)
                : untitled;
            const answer = selectedFields.slice(1).map((field) => <p key={field.id}>{words(field)}</p>);
            if (block.display === 'accordion')
              return (
                <details className="rio-interface-accordion" key={row.id}>
                  <summary>{heading}</summary>
                  <div>{answer}</div>
                </details>
              );
            const extra = (id: string | null | undefined) => {
              const field = id ? schema.fieldById.get(id) : undefined;
              return field ? valueOf(row, field) : '';
            };
            const cover = block.coverFieldId ? schema.fieldById.get(block.coverFieldId) : undefined;
            const file =
              cover?.type === 'attachment'
                ? idsOf(cellValue(row, cover))
                    .map((id) => session.attachments.get(id))
                    .find(
                      (item) =>
                        item?.scanState === 'clean' &&
                        (item.type.startsWith('image/') || item.type.startsWith('video/')),
                    )
                : undefined;
            const link = extra(block.linkFieldId);
            return (
              <article
                className="rio-interface-record-section"
                data-media={Boolean(file) || undefined}
                key={row.id}
              >
                <div className="rio-interface-section-words">
                  <h3>{heading}</h3>
                  {answer}
                  {link && safeLink(link) ? (
                    <a className="rio-interface-section-link" href={link} rel="noopener noreferrer">
                      {extra(block.linkLabelFieldId).trim() ||
                        t({ id: 'interfaces.button.open', message: 'Open' })}
                    </a>
                  ) : null}
                </div>
                {file && cover ? (
                  <div className="rio-interface-section-media">
                    <RecordMedia
                      reference={{
                        tableId: block.source.tableId,
                        recordId: row.id,
                        fieldId: cover.id,
                        attachmentId: file.id,
                      }}
                      kind={file.type.startsWith('video/') ? 'video' : 'image'}
                      alt={extra(block.altFieldId)}
                      playback={block.playback}
                      context={context}
                    />
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : block.showFieldNames === false && block.display !== 'table' ? (
        <div className={block.display === 'cards' ? 'rio-interface-cards' : 'rio-interface-record-items'}>
          {rows.map((row) => {
            const cover =
              block.display === 'cards' && block.coverFieldId
                ? schema.fieldById.get(block.coverFieldId)
                : null;
            const file =
              cover?.type === 'attachment'
                ? idsOf(cellValue(row, cover))
                    .map((id) => session.attachments.get(id))
                    .find((item) => item?.type.startsWith('image/') && item.scanState === 'clean')
                : null;
            const heading = (selectedFields[0] ? valueOf(row, selectedFields[0]) : '') || untitled;
            return (
              <article
                className={block.display === 'cards' ? 'rio-interface-card' : 'rio-interface-record-item'}
                key={row.id}
              >
                {file?.url ? <img src={file.url} alt="" /> : null}
                <h3 className="rio-interface-record-title">
                  <button
                    type="button"
                    aria-pressed={selected === row.id}
                    onClick={() => context.onSelect(block.id, row.id)}
                  >
                    {heading}
                  </button>
                </h3>
                {selectedFields.slice(1).map((field) => {
                  const value = valueOf(row, field);
                  return value ? <p key={field.id}>{value}</p> : null;
                })}
              </article>
            );
          })}
        </div>
      ) : block.display === 'cards' ? (
        <div className="rio-interface-cards">
          {rows.map((row) => {
            const cover = block.coverFieldId ? schema.fieldById.get(block.coverFieldId) : null;
            const file =
              cover?.type === 'attachment'
                ? idsOf(cellValue(row, cover))
                    .map((id) => session.attachments.get(id))
                    .find((item) => item?.type.startsWith('image/') && item.scanState === 'clean')
                : null;
            return (
              <button
                className="rio-interface-card"
                type="button"
                key={row.id}
                aria-pressed={selected === row.id}
                onClick={() => context.onSelect(block.id, row.id)}
              >
                {file?.url ? <img src={file.url} alt="" /> : null}
                <strong>{nameOf(row)}</strong>
                {shown.map((field) => (
                  <span key={field.id}>
                    {field.name}: {valueOf(row, field)}
                  </span>
                ))}
              </button>
            );
          })}
        </div>
      ) : view.type === 'grid' && view.config.groups.length ? (
        <GroupedRecords
          rows={rows}
          groups={state.groups ?? []}
          view={view}
          context={context}
          fieldIds={block.fieldIds}
          onSelect={(id) => context.onSelect(block.id, id)}
        />
      ) : block.display === 'table' ? (
        <div className="rio-interface-records__scroll">
          <Table
            aria-label={name}
            className="rio-interface-table"
            selectionMode="single"
            selectionBehavior="replace"
            disallowEmptySelection
            selectedKeys={selected ? [selected] : []}
            onSelectionChange={select}
          >
            <TableHeader className="rio-interface-table__header">
              <Column isRowHeader className="rio-interface-table__column">
                {primary?.name ?? ''}
              </Column>
              {shown.map((field) => (
                <Column key={field.id} className="rio-interface-table__column">
                  {field.name}
                </Column>
              ))}
            </TableHeader>
            <TableBody items={rows}>
              {(row) => (
                <Row id={row.id} className="rio-interface-table__row">
                  <Cell className="rio-interface-table__cell">
                    <Painted paint={primary ? colors.cell(row, primary) : null}>{nameOf(row)}</Painted>
                  </Cell>
                  {shown.map((field) => (
                    <Cell key={field.id} className="rio-interface-table__cell">
                      <CardValue
                        field={field}
                        value={cellValue(row, field)}
                        row={row}
                        format={format}
                        paint={colors.cell(row, field)}
                      />
                    </Cell>
                  ))}
                </Row>
              )}
            </TableBody>
          </Table>
        </div>
      ) : (
        <ListBox
          aria-label={name}
          className="rio-interface-records__list"
          items={rows}
          selectionMode="single"
          selectionBehavior="replace"
          disallowEmptySelection
          selectedKeys={selected ? [selected] : []}
          onSelectionChange={select}
        >
          {(row) => (
            <ListBoxItem
              id={row.id}
              textValue={nameOf(row)}
              description={
                shown.length
                  ? shown
                      .map((field) => {
                        const value = valueOf(row, field);
                        return value ? `${field.name}: ${value}` : '';
                      })
                      .filter(Boolean)
                      .join(' · ')
                  : undefined
              }
            >
              <Painted paint={primary ? colors.cell(row, primary) : null}>{nameOf(row)}</Painted>
              {shown.map((field) => {
                const paint = colors.cell(row, field);
                return paint?.sparkline ? (
                  <CardValue
                    key={field.id}
                    field={field}
                    value={cellValue(row, field)}
                    row={row}
                    format={format}
                    paint={paint}
                  />
                ) : null;
              })}
            </ListBoxItem>
          )}
        </ListBox>
      )}
      <div className="rio-interface-records__footer">
        <p className="rio-interface-records__count">
          {t({
            id: 'interfaces.records.count',
            message: plural(count, { one: '# record', other: '# records' }),
          })}
        </p>
        {rows.length < state.total ? (
          <Button size="sm" isPending={state.loadingMore} onPress={records.loadMore}>
            {t({ id: 'interfaces.records.more', message: 'Show more' })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
