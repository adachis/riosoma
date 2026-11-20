import { isComputedType, mapAutomationSteps, flattenAutomationSteps } from '@riosoma/contracts';
import type {
  AutomationConfig,
  AutomationStep,
  AutomationTrigger,
  FieldMeta,
  ViewMeta,
} from '@riosoma/contracts';
import type { SchemaState } from '../../../data/types';

export type TriggerKind = AutomationTrigger['kind'];
export type StepKind = AutomationStep['kind'];
export type RecordStep = Extract<AutomationStep, { kind: 'updateRecord' | 'createRecord' }>;
export type ScheduleTrigger = Extract<AutomationTrigger, { kind: 'schedule' }>;

export const TRIGGER_KINDS = [
  'recordCreated',
  'recordUpdated',
  'recordMatches',
  'formSubmitted',
  'schedule',
  'webhook',
] as const satisfies readonly TriggerKind[];

export const STEP_KINDS = [
  'findRecords',
  'createCalendarEvent',
  'generateDocument',
  'askAi',
  'if',
  'switch',
  'repeat',
  'wait',
  'slack',
  'teams',
  'studioFlow',
  'discord',
  'sms',
  'script',
  'updateRecord',
  'createRecord',
  'sendEmail',
  'sendNotification',
  'callWebhook',
] as const satisfies readonly StepKind[];

/** The most steps one automation may have */
export const MAX_STEPS = 25;

export function newStepId(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 20);
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function defaultConfig(tableId: string): AutomationConfig {
  return { trigger: { kind: 'recordCreated', tableId }, conditions: null, steps: [] };
}

/** The table whose record starts the automation, or null when no record does. */
export function triggerTableId(trigger: AutomationTrigger, schema: SchemaState): string | null {
  switch (trigger.kind) {
    case 'recordCreated':
    case 'recordUpdated':
    case 'recordMatches':
      return trigger.tableId;
    case 'formSubmitted':
      return schema.viewById.get(trigger.viewId)?.tableId ?? null;
    case 'schedule':
    case 'webhook':
      return null;
  }
}

export function startsWithRecord(trigger: AutomationTrigger): boolean {
  return trigger.kind !== 'schedule' && trigger.kind !== 'webhook';
}

export function isRecordStep(step: AutomationStep | undefined): step is RecordStep {
  return step?.kind === 'updateRecord' || step?.kind === 'createRecord';
}

export function formViews(schema: SchemaState): ViewMeta[] {
  return schema.tables.flatMap((table) =>
    (schema.views.get(table.id) ?? []).filter((view) => view.type === 'form'),
  );
}

/** The fields a step can write: everything but the ones Riosoma fills in itself. */
export function writableFields(schema: SchemaState, tableId: string): FieldMeta[] {
  // Only the person signing can sign, so a step never writes a signature.
  return (schema.fields.get(tableId) ?? []).filter(
    (field) => !isComputedType(field.type) && field.type !== 'signature',
  );
}

/** A trigger of another kind, keeping the table where the new kind has one. */
export function triggerOfKind(
  kind: TriggerKind,
  previous: AutomationTrigger,
  schema: SchemaState,
  fallbackTableId: string,
): AutomationTrigger {
  const tableId = triggerTableId(previous, schema) ?? fallbackTableId;
  switch (kind) {
    case 'recordCreated':
      return { kind, tableId };
    case 'recordUpdated':
      return { kind, tableId, fieldIds: [] };
    case 'recordMatches':
      return { kind, tableId, viewId: null, filter: null };
    case 'formSubmitted': {
      const forms = formViews(schema);
      const form = forms.find((view) => view.tableId === tableId) ?? forms[0];
      return form ? { kind, viewId: form.id } : previous;
    }
    case 'schedule':
      return { kind, every: { unit: 'day', n: 1 }, at: '09:00', weekday: 1, timeZone: localTimeZone() };
    case 'webhook':
      return { kind };
  }
}

/** Keeps each update step on the table its record comes from. */
export function followRecords(config: AutomationConfig, schema: SchemaState): AutomationConfig {
  const triggerTable = triggerTableId(config.trigger, schema);
  let changed = false;
  const steps = mapAutomationSteps(config.steps, (step) => {
    if (step.kind !== 'updateRecord' && step.kind !== 'generateDocument') return step;
    const source =
      step.record === 'trigger'
        ? triggerTable
        : (
            flattenAutomationSteps(config.steps).find(
              (item) => item.id === step.record && item.kind === 'createRecord',
            ) as RecordStep | undefined
          )?.tableId;
    if (!source || source === step.tableId) return step;
    changed = true;
    return { ...step, tableId: source };
  });
  return changed ? { ...config, steps } : config;
}

