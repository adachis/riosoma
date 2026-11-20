import { useEffect, useMemo, useState } from 'react';
import { useLingui } from '@lingui/react';
import {
  rangeFieldIds,
  type FieldMeta,
  type FieldRange,
  type ViewMeta,
  type ViewRanges,
} from '@riosoma/contracts';
import { api } from '../../../api';
import type { DatabaseSession } from '../../../data/types';
import type { FormatContext } from '../../../grid/format';
import { ruleName } from './labels';
import { iconBandLabel } from './iconLabels';
import { createViewColors, NO_COLORS, type ViewColors } from './paint';

const NO_RANGES: ReadonlyMap<string, FieldRange> = new Map();

/**
 * The lowest and highest values of the fields a view's scales and bars measure, across every record
 * the view shows the person, not only the rows loaded so far.  They reload shortly after the table's
 * records change, when the view's filter changes, and when the connection comes back.
 */
export function useViewRanges(
  session: DatabaseSession,
  view: Pick<ViewMeta, 'id' | 'tableId' | 'config'>,
  fieldIds: readonly string[],
  timeZone: string,
  where?: string,
): ReadonlyMap<string, FieldRange> {
  const [ranges, setRanges] = useState(NO_RANGES);
  const wanted = fieldIds.join(',');
  const filter = JSON.stringify(view.config.filter);
  useEffect(() => {
    if (!wanted) return;
    let disposed = false;
    let version = 0;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      const request = ++version;
      controller?.abort();
      controller = new AbortController();
      const query = new URLSearchParams({ fields: wanted, tz: timeZone });
      if (where !== undefined) query.set('where', where);
      api<ViewRanges>(`/api/views/${view.id}/ranges?${query}`, { signal: controller.signal })
        .then((result) => {
          if (!disposed && request === version)
            setRanges(new Map(result.ranges.map((range) => [range.fieldId, range])));
        })
        // Scales and bars keep the last ranges they had until a later reload succeeds.
        .catch(() => {});
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 250);
    };
    refresh();
    const unsubscribe = session.subscribeRecords(view.tableId, schedule);
    // A save can finish after the optimistic change that asked for new ranges.
    const unsubscribeSave = session.subscribeSaveState(schedule);
    window.addEventListener('online', schedule);
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(timer);
      unsubscribe();
      unsubscribeSave();
      window.removeEventListener('online', schedule);
    };
  }, [session, view.id, view.tableId, wanted, filter, timeZone, where]);
  return ranges;
}

/**
 * A view's conditional colors, ready for any view type to draw.  Rules follow the view's
 * configuration as it's edited, so the view previews each change.  Views that don't draw colors
 * pass `enabled` false and get none.
 */
export function useViewColors(
  session: DatabaseSession,
  view: Pick<ViewMeta, 'id' | 'tableId' | 'config'>,
  fields: readonly FieldMeta[],
  format: FormatContext,
  enabled = true,
  where?: string,
): ViewColors {
  const { i18n } = useLingui();
  const { colorRules, colorScales, dataBars, iconSets, sparklines } = view.config;
  const fieldIds = enabled ? rangeFieldIds(view.config, fields) : [];
  const ranges = useViewRanges(session, view, fieldIds, format.timeZone, where);
  return useMemo(
    () =>
      enabled &&
      (colorRules.length || colorScales.length || dataBars.length || iconSets.length || sparklines.length)
        ? createViewColors({
            config: { colorRules, colorScales, dataBars, iconSets, sparklines },
            fields,
            i18n,
            ranges,
            context: {
              timeZone: format.timeZone,
              linkedName: (id) => session.linked.get(id),
              fileName: (id) => session.attachments.get(id)?.name,
            },
            label: (rule, field) => ruleName(rule, field, format, i18n),
            iconLabel: (set, band) => iconBandLabel(set, band, i18n),
          })
        : NO_COLORS,
    [enabled, colorRules, colorScales, dataBars, iconSets, sparklines, fields, ranges, format, session, i18n],
  );
}
