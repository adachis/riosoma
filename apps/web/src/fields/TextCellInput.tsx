import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { TextMergeNotice, FieldMeta, TextConflict } from '@riosoma/contracts';
import { Button, TextArea } from '@riosoma/ui';
import { usePeers, type DatabaseSession } from '../data';
import { useServerMessage } from '../messages/useServerMessage';
import { JsonInput, type JsonInputHandle } from './JsonInput';
import { RichTextInput, type RichTextHandle } from './richText/lazy';
import { TextConflictDialog } from './TextConflictDialog.lazy';
import './text-edits.css';

interface Props {
  ref?: Ref<TextCellHandle>;
  session?: DatabaseSession;
  recordId: string;
  field: FieldMeta;
  value: string | null;
  labelId?: string;
  autoFocus?: boolean;
  initialText?: string | null;
  grid?: boolean;
  onChange?(value: string | null): void;
  onDone?(): void;
  onCancel?(): void;
}

export interface TextCellHandle {
  save(): boolean;
  closeLink(): boolean;
  canClose(): boolean;
}

/** A draft owns its starting value until the save answers, including across realtime updates. */
export function TextCellInput({
  session,
  recordId,
  field,
  value,
  labelId,
  autoFocus,
  initialText,
  grid,
  onChange,
  onDone,
  onCancel,
  ref,
}: Props) {
  const { t } = useLingui();
  const message = useServerMessage();
  const peers = usePeers(session ?? null);
  const [source, setSource] = useState(value);
  const [base, setBase] = useState(value);
  const [draft, setDraft] = useState(initialText ?? value ?? '');
  const [active, setActive] = useState(Boolean(grid));
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const unsaved = useRef(false);
  const [failed, setFailed] = useState(false);
  const [conflict, setConflict] = useState<TextConflict>();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const rich = useRef<RichTextHandle>(null);
  const json = useRef<JsonInputHandle>(null);
  const [revision, setRevision] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  if (!active && !pending && !conflict && !failed && source !== value) {
    setBase(value);
    setSource(value);
    setDraft(value ?? '');
  }
  useEffect(() => {
    if (!session || !active) return;
    session.setPresence({ tableId: field.tableId, cell: { recordId, fieldId: field.id }, editing: true });
    return () => session.setPresence({ tableId: field.tableId, recordId });
  }, [session, field.tableId, field.id, recordId, active]);

  function accept(next: string | null) {
    unsaved.current = false;
    setFailed(false);
    setBase(next);
    setSource(next);
    setDraft(next ?? '');
    setConflict(undefined);
    setRevision((revision) => revision + 1);
  }

  async function save(next: string | null, against = base, resolving = false) {
    if (busy.current || (conflict && !resolving)) return;
    if (next === against && !conflict) {
      onDone?.();
      return;
    }
    setError('');
    if (!session) {
      onChange?.(next);
      accept(next);
      onDone?.();
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      const answer = await session.run(
        [
          {
            kind: 'record.update',
            tableId: field.tableId,
            records: [{ id: recordId, values: { [field.id]: next }, baseValues: { [field.id]: against } }],
          },
        ],
        { handlesRefusal: true, reportResults: true },
      ).done;
      const result = answer.results?.[0];
      if (result?.status === 'rejected') {
        unsaved.current = true;
        setFailed(true);
        if (resolving) {
          setBase(against);
          setSource(next);
          setDraft(next ?? '');
          setRevision((revision) => revision + 1);
        }
        const collision = result.error?.conflicts?.find(
          (item) => item.fieldId === field.id && item.recordId === recordId,
        );
        if (collision) setConflict(collision);
        else setError(message(result.error?.messageKey ?? 'errors.internal', result.error?.params));
        return;
      }
      const notices = Array.isArray(result?.output?.textMerges)
        ? (result.output.textMerges as TextMergeNotice[])
        : [];
      const merged = notices.find((item) => item.fieldId === field.id && item.recordId === recordId);
      accept(merged ? merged.value : next);
      if (merged) {
        const name = merged.name ?? t({ id: 'textEdit.someone', message: 'Someone else' });
        setNotice(t({ id: 'textEdit.merged', message: `Merged with ${name}'s edit` }));
      } else {
        setNotice('');
        onDone?.();
      }
    } catch {
      unsaved.current = true;
      setFailed(true);
      setError(message('errors.internal'));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  function saveRich() {
    const dirty = rich.current?.isDirty();
    const next = rich.current?.getValue() ?? null;
    if (!rich.current?.save()) return false;
    if (busy.current || conflict) return true;
    if (!dirty && !unsaved.current) onDone?.();
    else if (session) void save(next);
    return true;
  }
  useImperativeHandle(ref, () => ({
    save: () => {
      if (busy.current || conflict) return false;
      if (field.type === 'longText' && field.options.richText) return saveRich();
      if (field.type === 'json') return json.current?.save() ?? true;
      void save(draft === '' ? null : draft);
      return true;
    },
    closeLink: () => rich.current?.closeLink() ?? false,
    canClose: () => !busy.current && !conflict && (grid || !unsaved.current),
  }));
  const editing = peers.filter(
    (peer) =>
      peer.where?.editing &&
      peer.where.tableId === field.tableId &&
      peer.where.cell?.recordId === recordId &&
      peer.where.cell.fieldId === field.id,
  );
  // Inert fields cannot take focus during a save, but the draft must remain keyboard scrollable.
  return (
    <div
      ref={root}
      className="rio-text-edit"
      aria-busy={pending}
      tabIndex={pending ? 0 : undefined}
      onKeyDownCapture={(event) => {
        if (
          event.key !== 'Escape' ||
          event.nativeEvent.isComposing ||
          grid ||
          busy.current ||
          conflict ||
          !unsaved.current
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        accept(base);
        setError('');
        queueMicrotask(() =>
          root.current?.querySelector<HTMLElement>('textarea, [contenteditable="true"]')?.focus(),
        );
      }}
      onFocusCapture={() => {
        setActive(true);
      }}
      onBlurCapture={(event) => {
        if (
          !grid &&
          !busy.current &&
          !conflict &&
          event.relatedTarget instanceof Node &&
          !root.current?.contains(event.relatedTarget)
        ) {
          // Start saving before focus changes let a realtime value replace the draft.
          let valid = true;
          if (field.type === 'longText' && field.options.richText) valid = saveRich();
          else if (field.type === 'json') valid = json.current?.save() ?? true;
          else void save(draft === '' ? null : draft);
          if (!valid) {
            unsaved.current = true;
            setFailed(true);
          }
          setActive(false);
        }
      }}
    >
      {editing.map((peer) => {
        const name = peer.name;
        return (
          <p className="rio-text-edit__status" role="status" key={peer.clientId}>
            {t({ id: 'textEdit.editing', message: `${name} is editing` })}
          </p>
        );
      })}
      <fieldset disabled={pending} inert={pending}>
        {field.type === 'longText' && field.options.richText ? (
          <RichTextInput
            key={revision}
            ref={rich}
            value={source}
            labelId={labelId}
            label={field.name}
            autoFocus={autoFocus}
            initialText={revision === 0 ? initialText : null}
            saveOnBlur={!grid && !conflict}
            onChange={(next) => void save(next)}
            onSaved={saveRich}
          />
        ) : field.type === 'json' ? (
          <JsonInput
            ref={json}
            key={revision}
            value={source}
            labelId={labelId}
            label={field.name}
            autoFocus={autoFocus}
            saveOnBlur={!grid && !conflict}
            onChange={(next) => void save(next)}
            onCancel={onCancel}
          />
        ) : (
          <TextArea
            label={labelId ? undefined : field.name}
            aria-labelledby={labelId}
            value={draft}
            onChange={setDraft}
            autoFocus={autoFocus}
            rows={8}
            onBlur={() => {
              if (!grid && !conflict) void save(draft === '' ? null : draft);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return event.continuePropagation();
              if (
                event.key === 'Enter' &&
                (event.ctrlKey || event.metaKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void save(draft === '' ? null : draft);
              } else if (!grid && event.key === 'Escape' && draft !== (base ?? '')) {
                event.preventDefault();
                event.stopPropagation();
                setDraft(base ?? '');
                setError('');
                if (!busy.current && !conflict) {
                  unsaved.current = false;
                  setFailed(false);
                }
              } else event.continuePropagation();
            }}
          />
        )}
        {grid && field.type !== 'json' && (
          <div className="rio-field-input__actions">
            <Button
              variant="primary"
              onPress={() =>
                field.type === 'longText' && field.options.richText
                  ? saveRich()
                  : void save(draft === '' ? null : draft)
              }
            >
              {t({ id: 'fields.richText.save', message: 'Save' })}
            </Button>
            <Button onPress={onCancel}>{t({ id: 'fields.richText.cancel', message: 'Cancel' })}</Button>
          </div>
        )}
      </fieldset>
      {notice && (
        <p className="rio-text-edit__status" role="status">
          {notice}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {conflict && (
        <TextConflictDialog
          key={`${conflict.updatedAt}:${conflict.theirs}`}
          field={field}
          conflict={conflict}
          pending={pending}
          onClose={() => setConflict(undefined)}
          onChoose={(next) => void save(next, conflict.theirs, true)}
        />
      )}
    </div>
  );
}