export function newStep(
  kind: StepKind,
  config: AutomationConfig,
  index: number,
  schema: SchemaState,
  fallbackTableId: string,
): AutomationStep {
  const id = newStepId();
  const tableId = triggerTableId(config.trigger, schema);
  switch (kind) {
    case 'findRecords':
      return { id, name: '', kind, tableId: tableId ?? fallbackTableId, filter: null, limit: 20 };
    case 'createCalendarEvent':
      return {
        id,
        name: '',
        kind,
        provider: 'google-calendar',
        calendarId: '',
        title: '',
        description: '',
        start: '',
        end: '',
        timeZone: localTimeZone(),
      };
    case 'generateDocument':
      return {
        id,
        name: '',
        kind,
        tableId: tableId ?? fallbackTableId,
        record: 'trigger',
        templateFieldId: '',
        attachmentFieldId: '',
        format: 'docx',
        filename: '',
        values: {},
      };
    case 'askAi':
      return { id, name: '', kind, prompt: '', format: 'text', tier: 'everyday', classification: 'internal' };
    case 'if':
      return { id, name: '', kind, conditions: null, then: [], otherwise: [] };
    case 'switch':
      return {
        id,
        name: '',
        kind,
        value: '',
        cases: [{ id: newStepId(), value: '', steps: [] }],
        otherwise: [],
      };
    case 'repeat':
      return { id, name: '', kind, list: '[]', steps: [] };
    case 'wait':
      return {
        id,
        name: '',
        kind,
        mode: 'duration',
        seconds: 60,
        date: '',
        conditions: null,
        timeoutSeconds: 86400,
      };
    case 'slack':
    case 'teams':
    case 'discord':
      return { id, name: '', kind, webhookUrl: '', body: '' };
    case 'studioFlow':
      return {
        id,
        name: '',
        kind,
        webhookUrl: '',
        body: '',
        title: '',
        recipient: '',
        recordUrl: tableId ? '{{trigger.record.url}}' : '',
      };
    case 'sms':
      return { id, name: '', kind, accountSid: '', authToken: '', from: '', to: '', body: '' };
    case 'script':
      return { id, name: '', kind, script: '', input: {} };
    case 'updateRecord': {
      if (tableId) return { id, name: '', kind, record: 'trigger', tableId, values: {} };
      const created = config.steps
        .slice(0, index)
        .filter((step) => step.kind === 'createRecord')
        .at(-1);
      return created
        ? { id, name: '', kind, record: created.id, tableId: created.tableId, values: {} }
        : { id, name: '', kind, record: 'trigger', tableId: fallbackTableId, values: {} };
    }
    case 'createRecord':
      return { id, name: '', kind, tableId: tableId ?? fallbackTableId, values: {} };
    case 'sendNotification':
      return {
        id,
        name: '',
        kind,
        recipients: { kind: 'automationOwner' },
        title: '',
        body: '',
        link: { kind: 'record' },
      };
    case 'sendEmail':
      return { id, name: '', kind, to: [''], subject: '', body: '' };
    case 'callWebhook':
      return { id, name: '', kind, url: '', method: 'POST', headers: {}, body: '' };
  }
}

export function withSteps(config: AutomationConfig, steps: AutomationStep[]): AutomationConfig {
  return { ...config, steps };
}

export function insertStep(config: AutomationConfig, index: number, step: AutomationStep): AutomationConfig {
  const steps = [...config.steps];
  steps.splice(index, 0, step);
  return withSteps(config, steps);
}

export function replaceStep(config: AutomationConfig, index: number, step: AutomationStep): AutomationConfig {
  return withSteps(
    config,
    config.steps.map((item, position) => (position === index ? step : item)),
  );
}

export function moveStep(config: AutomationConfig, index: number, offset: number): AutomationConfig {
  const target = index + offset;
  if (target < 0 || target >= config.steps.length) return config;
  const steps = [...config.steps];
  const [step] = steps.splice(index, 1);
  steps.splice(target, 0, step!);
  return withSteps(config, steps);
}

export function removeStep(config: AutomationConfig, index: number): AutomationConfig {
  return withSteps(
    config,
    config.steps.filter((_, position) => position !== index),
  );
}

/** Copies local references with their steps so a duplicated path remains self-contained. */
export function duplicateStep(step: AutomationStep): AutomationStep {
  const ids = new Map(flattenAutomationSteps([step]).map((item) => [item.id, newStepId()]));
  const copy = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') {
      if ((key === 'id' || key === 'record') && ids.has(value)) return ids.get(value);
      let text = value;
      for (const [before, after] of ids) text = text.replaceAll(`steps.${before}.`, `steps.${after}.`);
      return text;
    }
    if (Array.isArray(value)) return value.map((item) => copy(item));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== 'secretRef')
          .map(([key, item]) => [key, key === 'secretSaved' ? false : copy(item, key)]),
      );
    return value;
  };
  return copy(step) as AutomationStep;
}
