import {
  automationPaths,
  connectionAncestors,
  connectionLoopBody,
  connectionOrder,
  flattenAutomationSteps,
  type AutomationConfig,
  type AutomationStep,
} from '@riosoma/contracts';
import type { RunRow } from './store.js';
import {
  bodyText,
  bodyValue,
  fillJson,
  fillText,
  soleToken,
  tokensIn,
  type Resolver,
  type TokenValue,
} from './tokens.js';

export function templatesFor(step: AutomationStep): string[] {
  switch (step.kind) {
    case 'findRecords':
    case 'if':
      return [];
    case 'createCalendarEvent':
      return [step.title, step.description, step.start, step.end];
    case 'generateDocument':
      return [step.filename, ...Object.values(step.values)];
    case 'askAi':
      return [step.prompt];
    case 'switch':
      return [step.value];
    case 'repeat':
      return [step.list];
    case 'wait':
      return step.mode === 'date' ? [step.date] : [];
    case 'createRecord':
    case 'updateRecord':
      return Object.values(step.values);
    case 'script':
      return Object.values(step.input);
    case 'sendNotification':
      return [step.title, step.body, ...(step.link.kind === 'custom' ? [step.link.url] : [])];
    case 'sendEmail':
      return [...step.to, step.subject, step.body];
    case 'callWebhook':
      return [step.url, ...Object.values(step.headers), step.body];
    case 'studioFlow':
      return [step.body, step.title, step.recipient, step.recordUrl];
    case 'sms':
      return [step.to, step.body];
    default:
      return [step.body];
  }
}

export const tokenKey = (raw: string): string => raw.slice(2, -2).trim();
export const recordKey = (
  step: Extract<AutomationStep, { kind: 'updateRecord' | 'generateDocument' }>,
): string =>
  step.record === 'item'
    ? 'item'
    : step.record === 'trigger'
      ? 'trigger.recordId'
      : `steps.${step.record}.recordId`;

export function requiredValues(step: AutomationStep): string[] {
  const keys = templatesFor(step).flatMap((template) => tokensIn(template).map(({ raw }) => tokenKey(raw)));
  if (step.kind === 'sendNotification' && ['personField', 'recordCreator'].includes(step.recipients.kind))
    keys.push('trigger.recordId');
  if (step.kind === 'updateRecord' || step.kind === 'generateDocument') keys.push(recordKey(step));
  return [...new Set(keys)].filter((key) => key !== 'now');
}

export function sampleValue(value: unknown): TokenValue {
  return { text: bodyText(value), json: value, addresses: typeof value === 'string' ? [value] : [] };
}

export function recordedValues(
  row: RunRow | undefined,
  config: AutomationConfig,
  stepId: string,
): Record<string, TokenValue> | undefined {
  if (!row) return undefined;
  const steps = config.steps;
  const graph = config.connections !== undefined;
  const pathTo = (
    list: readonly AutomationStep[],
    path: Array<string | null> = [],
  ): Array<string | null> | undefined => {
    for (const step of list) {
      if (step.id === stepId) return path;
      for (const branch of automationPaths(step)) {
        const found = pathTo(branch.steps, [...path, step.id, step.kind === 'repeat' ? null : branch.id]);
        if (found) return found;
      }
    }
    return undefined;
  };
  const expected = graph
    ? connectionOrder(config)
        .filter((step) => step.kind === 'repeat' && connectionLoopBody(config, step.id).has(stepId))
        .flatMap((step) => [step.id, null])
    : pathTo(steps);
  if (!expected) return undefined;
  // Choose the last execution of this step on its current path.  An occurrence in another loop
  // or branch cannot supply its item, index, or earlier outputs.
  const at = row.steps.findLastIndex((result) => {
    const path = result.path ?? [];
    return (
      result.stepId === stepId &&
      result.state !== 'skipped' &&
      result.state !== 'queued' &&
      path.length === expected.length &&
      expected.every((part, index) =>
        part === null ? /^(0|[1-9]\d*)$/.test(path[index]!) : part === path[index],
      )
    );
  });
  if (expected.length && at < 0) return undefined;
  const selected = row.steps[at];
  const path = selected?.path ?? [];
  const all = flattenAutomationSteps(steps);
  const ancestors = graph ? connectionAncestors(config, stepId) : null;
  const earlier = ancestors
    ? all.filter((step) => ancestors.has(step.id))
    : all.slice(
        0,
        all.findIndex((step) => step.id === stepId),
      );
  const values: Record<string, TokenValue> = {};
  if (row.body !== null) values['trigger.body'] = sampleValue(row.body);
  if (row.record_id) values['trigger.recordId'] = sampleValue(row.record_id);
  for (const result of at < 0 ? row.steps : row.steps.slice(0, at + 1)) {
    const resultPath = result.path ?? [];
    if (resultPath.length > path.length || !resultPath.every((part, index) => part === path[index])) continue;
    const step = earlier.find((item) => item.id === result.stepId);
    if (result === selected || (step && result.state === 'succeeded')) Object.assign(values, result.context);
    if (!step || result.state !== 'succeeded' || !result.output) continue;
    values[`steps.${step.id}.output`] = sampleValue(
      step.kind === 'script' ? result.output.value : result.output,
    );
    if (typeof result.output.recordId === 'string')
      values[`steps.${step.id}.recordId`] = sampleValue(result.output.recordId);
  }
  // Loop values come only from the selected execution, never from a neighboring step's context.
  delete values.item;
  delete values.index;
  if (expected.includes(null) && selected?.context) {
    if (selected.context.item !== undefined) values.item = selected.context.item;
    if (selected.context.index !== undefined) values.index = selected.context.index;
  }
  const allowed = new Set(earlier.map((step) => step.id));
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => !key.startsWith('steps.') || allowed.has(key.split('.')[1]!)),
  );
}

