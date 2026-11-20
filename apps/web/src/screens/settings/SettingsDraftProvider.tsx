import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { toast } from '@riosoma/ui';
import { ApiError } from '../../api';
import { useServerMessage } from '../../messages/shellMessage';
import { LazyBoundary, lazyFeature } from '../../shell/lazy';
import { registerAdminNavigation } from './admin-search';
import { Context, type Section } from './SettingsDraftContext';

const LeaveDialog = lazyFeature(() =>
  import('./SettingsLeaveDialog').then((module) => ({ default: module.SettingsLeaveDialog })),
);
const revisionConflict = (cause: unknown) =>
  cause instanceof ApiError && cause.status === 409 && cause.info.messageKey === 'errors.conflict';
function focusInvalid() {
  requestAnimationFrame(() => {
    const invalid = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.rio-settings__content input[aria-invalid="true"], .rio-settings__content select[aria-invalid="true"], .rio-settings__content textarea[aria-invalid="true"], .rio-settings__content button[aria-invalid="true"], .rio-settings__content [aria-invalid="true"] input, .rio-settings__content [aria-invalid="true"] button, .rio-settings__content [data-invalid] input, .rio-settings__content [data-invalid] button:not([slot])',
      ),
    ).find(
      (field) => !field.closest('[hidden], [inert], [aria-hidden="true"]') && !field.matches(':disabled'),
    );
    invalid?.focus();
  });
}

