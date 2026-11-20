import { msg } from '@lingui/core/macro';
import type { I18n } from '@lingui/core';
import type { AutomationConfig } from '@riosoma/contracts';
import { connectionAncestors, flattenAutomationSteps } from '@riosoma/contracts';
import type { SchemaState } from '../../../data/types';
import { isRecordStep, triggerTableId } from './model';
import type { TokenCatalog, TokenGroup } from './TemplateInput';
import { readToken, token } from './tokens';

export function triggerRecordLabel(i18n: I18n): string {
  return i18n._(msg({ id: 'automations.step.triggerRecord', message: 'The record that started it' }));
}

export function stepRecordLabel(i18n: I18n, n: number): string {
  return i18n._(msg({ id: 'automations.step.createdBy', message: `The record from step ${n}` }));
}

/**
 * The values a step's text can use: the fields of the record that started the automation, the
 * fields of records that earlier steps made or changed, the current time, and, for webhooks, paths
 * into the JSON that was sent.
 */
export function tokenCatalog(
  config: AutomationConfig,
  index: number,
  schema: SchemaState,
  i18n: I18n,
  inLoop = false,
): TokenCatalog {
  const steps = config.connections ? flattenAutomationSteps(config.steps) : config.steps;
  const ancestors = config.connections ? connectionAncestors(config, steps[index]?.id ?? '') : null;
  const available = steps
    .map((step, position) => ({ step, position }))
    .filter(({ step, position }) => (ancestors ? ancestors.has(step.id) : position < index));
  const triggerTable = triggerTableId(config.trigger, schema);
  const now = i18n._(msg({ id: 'automations.token.now', message: 'The current time' }));
  const link = i18n._(msg({ id: 'automations.token.link', message: 'Link to the record' }));
  const deleted = i18n._(msg({ id: 'automations.token.missing', message: 'A deleted field' }));
  const groups: TokenGroup[] = [];
  const item = i18n._(msg({ id: 'automations.loop.item', message: 'Current item' }));
  const loopIndex = i18n._(msg({ id: 'automations.loop.index', message: 'Loop index, starting at zero' }));
  if (inLoop)
    groups.push({
      id: 'loop',
      title: i18n._(msg({ id: 'automations.step.repeat', message: 'Repeat for each' })),
      choices: [
        { token: 'item', label: item },
        { token: 'index', label: loopIndex },
      ],
    });
  if (triggerTable)
    groups.push({
      id: 'trigger',
      title: triggerRecordLabel(i18n),
      choices: [
        ...(schema.fields.get(triggerTable) ?? []).map((field) => ({
          token: token.triggerField(field.id),
          label: field.name,
        })),
        { token: token.link, label: link },
      ],
    });
  available.forEach(({ step, position }) => {
    if (isRecordStep(step))
      groups.push({
        id: step.id,
        title: stepRecordLabel(i18n, position + 1),
        choices: (schema.fields.get(step.tableId) ?? []).map((field) => ({
          token: token.stepField(step.id, field.id),
          label: field.name,
        })),
      });
  });
  available.forEach(({ step, position }) => {
    const n = position + 1;
    groups.push({
      id: `${step.id}-output`,
      title: i18n._(msg({ id: 'automations.script.stepOutput', message: `Output from step ${n}` })),
      choices: [
        ...(step.kind === 'findRecords'
          ? [
              {
                token: `steps.${step.id}.output.records`,
                label: i18n._(msg({ id: 'automations.find.records', message: 'Records' })),
              },
            ]
          : []),
        ...(step.kind === 'askAi'
          ? [
              {
                token: `steps.${step.id}.output.${step.format}`,
                label: i18n._(msg({ id: 'automations.ask.answer', message: 'Answer' })),
              },
            ]
          : []),
        {
          token: `steps.${step.id}.output`,
          label: i18n._(msg({ id: 'automations.script.output', message: 'Output' })),
        },
      ],
    });
  });
  return {
    groups,
    extras: [{ token: token.now, label: now }],
    body: config.trigger.kind === 'webhook',
    describe(text) {
      const ref = readToken(text);
      switch (ref?.kind) {
        case 'item':
          return { label: ref.path || item, missing: !inLoop };
        case 'index':
          return { label: loopIndex, missing: !inLoop };
        case 'output':
          return {
            label: ref.path || i18n._(msg({ id: 'automations.script.output', message: 'Output' })),
            missing: !available.some(({ step }) => step.id === ref.stepId),
          };
        case 'now':
          return { label: now, missing: false };
        case 'link':
          return { label: link, missing: !triggerTable, source: triggerRecordLabel(i18n) };
        case 'triggerField': {
          const field = schema.fieldById.get(ref.fieldId);
          return field && field.tableId === triggerTable
            ? { label: field.name, missing: false, source: triggerRecordLabel(i18n) }
            : { label: field?.name ?? deleted, missing: true };
        }
        case 'stepField': {
          const field = schema.fieldById.get(ref.fieldId);
          const position = steps.findIndex((step) => step.id === ref.stepId);
          const step = steps[position];
          return field && isRecordStep(step) && step.tableId === field.tableId
            ? {
                label: field.name,
                missing: ancestors ? !ancestors.has(step.id) : false,
                source: stepRecordLabel(i18n, position + 1),
              }
            : { label: field?.name ?? deleted, missing: true };
        }
        case 'body':
          return { label: ref.path, missing: config.trigger.kind !== 'webhook' };
        default:
          return { label: text, missing: true };
      }
    },
  };
}

/** SMS recipients can use only phone fields, while the message keeps the full token catalog. */
export function phoneCatalog(catalog: TokenCatalog, schema: SchemaState): TokenCatalog {
  return {
    ...catalog,
    extras: [],
    body: false,
    groups: catalog.groups
      .map((group) => ({
        ...group,
        choices: group.choices.filter((choice) => {
          const ref = readToken(choice.token);
          return (
            (ref?.kind === 'triggerField' || ref?.kind === 'stepField') &&
            schema.fieldById.get(ref.fieldId)?.type === 'phone'
          );
        }),
      }))
      .filter((group) => group.choices.length),
  };
}
