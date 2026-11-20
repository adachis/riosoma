import { AutomationConfig } from '@riosoma/contracts';
import type { AutomationMeta } from '@riosoma/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../api';
import type { DatabaseSession } from '../../../data/types';
import { reportError } from '../../../grid/view/actions';

/** How long editing pauses before the configuration is saved */
export const SAVE_DELAY = 400;

function validate(config: AutomationConfig) {
  const parsed = AutomationConfig.safeParse(config);
  if (!parsed.success)
    throw new ApiError(400, {
      code: 'validation_failed',
      messageKey: parsed.error.issues.some((issue) => issue.message === 'automations.flow.invalid')
        ? 'automations.flow.invalid'
        : 'errors.validationFailed',
      userFault: true,
    });
}

/**
 * The configuration being edited: the automation's draft, or its published version until someone
 * changes it.  Every change shows at once and is saved whole to the draft through
 * `automation.update` once editing pauses, and anything still waiting is saved on the way out.
 * What runs changes only when the draft is published.
 */
export function useAutomationDraft(session: DatabaseSession, automation: AutomationMeta) {
  const [draft, setDraft] = useState<AutomationConfig | null>(null);
  const pending = useRef<AutomationConfig | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const automationId = automation.id;
  const flush = useCallback(
    async (snapshot?: AutomationConfig): Promise<void> => {
      clearTimeout(timer.current);
      // Publish and tests must also wait for a save the editing timer already sent.
      while (inFlight.current) await inFlight.current;
      const config = snapshot ?? pending.current;
      if (!config) return;
      validate(config);
      const done = Promise.resolve().then(async () => {
        const result = await session.run([{ kind: 'automation.update', automationId, config }], {
          reportResults: true,
        }).done;
        if (result.rejected)
          throw new ApiError(
            400,
            result.results?.find((item) => item.status === 'rejected')?.error ?? {
              code: 'validation_failed',
              messageKey: 'errors.validationFailed',
              userFault: true,
            },
          );
        if (pending.current === config) {
          pending.current = null;
          setDraft((current) => (current === config ? null : current));
        }
      });
      inFlight.current = done;
      try {
        await done;
      } finally {
        inFlight.current = null;
      }
    },
    [session, automationId],
  );
  useEffect(
    () => () => {
      if (pending.current && AutomationConfig.safeParse(pending.current).success)
        void flush().catch(reportError);
      else clearTimeout(timer.current);
    },
    [flush],
  );
  const change = useCallback(
    (config: AutomationConfig, options?: { immediate?: boolean }) => {
      setDraft(config);
      clearTimeout(timer.current);
      // Only what the contract accepts is saved.  Anything else stays on screen until it's fixed.
      pending.current = config;
      if (!AutomationConfig.safeParse(config).success) return;
      if (options?.immediate) void flush(config).catch(reportError);
      else timer.current = setTimeout(() => void flush().catch(reportError), SAVE_DELAY);
    },
    [flush],
  );
  /** Saves now, and settles once the server has the change */
  const save = flush;
  const discard = useCallback(async () => {
    // A confirmed discard may clear invalid local edits; valid pending edits stay undoable.
    if (pending.current && !AutomationConfig.safeParse(pending.current).success) pending.current = null;
    await flush();
    setDraft(null);
  }, [flush]);
  return { config: draft ?? automation.draft?.config ?? automation.config, change, save, discard };
}
