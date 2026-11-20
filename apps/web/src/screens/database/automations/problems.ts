import {
  automationPaths,
  connectionAncestors,
  connectionLoopBody,
  flattenAutomationSteps,
  type AutomationConfig,
  type AutomationStep,
  type FilterGroup,
} from '@riosoma/contracts';
import type { SchemaState } from '../../../data/types';
import { conditionsOf } from '../view/filterValues';
import { isRecordStep, triggerTableId } from './model';
import { tokensIn, type TokenRef } from './tokens';

/**
 * What stops part of an automation from working: something it uses was deleted, or a step uses a
 * record that only a later step makes.  Each card shows its own.
 */
export type Problem = 'missing' | 'order';

export interface Problems {
  trigger: ReadonlySet<Problem>;
  conditions: ReadonlySet<Problem>;
  steps: ReadonlyMap<string, ReadonlySet<Problem>>;
}

function templatesOf(step: AutomationStep): string[] {
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
    case 'slack':
    case 'teams':
    case 'discord':
      return [step.body];
    case 'studioFlow':
      return [step.body, step.title, step.recipient, step.recordUrl];
    case 'sms':
      return [step.body, step.to];
    case 'script':
      return Object.values(step.input);
    case 'updateRecord':
    case 'createRecord':
      return Object.values(step.values);
    case 'sendNotification':
      return [step.title, step.body, ...(step.link.kind === 'custom' ? [step.link.url] : [])];
    case 'sendEmail':
      return [...step.to, step.subject, step.body];
    case 'callWebhook':
      return [step.url, ...Object.values(step.headers), step.body];
  }
}

export function findProblems(config: AutomationConfig, schema: SchemaState): Problems {
  const inTable = (tableId: string | null | undefined, fieldId: string) =>
    !!tableId && schema.fieldById.get(fieldId)?.tableId === tableId;
  const filterFits = (filter: FilterGroup | null, tableId: string) =>
    conditionsOf(filter).every((condition) => inTable(tableId, condition.fieldId));
  const { trigger } = config;
  const triggerTable = triggerTableId(trigger, schema);

  const triggerProblems = new Set<Problem>();
  switch (trigger.kind) {
    case 'recordCreated':
    case 'recordUpdated':
    case 'recordMatches': {
      const fits =
        schema.tableById.has(trigger.tableId) &&
        (trigger.kind !== 'recordUpdated' ||
          trigger.fieldIds.every((fieldId) => inTable(trigger.tableId, fieldId))) &&
        (trigger.kind !== 'recordMatches' ||
          ((!trigger.viewId || schema.viewById.get(trigger.viewId)?.tableId === trigger.tableId) &&
            filterFits(trigger.filter, trigger.tableId)));
      if (!fits) triggerProblems.add('missing');
      break;
    }
    case 'formSubmitted':
      if (schema.viewById.get(trigger.viewId)?.type !== 'form') triggerProblems.add('missing');
      break;
    case 'schedule':
    case 'webhook':
      break;
  }

  const conditionProblems = new Set<Problem>();
  if (config.conditions && (!triggerTable || !filterFits(config.conditions, triggerTable)))
    conditionProblems.add('missing');

  const steps = new Map<string, Set<Problem>>();
  const visit = (list: AutomationStep[], parents: AutomationStep[], inLoop: boolean) =>
    list.forEach((step, index) => {
      const available = config.connections
        ? flattenAutomationSteps(config.steps).filter((entry) =>
            connectionAncestors(config, step.id).has(entry.id),
          )
        : [...parents, ...list.slice(0, index)];
      if (config.connections)
        inLoop = flattenAutomationSteps(config.steps).some(
          (entry) => entry.kind === 'repeat' && connectionLoopBody(config, entry.id).has(step.id),
        );
      const problems = new Set<Problem>();
      const earlier = (stepId: string): AutomationStep | Problem => {
        const source = available.find((item) => item.id === stepId);
        return (
          source ??
          (flattenAutomationSteps(config.steps).some((item) => item.id === stepId) ? 'order' : 'missing')
        );
      };
      const check = (ref: TokenRef) => {
        switch (ref.kind) {
          case 'item':
          case 'index':
            if (!inLoop) problems.add('missing');
            return;
          case 'output': {
            const source = earlier(ref.stepId);
            if (typeof source === 'string') problems.add(source);
            return;
          }
          case 'now':
            return;
          case 'link':
            if (!triggerTable) problems.add('missing');
            return;
          case 'triggerField':
            if (!inTable(triggerTable, ref.fieldId)) problems.add('missing');
            return;
          case 'body':
            if (trigger.kind !== 'webhook') problems.add('missing');
            return;
          case 'stepField': {
            const source = earlier(ref.stepId);
            if (typeof source === 'string') problems.add(source);
            else if (!isRecordStep(source) || !inTable(source.tableId, ref.fieldId)) problems.add('missing');
            return;
          }
        }
      };
      if (step.kind === 'updateRecord' || step.kind === 'generateDocument') {
        if (step.record === 'item') {
          if (!inLoop) problems.add('missing');
        } else if (step.record === 'trigger') {
          if (!triggerTable) problems.add('missing');
        } else {
          const source = earlier(step.record);
          if (typeof source === 'string') problems.add(source);
          else if (source.kind !== 'createRecord') problems.add('missing');
        }
      }
      if (step.kind === 'findRecords' && !filterFits(step.filter, step.tableId)) problems.add('missing');
      if (step.kind === 'generateDocument') {
        for (const id of [step.templateFieldId, step.attachmentFieldId])
          if (id && !inTable(step.tableId, id)) problems.add('missing');
      }
      if ('tableId' in step && !schema.tableById.has(step.tableId)) problems.add('missing');
      if (isRecordStep(step)) {
        if (!schema.tableById.has(step.tableId)) problems.add('missing');
        for (const fieldId of Object.keys(step.values))
          if (!inTable(step.tableId, fieldId)) problems.add('missing');
      }
      if (
        (step.kind === 'if' || (step.kind === 'wait' && step.mode === 'condition')) &&
        (!triggerTable || !filterFits(step.conditions, triggerTable))
      )
        problems.add('missing');
      for (const path of automationPaths(step))
        visit(path.steps, available, inLoop || step.kind === 'repeat');
      for (const template of templatesOf(step)) for (const ref of tokensIn(template)) check(ref);
      if (problems.size) steps.set(step.id, problems);
    });

  visit(config.steps, [], false);
  return { trigger: triggerProblems, conditions: conditionProblems, steps };
}
