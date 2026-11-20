import { useEffect, useId, useState } from 'react';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { faPlus, faPen, faXmark } from '@fortawesome/free-solid-svg-icons';
import {
  FieldSpec,
  REST_LIMITS,
  REST_PAGING_STYLES,
  type CellValue,
  type RestEndpoint,
  type RestPagingStyle,
  type SourcePreview,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Disclosure,
  DisclosurePanel,
  DisclosureTrigger,
  Heading,
  ListBoxItem,
  NumberField,
  Select,
  Spinner,
  Text,
  TextArea,
  TextField,
} from '@riosoma/ui';
import { ApiError } from '../../../api';
import { useServerMessage } from '../../../messages/useServerMessage';
import { fieldTypeInfo } from '../../database/fields/fieldTypes';
import { blankEndpoint, toEndpoint, type EndpointDraft } from './kinds';
import { ARRAY_LABELS, PAGING_LABELS } from './labels';
import './sources.css';

/** Reads an endpoint's first page, with the dialog's address, sign-in, and secrets. */
export type EndpointPreviewer = (endpoint: RestEndpoint, signal: AbortSignal) => Promise<SourcePreview>;

export interface EndpointsEditorProps {
  endpoints: EndpointDraft[];
  onChange(endpoints: EndpointDraft[]): void;
  /** Null while the preview can't run, with `previewBlocked` saying why */
  preview: EndpointPreviewer | null;
  /** Why the preview can't run yet, already translated */
  previewBlocked?: string;
  isDisabled?: boolean;
}

/** How many of the first page's records the preview shows. */
const PREVIEW_ROWS = 5;
/** How long typing pauses before the preview asks the API again. */
const PREVIEW_DELAY_MS = 500;

/**
 * An API source's endpoints, each one a thing people can sync into a table.  They're added,
 * edited, and removed right here in the source's dialog, one open at a time, and the one open
 * shows its first page as it's set up, so the records path and paging can be checked against what
 * the API really answers.
 */
export function EndpointsEditor({
  endpoints,
  onChange,
  preview,
  previewBlocked,
  isDisabled,
}: EndpointsEditorProps) {
  const { t } = useLingui();
  const headingId = useId();
  const [editing, setEditing] = useState<number | null>(null);
  // What an endpoint was before this edit, or null for one that's new, so Cancel can undo it.
  const [before, setBefore] = useState<EndpointDraft | null>(null);

  function add() {
    onChange([...endpoints, blankEndpoint()]);
    setBefore(null);
    setEditing(endpoints.length);
  }
  function edit(index: number) {
    setBefore(endpoints[index]!);
    setEditing(index);
  }
  function cancel(index: number) {
    onChange(
      before === null
        ? endpoints.filter((_endpoint, position) => position !== index)
        : endpoints.map((endpoint, position) => (position === index ? before : endpoint)),
    );
    setEditing(null);
  }
  function remove(index: number) {
    onChange(endpoints.filter((_endpoint, position) => position !== index));
    if (editing !== null && editing > index) setEditing(editing - 1);
  }

  return (
    <section className="rio-sources__endpoints" aria-labelledby={headingId}>
      <Heading level={4} id={headingId}>
        <Trans id="sources.api.endpoints">Endpoints</Trans>
      </Heading>
      <Text variant="muted">
        <Trans id="sources.api.endpoints.hint">
          Each endpoint is something people can sync into a table, like a list of orders.
        </Trans>
      </Text>
      {endpoints.length ? (
        <ul className="rio-sources__endpoint-list">
          {endpoints.map((endpoint, index) =>
            index === editing ? (
              <li key={index}>
                <EndpointForm
                  draft={endpoint}
                  others={endpoints
                    .filter((_other, position) => position !== index)
                    .map((other) => other.name)}
                  onChange={(draft) =>
                    onChange(endpoints.map((other, position) => (position === index ? draft : other)))
                  }
                  onDone={() => setEditing(null)}
                  onCancel={() => cancel(index)}
                  preview={preview}
                  previewBlocked={previewBlocked}
                  isDisabled={isDisabled}
                />
              </li>
            ) : (
              <li key={index} className="rio-sources__endpoint">
                <span className="rio-sources__endpoint-text">
                  <Text className="rio-sources__endpoint-name">{endpoint.name}</Text>
                  <Text variant="muted" className="rio-sources__endpoint-path">
                    {endpoint.path || '/'}
                  </Text>
                </span>
                <span className="rio-sources__endpoint-actions">
                  <Button
                    size="sm"
                    aria-label={t({
                      id: 'sources.api.endpoint.editNamed',
                      message: `Edit ${endpoint.name}`,
                    })}
                    isDisabled={isDisabled || editing !== null}
                    onPress={() => edit(index)}
                    icon={faPen}
                  />
                  <Button
                    size="sm"
                    aria-label={t({
                      id: 'sources.api.endpoint.removeNamed',
                      message: `Remove ${endpoint.name}`,
                    })}
                    isDisabled={isDisabled || editing !== null}
                    onPress={() => remove(index)}
                    icon={faXmark}
                  />
                </span>
              </li>
            ),
          )}
        </ul>
      ) : (
        <Text>
          <Trans id="sources.api.endpoints.none">Add at least one endpoint to sync from.</Trans>
        </Text>
      )}
      {editing === null && endpoints.length < REST_LIMITS.endpoints ? (
        <Button
          icon={faPlus}
          className="rio-sources__endpoint-add"
          isDisabled={isDisabled}
          onPress={add}
          aria-label={t({ id: 'sources.api.endpoint.add', message: 'Add an endpoint' })}
        />
      ) : null}
    </section>
  );
}

