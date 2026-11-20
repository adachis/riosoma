import { useState, useSyncExternalStore } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { idsOf, type SiteSettings } from '@riosoma/contracts';
import { Select, ListBoxItem, TextField } from '@riosoma/ui';
import type { DatabaseSession, SchemaState } from '../../../data/types';

export function AttachmentPicker({
  label,
  value,
  onChange,
  session,
  schema,
  kind = 'image',
}: {
  label: string;
  value: SiteSettings['favicon'];
  onChange(value: SiteSettings['favicon']): void;
  session: DatabaseSession;
  schema: SchemaState;
  kind?: 'image' | 'video';
}) {
  const { t } = useLingui();
  const [fieldId, setFieldId] = useState(value?.fieldId ?? '');
  const [recordId, setRecordId] = useState(value?.recordId ?? '');
  const [search, setSearch] = useState('');
  const fields = [...schema.fieldById.values()].filter((field) => field.type === 'attachment');
  const field = schema.fieldById.get(fieldId);
  const records = useQuery({
    queryKey: ['siteImages', field?.tableId, search],
    enabled: Boolean(field),
    queryFn: () => session.searchRecords(field!.tableId, search),
  });
  const record = useQuery({
    queryKey: ['siteImageRecord', field?.tableId, recordId],
    enabled: Boolean(field && recordId),
    queryFn: () => session.getRecord(field!.tableId, recordId),
  });
  const files = idsOf(record.data?.values[fieldId] ?? null);
  useSyncExternalStore(
    (listener) => session.subscribeAttachments(listener),
    () => files.map((id) => session.attachments.get(id)?.name ?? '').join('|'),
  );
  return (
    <fieldset>
      <legend>{label}</legend>
      <div>
        {fields.length > 10 ? (
          <Select
            label={t({ id: 'sites.imageField', message: 'Attachment field' })}
            selectedKey={fieldId}
            onSelectionChange={(key) => {
              setFieldId(String(key ?? ''));
              setRecordId('');
              onChange(null);
            }}
          >
            <ListBoxItem id="">{t({ id: 'sites.noMedia', message: 'No attachment' })}</ListBoxItem>
            {fields.map((item) => (
              <ListBoxItem
                key={item.id}
                id={item.id}
                textValue={item.name}
                group={item.tableId}
                groupName={schema.tableById.get(item.tableId)?.name}
              >
                {schema.tableById.get(item.tableId)?.name} / {item.name}
              </ListBoxItem>
            ))}
          </Select>
        ) : (
          <label>
            {t({ id: 'sites.imageField', message: 'Attachment field' })}
            <select
              value={fieldId}
              onChange={(event) => {
                setFieldId(event.target.value);
                setRecordId('');
                onChange(null);
              }}
            >
              <option value="">{t({ id: 'sites.noMedia', message: 'No attachment' })}</option>
              {fields.map((item) => (
                <option key={item.id} value={item.id}>
                  {schema.tableById.get(item.tableId)?.name} / {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {field ? (
        <>
          <TextField
            label={t({ id: 'sites.findImage', message: 'Find a record' })}
            value={search}
            onChange={setSearch}
          />
          <div>
            {(records.data?.length ?? 0) > 10 ? (
              <Select
                label={t({ id: 'sites.imageRecord', message: 'Record' })}
                selectedKey={recordId}
                onSelectionChange={(key) => {
                  setRecordId(String(key ?? ''));
                  onChange(null);
                }}
              >
                <ListBoxItem id="">{t({ id: 'ui.select.placeholder', message: 'Choose…' })}</ListBoxItem>
                {records.data?.map((item) => (
                  <ListBoxItem key={item.id} id={item.id}>
                    {item.name}
                  </ListBoxItem>
                ))}
              </Select>
            ) : (
              <label>
                {t({ id: 'sites.imageRecord', message: 'Record' })}
                <select
                  value={recordId}
                  onChange={(event) => {
                    setRecordId(event.target.value);
                    onChange(null);
                  }}
                >
                  <option value=""></option>
                  {records.data?.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <label>
            {kind === 'video'
              ? t({ id: 'sites.videoFile', message: 'Video' })
              : t({ id: 'sites.imageFile', message: 'Image' })}
            <select
              value={value?.attachmentId ?? ''}
              onChange={(event) =>
                onChange(
                  event.target.value
                    ? { tableId: field.tableId, fieldId, recordId, attachmentId: event.target.value }
                    : null,
                )
              }
            >
              <option value="">{t({ id: 'sites.noMedia', message: 'No attachment' })}</option>
              {files
                .filter(
                  (id) =>
                    (kind === 'video'
                      ? ['video/mp4', 'video/webm', 'video/ogg']
                      : ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/x-icon']
                    ).includes(session.attachments.get(id)?.type ?? '') &&
                    (kind === 'video' || (session.attachments.get(id)?.size ?? Infinity) <= 5 * 1024 * 1024),
                )
                .map((id) => (
                  <option key={id} value={id}>
                    {session.attachments.get(id)?.name}
                  </option>
                ))}
            </select>
          </label>
        </>
      ) : null}
    </fieldset>
  );
}