/** A page owns its draft; sections supply their values and persistence without owning navigation. */
export function SettingsDraftProvider({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const router = useRouter({ warn: false });
  const sections = useRef(new Map<string, Section>());
  const [summary, setSummary] = useState({ dirty: false, conflict: false });
  const [page, setPage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingNow = useRef(false);
  const leavingDocument = useRef(false);
  const afterSave = useRef<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverConflict, setServerConflict] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const leave = useRef<{ promise: Promise<boolean>; resolve(answer: boolean): void } | null>(null);
  const register = useCallback((id: string, section: Section) => {
    const previous = sections.current.get(id);
    sections.current.set(id, section);
    if (!previous || previous.dirty !== section.dirty || previous.conflict !== section.conflict) {
      setError(null);
      const current = [...sections.current.values()];
      setSummary({
        dirty: current.some((entry) => entry.dirty),
        conflict: current.some((entry) => entry.conflict),
      });
    }
  }, []);
  const unregister = useCallback((id: string) => {
    if (sections.current.delete(id)) {
      const current = [...sections.current.values()];
      setSummary({
        dirty: current.some((entry) => entry.dirty),
        conflict: current.some((entry) => entry.conflict),
      });
    }
  }, []);
  const { dirty } = summary;
  const conflict = summary.conflict || serverConflict;
  const discard = useCallback(() => {
    for (const section of sections.current.values()) section.discard();
    setError(null);
    setServerConflict(false);
  }, []);
  const reload = useCallback(async () => {
    await client.refetchQueries({ type: 'active' });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    discard();
  }, [client, discard]);
  const save = useCallback(async () => {
    if (savingNow.current) return false;
    const pending = [...sections.current.values()].filter((section) => section.dirty);
    if (!pending.length) return true;
    let failure: string | null = null;
    for (const section of pending) {
      const invalid = section.validate?.() ?? null;
      failure ??= invalid;
    }
    if (failure) {
      setError(failure);
      focusInvalid();
      return false;
    }
    if (serverConflict || pending.some((section) => section.conflict)) {
      setError(
        t({
          id: 'settings.draft.conflict',
          message: 'These settings changed elsewhere.  Reload the stored values before saving.',
        }),
      );
      return false;
    }
    savingNow.current = true;
    setSaving(true);
    setError(null);
    const finishSnapshots = pending.map((section) => section.prepareSave?.());
    try {
      for (const section of pending.sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0)))
        await section.save();
      afterSave.current?.();
      afterSave.current = null;
      toast.show({ tone: 'success', title: t({ id: 'settings.draft.saved', message: 'Settings saved' }) });
      return true;
    } catch (cause) {
      afterSave.current = null;
      if (revisionConflict(cause)) setServerConflict(true);
      setError(
        revisionConflict(cause)
          ? t({
              id: 'settings.draft.conflict',
              message: 'These settings changed elsewhere.  Reload the stored values before saving.',
            })
          : message(
              cause instanceof ApiError
                ? cause.info.messageKey
                : cause instanceof Error && /^[a-z]+(?:\.[a-zA-Z]+)+$/.test(cause.message)
                  ? cause.message
                  : 'errors.internal',
            ),
      );
      focusInvalid();
      return false;
    } finally {
      for (const finish of finishSnapshots) finish?.();
      savingNow.current = false;
      setSaving(false);
    }
  }, [message, serverConflict, t]);
  const requestLeave = useCallback(() => {
    if (!savingNow.current && ![...sections.current.values()].some((section) => section.dirty))
      return Promise.resolve(true);
    if (leave.current) return leave.current.promise;
    let resolve!: (answer: boolean) => void;
    const promise = new Promise<boolean>((answer) => {
      resolve = answer;
    });
    leave.current = { promise, resolve };
    setLeaving(true);
    return promise;
  }, []);
  const answer = (result: boolean) => {
    leave.current?.resolve(result);
    leave.current = null;
    setLeaving(false);
  };
  useEffect(() => {
    if (leaving)
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-settings-keep]')?.focus());
  }, [leaving]);
  useEffect(
    () => () => {
      leave.current?.resolve(false);
    },
    [],
  );
  useEffect(() => {
    if (!page) return;
    const refresh = () => {
      if (!savingNow.current) void client.refetchQueries({ type: 'active' });
    };
    window.addEventListener('organizationChanged', refresh);
    const timer = dirty ? window.setInterval(refresh, 30_000) : undefined;
    return () => {
      window.removeEventListener('organizationChanged', refresh);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [client, dirty, page]);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!page || !viewport) return;
    const resize = () =>
      document.documentElement.style.setProperty(
        '--rio-shell-viewport',
        `${viewport.height + viewport.offsetTop}px`,
      );
    resize();
    viewport.addEventListener('resize', resize);
    viewport.addEventListener('scroll', resize);
    return () => {
      viewport.removeEventListener('resize', resize);
      viewport.removeEventListener('scroll', resize);
      document.documentElement.style.removeProperty('--rio-shell-viewport');
    };
  }, [page]);
  useEffect(
    () =>
      registerAdminNavigation((href, options) => {
        const navigate = () => {
          if (router) router.history.push(href, undefined, { ignoreBlocker: true });
          else {
            window.history.pushState(window.history.state, '', href);
            window.dispatchEvent(new PopStateEvent('popstate'));
          }
        };
        if (options?.afterSave && savingNow.current) {
          afterSave.current = navigate;
          return;
        }
        void requestLeave().then((accepted) => {
          if (accepted) navigate();
        });
      }),
    [router, requestLeave],
  );
  useEffect(
    () =>
      router?.history.block({
        enableBeforeUnload: false,
        blockerFn: async ({ currentLocation, nextLocation }) => {
          const current = new URLSearchParams(currentLocation.search);
          const next = new URLSearchParams(nextLocation.search);
          for (const parameters of [current, next]) {
            parameters.delete('help');
            parameters.delete('rioPreview');
            parameters.sort();
          }
          const changesPage =
            currentLocation.pathname !== nextLocation.pathname ||
            current.toString() !== next.toString() ||
            new URLSearchParams(currentLocation.hash.replace(/^#/, '')).get('unit') !==
              new URLSearchParams(nextLocation.hash.replace(/^#/, '')).get('unit');
          return changesPage && !(await requestLeave());
        },
      }),
    [router, requestLeave],
  );
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      if (leavingDocument.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const external = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
      const destination = new URL(link.href, window.location.href);
      if (!['http:', 'https:'].includes(destination.protocol)) return;
      if (destination.pathname === window.location.pathname && destination.search === window.location.search)
        return;
      event.preventDefault();
      void requestLeave().then((accepted) => {
        if (accepted) {
          leavingDocument.current = true;
          window.location.assign(destination.href);
        }
      });
    };
    const captured = (event: MouseEvent) => {
      const link =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (link && new URL(link.href, window.location.href).origin !== window.location.origin) external(event);
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', external);
    document.addEventListener('click', captured, true);
    return () => {
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', external);
      document.removeEventListener('click', captured, true);
    };
  }, [dirty, requestLeave]);
  return (
    <Context.Provider
      value={{
        active: page !== null,
        dirty,
        saving,
        conflict,
        error,
        explain: setError,
        register,
        unregister,
        setPage,
        save,
        discard,
        reload,
        requestLeave,
      }}
    >
      {children}
      {leaving && (
        <LazyBoundary size="dialog" onDismiss={() => answer(false)}>
          <LeaveDialog
            saving={saving}
            error={error}
            onKeep={() => answer(false)}
            onDiscard={() => {
              discard();
              answer(true);
            }}
            onSave={() => {
              void save().then((success) => {
                answer(success);
                if (!success) focusInvalid();
              });
            }}
          />
        </LazyBoundary>
      )}
    </Context.Provider>
  );
}
