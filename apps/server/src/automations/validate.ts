import {
  AppError,
  automationPaths,
  automationConnectionProblems,
  connectionAncestors,
  connectionSteps,
  connectionLoopBody,
  isComputedType,
  isGroup,
  isTimeZone,
  type AutomationConfig,
  type AutomationStep,
  type FilterGroup,
} from '@riosoma/contracts';
import type { CommandContext } from '../data/commands/context.js';
import { managedRefused } from '../data/managed.js';
import { loadFields, loadTables, loadViews } from '../data/metadata.js';
import type { StoredField } from '../data/types.js';
import { E164, webhookAllowed } from './messaging.js';
import { fillJson, soleToken, tokensIn, type TokenValue } from './tokens.js';

/**
 * Checks an automation's configuration against the database before it's saved: its tables,
 * views, and fields belong to this database, steps that change a record point at the trigger's
 * record or one an earlier step created, and every token names something that will be there.
 */

const notFound = (): never => {
  throw new AppError('not_found', 'errors.notFound');
};
const invalid = (): never => {
  throw new AppError('validation_failed', 'errors.validationFailed');
};
const unknownToken = (token: string): never => {
  throw new AppError('validation_failed', 'automations.token.unknown', { params: { token } });
};

/** Header names an automation may set on its own.  The rest belong to the connection. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
  'te',
  'trailer',
  'expect',
]);

export function headerAllowed(name: string): boolean {
  const lower = name.toLowerCase();
  return HEADER_NAME.test(name) && !RESERVED_HEADERS.has(lower) && !lower.startsWith('proxy-');
}

/** The table whose records a trigger hands to the steps, or null for schedules and webhooks. */
export function triggerTableId(
  config: Pick<AutomationConfig, 'trigger'>,
  formTable: (viewId: string) => string | null,
): string | null {
  const trigger = config.trigger;
  switch (trigger.kind) {
    case 'recordCreated':
    case 'recordUpdated':
    case 'recordMatches':
      return trigger.tableId;
    case 'formSubmitted':
      return formTable(trigger.viewId);
    default:
      return null;
  }
}

function filterFieldIds(group: FilterGroup | null | undefined, into: string[] = []): string[] {
  for (const condition of group?.conditions ?? []) {
    if (isGroup(condition)) filterFieldIds(condition, into);
    else into.push(condition.fieldId);
  }
  return into;
}

const placeholder: TokenValue = { text: '', json: null, addresses: [] };

