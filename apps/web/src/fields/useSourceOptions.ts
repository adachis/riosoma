import { useEffect, useState } from 'react';
import type { Choice, FieldMeta, CellValue } from '@riosoma/contracts';
import { api } from '../api';
import type { DatabaseSession } from '../data';

type SelectField = Extract<FieldMeta, { type: 'singleSelect' | 'multipleSelect' }>;

/** Search the whole source without replacing labels for selections already on screen. */
export function useSourceOptions(
  field: SelectField,
  query: string,
  value?: CellValue,
  session?: DatabaseSession,
) {
  const [page, setPage] = useState<{
    fieldId: string;
    query: string;
    choices: Choice[];
    truncated: boolean;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const source = Boolean(field.options.source);
  const selected =
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.filter((id): id is string => typeof id === 'string')
        : [];
  const missing = selected
    .filter((id) => !field.options.choices.some((choice) => choice.id === id))
    .join(',');
  const selection = selected.join(',');
  useEffect(() => {
    if (page?.fieldId === field.id && source)
      session?.rememberSelectChoices(
        field.id,
        page.choices.filter((choice) => selection.split(',').includes(choice.id)),
      );
  }, [field.id, page, selection, session, source]);
  useEffect(() => {
    if (!source || (!query.trim() && !missing)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<{ choices: Choice[]; truncated: boolean }>(
        `/api/fields/${field.id}/select-options?${query.trim() ? `search=${encodeURIComponent(query)}` : `ids=${encodeURIComponent(missing)}`}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (!controller.signal.aborted) {
            setPage({ ...result, fieldId: field.id, query });
            setFailed(false);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [field.id, field.options.choices, source, query, missing]);
  return {
    choices: page?.fieldId === field.id ? page.choices : [],
    truncated: page?.query === query ? page.truncated : field.options.sourceTruncated,
    failed,
  };
}
