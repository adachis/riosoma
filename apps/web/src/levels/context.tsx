import { useLingui } from '@lingui/react/macro';
import { levelsFor, reaches, type Level, type SessionInfo } from '@riosoma/contracts';
import { toast } from '@riosoma/ui';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useSavePreferences } from '../screens/settings/usePreferences';
import { appliedSettings } from '../session';
import { featureLevel, offersAt, tidiesAt, type FeatureId, type Holdings, type Surface } from './policy';
import { readUses, recordUse, suggestedLevel, type LevelUse } from './uses';
import { ABOVE_LEVEL_NOTES, SHOW_THEM } from './words';

export interface LevelState {
  /** The level the person works at */
  level: Level;
  /** The highest level they can choose */
  highest: Level;
  /** Where they'd be without a choice of their own */
  start: Level;
  /**
   * Whether a surface offers an entry: at the entry's level and above, and at every level once the
   * person already has some of its feature, in what the screen around it holds or in what the
   * surface knows itself.
   */
  offers(surface: Surface, item: string, here?: Holdings): boolean;
  /**
   * Whether the person's level falls short of a feature, so a surface knows it has to look for
   * what they already have before deciding what to offer
   */
  tidies(feature: FeatureId): boolean;
  /**
   * Called when the palette opens a feature.  One above the person's level opens all the same,
   * with a note offering to show its level, and counts toward the suggestion to move up.
   */
  opened(feature: FeatureId): void;
  /** Moves the person to a level */
  choose(level: Level): void;
  /** The level the quiet suggestion offers now, or null when there's nothing to suggest */
  suggestion: Level | null;
  /** Puts the suggestion away for good */
  dismissSuggestion(): void;
}

/**
 * Outside the signed-in shell (a screen on its own in a test, a page shared by link) nobody's
 * level is known, so nothing is tidied away.
 */
const EVERYTHING: LevelState = {
  level: 'advanced',
  highest: 'advanced',
  start: 'advanced',
  offers: () => true,
  tidies: () => false,
  opened: () => undefined,
  choose: () => undefined,
  suggestion: null,
  dismissSuggestion: () => undefined,
};

const LevelContext = createContext<LevelState>(EVERYTHING);
const HoldingsContext = createContext<Holdings>({});

/** The person's level, with its entries weighed against what the screens around them hold. */
export function useLevel(): LevelState {
  const state = useContext(LevelContext);
  const held = useContext(HoldingsContext);
  return useMemo(
    () => ({
      ...state,
      offers: (surface: Surface, item: string, here: Holdings = {}) =>
        offersAt(state.level, surface, item, held, here),
    }),
    [state, held],
  );
}

/**
 * What a screen already holds, such as a database's dashboards, field types, and automations, so
 * every surface inside it keeps the entries of features the screen already uses.  Screens inside
 * one another add to what the outer ones hold.
 */
export function HoldingsProvider({ holdings, children }: { holdings: Holdings; children: ReactNode }) {
  const outer = useContext(HoldingsContext);
  const value = useMemo(() => ({ ...outer, ...holdings }), [outer, holdings]);
  return <HoldingsContext.Provider value={value}>{children}</HoldingsContext.Provider>;
}

/** The signed-in person's level, for everything inside the shell. */
export function LevelProvider({ session, children }: { session: SessionInfo; children: ReactNode }) {
  const { i18n } = useLingui();
  const save = useSavePreferences();
  const mutate = save.mutate;
  const personId = session.user.id;
  const { level, highest, start } = levelsFor(
    session.membership.kind,
    appliedSettings(session) ?? {},
    session.preferences.level,
  );
  const dismissed = session.preferences.levelSuggestion === 'dismissed';
  const [uses, setUses] = useState<{ personId: string; uses: readonly LevelUse[] }>(() => ({
    personId,
    uses: readUses(personId),
  }));
  // Someone else signing in on this browser has uses of their own.
  const current = uses.personId === personId ? uses.uses : readUses(personId);
  if (uses.personId !== personId) setUses({ personId, uses: current });

  const choose = useCallback((next: Level) => mutate({ level: next }), [mutate]);
  const dismissSuggestion = useCallback(() => mutate({ levelSuggestion: 'dismissed' }), [mutate]);
  const opened = useCallback(
    (feature: FeatureId) => {
      const needed = featureLevel(feature);
      // Nothing to note for a feature at the person's level, or one past what they may choose.
      if (needed === 'simple' || reaches(level, needed) || !reaches(highest, needed)) return;
      setUses({ personId, uses: recordUse(personId, needed) });
      toast.show({
        tone: 'info',
        title: i18n._(ABOVE_LEVEL_NOTES[needed]),
        action: { label: i18n._(SHOW_THEM), onPress: () => choose(needed) },
      });
    },
    [level, highest, personId, i18n, choose],
  );
  const suggestion = dismissed ? null : suggestedLevel(current, level, highest);
  const value = useMemo<LevelState>(
    () => ({
      level,
      highest,
      start,
      offers: (surface: Surface, item: string, here: Holdings = {}) => offersAt(level, surface, item, here),
      tidies: (feature: FeatureId) => tidiesAt(level, feature),
      opened,
      choose,
      suggestion,
      dismissSuggestion,
    }),
    [level, highest, start, opened, choose, suggestion, dismissSuggestion],
  );
  return <LevelContext.Provider value={value}>{children}</LevelContext.Provider>;
}
