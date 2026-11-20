import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ColorRule, FieldMeta, FilterGroup, GridConfig, ViewMeta } from '@riosoma/contracts';
import type { DatabaseSession } from '../../../data/types';
import { conditionsOf } from '../view/filterValues';
import { reportError } from '../../../grid/view/actions';

function textValueOnly(
  before: FilterGroup | null,
  after: FilterGroup | null,
  fields: readonly FieldMeta[],
): boolean {
  if (!before || !after) return false;
  const strip = (filter: FilterGroup) =>
    JSON.stringify(filter, (key, value: unknown) => (key === 'value' ? undefined : value));
  if (strip(before) !== strip(after)) return false;
  const previous = new Map(conditionsOf(before).map((condition) => [condition.id, condition]));
  return conditionsOf(after)
    .filter(
      (condition) => JSON.stringify(condition.value) !== JSON.stringify(previous.get(condition.id)?.value),
    )
    .every((condition) => {
      const type = fields.find((field) => field.id === condition.fieldId)?.type;
      return (
        type === 'text' ||
        type === 'longText' ||
        type === 'email' ||
        type === 'url' ||
        type === 'phone' ||
        type === 'number'
      );
    });
}

/** Only names and typed values changed, so saving can wait for a pause in typing. */
function ruleTextOnly(
  before: readonly ColorRule[],
  after: readonly ColorRule[],
  fields: readonly FieldMeta[],
): boolean {
  if (before.length !== after.length) return false;
  const strip = (rule: ColorRule) =>
    JSON.stringify(rule, (key, value: unknown) => (key === 'value' || key === 'name' ? undefined : value));
  return after.every((rule, index) => {
    const previous = before[index]!;
    if (strip(previous) !== strip(rule)) return false;
    if (JSON.stringify(previous.condition.value) === JSON.stringify(rule.condition.value)) return true;
    const type = fields.find((field) => field.id === rule.condition.fieldId)?.type;
    return (
      type === 'text' ||
      type === 'longText' ||
      type === 'email' ||
      type === 'url' ||
      type === 'phone' ||
      type === 'number'
    );
  });
}

export function useViewConfig(session: DatabaseSession, view: ViewMeta, fields: readonly FieldMeta[]) {
  const [draft, setDraft] = useState<Partial<GridConfig>>({});
  const pending = useRef<Partial<GridConfig>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const config = useMemo(() => ({ ...view.config, ...draft }), [view.config, draft]);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length) {
      try {
        session.run([{ kind: 'view.update', viewId: view.id, config: patch }]);
      } catch (error) {
        reportError(error);
      }
    }
  }, [session, view.id]);
  useEffect(() => () => flush(), [flush]);
  const change = useCallback(
    (patch: Partial<GridConfig>) => {
      const debounce =
        Object.keys(patch).length === 1 &&
        (('filter' in patch && textValueOnly(config.filter, patch.filter ?? null, fields)) ||
          ('colorRules' in patch && ruleTextOnly(config.colorRules, patch.colorRules ?? [], fields)));
      const merged = { ...pending.current, ...patch };
      pending.current = merged;
      setDraft(merged);
      clearTimeout(timer.current);
      if (debounce)
        timer.current = setTimeout(() => {
          flush();
          setDraft({});
        }, 400);
      else {
        flush();
        setDraft({});
      }
    },
    [config.filter, config.colorRules, fields, flush],
  );
  return { config, change };
}