interface EndpointFormProps {
  draft: EndpointDraft;
  /** The other endpoints' names, which this one can't repeat */
  others: string[];
  onChange(draft: EndpointDraft): void;
  onDone(): void;
  onCancel(): void;
  preview: EndpointPreviewer | null;
  previewBlocked: string | undefined;
  isDisabled: boolean | undefined;
}

/** One endpoint's settings: where it is, where its records are, and how it pages. */
function EndpointForm({
  draft,
  others,
  onChange,
  onDone,
  onCancel,
  preview,
  previewBlocked,
  isDisabled,
}: EndpointFormProps) {
  const { t, i18n } = useLingui();
  const change = (patch: Partial<EndpointDraft>) => onChange({ ...draft, ...patch });
  const endpoint = toEndpoint(draft);
  const taken = others.some(
    (name) => name.trim().toLocaleLowerCase() === draft.name.trim().toLocaleLowerCase(),
  );
  const common = { isDisabled, autoComplete: 'off' };
  const paging = (
    <>
      <Select
        label={t({ id: 'sources.api.paging', message: 'Paging' })}
        selectedKey={draft.paging}
        onSelectionChange={(key) => {
          const style = REST_PAGING_STYLES.find((option) => option === key);
          if (style) change({ paging: style as RestPagingStyle });
        }}
        isDisabled={isDisabled}
      >
        {/* Record cursors remain a preset option without adding controls to the API form. */}
        {REST_PAGING_STYLES.filter((style) => style !== 'last-record').map((style) => (
          <ListBoxItem key={style} id={style}>
            {i18n._(PAGING_LABELS[style])}
          </ListBoxItem>
        ))}
      </Select>
      {draft.paging === 'page' ? (
        <>
          <TextField
            label={t({ id: 'sources.api.pageParam', message: 'Page parameter' })}
            value={draft.pageParam}
            onChange={(pageParam) => change({ pageParam })}
            isRequired
            {...common}
          />
          <NumberField
            label={t({ id: 'sources.api.pageStart', message: 'First page' })}
            value={draft.pageStart}
            onChange={(pageStart) => change({ pageStart })}
            minValue={0}
            formatOptions={{ useGrouping: false }}
            isRequired
            isDisabled={isDisabled}
          />
          <TextField
            label={t({ id: 'sources.api.sizeParam', message: 'Page size parameter' })}
            description={t({
              id: 'sources.api.sizeParam.hint',
              message: 'Leave empty when the API decides how many records a page holds.',
            })}
            value={draft.sizeParam}
            onChange={(sizeParam) => change({ sizeParam })}
            {...common}
          />
          <NumberField
            label={t({ id: 'sources.api.pageSize', message: 'Page size' })}
            description={t({
              id: 'sources.api.pageSize.hint',
              message: 'Records a full page holds, so a shorter one is known to be the last.',
            })}
            value={draft.pageSize}
            onChange={(pageSize) => change({ pageSize })}
            minValue={1}
            maxValue={10_000}
            isRequired={draft.sizeParam.trim() !== ''}
            isDisabled={isDisabled}
          />
        </>
      ) : null}
      {draft.paging === 'offset' ? (
        <>
          <TextField
            label={t({ id: 'sources.api.offsetParam', message: 'Offset parameter' })}
            value={draft.offsetParam}
            onChange={(offsetParam) => change({ offsetParam })}
            isRequired
            {...common}
          />
          <TextField
            label={t({ id: 'sources.api.limitParam', message: 'Limit parameter' })}
            value={draft.limitParam}
            onChange={(limitParam) => change({ limitParam })}
            isRequired
            {...common}
          />
          <NumberField
            label={t({ id: 'sources.api.limit', message: 'Records a page' })}
            value={draft.limit}
            onChange={(limit) => change({ limit })}
            minValue={1}
            maxValue={10_000}
            isRequired
            isDisabled={isDisabled}
          />
        </>
      ) : null}
      {draft.paging === 'cursor' ? (
        <>
          <TextField
            label={t({ id: 'sources.api.cursorPath', message: 'Cursor at' })}
            description={t({
              id: 'sources.api.cursorPath.hint',
              message: 'Where each answer holds the next cursor, like meta.next_cursor.',
            })}
            value={draft.cursorPath}
            onChange={(cursorPath) => change({ cursorPath })}
            isRequired
            {...common}
          />
          <TextField
            label={t({ id: 'sources.api.cursorParam', message: 'Cursor parameter' })}
            description={t({
              id: 'sources.api.cursorParam.hint',
              message: 'The query parameter the next request sends it in, like cursor.',
            })}
            value={draft.cursorParam}
            onChange={(cursorParam) => change({ cursorParam })}
            isRequired
            {...common}
          />
        </>
      ) : null}
      {draft.paging === 'next-url' ? (
        <TextField
          label={t({ id: 'sources.api.nextPath', message: 'Next page at' })}
          description={t({
            id: 'sources.api.nextPath.hint',
            message: 'Where each answer holds the next page’s address, like links.next.',
          })}
          value={draft.nextPath}
          onChange={(nextPath) => change({ nextPath })}
          isRequired
          {...common}
        />
      ) : null}
      {draft.paging === 'link-header' ? (
        <Text variant="muted">
          <Trans id="sources.api.linkHeader.hint">
            Riosoma follows the address each answer’s Link header marks as next.
          </Trans>
        </Text>
      ) : null}
    </>
  );

  return (
    <div
      className="rio-sources__endpoint-form"
      role="group"
      aria-label={t({ id: 'sources.api.endpoint', message: 'Endpoint' })}
    >
      <TextField
        label={t({ id: 'sources.api.endpointName', message: 'Endpoint name' })}
        description={t({
          id: 'sources.api.endpointName.hint',
          message: 'What people see when they choose what to sync.',
        })}
        value={draft.name}
        onChange={(name) => change({ name })}
        isRequired
        isInvalid={taken}
        errorMessage={
          taken
            ? t({ id: 'sources.api.endpointName.taken', message: 'Another endpoint has this name.' })
            : undefined
        }
        {...common}
      />
      <TextField
        label={t({ id: 'sources.api.path', message: 'Path' })}
        description={t({
          id: 'sources.api.path.hint',
          message: 'Under the base address, like /orders.  Leave empty for the base address itself.',
        })}
        value={draft.path}
        onChange={(path) => change({ path })}
        {...common}
      />
      <TextArea
        label={t({ id: 'sources.api.query', message: 'Query parameters' })}
        description={t({
          id: 'sources.api.query.hint',
          message: 'One per line, as name=value.  Keep keys under Authentication, not here.',
        })}
        value={draft.query}
        onChange={(query) => change({ query })}
        rows={2}
        className="rio-sources__pem"
        isDisabled={isDisabled}
      />
      <TextField
        label={t({ id: 'sources.api.records', message: 'Records at' })}
        description={t({
          id: 'sources.api.records.hint',
          message:
            'Where each answer holds its list of records, like data.items.  Leave empty when the answer is the list.',
        })}
        value={draft.records}
        onChange={(records) => change({ records })}
        {...common}
      />
      {paging}
      <Disclosure>
        <DisclosureTrigger level={4}>
          <Trans id="sources.advanced">Advanced</Trans>
        </DisclosureTrigger>
        <DisclosurePanel>
          <div className="rio-sources__group">
            <NumberField
              label={t({ id: 'sources.api.maxPages', message: 'Page limit' })}
              description={t({
                id: 'sources.api.maxPages.hint',
                message:
                  'A sync that finds more pages than this stops and says so, instead of paging forever.',
              })}
              value={draft.maxPages}
              onChange={(maxPages) => change({ maxPages })}
              minValue={1}
              maxValue={100_000}
              isRequired
              isDisabled={isDisabled}
            />
            <NumberField
              label={t({ id: 'sources.api.maxRecords', message: 'Record limit' })}
              value={draft.maxRecords}
              onChange={(maxRecords) => change({ maxRecords })}
              minValue={1}
              maxValue={10_000_000}
              isRequired
              isDisabled={isDisabled}
            />
            <NumberField
              label={t({ id: 'sources.api.flattenDepth', message: 'Nested levels as columns' })}
              description={t({
                id: 'sources.api.flattenDepth.hint',
                message:
                  'How many levels of nested objects become columns like customer.name.  Deeper ones stay JSON.',
              })}
              value={draft.flattenDepth}
              onChange={(flattenDepth) => change({ flattenDepth })}
              minValue={0}
              maxValue={REST_LIMITS.flattenDepth}
              isRequired
              isDisabled={isDisabled}
            />
            <Select
              label={t({ id: 'sources.api.arrays', message: 'Lists of values' })}
              selectedKey={draft.arrays}
              onSelectionChange={(key) => {
                if (key === 'text' || key === 'json') change({ arrays: key });
              }}
              isDisabled={isDisabled}
            >
              <ListBoxItem id="text">{i18n._(ARRAY_LABELS.text)}</ListBoxItem>
              <ListBoxItem id="json">{i18n._(ARRAY_LABELS.json)}</ListBoxItem>
            </Select>
          </div>
        </DisclosurePanel>
      </Disclosure>
      <EndpointPreview endpoint={endpoint} run={preview} blocked={previewBlocked} />
      <div className="rio-sources__endpoint-actions">
        <Button size="sm" isDisabled={isDisabled} onPress={onCancel}>
          <Trans id="sources.api.endpoint.cancel">Cancel</Trans>
        </Button>
        <Button size="sm" variant="primary" isDisabled={isDisabled || !endpoint || taken} onPress={onDone}>
          <Trans id="sources.api.endpoint.done">Done</Trans>
        </Button>
      </div>
    </div>
  );
}

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; preview: SourcePreview }
  | { status: 'failed'; messageKey: string; params?: Record<string, string | number | boolean> };

