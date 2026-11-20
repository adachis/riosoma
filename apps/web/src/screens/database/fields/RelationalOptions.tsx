import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import {
  FieldSpec,
  readsSourceLive,
  ROLLUP_FUNCTIONS,
  type FieldMeta,
  type FieldType,
  type RollupFunction,
} from '@riosoma/contracts';
import { ListBoxItem, Select, Switch, TextField } from '@riosoma/ui';
import type { SchemaState } from '../../../data';
import { resultType } from '../../../data/formulas';
import { isMatchable } from '../joins/matched';
import { FilterEditor } from '../view/FilterEditor';
import { anchor } from '../../../demos/anchors';
import { LinkTableSelect } from './LinkTableSelect';
import { LinkChoiceOptions } from './LinkChoiceOptions';

const FUNCTIONS = {
  sum: msg({ id: 'field.rollup.fn.sum', message: 'Sum' }),
  average: msg({ id: 'field.rollup.fn.average', message: 'Average' }),
  min: msg({ id: 'field.rollup.fn.min', message: 'Minimum' }),
  max: msg({ id: 'field.rollup.fn.max', message: 'Maximum' }),
  count: msg({ id: 'field.rollup.fn.count', message: 'Count of values' }),
  countAll: msg({ id: 'field.rollup.fn.countAll', message: 'Count of all' }),
  countUnique: msg({ id: 'field.rollup.fn.countUnique', message: 'Count of unique values' }),
  and: msg({ id: 'field.rollup.fn.and', message: 'All true' }),
  or: msg({ id: 'field.rollup.fn.or', message: 'Any true' }),
  concatenate: msg({ id: 'field.rollup.fn.concatenate', message: 'Joined text' }),
  arrayUnique: msg({ id: 'field.rollup.fn.arrayUnique', message: 'Unique values' }),
  earliest: msg({ id: 'field.rollup.fn.earliest', message: 'Earliest' }),
  latest: msg({ id: 'field.rollup.fn.latest', message: 'Latest' }),
} satisfies Record<RollupFunction, ReturnType<typeof msg>>;

export function rollupFunctions(target?: FieldMeta): readonly RollupFunction[] {
  if (!target) return [];
  const type = resultType(target);
  return ROLLUP_FUNCTIONS.filter((fn) => {
    if (fn === 'sum' || fn === 'average') return type === 'number';
    if (fn === 'and' || fn === 'or') return type === 'boolean';
    if (fn === 'earliest' || fn === 'latest') return type === 'date' || type === 'datetime';
    return true;
  });
}

function rollupResult(fn: RollupFunction, target: FieldMeta) {
  if (['sum', 'average', 'count', 'countAll', 'countUnique'].includes(fn)) return 'number' as const;
  if (fn === 'and' || fn === 'or') return 'boolean' as const;
  if (fn === 'concatenate') return 'text' as const;
  if (fn === 'arrayUnique') return 'array' as const;
  return resultType(target);
}

export function relationalSpec(spec: FieldSpec, schema?: SchemaState): FieldSpec {
  if (spec.type !== 'lookup' && spec.type !== 'rollup') return spec;
  const target = schema?.fieldById.get(spec.options.targetFieldId);
  if (!target) return spec;
  if (spec.type === 'lookup')
    return { ...spec, options: { ...spec.options, resultType: resultType(target) } };
  return { ...spec, options: { ...spec.options, resultType: rollupResult(spec.options.fn, target) } };
}

export function initialSpec(
  type: FieldType,
  schema?: SchemaState,
  tableId?: string,
  selfId?: string,
): FieldSpec {
  const link = schema?.fields
    .get(tableId ?? '')
    ?.find(
      (field): field is Extract<FieldMeta, { type: 'link' | 'lineItems' }> =>
        (field.type === 'link' || field.type === 'lineItems') && field.id !== selfId,
    );
  const linkFieldId = link?.id ?? '';
  const targetFieldId = link ? (schema?.fields.get(link.options.linkedTableId)?.[0]?.id ?? '') : '';
  switch (type) {
    case 'link':
      return {
        type,
        options: {
          linkedTableId: schema?.tables.find((table) => !readsSourceLive(table.source))?.id ?? '',
          inverseFieldId: null,
          prefersSingle: false,
        },
      };
    case 'count':
      return { type, options: { linkFieldId } };
    case 'lookup':
      return relationalSpec({ type, options: { linkFieldId, targetFieldId, resultType: 'array' } }, schema);
    case 'rollup':
      return {
        type,
        options: { linkFieldId, targetFieldId, resultType: 'number', precision: null, fn: 'count' },
      };
    default:
      return FieldSpec.parse({ type });
  }
}

