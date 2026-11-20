import {
  choicesForRecord,
  checkCellValue,
  isDateOnly,
  type CellValue,
  type FieldMeta,
} from '@riosoma/contracts';

/** A model's answer as a value for its field, or the message key saying why it isn't one. */
export type ParsedOutput =
  { ok: true; value: CellValue } | { ok: false; messageKey: string; params?: Record<string, string> };

const fail = (messageKey: string, answer?: string): ParsedOutput => ({
  ok: false,
  messageKey,
  ...(answer !== undefined ? { params: { answer: answer.slice(0, 200) } } : {}),
});

/** An answer without what models tend to wrap one in: code fences, quotes, and a closing period. */
function bare(text: string): string {
  let answer = text.trim();
  const fenced = /^```[\w-]*\n?([\s\S]*?)\n?```$/.exec(answer);
  if (fenced) answer = fenced[1]!.trim();
  for (const [open, close] of [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['`', '`'],
  ] as const)
    if (answer.length >= 2 && answer.startsWith(open) && answer.endsWith(close))
      answer = answer.slice(1, -1).trim();
  return answer;
}

/** A single word or number with a closing period dropped, since "Yes." means yes. */
function word(text: string): string {
  return bare(text).replace(/\.$/, '').trim();
}

function choiceNamed(field: FieldMeta, answer: string): string | undefined {
  if (field.type !== 'singleSelect' && field.type !== 'multipleSelect') return undefined;
  const choices = field.options.choices;
  const exact = choices.find((choice) => choice.name === answer);
  if (exact) return exact.id;
  const folded = answer.trim().toLocaleLowerCase();
  const loose = choices.filter((choice) => choice.name.trim().toLocaleLowerCase() === folded);
  return loose.length === 1 ? loose[0]!.id : undefined;
}

/** The names a multiple select answer gives: a JSON list, or one to a line. */
function names(text: string): string[] {
  const answer = bare(text);
  if (answer.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(answer);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
    } catch {
      /* Read it line by line instead. */
    }
  }
  return answer
    .split('\n')
    .map((line) => bare(line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')).replace(/,$/, ''))
    .filter(Boolean);
}

function parsed(field: FieldMeta, text: string): ParsedOutput {
  switch (field.type) {
    case 'text':
      return { ok: true, value: bare(text).replace(/\s*\n\s*/g, ' ') };
    case 'longText':
      return { ok: true, value: bare(text) };
    case 'number': {
      const answer = word(text).replace(/(\d),(?=\d{3}\b)/g, '$1');
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(answer))
        return fail('aiFields.output.notNumber', word(text));
      return { ok: true, value: Number(answer) };
    }
    case 'checkbox': {
      const answer = word(text).toLowerCase();
      if (/^(true|yes|checked|1)$/.test(answer)) return { ok: true, value: true };
      if (/^(false|no|unchecked|0)$/.test(answer)) return { ok: true, value: false };
      return fail('aiFields.output.notCheckbox', word(text));
    }
    case 'date': {
      const answer = word(text);
      if (!field.options.includeTime) {
        const day = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/.exec(answer)?.[1];
        return day && isDateOnly(day) ? { ok: true, value: day } : fail('aiFields.output.notDate', answer);
      }
      if (isDateOnly(answer)) return { ok: true, value: `${answer}T00:00:00.000Z` };
      const time = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(answer)
        ? Date.parse(answer)
        : Number.NaN;
      return Number.isFinite(time)
        ? { ok: true, value: new Date(time).toISOString() }
        : fail('aiFields.output.notDate', answer);
    }
    case 'singleSelect': {
      const answer = word(text);
      if (answer === '') return { ok: true, value: null };
      const id = choiceNamed(field, answer) ?? choiceNamed(field, bare(text));
      // An answer that isn't one of the options is a mistake, never a new option.
      return id ? { ok: true, value: id } : fail('aiFields.output.notChoice', answer);
    }
    case 'multipleSelect': {
      const ids: string[] = [];
      for (const name of names(text)) {
        const id = choiceNamed(field, name);
        if (!id) return fail('aiFields.output.notChoice', name);
        if (!ids.includes(id)) ids.push(id);
      }
      return { ok: true, value: ids.length ? ids : null };
    }
    default:
      return fail('aiFields.outputType');
  }
}

/**
 * Reads a model's answer as a value of the field's type, checked as any written value is.  Text
 * becomes one line for a text field, numbers, checkboxes, and dates are read strictly, and a select
 * answer has to name one of the field's options.
 */
export function parseOutput(field: FieldMeta, text: string): ParsedOutput {
  const result = parsed(field, text);
  if (!result.ok) return result;
  const checked = checkCellValue(field, result.value);
  return checked.ok ? { ok: true, value: checked.value } : { ok: false, messageKey: checked.messageKey };
}

/** What the model is told about the shape of its answer, by the field's type. */
export function answerShape(field: FieldMeta, values: Readonly<Record<string, unknown>> = {}): string {
  switch (field.type) {
    case 'text':
      return 'Answer with one line of plain text.';
    case 'longText':
      return field.options.richText
        ? 'Answer with text.  Markdown formatting is fine.'
        : 'Answer with plain text.  Several paragraphs are fine.';
    case 'number':
      return 'Answer with one number only, using a period for decimals, with no thousands separators, units, or words.';
    case 'checkbox':
      return 'Answer with true or false only.';
    case 'date':
      return field.options.includeTime
        ? 'Answer with one date and time only, in ISO 8601 with a time zone offset, like 2026-09-28T14:30:00Z.'
        : 'Answer with one date only, as YYYY-MM-DD.';
    case 'singleSelect':
      return `Answer with exactly one of these options, written exactly as shown, or with nothing when none fits: ${JSON.stringify(choicesForRecord(field.options, values).map((choice) => choice.name))}`;
    case 'multipleSelect':
      return `Answer with a JSON list of the options that fit, written exactly as shown, or [] when none fits.  The options: ${JSON.stringify(choicesForRecord(field.options, values).map((choice) => choice.name))}`;
    default:
      return 'Answer with plain text.';
  }
}

/** Roughly how many tokens an answer of the field's type takes, low and high, for estimates. */
export function answerTokens(field: FieldMeta): { low: number; high: number } {
  switch (field.type) {
    case 'text':
      return { low: 10, high: 60 };
    case 'longText':
      return { low: 60, high: 600 };
    case 'multipleSelect':
      return { low: 4, high: 40 };
    default:
      return { low: 2, high: 16 };
  }
}