export function valueAt(values: Record<string, TokenValue>, key: string): TokenValue | undefined {
  if (Object.hasOwn(values, key)) return values[key];
  const root = key.startsWith('item.')
    ? 'item'
    : key.startsWith('trigger.body.')
      ? 'trigger.body'
      : /^steps\.[^.]+\.output(?=\.)/.exec(key)?.[0];
  if (!root || !Object.hasOwn(values, root)) return undefined;
  const value = bodyValue(values[root]?.json, key.slice(root.length + 1).split('.'));
  return value === undefined ? undefined : sampleValue(value);
}

export function resolvedInputs(
  step: AutomationStep,
  resolve: Resolver,
  values: Record<string, TokenValue>,
): Record<string, unknown> {
  const text = (template: string) => fillText(template, resolve);
  const mapping = (input: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(input).map(([key, template]) => {
        const sole = soleToken(template);
        return [key, sole ? resolve(sole.ref, sole.raw).json : text(template)];
      }),
    );
  switch (step.kind) {
    case 'findRecords':
      return { tableId: step.tableId, filter: step.filter, limit: step.limit };
    case 'createCalendarEvent':
      return {
        provider: step.provider,
        calendarId: step.calendarId,
        title: text(step.title),
        description: text(step.description),
        ...mapping({ start: step.start, end: step.end }),
        timeZone: step.timeZone,
      };
    case 'generateDocument':
      return {
        tableId: step.tableId,
        recordId: valueAt(values, recordKey(step))?.json,
        templateFieldId: step.templateFieldId,
        attachmentFieldId: step.attachmentFieldId,
        format: step.format,
        filename: text(step.filename),
        values: mapping(step.values),
      };
    case 'askAi':
      return {
        prompt: step.prompt,
        values: Object.fromEntries(
          tokensIn(step.prompt).map(({ ref, raw }) => [tokenKey(raw), resolve(ref, raw).json]),
        ),
        format: step.format,
        tier: step.tier,
        classification: step.classification,
      };
    case 'if':
      return { conditions: step.conditions };
    case 'switch':
      return { value: text(step.value) };
    case 'repeat':
      return mapping({ list: step.list });
    case 'wait':
      return {
        mode: step.mode,
        seconds: step.seconds,
        date: step.mode === 'date' ? text(step.date) : '',
        conditions: step.conditions,
        timeoutSeconds: step.timeoutSeconds,
      };
    case 'script':
      return mapping(step.input);
    case 'createRecord':
      return { tableId: step.tableId, values: mapping(step.values) };
    case 'updateRecord':
      return {
        tableId: step.tableId,
        recordId: valueAt(values, recordKey(step))?.json,
        values: mapping(step.values),
      };
    case 'sendNotification':
      return {
        recipients: step.recipients,
        title: text(step.title),
        message: text(step.body),
        link: step.link.kind === 'custom' ? text(step.link.url) : step.link.kind,
      };
    case 'sendEmail':
      return { to: step.to.map(text), subject: text(step.subject), body: text(step.body) };
    case 'callWebhook':
      return {
        url: text(step.url),
        method: step.method,
        headers: Object.fromEntries(Object.entries(step.headers).map(([key, value]) => [key, text(value)])),
        body: fillJson(step.body, resolve),
      };
    case 'studioFlow':
      return {
        body: text(step.body),
        title: text(step.title),
        recipient: text(step.recipient),
        recordUrl: text(step.recordUrl),
      };
    case 'sms':
      return { to: text(step.to), from: step.from, body: text(step.body) };
    default:
      return { body: text(step.body) };
  }
}