export function RelationalOptions({
  spec,
  schema,
  tableId,
  fieldId,
  onChange,
}: {
  spec: Extract<FieldSpec, { type: 'link' | 'lookup' | 'rollup' | 'count' }>;
  schema?: SchemaState;
  tableId?: string;
  fieldId?: string;
  onChange: (options: FieldSpec['options']) => void;
}) {
  const { t, i18n } = useLingui();
  if (spec.type === 'link') {
    const { match, ...ordinary } = spec.options;
    // Links that follow values pair a field here with one in the linked table, of kinds that hold keys.
    const followable = (id: string) =>
      (schema?.fields.get(id) ?? []).filter((field) => field.id !== fieldId && isMatchable(field));
    return (
      <>
        <LinkTableSelect options={spec.options} schema={schema} onChange={onChange} />
        <Switch
          {...anchor('field.link.multiple')}
          isSelected={!spec.options.prefersSingle}
          onChange={(multiple) => onChange({ ...spec.options, prefersSingle: !multiple })}
        >
          {t({ id: 'field.link.multiple', message: 'Allow linking to more than one record' })}
        </Switch>
        <Switch
          isSelected={Boolean(match)}
          onChange={(on) =>
            onChange(
              on
                ? {
                    ...ordinary,
                    filter: undefined,
                    limitToViewId: undefined,
                    match: { fieldId: '', linkedFieldId: '' },
                  }
                : ordinary,
            )
          }
        >
          {t({ id: 'field.link.match', message: 'Link by matching values' })}
        </Switch>
        <LinkChoiceOptions
          spec={spec}
          schema={schema}
          tableId={tableId}
          fieldId={fieldId}
          onChange={onChange}
        />
        {match && (
          <>
            {/* A graph source's relationships arrive as an array of the other node's IDs, which a
                link follows one string at a time. */}
            {(followable(tableId ?? '').some((field) => field.type === 'json') ||
              followable(spec.options.linkedTableId).some((field) => field.type === 'json')) && (
              <p>
                {t({
                  id: 'field.link.matchArray',
                  message: 'A JSON field matches each string in its array to one value in the other table.',
                })}
              </p>
            )}
            <Select
              label={t({ id: 'field.link.matchField', message: 'This table’s field' })}
              selectedKey={match.fieldId || null}
              onSelectionChange={(key) => {
                if (key !== null) onChange({ ...ordinary, match: { ...match, fieldId: String(key) } });
              }}
            >
              {followable(tableId ?? '').map((field) => (
                <ListBoxItem key={field.id} id={field.id}>
                  {field.name}
                </ListBoxItem>
              ))}
            </Select>
            <Select
              label={t({
                id: 'field.link.matchLinkedField',
                message: 'Matches this field in the linked table',
              })}
              selectedKey={match.linkedFieldId || null}
              isDisabled={!spec.options.linkedTableId}
              onSelectionChange={(key) => {
                if (key !== null) onChange({ ...ordinary, match: { ...match, linkedFieldId: String(key) } });
              }}
            >
              {followable(spec.options.linkedTableId).map((field) => (
                <ListBoxItem key={field.id} id={field.id}>
                  {field.name}
                </ListBoxItem>
              ))}
            </Select>
          </>
        )}
      </>
    );
  }
  const links =
    schema?.fields
      .get(tableId ?? '')
      ?.filter(
        (field): field is Extract<FieldMeta, { type: 'link' | 'lineItems' }> =>
          (field.type === 'link' || field.type === 'lineItems') && field.id !== fieldId,
      ) ?? [];
  const link = links.find((field) => field.id === spec.options.linkFieldId);
  // A button holds nothing to look up or roll up.
  const targets =
    (link ? schema?.fields.get(link.options.linkedTableId) : [])?.filter(
      (field) => field.id !== fieldId && field.type !== 'button',
    ) ?? [];
  const target =
    spec.type === 'count' ? undefined : targets.find((field) => field.id === spec.options.targetFieldId);
  const functions = rollupFunctions(target);
  return (
    <>
      <Select
        label={
          spec.type === 'count'
            ? t({ id: 'field.count.link', message: 'Count links in' })
            : t({ id: 'field.lookup.link', message: 'Linked field' })
        }
        selectedKey={spec.options.linkFieldId || null}
        onSelectionChange={(key) => {
          if (key === null) return;
          onChange(
            spec.type === 'count'
              ? { linkFieldId: String(key) }
              : {
                  ...spec.options,
                  filter: undefined,
                  sort: undefined,
                  linkFieldId: String(key),
                  targetFieldId: '',
                },
          );
        }}
      >
        {links.map((field) => (
          <ListBoxItem key={field.id} id={field.id}>
            {field.name}
          </ListBoxItem>
        ))}
      </Select>
      {spec.type !== 'count' && (
        <Select
          label={
            spec.type === 'lookup'
              ? t({ id: 'field.lookup.target', message: 'Field to look up' })
              : t({ id: 'field.rollup.target', message: 'Field to summarize' })
          }
          selectedKey={spec.options.targetFieldId || null}
          isDisabled={!link}
          onSelectionChange={(key) => {
            const target = targets.find((field) => field.id === key);
            if (!target) return;
            const allowed = rollupFunctions(target);
            onChange(
              relationalSpec(
                {
                  ...spec,
                  options: {
                    ...spec.options,
                    targetFieldId: target.id,
                    ...(spec.type === 'rollup' && !allowed.includes(spec.options.fn)
                      ? { fn: allowed[0]! }
                      : {}),
                  },
                } as FieldSpec,
                schema,
              ).options,
            );
          }}
        >
          {targets.map((field) => (
            <ListBoxItem key={field.id} id={field.id}>
              {field.name}
            </ListBoxItem>
          ))}
        </Select>
      )}
      {spec.type === 'rollup' && (
        <Select
          label={t({ id: 'field.rollup.fn', message: 'Summary' })}
          selectedKey={functions.includes(spec.options.fn) ? spec.options.fn : null}
          isDisabled={!target}
          onSelectionChange={(key) => {
            const fn = functions.find((fn) => fn === key);
            if (fn) onChange(relationalSpec({ ...spec, options: { ...spec.options, fn } }, schema).options);
          }}
        >
          {functions.map((fn) => (
            <ListBoxItem key={fn} id={fn}>
              {i18n._(FUNCTIONS[fn])}
            </ListBoxItem>
          ))}
        </Select>
      )}
      {link && (
        <fieldset className="rio-relational-filter">
          <legend>{t({ id: 'field.lookup.filter', message: 'Include linked records that match' })}</legend>
          <FilterEditor
            fields={targets}
            currentFields={(schema?.fields.get(tableId ?? '') ?? []).filter((item) => item.id !== fieldId)}
            value={spec.options.filter ?? null}
            onChange={(filter) => {
              const { filter: _filter, ...options } = spec.options;
              onChange(filter ? { ...options, filter } : options);
            }}
          />
        </fieldset>
      )}
      {spec.type === 'lookup' && link && (
        <>
          <Select
            label={t({ id: 'field.lookup.sort', message: 'Sort linked records by' })}
            selectedKey={spec.options.sort?.[0]?.fieldId ?? 'linkOrder'}
            onSelectionChange={(key) => {
              const { sort: _sort, ...options } = spec.options;
              onChange(
                key === 'linkOrder'
                  ? options
                  : { ...options, sort: [{ fieldId: String(key), direction: 'asc' }] },
              );
            }}
          >
            <ListBoxItem id="linkOrder">
              {t({ id: 'field.lookup.linkOrder', message: 'Link order' })}
            </ListBoxItem>
            {targets.map((item) => (
              <ListBoxItem key={item.id} id={item.id}>
                {item.name}
              </ListBoxItem>
            ))}
          </Select>
          {spec.options.sort?.length ? (
            <Select
              label={t({ id: 'field.lookup.direction', message: 'Sort direction' })}
              selectedKey={spec.options.sort[0]!.direction}
              onSelectionChange={(key) =>
                onChange({
                  ...spec.options,
                  sort: [{ ...spec.options.sort![0]!, direction: key === 'desc' ? 'desc' : 'asc' }],
                })
              }
            >
              <ListBoxItem id="asc">{t({ id: 'field.lookup.ascending', message: 'Ascending' })}</ListBoxItem>
              <ListBoxItem id="desc">
                {t({ id: 'field.lookup.descending', message: 'Descending' })}
              </ListBoxItem>
            </Select>
          ) : null}
          <TextField
            label={t({ id: 'field.lookup.limit', message: 'Maximum linked records' })}
            type="number"
            value={spec.options.limit?.toString() ?? ''}
            onChange={(value) => {
              const { limit: _limit, ...options } = spec.options;
              onChange(value === '' ? options : { ...options, limit: Number(value) });
            }}
          />
        </>
      )}
    </>
  );
}
