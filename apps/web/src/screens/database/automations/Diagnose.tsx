import { faStethoscope } from '@fortawesome/free-solid-svg-icons';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { useLingui } from '@lingui/react/macro';
import {
  newId,
  automationStepEntries,
  type AutomationDiagnosis,
  type AutomationDiagnosisReceipt,
  type AutomationMeta,
  type AutomationRun,
  type DiagnosisCause,
  type DiagnosisDiffLine,
  type UndoResult,
} from '@riosoma/contracts';
import { Button, Spinner } from '@riosoma/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { api, ApiError } from '../../../api';
import { clientId } from '../../../data/deps';
import type { SchemaState } from '../../../data/types';
import { undoSkipped } from '../../../grid/view/actions';
import { Usage } from '../../../features/rio/Blocks';
import { Markdown } from '../../../features/rio/Markdown';
import { rioStatusQuery } from '../../../features/rio/status';
import { ProviderOffNotice } from '../../../features/rio/ProviderOffNotice';
import { useServerMessage } from '../../../messages/useServerMessage';
import { STEP_LABELS } from './labels';

/**
 * Diagnose, on a run that failed or was skipped: Rio's plain explanation of what went wrong, and at
 * most one fix, shown as a plan to apply with its diff.  Applying saves the change as one action,
 * undoable here in one step, like Rio's own receipts.
 */

export const CAUSE_LABELS: Record<DiagnosisCause, MessageDescriptor> = {
  missingField: msg({
    id: 'automations.diagnose.cause.missingField',
    message: 'Something the step uses is gone',
  }),
  typeMismatch: msg({ id: 'automations.diagnose.cause.typeMismatch', message: 'A value of the wrong kind' }),
  permission: msg({ id: 'automations.diagnose.cause.permission', message: 'Missing access' }),
  rateLimit: msg({ id: 'automations.diagnose.cause.rateLimit', message: 'Too many requests' }),
  badAddress: msg({ id: 'automations.diagnose.cause.badAddress', message: 'A wrong or unreachable address' }),
  scriptError: msg({ id: 'automations.diagnose.cause.scriptError', message: 'An error in the script' }),
  emptyTriggerValue: msg({
    id: 'automations.diagnose.cause.emptyTriggerValue',
    message: 'An empty value in the trigger’s record',
  }),
  conditionsNeverMatch: msg({
    id: 'automations.diagnose.cause.conditionsNeverMatch',
    message: 'Conditions that never match',
  }),
  other: msg({ id: 'automations.diagnose.cause.other', message: 'Something else' }),
};

/** A value in a diff line, as short text, with the fields it names by their names. */
function shown(value: unknown, schema: SchemaState | undefined): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return text.replace(/fld[0-9A-Za-z]{14}/g, (id) => schema?.fieldById.get(id)?.name ?? id);
}