export async function validateConfig(
  c: CommandContext,
  config: AutomationConfig,
  publish = false,
): Promise<void> {
  const wiring = automationConnectionProblems(config, publish);
  if (wiring.length)
    throw new AppError('validation_failed', 'automations.wire.publish', {
      params: {
        missing: wiring
          .filter((problem) => problem.messageKey === 'automations.wire.missingInput')
          .map((problem) => problem.stepId)
          .join(', '),
        unreachable: wiring
          .filter((problem) => problem.messageKey === 'automations.wire.unreachable')
          .map((problem) => problem.stepId)
          .join(', '),
      },
    });
  const tables = await loadTables(c.db, c.schemas, c.databaseId);
  const tableIds = tables.map((table) => table.id);
  const views = await loadViews(c.db, c.schemas, tableIds);
  const active = await loadFields(c.db, c.schemas, tableIds);
  const all = await loadFields(c.db, c.schemas, tableIds, { includeTrashed: true });
  const fieldsOf = (fields: StoredField[], tableId: string) =>
    new Map(fields.filter((field) => field.tableId === tableId).map((field) => [field.id, field]));
  const tableKnown = (tableId: string) => tableIds.includes(tableId) || notFound();
  // Filters keep conditions on trashed fields, as views do, so restoring the field restores them.
  const checkFilter = (tableId: string, filter: FilterGroup | null | undefined) => {
    const known = fieldsOf(all, tableId);
    if (filterFieldIds(filter).some((id) => !known.has(id))) notFound();
  };

  const trigger = config.trigger;
  const formTable = (viewId: string) => {
    const view = views.find((candidate) => candidate.id === viewId);
    if (!view) return notFound();
    if (view.type !== 'form') return invalid();
    return view.tableId;
  };
  const triggerTable = triggerTableId(config, formTable);
  switch (trigger.kind) {
    case 'recordCreated':
      tableKnown(trigger.tableId);
      break;
    case 'recordUpdated': {
      tableKnown(trigger.tableId);
      const known = fieldsOf(all, trigger.tableId);
      if (trigger.fieldIds.some((id) => !known.has(id))) notFound();
      break;
    }
    case 'recordMatches': {
      tableKnown(trigger.tableId);
      if (trigger.viewId) {
        const view = views.find((candidate) => candidate.id === trigger.viewId);
        if (!view || view.tableId !== trigger.tableId) notFound();
      }
      checkFilter(trigger.tableId, trigger.filter);
      break;
    }
    case 'schedule':
      if (!isTimeZone(trigger.timeZone)) invalid();
      break;
    case 'formSubmitted':
    case 'webhook':
      break;
  }
  if (triggerTable) checkFilter(triggerTable, config.conditions);

  let earlier = new Map<string, AutomationStep>();
  let loopDepth = 0;
  const checkTokens = (template: string) => {
    for (const { raw, ref } of tokensIn(template)) {
      if (!ref) unknownToken(raw);
      else if ((ref.kind === 'item' || ref.kind === 'index') && !loopDepth) unknownToken(raw);
      else if (ref.kind === 'output' && !earlier.has(ref.stepId)) unknownToken(raw);
      else if (ref.kind === 'url' && !triggerTable) unknownToken(raw);
      else if (ref.kind === 'body' && trigger.kind !== 'webhook') unknownToken(raw);
      else if (ref.kind === 'field') {
        let tableId = triggerTable;
        if (ref.stepId !== null) {
          const step = earlier.get(ref.stepId);
          tableId =
            step && (step.kind === 'createRecord' || step.kind === 'updateRecord') ? step.tableId : null;
        }
        if (!tableId || !fieldsOf(active, tableId).has(ref.fieldId)) unknownToken(raw);
      }
    }
  };
  const checkValues = (tableId: string, values: Record<string, string>) => {
    const known = fieldsOf(active, tableId);
    for (const [fieldId, template] of Object.entries(values)) {
      const field = known.get(fieldId);
      if (!field) notFound();
      else if (isComputedType(field.type))
        throw new AppError('validation_failed', 'data.value.computed', { params: { fieldId } });
      // Only the person signing can sign, so a step never writes a signature.
      else if (field.type === 'signature')
        throw new AppError('validation_failed', 'data.value.signatureStep', { params: { fieldId } });
      // Only Riosoma writes a managed field, such as a payment result.
      else if (field.managed) throw managedRefused();
      checkTokens(template);
    }
  };

  const visit = (steps: AutomationStep[]) => {
    for (const step of steps) {
      if (config.connections) {
        const ancestors = publish
          ? connectionAncestors(config, step.id)
          : new Set(
              connectionSteps(config)
                .filter((entry) => entry.id !== step.id)
                .map((entry) => entry.id),
            );
        earlier = new Map(
          connectionSteps(config)
            .filter((entry) => ancestors.has(entry.id))
            .map((entry) => [entry.id, entry]),
        );
        loopDepth = connectionSteps(config).filter(
          (entry) => entry.kind === 'repeat' && connectionLoopBody(config, entry.id).has(step.id),
        ).length;
      }
      // `trigger` names the trigger's record, so no step may take it as its ID.
      if (earlier.has(step.id) || step.id === 'trigger') invalid();
      switch (step.kind) {
        case 'findRecords':
          tableKnown(step.tableId);
          checkFilter(step.tableId, step.filter);
          break;
        case 'createCalendarEvent':
          if (!isTimeZone(step.timeZone)) invalid();
          for (const text of [step.title, step.description, step.start, step.end]) checkTokens(text);
          break;
        case 'askAi':
          checkTokens(step.prompt);
          break;
        case 'if':
          if (!triggerTable) invalid();
          else checkFilter(triggerTable, step.conditions);
          break;
        case 'switch':
          checkTokens(step.value);
          break;
        case 'repeat':
          checkTokens(step.list);
          break;
        case 'wait':
          if (step.mode === 'date') checkTokens(step.date);
          if (step.mode === 'condition') {
            if (!triggerTable || !step.conditions) invalid();
            else checkFilter(triggerTable, step.conditions);
          }
          break;
        case 'script':
          for (const template of Object.values(step.input)) checkTokens(template);
          break;
        case 'generateDocument':
        case 'updateRecord': {
          tableKnown(step.tableId);
          if (step.record === 'item') {
            if (!loopDepth) invalid();
          } else if (step.record === 'trigger') {
            if (triggerTable !== step.tableId) invalid();
          } else {
            const source = earlier.get(step.record);
            if (source?.kind !== 'createRecord' || source.tableId !== step.tableId) invalid();
          }
          if (step.kind === 'generateDocument') {
            for (const id of [step.templateFieldId, step.attachmentFieldId]) {
              if (id && fieldsOf(active, step.tableId).get(id)?.type !== 'attachment') invalid();
            }
            checkTokens(step.filename);
            for (const value of Object.values(step.values)) checkTokens(value);
          } else {
            checkValues(step.tableId, step.values);
            if (step.baseValues) {
              checkValues(step.tableId, step.baseValues);
              for (const id of Object.keys(step.baseValues)) {
                const field = fieldsOf(active, step.tableId).get(id);
                if (field?.type !== 'longText' && field?.type !== 'json') invalid();
              }
            }
          }
          break;
        }
        case 'createRecord':
          tableKnown(step.tableId);
          checkValues(step.tableId, step.values);
          break;
        case 'slack':
        case 'teams':
        case 'studioFlow':
        case 'discord':
          if (step.webhookUrl && !webhookAllowed(step.kind, step.webhookUrl))
            throw new AppError('validation_failed', 'automations.messaging.webhook');
          checkTokens(step.body);
          if (step.kind === 'studioFlow') {
            checkTokens(step.title);
            checkTokens(step.recipient);
            checkTokens(step.recordUrl);
          }
          break;
        case 'sms': {
          checkTokens(step.body);
          checkTokens(step.to);
          const token = soleToken(step.to);
          if (token) {
            const ref = token.ref;
            if (ref?.kind !== 'field') invalid();
            else {
              const source = ref.stepId ? earlier.get(ref.stepId) : null;
              const tableId =
                ref.stepId === null
                  ? triggerTable
                  : source && (source.kind === 'createRecord' || source.kind === 'updateRecord')
                    ? source.tableId
                    : null;
              if (!tableId || fieldsOf(active, tableId).get(ref.fieldId)?.type !== 'phone')
                throw new AppError('validation_failed', 'automations.messaging.phone');
            }
          } else if (!E164.test(step.to))
            throw new AppError('validation_failed', 'automations.messaging.phone');
          if (!E164.test(step.from)) throw new AppError('validation_failed', 'automations.messaging.phone');
          if (!tokensIn(step.body).length && step.body.length > 1600)
            throw new AppError('validation_failed', 'automations.messaging.length');
          break;
        }
        case 'sendNotification':
          if (step.recipients.kind === 'personField') {
            if (!triggerTable || fieldsOf(active, triggerTable).get(step.recipients.fieldId)?.type !== 'user')
              invalid();
          }
          if (step.recipients.kind === 'recordCreator' && !triggerTable) invalid();
          for (const template of [
            step.title,
            step.body,
            ...(step.link.kind === 'custom' ? [step.link.url] : []),
          ])
            checkTokens(template);
          break;
        case 'sendEmail':
          for (const template of [...step.to, step.subject, step.body]) checkTokens(template);
          break;
        case 'callWebhook': {
          checkTokens(step.url);
          if (!tokensIn(step.url).length) {
            let url: URL | null = null;
            try {
              url = new URL(step.url.trim());
            } catch {
              invalid();
            }
            if (url && url.protocol !== 'http:' && url.protocol !== 'https:') invalid();
          }
          for (const [name, template] of Object.entries(step.headers)) {
            if (!headerAllowed(name)) invalid();
            checkTokens(template);
          }
          checkTokens(step.body);
          if (step.body.trim()) {
            try {
              JSON.parse(fillJson(step.body, () => placeholder));
            } catch {
              invalid();
            }
          }
          break;
        }
      }
      const parent = earlier;
      if (step.kind === 'repeat') loopDepth++;
      for (const path of automationPaths(step)) {
        earlier = new Map(parent);
        visit(path.steps);
      }
      if (step.kind === 'repeat') loopDepth--;
      earlier = parent;
      earlier.set(step.id, step);
    }
  };
  visit(config.steps);
}
