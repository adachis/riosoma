import { useLingui } from '@lingui/react/macro';
import { automationStepEntries, type AutomationConfig } from '@riosoma/contracts';
import { useState } from 'react';
import { STEP_LABELS } from './labels';

/** Compare complete configurations so nested paths and canvas notes appear with step changes. */
export function VersionDiff({ before, after }: { before: AutomationConfig | null; after: AutomationConfig }) {
  const { t, i18n } = useLingui();
  const [open, setOpen] = useState(false);
  const old = automationStepEntries(before?.steps ?? []);
  const next = automationStepEntries(after.steps);
  const ids = [...new Set([...old, ...next].map(({ step }) => step.id))];
  const changes = ids.flatMap((id) => {
    const from = old.find(({ step }) => step.id === id);
    const to = next.find(({ step }) => step.id === id);
    if (JSON.stringify(from) === JSON.stringify(to)) return [];
    const step = to?.step ?? from!.step;
    return [{ id, title: step.name || i18n._(STEP_LABELS[step.kind]), from, to }];
  });
  const settings = (config: AutomationConfig | null) =>
    config
      ? {
          trigger: config.trigger,
          conditions: config.conditions,
          loopItemCap: config.loopItemCap ?? 1000,
          notes: config.notes ?? [],
          connections: config.connections,
        }
      : null;
  const settingsChanged = JSON.stringify(settings(before)) !== JSON.stringify(settings(after));
  return (
    <details className="rio-automation-diff" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {t({ id: 'automations.versions.diff', message: 'Changes from the published version' })}
      </summary>
      {(open
        ? [
            ...changes,
            ...(settingsChanged
              ? [
                  {
                    id: 'settings',
                    title: t({
                      id: 'automations.versions.settings',
                      message: 'Trigger, conditions, loop limit, notes, and connections',
                    }),
                    from: settings(before),
                    to: settings(after),
                  },
                ]
              : []),
          ]
        : []
      ).map((change) => (
        <section key={change.id}>
          <h3>{change.title}</h3>
          <h4>{t({ id: 'automations.versions.before', message: 'Before' })}</h4>
          <pre>{JSON.stringify(change.from ?? null, null, 2)}</pre>
          <h4>{t({ id: 'automations.versions.after', message: 'After' })}</h4>
          <pre>{JSON.stringify(change.to ?? null, null, 2)}</pre>
        </section>
      ))}
    </details>
  );
}
