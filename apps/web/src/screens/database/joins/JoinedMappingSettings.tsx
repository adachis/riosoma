import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  FieldCreate,
  joinedFieldSpec,
  joinedSources,
  mappedFieldSpec,
  newId,
  type TableMeta,
} from '@riosoma/contracts';
import { Button, DialogBody, DialogFooter } from '@riosoma/ui';
import { useSchema, type DatabaseSession } from '../../../data';
import { reportError } from '../../../grid/view/actions';
import { uniqueNames } from '../../import/columns';
import { ColumnMappings, type MappingDraft } from './ColumnMappings';

export function JoinedMappingSettings({
  session,
  table,
  onClose,
}: {
  session: DatabaseSession;
  table: TableMeta;
  onClose(): void;
}) {
  const { t } = useLingui();
  const schema = useSchema(session)!;
  const joined = table.joined!;
  const [mappings, setMappings] = useState<MappingDraft[]>(
    joined.fields
      .filter((mapping) => mapping.sources)
      .map((mapping) => ({
        sources: joinedSources(mapping),
        name: schema.fieldById.get(mapping.outputFieldId)!.name,
      })),
  );
  const [included, setIncluded] = useState(
    joined.fields.flatMap((mapping) => joinedSources(mapping).map((source) => source.fieldId)),
  );
  const [pending, setPending] = useState(false);
  async function save() {
    const sources = [...new Set(included)].flatMap((id) => schema.fieldById.get(id) ?? []);
    const groups = sources.flatMap((field) => {
      const mapping = mappings.find((item) => item.sources.some((source) => source.fieldId === field.id));
      if (
        mapping &&
        sources.find((item) => mapping.sources.some((source) => source.fieldId === item.id))?.id !== field.id
      )
        return [];
      return [
        {
          sources: mapping?.sources ?? [{ tableId: field.tableId, fieldId: field.id }],
          name:
            mapping?.name ??
            schema.fieldById.get(
              joined.fields.find((item) => !item.sources && item.fieldId === field.id)?.outputFieldId ?? '',
            )?.name ??
            field.name,
        },
      ];
    });
    const used = new Set<string>();
    const output = groups.map((group) => {
      const prior = joined.fields.find(
        (mapping) =>
          !used.has(mapping.outputFieldId) &&
          joinedSources(mapping).some((source) =>
            group.sources.some((item) => item.fieldId === source.fieldId),
          ),
      );
      const id = prior?.outputFieldId ?? newId('field');
      used.add(id);
      const fields = group.sources.map((source) => schema.fieldById.get(source.fieldId)!);
      const previous = schema.fieldById.get(id);
      const unchangedSources =
        prior &&
        joinedSources(prior).length === group.sources.length &&
        joinedSources(prior).every((source) => group.sources.some((item) => item.fieldId === source.fieldId));
      const spec =
        previous && unchangedSources
          ? { type: previous.type, options: previous.options }
          : previous
            ? mappedFieldSpec([...fields, previous])
            : fields.length > 1
              ? mappedFieldSpec(fields)
              : joinedFieldSpec(fields[0]!);
      return {
        ...previous,
        ...spec!,
        id,
        name: group.name,
        description: schema.fieldById.get(id)?.description ?? '',
      };
    });
    // Existing names keep their spelling even if a newly named output collides with them.
    const retained = output.filter((field) => schema.fieldById.get(field.id)?.name === field.name);
    const renamed = output.filter((field) => !retained.includes(field));
    const names = uniqueNames(
      [...retained, ...renamed].map((field) => field.name),
      () => table.name,
    );
    renamed.forEach((field, index) => {
      field.name = names[retained.length + index]!;
    });
    setPending(true);
    try {
      const result = await session.run([
        {
          kind: 'table.update',
          tableId: table.id,
          joinedFields: output.map((field) => FieldCreate.parse(field)),
          joined: {
            ...joined,
            fields: groups.map((group, index) => ({
              ...group.sources[0]!,
              outputFieldId: output[index]!.id,
              ...(group.sources.length > 1 ? { sources: group.sources } : {}),
            })),
          },
        },
      ]).done;
      if (!result.rejected) onClose();
    } catch (error) {
      reportError(error);
    } finally {
      setPending(false);
    }
  }
  const visible = included.every((id) => schema.fieldById.has(id));
  return (
    <>
      <DialogBody className="rio-joined-form">
        <ColumnMappings
          showTitle={false}
          session={session}
          input={joined}
          mappings={mappings}
          onChange={setMappings}
          onInclude={(ids) => setIncluded((current) => [...new Set([...current, ...ids])])}
        />
      </DialogBody>
      <DialogFooter>
        {pending && (
          <p role="status">
            {t({
              id: 'joined.mapping.saving',
              message: 'Saving column mappings and refreshing joined rows…',
            })}
          </p>
        )}
        <Button
          variant="primary"
          isPending={pending}
          isDisabled={!visible}
          onPress={() => {
            void save();
          }}
        >
          {t({ id: 'field.dialog.save', message: 'Save' })}
        </Button>
      </DialogFooter>
    </>
  );
}
