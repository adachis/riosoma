import { useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { readsSourceLive, type FieldOptionsOf, type LinkTarget } from '@riosoma/contracts';
import { ListBoxItem, ListBoxSection, Select } from '@riosoma/ui';
import { api, ApiError } from '../../../api';
import type { SchemaState } from '../../../data';
import { anchor } from '../../../demos/anchors';
import { useServerMessage } from '../../../messages/useServerMessage';

export function LinkTableSelect({
  options,
  schema,
  onChange,
}: {
  options: FieldOptionsOf<'link'>;
  schema?: SchemaState;
  onChange: (options: FieldOptionsOf<'link'>) => void;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const [targets, setTargets] = useState<LinkTarget[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void api<LinkTarget[]>('/api/link-targets', { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setTargets(result);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof ApiError ? error.info.messageKey : 'errors.offline');
      });
    return () => controller.abort();
  }, []);
  const choices =
    targets ??
    (schema?.tables ?? [])
      .filter((table) => !readsSourceLive(table.source) && !table.joined)
      .map((table) => ({ table, database: schema!.database, canEditSchema: true }));
  const groups = new Map<string, { name: string; targets: LinkTarget[] }>();
  for (const target of choices) {
    let group = groups.get(target.database.id);
    if (!group) {
      group = { name: target.database.name, targets: [] };
      groups.set(target.database.id, group);
    }
    group.targets.push(target);
  }
  return (
    <>
      <Select
        {...anchor('field.link.table')}
        label={t({ id: 'field.link.table', message: 'Link to' })}
        filterable
        listId="link-targets"
        selectedKey={options.linkedTableId || null}
        onSelectionChange={(key) => {
          const target = choices.find((item) => item.table.id === key);
          if (!target) return;
          const { oneWay: _oneWay, ...ordinary } = options;
          onChange({
            ...ordinary,
            linkedTableId: target.table.id,
            inverseFieldId: null,
            filter: undefined,
            limitToViewId: undefined,
            displayFieldIds: undefined,
            ...(!target.canEditSchema ? { oneWay: true } : {}),
            ...(options.match ? { match: { fieldId: options.match.fieldId, linkedFieldId: '' } } : {}),
          });
        }}
      >
        {[...groups].map(([id, group]) => (
          <ListBoxSection key={id} title={group.name}>
            {group.targets.map(({ table }) => (
              <ListBoxItem
                key={table.id}
                id={table.id}
                textValue={table.name}
                group={id}
                groupName={group.name}
              >
                {table.name}
              </ListBoxItem>
            ))}
          </ListBoxSection>
        ))}
      </Select>
      {options.oneWay && (
        <p>
          {t({
            id: 'field.link.oneWay',
            message:
              'You can edit records in this database, but cannot change its structure.  This link will appear only in this table.',
          })}
        </p>
      )}
      {error && <p role="alert">{message(error)}</p>}
    </>
  );
}
