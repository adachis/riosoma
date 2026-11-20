import type { PublicQuestion } from '@riosoma/contracts';

/** Shared by the server and the site script so visibility uses exactly the submitted value shapes. */
export function decodeSiteAnswers(
  questions: readonly PublicQuestion[],
  values: URLSearchParams,
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const question of questions) {
    const name = question.fieldId;
    const value = values.get(name);
    if (question.type === 'lineItems') {
      const columns = question.options.columns as Array<{
        id: string;
        name: string;
        type: PublicQuestion['type'];
        options: Record<string, unknown>;
      }>;
      const indices = new Set<number>();
      for (const key of values.keys()) {
        if (!key.startsWith(`${name}.`)) continue;
        const index = key.slice(name.length + 1).split('.')[0]!;
        if (/^\d{1,6}$/.test(index)) indices.add(Number(index));
      }
      answers[name] = [...indices]
        .sort((a, b) => a - b)
        .flatMap((index) => {
          const fields = columns.map((column) => ({
            fieldId: `${name}.${index}.${column.id}`,
            type: column.type,
            options: column.options,
            label: column.name,
            help: '',
            required: false,
          }));
          const decoded = decodeSiteAnswers(fields, values);
          const cells = Object.fromEntries(
            columns.map((column) => [column.id, decoded[`${name}.${index}.${column.id}`]]),
          );
          return Object.values(cells).some(
            (cell) => cell !== undefined && cell !== false && cell !== null && cell !== '',
          )
            ? [{ values: Object.fromEntries(Object.entries(cells).filter(([, cell]) => cell !== undefined)) }]
            : [];
        });
    } else if (question.type === 'multiCurrency') {
      const amount = values.get(`${name}.amount`);
      if (amount)
        answers[name] = { amount: Number(amount), code: values.get(`${name}.code`) ?? question.options.code };
    } else if (question.type === 'checkbox') answers[name] = value === 'on';
    else if (question.type === 'multipleSelect') answers[name] = values.getAll(name).filter(Boolean);
    else if (question.type === 'location' && values.get(`${name}.lat`) && values.get(`${name}.lng`)) {
      answers[name] = { lat: Number(values.get(`${name}.lat`)), lng: Number(values.get(`${name}.lng`)) };
    } else if (question.type === 'dateRange' && values.get(`${name}.start`)) {
      answers[name] = {
        start: `${values.get(`${name}.start`)}${question.options.includeTime ? 'Z' : ''}`,
        end: values.get(`${name}.end`)
          ? `${values.get(`${name}.end`)}${question.options.includeTime ? 'Z' : ''}`
          : null,
      };
    } else if (value) {
      if (['number', 'currency', 'percent', 'duration', 'rating'].includes(question.type))
        answers[name] = Number(value);
      else if (question.type === 'signature') answers[name] = { name: value };
      else if (question.type === 'date' && question.options.includeTime) answers[name] = `${value}Z`;
      else answers[name] = value;
    }
  }
  return answers;
}
