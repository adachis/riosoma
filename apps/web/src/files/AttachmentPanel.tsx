import { faXmark, faPlus } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { newId, type CommandBatchResult, type AttachmentMeta, type FieldMeta } from '@riosoma/contracts';
import { Icon } from '@riosoma/icons';
import { Button, ProgressBar, SortableItem, SortableList, moveList } from '@riosoma/ui';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError } from '../api';
import type { DatabaseSession } from '../data';
import { useServerMessage } from '../messages/useServerMessage';
import { AttachmentPreview } from './AttachmentPreview';
import { fileIcons, fileKind, fileSize } from './fileKind';
import { AddFromMenu } from './pickers/AddFromMenu';
import { attachmentUploads, FileTooLarge } from './upload';
import './attachments.css';

const noUploads = [] as const;
const emptyUploads = () => noUploads;
const noSubscribe = () => () => {};
const emptyDetails = new Map<string, AttachmentMeta>();

export function AttachmentPanel({
  field,
  recordId,
  ids,
  session,
  details = emptyDetails,
  locale,
  readOnly = false,
  layout = 'list',
  autoFocus = false,
  onSourceNavigate,
  onChange,
}: {
  field: FieldMeta;
  recordId: string;
  ids: readonly string[];
  session?: DatabaseSession;
  details?: ReadonlyMap<string, AttachmentMeta>;
  locale: string;
  readOnly?: boolean;
  layout?: 'list' | 'grid';
  autoFocus?: boolean;
  onSourceNavigate?(): void;
  onChange(ids: string[]): void;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const helpId = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const pendingUrl = useRef<{
    target: string;
    url: string;
    filename?: string;
    imageSearchToken?: string;
    id: string;
    groupId: string;
  } | null>(null);
  const [dropping, setDropping] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [uploads] = useState(() =>
    session ? attachmentUploads(session, field.tableId, field.id, recordId) : undefined,
  );
  const entries = useSyncExternalStore(uploads?.subscribe ?? noSubscribe, uploads?.snapshot ?? emptyUploads);
  const [, redraw] = useState(0);
  useEffect(() => session?.subscribeAttachments(() => redraw((value) => value + 1)), [session]);
  useEffect(() => {
    session?.ensureAttachments(ids);
  }, [session, ids]);
  const files = session?.attachments ?? details;
  const canUpload = !readOnly && uploads !== undefined;
  const add = (files: FileList | readonly File[]) => {
    if (canUpload) uploads.add(Array.from(files));
  };
  return (
    <div
      ref={root}
      className="rio-files"
      data-layout={layout}
      data-file-drop={dropping || undefined}
      role="group"
      aria-label={field.name}
      onDragOver={(event) => {
        if (!event.dataTransfer.types?.includes('Files')) return;
        event.preventDefault();
        setDropping(true);
        event.dataTransfer.dropEffect = canUpload ? 'copy' : 'none';
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(event) => {
        setDropping(false);
        if (readOnly) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer.files.length) add(event.dataTransfer.files);
      }}
      onPaste={(event) => {
        if (!canUpload || !event.clipboardData.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        add(event.clipboardData.files);
      }}
    >
      {dropping && (
        <p role="status">
          {canUpload
            ? t({ id: 'files.drop', message: 'Drop files to add them' })
            : t({ id: 'files.dropReadOnly', message: 'You cannot add files to this cell.' })}
        </p>
      )}
      {!ids.length && <p>{t({ id: 'files.empty', message: 'No files yet' })}</p>}
      <SortableList
        items={ids.map((id) => ({ id, name: files.get(id)?.name ?? id }))}
        disabledReason={
          readOnly ? t({ id: 'files.readOnly', message: 'You can only view these files.' }) : undefined
        }
        onMove={(from, to) => onChange([...moveList(ids, from, to)])}
      >
        <ul
          className="rio-files__list"
          aria-label={field.name}
          aria-describedby={readOnly ? undefined : helpId}
        >
          {ids.map((id, index) => {
            const file = files.get(id);
            const name = file?.name ?? id;
            const signature = file?.scanSignature ?? '';
            const size = file ? fileSize(file.size, locale) : '';
            return (
              <SortableItem
                key={id}
                id={id}
                as="li"
                className="rio-files__item"
                altMoveScope="row"
                renderWrapper={(props, children) => (
                  <li {...props} data-file-id={id}>
                    {children}
                  </li>
                )}
              >
                <>
                  <Button
                    className="rio-files__file"
                    data-sortable-surface
                    aria-describedby={readOnly ? undefined : helpId}
                    variant="quiet"
                    isDisabled={Boolean(
                      file?.scanState && file.scanState !== 'clean' && file.scanState !== 'too_large_allowed',
                    )}
                    onPress={() => setPreview(id)}
                  >
                    <span className="rio-files__thumbnail" aria-hidden="true">
                      {file?.type.startsWith('image/') && file.thumbnails.small ? (
                        <img src={file.thumbnails.small} alt="" />
                      ) : file ? (
                        <Icon icon={fileIcons[fileKind(file)]} />
                      ) : (
                        <span className="rio-files__placeholder" />
                      )}
                    </span>
                    <span className="rio-files__name">{name}</span>
                    {file?.scanState === 'infected' ? (
                      <span>
                        {t({
                          id: 'files.infected',
                          message: `Removed: this file contained a virus (${signature})`,
                        })}
                      </span>
                    ) : file?.scanState === 'too_large_allowed' ? (
                      <span>
                        {t({
                          id: 'files.tooLargeAllowed',
                          message: 'Too large to scan—download allowed, unscanned',
                        })}
                      </span>
                    ) : file?.scanState === 'too_large' ? (
                      <span>
                        {t({
                          id: 'files.tooLargeToScan',
                          message: 'Too large to scan—kept in quarantine',
                        })}
                      </span>
                    ) : file?.scanState && file.scanState !== 'clean' ? (
                      <span>{t({ id: 'files.checking', message: 'Checking for viruses' })}</span>
                    ) : null}
                    {file && (
                      <span className="rio-files__size">{t({ id: 'files.size', message: `${size}` })}</span>
                    )}
                  </Button>
                  {!readOnly && (
                    <Button
                      icon={faXmark}
                      variant="quiet"
                      aria-label={t({ id: 'files.remove', message: `Remove ${name}` })}
                      onPress={() => {
                        const next = ids[index + 1] ?? ids[index - 1];
                        const target = next
                          ? root.current?.querySelector<HTMLElement>(
                              `[data-file-id="${next}"] .rio-files__file`,
                            )
                          : root.current?.querySelector<HTMLElement>('.rio-files__add');
                        target?.focus();
                        onChange(ids.filter((current) => current !== id));
                      }}
                    />
                  )}
                </>
              </SortableItem>
            );
          })}
        </ul>
      </SortableList>
      {!readOnly && (
        <>
          <p id={helpId} className="rio-files__hint">
            {t({
              id: 'files.reorderHelp',
              message: 'To reorder files, drag them or press Alt+Up or Alt+Down on a file.',
            })}
          </p>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            aria-label={t({ id: 'files.add', message: 'Add files' })}
            onChange={(event) => {
              if (event.target.files) add(event.target.files);
              event.target.value = '';
            }}
          />
          <div className="rio-files__adders">
            <Button
              className="rio-files__add"
              autoFocus={autoFocus}
              isDisabled={!canUpload}
              onPress={() => input.current?.click()}
              aria-label={t({ id: 'files.add', message: 'Add files' })}
              icon={faPlus}
            />
            {canUpload && (
              <AddFromMenu
                onSourceNavigate={onSourceNavigate}
                locale={locale}
                fieldId={field.id}
                tableId={field.tableId}
                recordId={recordId}
                onFiles={add}
                onPicks={(picks) => uploads.addRemote(picks)}
                onUrl={async (url, filename, imageSearchToken) => {
                  // A lost response may follow a committed write; retry with the same identity.
                  const target = `${field.tableId}:${field.id}:${recordId}`;
                  if (
                    pendingUrl.current?.target !== target ||
                    pendingUrl.current.url !== url ||
                    pendingUrl.current.filename !== filename ||
                    pendingUrl.current.imageSearchToken !== imageSearchToken
                  )
                    pendingUrl.current = {
                      target,
                      url,
                      filename,
                      imageSearchToken,
                      id: newId('command'),
                      groupId: newId('action'),
                    };
                  const { id, groupId } = pendingUrl.current;
                  const result = await api<CommandBatchResult>(
                    `/api/databases/${session!.databaseId}/commands`,
                    {
                      method: 'POST',
                      body: {
                        clientId: newId('client'),
                        commands: [
                          {
                            id,
                            groupId,
                            kind: 'record.attachFromUrl',
                            tableId: field.tableId,
                            fieldId: field.id,
                            recordId,
                            url,
                            filename,
                            imageSearchToken,
                          },
                        ],
                      },
                    },
                  );
                  pendingUrl.current = null;
                  const error = result.results[0]?.error;
                  if (error) throw new ApiError(422, error);
                  session!.adoptAction?.(groupId, {
                    kind: 'record.attachFromUrl',
                    count: 1,
                    name: field.name,
                  });
                }}
              />
            )}
          </div>
          <p className="rio-files__hint">{t({ id: 'files.drop', message: 'Drop files to add them' })}</p>
        </>
      )}
      <div aria-live="polite">
        {entries.map((entry) => {
          const name = entry.name;
          return (
            <div key={entry.id} className="rio-files__upload">
              {entry.status === 'uploading' ? (
                entry.remote ? (
                  <div className="rio-files__copy">
                    <ProgressBar
                      value={entry.progress}
                      isIndeterminate={entry.indeterminate}
                      label={t({ id: 'files.copying', message: `Copying ${name}` })}
                    />
                    {!entry.uploaded && (
                      <Button
                        size="sm"
                        aria-label={t({ id: 'files.cancelCopy', message: `Cancel copying ${name}` })}
                        onPress={() => uploads?.cancel(entry.id)}
                      >
                        {t({ id: 'files.cancel', message: 'Cancel' })}
                      </Button>
                    )}
                  </div>
                ) : (
                  <ProgressBar
                    value={entry.progress}
                    label={t({ id: 'files.uploading', message: `Uploading ${name}` })}
                  />
                )
              ) : (
                <>
                  <p role="alert">
                    {entry.error instanceof FileTooLarge ? (
                      t({ id: 'files.tooLarge', message: `${name} is larger than the upload limit.` })
                    ) : (
                      <>
                        {entry.remote
                          ? t({ id: 'files.copyFailed', message: `${name} didn’t copy.` })
                          : t({ id: 'files.failed', message: `${name} didn’t upload.` })}{' '}
                        {entry.error instanceof ApiError
                          ? message(entry.error.info.messageKey, entry.error.info.params)
                          : message('errors.internal')}
                      </>
                    )}
                  </p>
                  <div className="rio-files__actions">
                    {!(entry.error instanceof FileTooLarge) && (
                      <Button onPress={() => uploads?.retry(entry.id)}>
                        {t({ id: 'files.retry', message: 'Try again' })}
                      </Button>
                    )}
                    <Button onPress={() => uploads?.dismiss(entry.id)}>
                      {t({ id: 'files.dismiss', message: 'Dismiss' })}
                    </Button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      {preview && ids.includes(preview) && (
        <AttachmentPreview
          ids={ids}
          selected={preview}
          details={files}
          onSelect={setPreview}
          onClose={() => setPreview(undefined)}
        />
      )}
    </div>
  );
}