export function DiagnosePanel({
  automation,
  run,
  schema,
  save,
}: {
  automation: AutomationMeta;
  run: AutomationRun;
  /** Names fields in the fix's diff by name rather than ID */
  schema?: SchemaState;
  save?: () => Promise<unknown>;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const status = useQuery(rioStatusQuery);
  const titleId = useId();
  const diagnose = useMutation({
    mutationFn: () =>
      api<AutomationDiagnosis>(
        `/api/automations/${automation.id}/runs/${encodeURIComponent(run.id)}/diagnose`,
        {
          method: 'POST',
          body: { locale: i18n.locale },
        },
      ),
  });
  // Nothing to offer until the server says whether Rio is on.
  if (!status.data) return null;
  if (!status.data.enabled || !status.data.diagnose || status.data.paused)
    return (
      <p className="rio-automation-diagnose__note">
        {status.data.disabledReason === 'noProvider' ? (
          <ProviderOffNotice />
        ) : !status.data.enabled ? (
          t({
            id: 'automations.diagnose.noProvider',
            message:
              'Diagnose uses Rio, which needs an AI provider.  An admin can set one up in AI settings.',
          })
        ) : (
          message(!status.data.diagnose ? 'automations.diagnose.off' : 'rio.paused')
        )}
      </p>
    );
  const diagnosis = diagnose.data;
  return (
    <section className="rio-automation-diagnose" aria-labelledby={titleId}>
      <h4 id={titleId} className="rio-automation-diagnose__title">
        {t({ id: 'automations.diagnose.title', message: 'Diagnose' })}
      </h4>
      {!diagnosis ? (
        <div className="rio-automation-diagnose__start">
          <p className="rio-automation-diagnose__note">
            {t({
              id: 'automations.diagnose.help',
              message:
                'Rio reads this run’s settings, values, and errors, leaving out anything you can’t see, and explains what went wrong.',
            })}
          </p>
          <Button icon={faStethoscope} isPending={diagnose.isPending} onPress={() => diagnose.mutate()}>
            {t({ id: 'automations.diagnose', message: 'Diagnose' })}
          </Button>
        </div>
      ) : (
        <>
          <p className="rio-automation-diagnose__cause">
            {t({
              id: 'automations.diagnose.causeIs',
              message: `Cause: ${i18n._(CAUSE_LABELS[diagnosis.cause])}`,
            })}
          </p>
          <div className="rio-automation-diagnose__explanation">
            <Markdown text={diagnosis.explanation} />
          </div>
          {diagnosis.withheld ? (
            <p className="rio-automation-diagnose__note">
              {t({
                id: 'automations.diagnose.withheld',
                message:
                  'Rules limit what you can see in this database, so Rio read none of this run’s values, only its settings, its errors, and its fields’ names and types.',
              })}
            </p>
          ) : diagnosis.redacted ? (
            <p className="rio-automation-diagnose__note">
              {t({
                id: 'automations.diagnose.redacted',
                message: 'Values you can’t see were left out of what Rio read.',
              })}
            </p>
          ) : null}
          {diagnosis.fix ? (
            <FixPreview automation={automation} fix={diagnosis.fix} schema={schema} save={save} />
          ) : diagnosis.fixRejected ? (
            <p className="rio-automation-diagnose__note">
              {t({
                id: 'automations.diagnose.fixRejected',
                message: 'Rio suggested a change that didn’t check out, so there’s nothing to apply.',
              })}
            </p>
          ) : null}
          <Usage usage={diagnosis.usage} />
        </>
      )}
      {diagnose.error ? (
        <p role="alert">
          {message(diagnose.error instanceof ApiError ? diagnose.error.info.messageKey : 'errors.internal')}
        </p>
      ) : null}
    </section>
  );
}

function FixPreview({
  automation,
  fix,
  schema,
  save,
}: {
  automation: AutomationMeta;
  fix: NonNullable<AutomationDiagnosis['fix']>;
  schema?: SchemaState;
  save?: () => Promise<unknown>;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const [state, setState] = useState<'pending' | 'applied' | 'dismissed' | 'undone'>('pending');
  const [receipt, setReceipt] = useState<AutomationDiagnosisReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commandId = useRef(newId('command'));
  /** A path segment as the person knows it: a field by its name, a position counting from one */
  const name = (segment: string | number | undefined): string =>
    typeof segment === 'number'
      ? String(segment + 1)
      : (schema?.fieldById.get(segment ?? '')?.name ?? String(segment ?? ''));
  const where = (line: DiagnosisDiffLine): string => {
    const [part, index, ...rest] = line.path;
    if (part === 'steps') {
      const entries = automationStepEntries(automation.draft?.config.steps ?? automation.config.steps);
      const entry = entries.findLast(({ path }) => path.every((segment, at) => line.path[at] === segment));
      const number = entry ? entries.indexOf(entry) + 1 : 0;
      const kind = entry ? i18n._(STEP_LABELS[entry.step.kind]) : '';
      const setting = line.path
        .slice(entry?.path.length ?? 2)
        .map(name)
        .join(' › ');
      return t({ id: 'automations.diagnose.inStep', message: `Step ${number}, ${kind}: ${setting}` });
    }
    const setting = [index, ...rest]
      .filter((segment) => segment !== undefined)
      .map(name)
      .join(' › ');
    return part === 'conditions'
      ? t({ id: 'automations.diagnose.inConditions', message: `Conditions: ${setting}` })
      : t({ id: 'automations.diagnose.inTrigger', message: `Trigger: ${setting}` });
  };
  async function act(kind: 'apply' | 'undo') {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === 'apply') {
        // Edits still waiting to save go first, so the fix never overwrites them unseen.
        await save?.();
        const saved = await api<AutomationDiagnosisReceipt>(
          `/api/automations/${automation.id}/diagnoses/apply`,
          {
            method: 'POST',
            body: { token: fix.token },
          },
        );
        setReceipt(saved);
        setState('applied');
      } else if (receipt) {
        const result = await api<UndoResult>(
          `/api/databases/${encodeURIComponent(receipt.databaseId)}/undo`,
          {
            body: { clientId: clientId(), groupId: receipt.groupId, commandId: commandId.current },
          },
        );
        if (result.status === 'rejected') setError(message(result.error?.messageKey ?? 'errors.internal'));
        else {
          setState('undone');
          if (result.skipped || result.pending) undoSkipped(result.skipped, result.pending);
        }
      }
    } catch (cause) {
      setError(message(cause instanceof ApiError ? cause.info.messageKey : 'errors.internal'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rio-automation-diagnose__fix">
      <h5>{t({ id: 'automations.diagnose.fix', message: 'Suggested fix' })}</h5>
      <Markdown text={fix.summary} />
      <ul
        className="rio-automation-diagnose__diff"
        aria-label={t({ id: 'automations.diagnose.diff', message: 'Changes' })}
      >
        {fix.diff.map((line, index) => (
          <li key={index}>
            <span className="rio-automation-diagnose__where">{where(line)}</span>
            {'before' in line ? (
              <del>
                <span aria-hidden="true">− </span>
                {shown(line.before, schema)}
              </del>
            ) : null}
            {'after' in line ? (
              <ins>
                <span aria-hidden="true">+ </span>
                {shown(line.after, schema)}
              </ins>
            ) : null}
          </li>
        ))}
      </ul>
      {state === 'pending' ? (
        <div className="rio-automation-diagnose__actions">
          <Button variant="primary" isDisabled={busy} onPress={() => void act('apply')}>
            {t({ id: 'rio.plan.apply', message: 'Apply' })}
          </Button>
          <Button isDisabled={busy} onPress={() => setState('dismissed')}>
            {t({ id: 'rio.plan.dismiss', message: 'Dismiss' })}
          </Button>
        </div>
      ) : state === 'applied' ? (
        <div className="rio-automation-diagnose__actions">
          <p role="status">{t({ id: 'rio.plan.applied', message: 'Applied' })}</p>
          <Button isDisabled={busy} onPress={() => void act('undo')}>
            {t({ id: 'rio.receipt.undo', message: 'Undo' })}
          </Button>
        </div>
      ) : state === 'undone' ? (
        <p role="status">{t({ id: 'rio.receipt.undone', message: 'Undone' })}</p>
      ) : (
        <p role="status">{t({ id: 'rio.plan.dismissed', message: 'Dismissed' })}</p>
      )}
      {busy ? <Spinner /> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