/** A preview value as plain text: empty for no value, and lists joined with commas. */
function plainValue(value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/**
 * The endpoint's first page, asked for again a moment after its settings stop changing, with each
 * column's name and the type Riosoma would give it.
 */
function EndpointPreview({
  endpoint,
  run,
  blocked,
}: {
  endpoint: RestEndpoint | null;
  run: EndpointPreviewer | null;
  blocked: string | undefined;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  // Each answer remembers what it answered, so a changed endpoint or sign-in never shows an old one.
  const [answer, setAnswer] = useState<{ key: string; run: EndpointPreviewer; state: PreviewState } | null>(
    null,
  );
  const key = endpoint && run && !blocked ? JSON.stringify(endpoint) : null;
  useEffect(() => {
    if (key === null || !endpoint || !run) return;
    const abort = new AbortController();
    const settle = (state: PreviewState) => {
      if (!abort.signal.aborted) setAnswer({ key, run, state });
    };
    const timer = setTimeout(() => {
      run(endpoint, abort.signal)
        .then((preview) => settle({ status: 'done', preview }))
        .catch((error: unknown) =>
          settle(
            error instanceof ApiError
              ? { status: 'failed', messageKey: error.info.messageKey, params: error.info.params }
              : { status: 'failed', messageKey: 'errors.internal' },
          ),
        );
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
    // The endpoint is compared by its settings, which the key holds, not by the object carrying them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, run]);
  const state: PreviewState =
    key === null
      ? { status: 'idle' }
      : answer?.key === key && answer.run === run
        ? answer.state
        : { status: 'loading' };

  const label = t({ id: 'sources.api.preview', message: 'First page' });
  return (
    <section
      className="rio-sources__endpoint-preview"
      aria-label={label}
      aria-busy={state.status === 'loading'}
    >
      <Text className="rio-sources__endpoint-preview-title">{label}</Text>
      {blocked ? (
        <Text variant="muted">{blocked}</Text>
      ) : !endpoint ? (
        <Text variant="muted">
          <Trans id="sources.api.preview.incomplete">Fill in the endpoint to see its first page.</Trans>
        </Text>
      ) : state.status === 'loading' ? (
        <Spinner />
      ) : state.status === 'failed' ? (
        <Banner tone="danger">{message(state.messageKey, state.params)}</Banner>
      ) : state.status === 'done' ? (
        <>
          <Text variant="muted">
            {t({
              id: 'sources.api.preview.count',
              message: plural(state.preview.rows.length, {
                one: '# record on the first page.',
                other: '# records on the first page.',
              }),
            })}
          </Text>
          {state.preview.columns.length ? (
            <div
              className="rio-sources__preview"
              role="region"
              tabIndex={0}
              aria-label={t({ id: 'sources.api.preview.records', message: 'First page’s records' })}
            >
              <table>
                <thead>
                  <tr>
                    {state.preview.columns.map((column) => {
                      const spec = column.suggested ? FieldSpec.safeParse(column.suggested) : null;
                      return (
                        <th key={column.name} scope="col">
                          <span className="rio-sources__preview-cell">{column.name}</span>
                          {spec?.success ? (
                            <span className="rio-sources__preview-type">
                              {i18n._(fieldTypeInfo(spec.data.type).name)}
                            </span>
                          ) : null}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {state.preview.rows.slice(0, PREVIEW_ROWS).map((row, index) => (
                    <tr key={index}>
                      {state.preview.columns.map((_column, position) => (
                        <td key={position}>
                          <span className="rio-sources__preview-cell">{plainValue(row[position])}</span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
