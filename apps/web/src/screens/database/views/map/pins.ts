import {
  cellValue,
  coordinatesText,
  isLocationValue,
  validCoordinates,
  type ChoiceColor,
  type FieldMeta,
  type LocationValue,
  type RowData,
} from '@riosoma/contracts';

/** What each pin carries: its record, and the color it's drawn in. */
export type PinProperties = {
  id: string;
  /** The color of the record's matching color rule, or else of its option in the color field, or null */
  color: ChoiceColor | null;
  /** The color to draw, from the theme */
  fill: string;
};

export interface PinFeature {
  type: 'Feature';
  /** The record's place in the view's order */
  id: number;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: PinProperties;
}

export interface PinCollection {
  type: 'FeatureCollection';
  features: PinFeature[];
}

export interface PinData {
  pins: PinCollection;
  /** Records with no place in the location field, in the view's order */
  unplaced: RowData[];
}

/** A record's place, when its location field holds one the map can draw. */
export function placeOf(row: RowData, field: FieldMeta): LocationValue | null {
  const value = cellValue(row, field);
  return isLocationValue(value) && validCoordinates(value.lat, value.lng) ? value : null;
}

/** How a place reads in a list: its label with its coordinates, or the coordinates alone. */
export function placeText(place: LocationValue): string {
  return place.label ? `${place.label} (${coordinatesText(place)})` : coordinatesText(place);
}

/** The option a record has in the color field, which colors its pin. */
export function pinColor(row: RowData, field: FieldMeta | undefined): ChoiceColor | null {
  if (field?.type !== 'singleSelect') return null;
  const value = cellValue(row, field);
  return field.options.choices.find((choice) => choice.id === value)?.color ?? null;
}

/**
 * A pin for each loaded record with a place, in the view's order, so whatever the view's filter
 * leaves out never reaches the map.  Records still loading are neither pinned nor counted.  A
 * record colored by one of the view's color rules takes the rule's color, which outranks the
 * color field's option.
 */
export function pinData(
  rows: ReadonlyArray<RowData | undefined>,
  location: FieldMeta,
  color: FieldMeta | undefined,
  paint: (color: ChoiceColor | null) => string,
  ruled?: (row: RowData) => ChoiceColor | null,
): PinData {
  const features: PinFeature[] = [];
  const unplaced: RowData[] = [];
  rows.forEach((row, index) => {
    if (!row) return;
    const place = placeOf(row, location);
    if (!place) {
      unplaced.push(row);
      return;
    }
    const choice = ruled?.(row) ?? pinColor(row, color);
    features.push({
      type: 'Feature',
      id: index,
      geometry: { type: 'Point', coordinates: [place.lng, place.lat] },
      properties: { id: row.id, color: choice, fill: paint(choice) },
    });
  });
  return { pins: { type: 'FeatureCollection', features }, unplaced };
}

export type Bounds = [[number, number], [number, number]];

/**
 * The smallest box around every pin, as `[[west, south], [east, north]]`.  Pins on both sides of
 * the 180th meridian, such as in Japan and Hawaii, get a box across it, with the east edge past
 * 180, rather than one around the rest of the world.  Null with no pins.
 */
export function pinBounds(features: readonly PinFeature[]): Bounds | null {
  if (!features.length) return null;
  let south = 90;
  let north = -90;
  const longitudes: number[] = [];
  for (const feature of features) {
    const [lng, lat] = feature.geometry.coordinates;
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    longitudes.push(lng);
  }
  longitudes.sort((a, b) => a - b);
  // The box leaves out the widest stretch of longitude with no pins, which is usually the one
  // across the 180th meridian.
  let gap = longitudes[0]! + 360 - longitudes.at(-1)!;
  let west = longitudes[0]!;
  let east = longitudes.at(-1)!;
  for (let index = 1; index < longitudes.length; index++) {
    const width = longitudes[index]! - longitudes[index - 1]!;
    if (width > gap) {
      gap = width;
      west = longitudes[index]!;
      east = longitudes[index - 1]! + 360;
    }
  }
  return [
    [west, south],
    [east, north],
  ];
}
