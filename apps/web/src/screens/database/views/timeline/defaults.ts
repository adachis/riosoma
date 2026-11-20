import type { FieldMeta } from '@riosoma/contracts';

/**
 * Words in a field's name that say it's when something starts or ends, in each language the app
 * speaks.  Latin-script names match whole words, with accents ignored, so "Start" never matches
 * "Restart" and "End" never matches "Weekend".  Chinese, Japanese, and Korean names match anywhere
 * in the name.  Words as general as "de" or "to" are left out, since "Fecha de fin" has both.
 */
const START_WORDS = [
  // English
  'start',
  'starts',
  'starting',
  'begin',
  'begins',
  'beginning',
  'from',
  'kickoff',
  'opens',
  'opening',
  'commence',
  'commences',
  // Spanish, Portuguese, French, Italian, German, Dutch
  'inicio',
  'comienzo',
  'desde',
  'apertura',
  'comeco',
  'abertura',
  'debut',
  'commencement',
  'ouverture',
  'lancement',
  'inizio',
  'avvio',
  'beginn',
  'anfang',
  'startdatum',
  'eroffnung',
  'vanaf',
  'aanvang',
  'begindatum',
];

const END_WORDS = [
  // English
  'end',
  'ends',
  'ending',
  'finish',
  'finishes',
  'due',
  'deadline',
  'until',
  'through',
  'closes',
  'closing',
  // Spanish, Portuguese, French, Italian, German, Dutch
  'fin',
  'final',
  'hasta',
  'vencimiento',
  'cierre',
  'fim',
  'termino',
  'ate',
  'prazo',
  'encerramento',
  'jusqu',
  'echeance',
  'cloture',
  'fine',
  'scadenza',
  'chiusura',
  'ende',
  'bis',
  'frist',
  'enddatum',
  'faellig',
  'fallig',
  'einde',
  'eind',
  'einddatum',
  'afloop',
];

const START_PHRASES = ['開始', '开始', '起始', '着手', '시작'];
const END_PHRASES = ['終了', '结束', '結束', '截止', '期限', '締切', '締め切り', '마감', '종료'];

const START = new Set(START_WORDS);
const END = new Set(END_WORDS);

function words(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Whether a field's name says it's when something starts, ends, both, or neither. */
function suggests(name: string): { start: boolean; end: boolean } {
  const list = words(name);
  // Two words run together count too, as in "Kick off" or "Start date".
  const joined = list.slice(1).map((word, index) => `${list[index]!}${word}`);
  const has = (set: ReadonlySet<string>, phrases: readonly string[]) =>
    list.some((word) => set.has(word)) ||
    joined.some((word) => set.has(word)) ||
    phrases.some((phrase) => name.includes(phrase));
  return { start: has(START, START_PHRASES), end: has(END, END_PHRASES) };
}

function role(field: FieldMeta): 'start' | 'end' | null {
  const { start, end } = suggests(field.name ?? '');
  return start === end ? null : start ? 'start' : 'end';
}

/**
 * The fields a new timeline or Gantt chart starts and ends its bars with.  A date field whose name
 * suggests a start comes first, and one whose name suggests an end next.  Without them it's the
 * first date fields in the table's order, as it always was, and a table with no date fields
 * starts its bars on a date its records keep for themselves, such as when each was created.
 */
export function timelineDates(fields: readonly FieldMeta[]): {
  startFieldId: string | null;
  endFieldId: string | null;
} {
  const dates = fields.filter((field) => field.type === 'date');
  const start =
    dates.find((field) => role(field) === 'start') ??
    dates.find((field) => role(field) !== 'end') ??
    dates[0];
  const others = dates.filter((field) => field !== start);
  const end =
    others.find((field) => role(field) === 'end') ?? others.find((field) => role(field) !== 'start');
  // A date formula only JavaScript computes can't place records, so it isn't a choice.
  const computed = fields.find(
    (field) =>
      field.type === 'createdTime' ||
      field.type === 'lastModifiedTime' ||
      (field.type === 'formula' &&
        ['date', 'datetime'].includes(field.options.resultType) &&
        field.options.sortable),
  );
  return { startFieldId: start?.id ?? computed?.id ?? null, endFieldId: end?.id ?? null };
}
