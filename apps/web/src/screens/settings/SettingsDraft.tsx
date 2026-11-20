import { faRotateRight } from '@fortawesome/free-solid-svg-icons';
import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode, SetStateAction } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button, Tooltip, TooltipTrigger } from '@riosoma/ui';
import { usePaletteItems } from '../../palette/sources';
import { useShortcut } from '../../shortcuts/useShortcut';
import { Context, type DraftContext, type Section } from './SettingsDraftContext';
import './SettingsDraft.css';

export { SettingsDraftProvider } from './SettingsDraftProvider';
export { useSettingsLeaveGuard } from './SettingsDraftContext';
const serialize = (value: unknown) => JSON.stringify(value);

export function useSettingsStoredAction() {
  const context = useContext(Context);
  const { t } = useLingui();
  return () => {
    if (!context?.dirty) return true;
    context.explain(
      t({
        id: 'settings.draft.saveFirst',
        message: 'Save the pending changes in the bar before using this action.',
      }),
    );
    return false;
  };
}

export function SettingsDraftPage({ page, children }: { page: string; children: ReactNode }) {
  const context = useContext(Context);
  const setPage = context?.setPage;
  useEffect(() => {
    setPage?.(page);
    return () => setPage?.(null);
  }, [page, setPage]);
  return children;
}

/** Registers an existing form's local state with the page's shared save and discard actions. */
export function useSettingsSection(section: Section) {
  const context = useContext(Context);
  const id = useId();
  const register = context?.register;
  const unregister = context?.unregister;
  const base = useRef(serialize(section.stored));
  const wasDirty = useRef(section.dirty);
  const committed = useRef(false);
  const currentStored = useRef(section.stored);
  useEffect(() => {
    currentStored.current = section.stored;
  });
  useEffect(() => {
    const stored = serialize(section.stored);
    if (committed.current) {
      base.current = stored;
      committed.current = false;
    }
    if (section.stored !== undefined && !wasDirty.current && base.current !== stored) {
      base.current = stored;
      section.discard();
      return;
    }
    wasDirty.current = section.dirty;
    if (!section.dirty) base.current = stored;
    if (!context?.active) {
      unregister?.(id);
      return;
    }
    register?.(id, {
      ...section,
      save: async () => {
        await section.save();
        base.current = serialize(currentStored.current);
        committed.current = true;
      },
      conflict: section.conflict || (section.dirty && base.current !== serialize(section.stored)),
    });
  });
  useEffect(() => () => unregister?.(id), [id, unregister]);
  return { active: context?.active ?? false, saving: context?.saving ?? false, save: context?.save };
}

/** Keeps stored values separate from a local draft, including when live data arrives during editing. */
export function useSettingsDraft<T>(
  stored: T,
  persist: (value: T, version?: unknown) => Promise<unknown>,
  options: {
    validate?(value: T): string | null;
    priority?: number;
    version?: unknown;
    savedVersion?(result: unknown): unknown;
    reconcile?(current: T, submitted: T, result: unknown): T;
  } = {},
) {
  const [draft, setDraft] = useState<{ base: T; value: T; version?: unknown } | null>(null);
  const submitting = useRef(false);
  const value = draft?.value ?? stored;
  const dirty = serialize(value) !== serialize(draft?.base ?? stored);
  const setValue = (next: SetStateAction<T>) => {
    // A return to the old value is still a newer edit while a different snapshot is being saved.
    const keepDraft = submitting.current;
    setDraft((previous) => {
      const base = previous?.base ?? stored;
      const value =
        typeof next === 'function' ? (next as (current: T) => T)(previous?.value ?? stored) : next;
      return serialize(base) === serialize(value) && !keepDraft
        ? null
        : { base, value, version: previous?.version ?? options.version };
    });
  };
  const section = useSettingsSection({
    dirty,
    conflict:
      dirty &&
      draft !== null &&
      (serialize(draft.base) !== serialize(stored) ||
        serialize(draft.version) !== serialize(options.version)),
    priority: options.priority,
    validate: () => options.validate?.(value) ?? null,
    discard: () => setDraft(null),
    prepareSave: () => {
      // Queued sections also have captured snapshots, so reverting remains a newer edit.
      submitting.current = true;
      return () => {
        submitting.current = false;
        setDraft((current) =>
          current && serialize(current.base) === serialize(current.value) ? null : current,
        );
      };
    },
    save: async () => {
      const version = draft?.version ?? options.version;
      const result = await (version === undefined ? persist(value) : persist(value, version));
      const base = options.reconcile?.(value, value, result) ?? value;
      const savedVersion = options.savedVersion?.(result) ?? options.version;
      setDraft((current) =>
        current && serialize(current.value) !== serialize(value)
          ? {
              base,
              value: options.reconcile?.(current.value, value, result) ?? current.value,
              version: savedVersion,
            }
          : null,
      );
    },
  });
  return { value, setValue, dirty, ...section };
}

export function SettingsSaveBar() {
  const context = useContext(Context);
  return context?.active ? <SaveBar context={context} /> : null;
}

function SaveBar({ context }: { context: DraftContext }) {
  const { t } = useLingui();
  useShortcut('settings.save', () => {
    if (context.dirty && !context.saving) void context.save();
  });
  const saveDraft = context.save;
  const saveCommand = useCallback(() => {
    void saveDraft();
  }, [saveDraft]);
  usePaletteItems('settings.save', [
    {
      id: 'settings.save',
      group: 'commands',
      label: t({ id: 'settings.draft.label', message: 'Save changes' }),
      run: saveCommand,
    },
  ]);
  return (
    <section
      className="rio-settings-save-bar"
      aria-label={t({ id: 'settings.draft.label', message: 'Save changes' })}
    >
      <span
        className="rio-settings-save-bar__status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        tabIndex={context.error || context.conflict ? 0 : undefined}
      >
        {context.error ??
          (context.saving
            ? t({ id: 'settings.draft.saving', message: 'Saving changes…' })
            : context.conflict
              ? t({
                  id: 'settings.draft.conflict',
                  message: 'These settings changed elsewhere.  Reload the stored values before saving.',
                })
              : context.dirty
                ? t({ id: 'settings.draft.unsaved', message: 'Unsaved changes' })
                : t({ id: 'settings.draft.idle', message: 'No unsaved changes' }))}
      </span>
      <div className="rio-settings-save-bar__actions">
        {context.conflict && (
          <TooltipTrigger>
            <Button
              isDisabled={context.saving}
              icon={faRotateRight}
              aria-label={t({ id: 'settings.draft.reload', message: 'Reload stored values' })}
              onPress={() => {
                void context.reload();
              }}
            />
            <Tooltip>{t({ id: 'settings.draft.reload', message: 'Reload stored values' })}</Tooltip>
          </TooltipTrigger>
        )}
        <Button isDisabled={!context.dirty || context.saving} onPress={context.discard}>
          <Trans id="settings.draft.discard">Discard</Trans>
        </Button>
        <Button
          variant="primary"
          isPending={context.saving}
          isDisabled={!context.dirty || context.saving}
          onPress={() => {
            void context.save();
          }}
        >
          <Trans id="settings.draft.save">Save</Trans>
        </Button>
      </div>
    </section>
  );
}
