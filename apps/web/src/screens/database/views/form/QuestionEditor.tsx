import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  AttachmentMeta,
  ErrorBody,
  idsOf,
  LIMITS,
  type CellValue,
  type CellValues,
  type FieldMeta,
} from '@riosoma/contracts';
import { Button, FilterableList } from '@riosoma/ui';
import { ApiError, currentCsrfToken, guardRequest } from '../../../../api';
import type { DatabaseSession } from '../../../../data/types';
import { useServerMessage } from '../../../../messages/useServerMessage';
import { formatCell, type FormatContext } from '../../../../grid/format';
import { createLinkedRecord, LinkPicker } from '../../../../grid/editors/LinkEditor';
import { AnswerEditor } from './AnswerEditor';

interface QuestionEditorProps {
  disabled?: boolean;
  field: FieldMeta;
  value: CellValue;
  values?: Readonly<Record<string, unknown>>;
  format: FormatContext;
  session: DatabaseSession;
  labelId: string;
  onChange: (fieldId: string, value: CellValue) => void;
  onUploading: (busy: boolean) => void;
}

export function QuestionEditor(props: QuestionEditorProps) {
  const { t } = useLingui();
  const { field, value, format, session, labelId, onChange, disabled } = props;
  if (field.type === 'link')
    return (
      <LinkPicker
        readOnly={disabled}
        field={field}
        selected={idsOf(value)}
        currentValues={props.values as CellValues | undefined}
        format={format}
        session={session}
        expanded={false}
        onChange={(ids) => onChange(field.id, ids)}
        onCreate={(name) => {
          if (disabled) return;
          const selected = idsOf(value);
          const id = createLinkedRecord(session, field, undefined, name, selected, format);
          if (id) onChange(field.id, field.options.prefersSingle ? [id] : [...selected, id]);
          return id;
        }}
      />
    );
  if (field.type === 'attachment') return <AttachmentQuestion {...props} />;
  if (field.type === 'user' && format.collaborators.size > 10)
    return (
      <FilterableList
        isDisabled={disabled}
        listId={`form.members:${field.id}`}
        label={field.name}
        aria-labelledby={labelId}
        items={[...format.collaborators].map(([id, person]) => ({
          id,
          name: person.name,
          description: person.email,
          searchText: `${person.name} ${person.email ?? ''}`,
        }))}
        selectionMode={field.options.allowMultiple ? 'multiple' : 'single'}
        selectedKeys={idsOf(value)}
        onSelectionChange={(keys) => onChange(field.id, [...keys].map(String))}
      />
    );
  if (field.type === 'user')
    return (
      <select
        disabled={disabled}
        className="rio-form-view__select"
        aria-labelledby={labelId}
        multiple={field.options.allowMultiple}
        value={field.options.allowMultiple ? idsOf(value) : (idsOf(value)[0] ?? '')}
        onChange={(event) =>
          onChange(
            field.id,
            [...event.currentTarget.selectedOptions].map((option) => option.value).filter(Boolean),
          )
        }
      >
        {!field.options.allowMultiple && (
          <option value="">{t({ id: 'form.choosePerson', message: 'Choose a person' })}</option>
        )}
        {[...format.collaborators].map(([id, person]) => (
          <option key={id} value={id}>
            {person.name}
          </option>
        ))}
      </select>
    );
  const editor = (
    <AnswerEditor
      disabled={disabled}
      session={session}
      values={props.values}
      field={field}
      value={value}
      format={format}
      labelId={labelId}
      onChange={onChange}
    />
  );
  // Custom lists stay focusable for scrolling while their options are disabled.
  return field.type === 'lineItems' ? (
    editor
  ) : (
    <fieldset disabled={disabled} className="rio-form-view__editor">
      {editor}
    </fieldset>
  );
}

function AttachmentQuestion({
  field,
  value,
  format,
  labelId,
  onChange,
  onUploading,
  disabled,
}: QuestionEditorProps) {
  const { t } = useLingui();
  const message = useServerMessage();
  const [files, setFiles] = useState<ReadonlyMap<string, AttachmentMeta>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const busyCallback = useRef(onUploading);
  useEffect(() => {
    busyCallback.current = onUploading;
  }, [onUploading]);
  useEffect(
    () => () => {
      request.current?.abort();
      busyCallback.current(false);
    },
    [],
  );
  const ids = idsOf(value);

  async function upload(selected: File[]) {
    if (disabled || busy || !selected.length) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    onUploading(true);
    setError('');
    const uploaded: AttachmentMeta[] = [];
    try {
      for (const file of selected.slice(0, LIMITS.attachmentsPerCell - ids.length)) {
        const path = `/api/tables/${field.tableId}/fields/${field.id}/files`;
        guardRequest('POST', path);
        const response = await fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          body: file,
          signal: controller.signal,
          headers: {
            'x-file-name': encodeURIComponent(file.name),
            'x-csrf-token': currentCsrfToken() ?? '',
            'content-type': file.type || 'application/octet-stream',
          },
        });
        const body: unknown = await response.json();
        if (!response.ok) {
          const parsed = ErrorBody.safeParse(body);
          throw new ApiError(
            response.status,
            parsed.success
              ? parsed.data.error
              : { code: 'internal', messageKey: 'errors.internal', userFault: false },
          );
        }
        uploaded.push(AttachmentMeta.parse(body));
      }
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          message(
            reason instanceof ApiError ? reason.info.messageKey : 'errors.offline',
            reason instanceof ApiError ? reason.info.params : undefined,
          ),
        );
    } finally {
      if (!controller.signal.aborted) {
        setFiles((previous) => new Map([...previous, ...uploaded.map((file) => [file.id, file] as const)]));
        if (uploaded.length) onChange(field.id, [...ids, ...uploaded.map((file) => file.id)]);
        setBusy(false);
        onUploading(false);
      }
    }
  }

  return (
    <div aria-busy={busy}>
      <input
        className="rio-form-view__file"
        type="file"
        multiple
        aria-labelledby={labelId}
        aria-describedby={`${labelId}-upload-error`}
        disabled={disabled || busy || ids.length >= LIMITS.attachmentsPerCell}
        onChange={(event) => {
          const selected = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = '';
          void upload(selected);
        }}
      />
      <div className="rio-form-view__attachments">
        {ids.map((id) => {
          const name = files.get(id)?.name ?? formatCell(field, [id], format);
          return (
            <div key={id}>
              <span>{name}</span>
              <Button
                isDisabled={disabled || busy}
                onPress={() =>
                  onChange(
                    field.id,
                    ids.filter((selected) => selected !== id),
                  )
                }
                aria-label={t({ id: 'form.removeFile', message: `Remove ${name}` })}
                icon={faXmark}
              />
            </div>
          );
        })}
      </div>
      <div id={`${labelId}-upload-error`} className="rio-form-view__error" role="alert">
        {error}
      </div>
    </div>
  );
}
