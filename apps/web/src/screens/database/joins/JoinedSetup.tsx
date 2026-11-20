import { ColumnMappings, type MappingDraft } from './ColumnMappings';
import { faPlus, faTrash } from '@fortawesome/free-solid-svg-icons';
import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import {
  joinedFieldSpec,
  mappedFieldSpec,
  newId,
  type JoinedTable,
  type JoinSuggestions,
  type TableCreate,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Checkbox,
  DialogBody,
  DialogFooter,
  ListBoxItem,
  Select,
  TextField,
} from '@riosoma/ui';
import { api } from '../../../api';
import { useSchema, type DatabaseSession } from '../../../data';
import { reportError } from '../../../grid/view/actions';
import { uniqueNames } from '../../import/columns';

const matchable = new Set(['text', 'email', 'url', 'phone', 'number', 'autoNumber', 'recordId']);

export function JoinedSetup({
  session,
  tableId,
  onCreated,
}: {
  session: DatabaseSession;
  tableId: string;
  onCreated(tableId: string): void;
}) {
  const { t } = useLingui();
  const schema = useSchema(session)!;
  const [name, setName] = useState(t({ id: 'joined.defaultName', message: 'Joined table' }));
  const [base, setBase] = useState(tableId);
  const [steps, setSteps] = useState<JoinedTable['steps']>([
    { tableId: '', leftTableId: tableId, leftFieldId: '', rightFieldId: '', kind: 'left' },
  ]);
  const [mappings, setMappings] = useState<MappingDraft[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const suggestions = useQuery({
    queryKey: ['join-suggestions', session.databaseId, 'joined'],
    queryFn: ({ signal }) =>
      api<JoinSuggestions>(`/api/databases/${session.databaseId}/join-suggestions`, {
        method: 'POST',
        body: {},
        signal,
      }),
    retry: false,
  });
  const inputs = [base, ...steps.map((step) => step.tableId)].filter(Boolean);
  const fields = inputs.flatMap((id) => schema.fields.get(id) ?? []);
  const chosen = fields.filter((field) => selected.includes(field.id) && field.type !== 'button');
  const fieldLabel = (table: string, field: string) =>
    t({ id: 'joined.fieldLabel', message: `${table} ${field}` });
  const ready =
    name.trim() &&
    chosen.length &&
    steps.every((step) => step.tableId && step.leftFieldId && step.rightFieldId) &&
    new Set(inputs).size === inputs.length;
  const update = (index: number, patch: Partial<JoinedTable['steps'][number]>) =>
    setSteps((current) => current.map((step, at) => (at === index ? { ...step, ...patch } : step)));
  async function save() {
    if (!ready) return;
    const active = mappings.filter((mapping) =>
      mapping.sources.every((source) => chosen.some((field) => field.id === source.fieldId)),
    );
    const groups = chosen.flatMap((field) => {
      const mapping = active.find((item) => item.sources.some((source) => source.fieldId === field.id));
      if (
        mapping &&
        chosen.find((item) => mapping.sources.some((source) => source.fieldId === item.id))?.id !== field.id
      )
        return [];
      return [
        {
          sources: mapping?.sources ?? [{ tableId: field.tableId, fieldId: field.id }],
          name: mapping?.name ?? fieldLabel(schema.tableById.get(field.tableId)!.name, field.name),
        },
      ];
    });
    const names = uniqueNames(
      groups.map((group) => group.name),
      () => name,
    );
    const output = groups.map((group, index) => ({
      ...(group.sources.length > 1
        ? mappedFieldSpec(group.sources.map((source) => schema.fieldById.get(source.fieldId)!))!
        : joinedFieldSpec(schema.fieldById.get(group.sources[0]!.fieldId)!)),
      id: newId('field'),
      name: names[index]!,
      description: '',
    }));
    const id = newId('table');
    const table: TableCreate = {
      id,
      name,
      description: '',
      fields: output,
      records: [],
      view: { id: newId('view'), name: t({ id: 'joined.grid', message: 'Grid' }) },
      joined: {
        baseTableId: base,
        steps,
        fields: groups.map((group, index) => ({
          ...group.sources[0]!,
          ...(group.sources.length > 1 ? { sources: group.sources } : {}),
          outputFieldId: output[index]!.id,
        })),
      },
    };
    setPending(true);
    try {
      const result = await session.run([{ kind: 'table.create', table }]).done;
      if (!result.rejected) onCreated(id);
    } catch (error) {
      reportError(error);
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <DialogBody className="rio-joined-form">
        <p>
          {t({
            id: 'joined.help',
            message:
              'Combine rows by matching key values.  Changes to either table refresh the result.  Duplicate keys produce one row for each matching pair.',
          })}
        </p>
        <TextField
          label={t({ id: 'joined.name', message: 'Table name' })}
          value={name}
          onChange={setName}
          isRequired
        />
        <Select
          label={t({ id: 'joined.first', message: 'First table' })}
          selectedKey={base}
          onSelectionChange={(key) => {
            setBase(String(key));
            setSteps([
              { tableId: '', leftTableId: String(key), leftFieldId: '', rightFieldId: '', kind: 'left' },
            ]);
            setSelected([]);
            setMappings([]);
          }}
        >
          {schema.tables.map((table) => (
            <ListBoxItem id={table.id} key={table.id}>
              {table.name}
            </ListBoxItem>
          ))}
        </Select>
        {suggestions.isError && (
          <Banner tone="info">
            {t({
              id: 'joined.suggestionsUnavailable',
              message: 'Suggestions are unavailable.  You can choose matching fields below.',
            })}
          </Banner>
        )}
        {(suggestions.data?.suggestions ?? [])
          .filter((item) => item.fromTableId === base || item.toTableId === base)
          .slice(0, 6)
          .map((item) => {
            const forward = item.fromTableId === base;
            const other = forward ? item.toTableId : item.fromTableId;
            const leftFieldId = forward ? item.fromFieldId : item.toFieldId;
            const rightFieldId = forward ? item.toFieldId : item.fromFieldId;
            const left = schema.fieldById.get(leftFieldId)?.name ?? '';
            const right = schema.fieldById.get(rightFieldId)?.name ?? '';
            const table = schema.tableById.get(other)?.name ?? '';
            return (
              <Button
                key={`${leftFieldId}:${rightFieldId}`}
                size="sm"
                onPress={() => {
                  setSteps([{ tableId: other, leftTableId: base, leftFieldId, rightFieldId, kind: 'left' }]);
                }}
              >
                {t({ id: 'joined.suggestion', message: `Match ${left} with ${right} in ${table}` })}
              </Button>
            );
          })}
        {steps.map((step, index) => (
          <fieldset className="rio-joined-step" key={index}>
            <legend>{t({ id: 'joined.step', message: `Join ${index + 1}` })}</legend>
            <Select
              label={t({ id: 'joined.next', message: 'Next table' })}
              selectedKey={step.tableId || null}
              onSelectionChange={(key) => update(index, { tableId: String(key), rightFieldId: '' })}
            >
              {schema.tables
                .filter((table) => table.id === step.tableId || !inputs.includes(table.id))
                .map((table) => (
                  <ListBoxItem id={table.id} key={table.id}>
                    {table.name}
                  </ListBoxItem>
                ))}
            </Select>
            <Select
              label={t({ id: 'joined.leftKey', message: 'Key from an earlier table' })}
              selectedKey={step.leftFieldId || null}
              onSelectionChange={(key) => {
                const field = schema.fieldById.get(String(key));
                if (field) update(index, { leftFieldId: field.id, leftTableId: field.tableId });
              }}
            >
              {[base, ...steps.slice(0, index).map((item) => item.tableId)]
                .flatMap((id) => schema.fields.get(id) ?? [])
                .filter((field) => matchable.has(field.type))
                .map((field) => (
                  <ListBoxItem id={field.id} key={field.id}>
                    {fieldLabel(schema.tableById.get(field.tableId)!.name, field.name)}
                  </ListBoxItem>
                ))}
            </Select>
            <Select
              label={t({ id: 'joined.rightKey', message: 'Key from the next table' })}
              selectedKey={step.rightFieldId || null}
              onSelectionChange={(key) => update(index, { rightFieldId: String(key) })}
            >
              {(schema.fields.get(step.tableId) ?? [])
                .filter((field) => matchable.has(field.type))
                .map((field) => (
                  <ListBoxItem id={field.id} key={field.id}>
                    {field.name}
                  </ListBoxItem>
                ))}
            </Select>
            <Select
              label={t({ id: 'joined.kind', message: 'Rows to keep' })}
              selectedKey={step.kind}
              onSelectionChange={(key) => update(index, { kind: key as 'inner' | 'left' | 'full' })}
            >
              <ListBoxItem id="inner">
                {t({ id: 'joined.inner', message: 'Inner—matching rows' })}
              </ListBoxItem>
              <ListBoxItem id="left">
                {t({ id: 'joined.left', message: 'Left—all earlier rows' })}
              </ListBoxItem>
              <ListBoxItem id="full">
                {t({ id: 'joined.full', message: 'Full—all rows from both sides' })}
              </ListBoxItem>
            </Select>
            {index > 0 && (
              <Button
                size="sm"
                icon={faTrash}
                aria-label={t({ id: 'joined.removeStep', message: 'Remove this and later joins' })}
                onPress={() => setSteps((current) => current.slice(0, index))}
              />
            )}
          </fieldset>
        ))}
        <Button
          size="sm"
          isDisabled={steps.length >= 9 || !steps.at(-1)?.tableId}
          onPress={() =>
            setSteps((current) => [
              ...current,
              { tableId: '', leftTableId: base, leftFieldId: '', rightFieldId: '', kind: 'left' },
            ])
          }
          aria-label={t({ id: 'joined.addStep', message: 'Add another table' })}
          icon={faPlus}
        />
        <ColumnMappings
          session={session}
          input={{ baseTableId: base, steps }}
          mappings={mappings}
          onChange={setMappings}
          onInclude={(ids) => setSelected((current) => [...new Set([...current, ...ids])])}
        />
        <fieldset className="rio-joined-step">
          <legend>{t({ id: 'joined.fields', message: 'Fields to include' })}</legend>
          {fields
            .filter((field) => field.type !== 'button')
            .map((field) => (
              <Checkbox
                key={field.id}
                isSelected={selected.includes(field.id)}
                onChange={(checked) =>
                  setSelected((current) =>
                    checked ? [...current, field.id] : current.filter((id) => id !== field.id),
                  )
                }
              >
                {fieldLabel(schema.tableById.get(field.tableId)!.name, field.name)}
              </Checkbox>
            ))}
        </fieldset>
      </DialogBody>
      <DialogFooter>
        <Button
          variant="primary"
          isDisabled={!ready}
          isPending={pending}
          onPress={() => {
            void save();
          }}
        >
          {t({ id: 'joined.create', message: 'Create joined table' })}
        </Button>
      </DialogFooter>
    </>
  );
}
