import { FEATURES as POLICIES, type Feature as FeaturePolicy, type Place as PlacePolicy } from './policy';
import { commandAt, type PlaceCommand } from './commands';
import type { Surface, FeatureId, PlaceKey } from './policy';
export type { Surface, PlaceKey, Holdings, FeatureId } from './policy';
export type { PlaceCommand } from './commands';
export { offersAt, featureLevel, tidiesAt } from './policy';

export interface Place extends PlacePolicy {
  command: PlaceCommand;
}
export interface Feature extends Omit<FeaturePolicy, 'places'> {
  places: readonly Place[];
}

export const FEATURES: readonly Feature[] = POLICIES.map((feature) => ({
  ...feature,
  places: feature.places.map((place) => ({ ...place, command: commandAt(`${place.surface}:${place.item}`) })),
}));

const BY_ID = new Map(FEATURES.map((feature) => [feature.id, feature]));
const BY_PLACE = new Map(
  FEATURES.flatMap((feature) =>
    feature.places.map((place) => [`${place.surface}:${place.item}`, { feature, place }] as const),
  ),
);

export function featureById(id: FeatureId): Feature | undefined {
  return BY_ID.get(id);
}

/** Every registered entry, as screens name them to the palette */
export const PLACE_KEYS = [...BY_PLACE.keys()] as readonly PlaceKey[];

/** A registered entry and the feature it belongs to, or nothing for an entry at every level. */
export function placeAt(key: PlaceKey): { feature: Feature; place: Place } | undefined {
  return BY_PLACE.get(key);
}

/** The feature an entry is, or nothing when the entry shows at every level. */
export function featureAt(surface: Surface, item: string): Feature | undefined {
  return BY_PLACE.get(`${surface}:${item}`)?.feature;
}
