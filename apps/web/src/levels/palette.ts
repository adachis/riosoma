import type { I18n } from '@lingui/core';
import { useLingui } from '@lingui/react';
import type { IconDefinition } from '@riosoma/icons';
import { useEffect, useMemo, useRef } from 'react';
import { usePaletteItems } from '../palette/sources';
import type { PaletteFeatureCommand } from '../palette/types';
import { placeAt, type FeatureId, type PlaceKey } from './features';

/** A registered entry's palette words, and the feature it belongs to */
export interface PlaceWords {
  label: string;
  icon: IconDefinition;
  feature: FeatureId;
  place: PlaceKey;
}

/**
 * What the palette calls a registered entry, in the person's language.  The registry is the only
 * source of these words, so naming an entry the registry doesn't know is a mistake, and throws.
 */
export function placeWords(i18n: I18n, key: PlaceKey): PlaceWords {
  const found = placeAt(key);
  if (!found) throw new Error(`No feature is registered at ${key}`);
  const { command } = found.place;
  return { label: command.label(i18n), icon: command.icon, feature: found.feature.id, place: key };
}

/** What a screen does when the palette opens one of its registered entries */
export interface FeatureAction {
  /** The registered entry the action stands in for */
  place: PlaceKey;
  /** What it acts on, when a screen offers the entry once for each table, field, view, or record */
  target?: { id: string; name: string };
  run(): void;
}

const rowId = ({ place, target }: FeatureAction) => `feature:${place}${target ? `:${target.id}` : ''}`;

/**
 * Offers the registered entries a screen can open to the palette, for as long as the screen is
 * mounted and whatever the person's level: search always finds every feature.  The words come
 * from the registry.  The rows change only when their words do, and choosing one runs the
 * screen's latest version of it, so a command never acts on the screen as it was when the command
 * was first offered.
 */
export function useFeatureCommands(key: string, actions: readonly FeatureAction[]): void {
  const { i18n } = useLingui();
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });
  const signature = [
    i18n.locale,
    ...actions.map((action) => [rowId(action), action.target?.name ?? ''].join('\u0000')),
  ].join('\u0001');
  const offers = useMemo<PaletteFeatureCommand[]>(
    () =>
      actions.map((action) => {
        const id = rowId(action);
        const { label, icon, feature, place } = placeWords(i18n, action.place);
        return {
          id,
          group: 'features',
          label,
          icon,
          feature,
          place,
          ...(action.target ? { secondary: action.target.name } : {}),
          run: () => latest.current.find((current) => rowId(current) === id)?.run(),
        };
      }),
    // The rows follow the words alone.  Each run looks up the latest action when it's chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  );
  usePaletteItems(key, offers);
}
