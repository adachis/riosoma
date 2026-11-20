import { useLingui } from '@lingui/react/macro';
import type {
  AutomationMeta,
  AutomationRun,
  AutomationStep,
  AutomationStepTestPreview,
} from '@riosoma/contracts';
import { Banner, Button, ConfirmDialog, Spinner, TextField } from '@riosoma/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../../../api';
import type { SchemaState } from '../../../data/types';
import { useServerMessage } from '../../../messages/useServerMessage';
import { RunSteps, RunSummary, runsKey } from './RunHistory';

export function StepTestPanel({
  automation,
  step,
  schema,
  save,
  onResult,
}: {
  automation: AutomationMeta;
  step: AutomationStep;
  schema: SchemaState;
  save(): Promise<unknown>;
  onResult(run: AutomationRun): void;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const path = `/api/automations/${automation.id}/steps/${step.id}/test`;
  const preview = useQuery({
    queryKey: ['automations', automation.id, 'step-test', step],
    queryFn: async ({ signal }) => {
      await save();
      return api<AutomationStepTestPreview>(path, { method: 'POST', body: { preview: true }, signal });
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const test = useMutation({
    mutationFn: async () => {
      await save();
      const values = Object.fromEntries(
        Object.entries(samples).map(([key, text]) => {
          try {
            return [key, JSON.parse(text) as unknown];
          } catch {
            return [key, text];
          }
        }),
      );
      return api<AutomationRun>(path, { method: 'POST', body: { samples: values } });
    },
    onSuccess: onResult,
    onSettled: () => client.invalidateQueries({ queryKey: runsKey(automation.id) }),
  });
  const table = 'tableId' in step ? (schema.tableById.get(step.tableId)?.name ?? '') : '';
  // Every kind says what testing it does, so a new kind without wording fails to compile.
  const effect = ((): string => {
    switch (step.kind) {
      case 'createRecord':
        return t({ id: 'automations.test.createsRecord', message: `This creates a record in ${table}.` });
      case 'updateRecord':
        return t({ id: 'automations.test.updatesRecord', message: `This updates a record in ${table}.` });
      case 'findRecords':
        return t({
          id: 'automations.test.findsRecords',
          message: 'This searches records and changes nothing.',
        });
      case 'createCalendarEvent':
        return t({
          id: 'automations.test.createsEvent',
          message: 'This creates a real event in your connected calendar.',
        });
      case 'generateDocument':
        return t({
          id: 'automations.test.generatesDocument',
          message: `This attaches a generated document to a record in ${table}.`,
        });
      case 'askAi':
        return t({
          id: 'automations.test.asksAi',
          message: 'This sends the prompt and its values to the AI provider and counts toward the AI budget.',
        });
      case 'script':
        return t({
          id: 'automations.test.runsScript',
          message: 'This runs the script and can change records or send requests.',
        });
      case 'callWebhook':
        return t({
          id: 'automations.test.callsWebhook',
          message: 'This sends a real request to the webhook.',
        });
      case 'sms':
        return t({
          id: 'automations.test.sendsSms',
          message: 'This sends a real text message and can incur charges.',
        });
      case 'sendNotification':
        return t({
          id: 'automations.test.sendsNotification',
          message: 'This sends a real notification using each person’s preferences.',
        });
      case 'sendEmail':
      case 'slack':
      case 'teams':
      case 'discord':
      case 'studioFlow':
        return t({
          id: 'automations.test.sendsMessage',
          message: 'This sends a real message to the configured recipients or channel.',
        });
      case 'if':
      case 'switch':
      case 'repeat':
      case 'wait':
        return t({
          id: 'automations.test.checksFlow',
          message: 'This checks the step with sample values and changes nothing.',
        });
    }
  })();
  const error = test.error ?? preview.error;
  return (
    <section
      className="rio-automation-test"
      aria-label={t({ id: 'automations.test.step', message: 'Test step' })}
    >
      <h3>{t({ id: 'automations.test.step', message: 'Test step' })}</h3>
      <p>{effect}</p>
      {preview.isPending ? (
        <Spinner label={t({ id: 'automations.script.inputs', message: 'Inputs' })} />
      ) : null}
      {error ? (
        <Banner tone="danger">
          {message(error instanceof ApiError ? error.info.messageKey : 'errors.internal')}
        </Banner>
      ) : null}
      {preview.data ? (
        <>
          <p>
            {preview.data.source === 'history'
              ? t({
                  id: 'automations.test.historyInputs',
                  message: 'Using values recorded in the latest run.',
                })
              : t({
                  id: 'automations.test.sampleInputs',
                  message: 'Using sample values.  Enter missing values as text or JSON.',
                })}
          </p>
          {preview.data.error ? (
            <Banner tone="warning">{message(preview.data.error.messageKey)}</Banner>
          ) : null}
          {preview.data.missing.map((key) => (
            <TextField
              key={key}
              label={t({ id: 'automations.test.sampleValue', message: `Sample value for ${key}` })}
              value={samples[key] ?? ''}
              onChange={(value) => setSamples((current) => ({ ...current, [key]: value }))}
            />
          ))}
          <h4>{t({ id: 'automations.script.inputs', message: 'Inputs' })}</h4>
          <pre>{JSON.stringify(preview.data.inputs, null, 2)}</pre>
          <Button
            isPending={test.isPending}
            isDisabled={
              preview.isFetching || preview.data.missing.some((key) => !Object.hasOwn(samples, key))
            }
            onPress={() => setConfirming(true)}
          >
            {t({ id: 'automations.test.runStep', message: 'Run this step' })}
          </Button>
        </>
      ) : null}
      {test.data ? (
        <div aria-live="polite">
          <RunSummary run={test.data} />
          <RunSteps run={test.data} automation={automation} />
        </div>
      ) : null}
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title={t({ id: 'automations.test.confirmStep', message: 'Run this step?' })}
        message={effect}
        confirmLabel={t({ id: 'automations.test.runStep', message: 'Run this step' })}
        onConfirm={() =>
          test
            .mutateAsync()
            .then(() => undefined)
            .catch(() => undefined)
        }
      />
    </section>
  );
}
