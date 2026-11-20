import { CHOICE_COLORS, LIMITS, newId, type FieldMeta } from '@riosoma/contracts';
import type { CommandInput } from '../../data/types';
import type { PastePlan } from './plan';

export interface PasteCommands {
  optionCommands: CommandInput[];
  /** Call after the option commands succeed; values are parsed against the appended choices. */
  recordCommands(): CommandInput[];
}

const COLORS = CHOICE_COLORS.filter((color) => color !== 'gray');

/** Options must exist before record values can refer to their IDs. */
export function pasteCommands(
  plan: PastePlan,
  tableId: string,
  fieldsById: ReadonlyMap<string, FieldMeta>,
): PasteCommands {
  const optionCommands: CommandInput[] = [];
  const resolvedFields = new Map(fieldsById);
  for (const [fieldId, names] of plan.newChoices) {
    const field = fieldsById.get(fieldId);
    if (field?.type !== 'singleSelect' && field?.type !== 'multipleSelect') continue;
    if (field.options.cascade || field.options.source) continue;
    const choices = [...field.options.choices];
    for (const name of names) {
      choices.push({ id: newId('choice'), name, color: COLORS[choices.length % COLORS.length]! });
    }
    const options = { ...field.options, choices };
    resolvedFields.set(fieldId, { ...field, options });
    optionCommands.push({ kind: 'field.update', fieldId, options });
  }
  return {
    optionCommands,
    recordCommands() {
      const resolved = plan.replan(resolvedFields);
      const commands: CommandInput[] = [];
      for (const [kind, records] of [
        ['record.update', resolved.updates],
        ['record.create', resolved.creates],
      ] as const) {
        for (let start = 0; start < records.length; start += LIMITS.recordsPerCommand) {
          commands.push({ kind, tableId, records: records.slice(start, start + LIMITS.recordsPerCommand) });
        }
      }
      return commands;
    },
  };
}
