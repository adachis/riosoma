import { useEffect, useRef, useState } from 'react';
import {
  MapLibreMap,
  setWorkerUrl,
  type FilterSpecification,
  type GeoJSONSource,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import type { MapColors } from './colors';
import { pinBounds, type PinCollection } from './pins';
import { MAP_WORKER_URL } from './worker';

const SOURCE = 'rio-records';
const CLUSTERS = 'rio-clusters';
const COUNTS = 'rio-cluster-counts';
const PINS = 'rio-pins';
const SELECTED = 'rio-selected';

/** How close framing comes, so one pin, or pins on one street, still show where they are. */
const FIT_MAX_ZOOM = 14;
/** How close showing one record's pin comes, when the map is farther out than this. */
const SHOW_ZOOM = 12;
const PADDING = 48;
/** The font a style names for its own labels, when it names none the map can read. */
const FALLBACK_FONT = ['Noto Sans Regular'];

export interface MapControls {
  fitAll(): void;
  /** Brings a record's pin into view and selects it */
  show(recordId: string): void;
  zoomIn(): void;
  zoomOut(): void;
}

interface Props {
  styleUrl: string;
  pins: PinCollection;
  colors: MapColors;
  selected: string | null;
  /** What screen readers call the map */
  label: string;
  /** How to use the map from the keyboard, and where its list is */
  descriptionId: string;
  /** MapLibre's own words, such as the attribution button's label, in the reader's language */
  strings: Record<string, string>;
  onSelect(recordId: string | null): void;
  /** The map couldn't start, or couldn't load its style */
  onFail(): void;
  onControls(controls: MapControls | null): void;
}

function selectedFilter(recordId: string | null): FilterSpecification {
  return ['all', ['!', ['has', 'point_count']], ['==', ['get', 'id'], recordId ?? '']];
}

/** A font the style itself uses for labels, so cluster counts draw with glyphs it serves. */
function styleFont(map: MapLibreMap): string[] {
  for (const layer of map.getStyle().layers) {
    if (layer.type !== 'symbol') continue;
    const font: unknown = layer.layout?.['text-font'];
    if (Array.isArray(font) && font.length && font.every((name) => typeof name === 'string')) return font;
  }
  return FALLBACK_FONT;
}

function addLayers(map: MapLibreMap, pins: PinCollection, colors: MapColors, selected: string | null) {
  map.addSource(SOURCE, {
    type: 'geojson',
    data: pins,
    cluster: true,
    clusterRadius: 48,
    clusterMaxZoom: 14,
  });
  map.addLayer({
    id: CLUSTERS,
    type: 'circle',
    source: SOURCE,
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': colors.accent,
      'circle-radius': ['step', ['get', 'point_count'], 16, 10, 20, 100, 26, 1000, 32],
      'circle-stroke-width': 2,
      'circle-stroke-color': colors.ring,
    },
  });
  map.addLayer({
    id: COUNTS,
    type: 'symbol',
    source: SOURCE,
    filter: ['has', 'point_count'],
    layout: {
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': styleFont(map),
      'text-size': 12,
      'text-allow-overlap': true,
    },
    paint: { 'text-color': colors.onAccent },
  });
  map.addLayer({
    id: PINS,
    type: 'circle',
    source: SOURCE,
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': ['get', 'fill'],
      'circle-radius': 7,
      'circle-stroke-width': 2,
      'circle-stroke-color': colors.ring,
    },
  });
  map.addLayer({
    id: SELECTED,
    type: 'circle',
    source: SOURCE,
    filter: selectedFilter(selected),
    paint: {
      'circle-radius': 12,
      'circle-opacity': 0,
      'circle-stroke-width': 3,
      'circle-stroke-color': colors.accent,
    },
  });
}

function fit(map: MapLibreMap, pins: PinCollection, animate: boolean) {
  const bounds = pinBounds(pins.features);
  if (bounds)
    map.fitBounds(bounds, { padding: PADDING, maxZoom: FIT_MAX_ZOOM, ...(animate ? {} : { duration: 0 }) });
}

/**
 * The map itself: records' pins on a MapLibre map, clustered when they crowd together.  Clicking a
 * cluster zooms in on it, and clicking a pin selects its record.
 */
export function MapCanvas(props: Props) {
  const { styleUrl, pins, colors, selected, label } = props;
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const latest = useRef(props);
  const framed = useRef(false);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const node = container.current;
    if (!node) return;
    let instance: MapLibreMap;
    try {
      setWorkerUrl(MAP_WORKER_URL);
      instance = new MapLibreMap({
        container: node,
        style: styleUrl,
        // GTK WebKit otherwise presents a stale WebGL frame after data changes.
        canvasContextAttributes: { antialias: true },
        attributionControl: { compact: false },
        maplibreLogo: false,
        boxZoom: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        locale: { ...latest.current.strings, 'Map.Title': latest.current.label },
        center: [0, 20],
        zoom: 1,
      });
    } catch {
      // No WebGL, most likely.  The records and their places still show as a list.
      latest.current.onFail();
      return;
    }
    instance.touchZoomRotate.disableRotation();
    instance.keyboard.disableRotation();
    let styled = false;
    instance.on('style.load', () => {
      styled = true;
    });
    // Missing tiles and images come and go, but a style that never loads leaves nothing to show.
    instance.on('error', () => {
      if (!styled) latest.current.onFail();
    });
    instance.on('load', () => {
      const current = latest.current;
      addLayers(instance, current.pins, current.colors, current.selected);
      instance.getCanvas().setAttribute('aria-describedby', current.descriptionId);
      setMap(instance);
    });
    instance.on('click', CLUSTERS, (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      const cluster: unknown = feature?.properties.cluster_id;
      const geometry = feature?.geometry;
      if (typeof cluster !== 'number' || geometry?.type !== 'Point') return;
      const [lng = 0, lat = 0] = geometry.coordinates;
      instance
        .getSource<GeoJSONSource>(SOURCE)
        ?.getClusterExpansionZoom(cluster)
        .then((zoom) => instance.easeTo({ center: [lng, lat], zoom }))
        .catch(() => undefined);
    });
    instance.on('click', PINS, (event: MapLayerMouseEvent) => {
      const id: unknown = event.features?.[0]?.properties.id;
      if (typeof id === 'string') latest.current.onSelect(id);
    });
    instance.on('click', (event) => {
      if (!instance.queryRenderedFeatures(event.point, { layers: [PINS, CLUSTERS] }).length)
        latest.current.onSelect(null);
    });
    for (const layer of [PINS, CLUSTERS]) {
      instance.on('mouseenter', layer, () => {
        instance.getCanvas().style.cursor = 'pointer';
      });
      instance.on('mouseleave', layer, () => {
        instance.getCanvas().style.cursor = '';
      });
    }
    return () => {
      instance.remove();
      framed.current = false;
      setMap(null);
    };
  }, [styleUrl]);

  useEffect(() => {
    if (!map) return;
    map
      .getSource<GeoJSONSource>(SOURCE)
      ?.setData(pins)
      .catch(() => undefined);
    // The first pins frame the map.  After that, it stays where the person moved it.
    if (!framed.current && pins.features.length) {
      framed.current = true;
      fit(map, pins, false);
    }
  }, [map, pins]);

  useEffect(() => {
    map?.setFilter(SELECTED, selectedFilter(selected));
  }, [map, selected]);

  useEffect(() => {
    if (!map) return;
    map.setPaintProperty(CLUSTERS, 'circle-color', colors.accent);
    map.setPaintProperty(CLUSTERS, 'circle-stroke-color', colors.ring);
    map.setPaintProperty(COUNTS, 'text-color', colors.onAccent);
    map.setPaintProperty(PINS, 'circle-stroke-color', colors.ring);
    map.setPaintProperty(SELECTED, 'circle-stroke-color', colors.accent);
  }, [map, colors]);

  useEffect(() => {
    map?.getCanvas().setAttribute('aria-label', label);
  }, [map, label]);

  useEffect(() => {
    if (!map) return;
    latest.current.onControls({
      fitAll: () => fit(map, latest.current.pins, true),
      show: (recordId) => {
        const feature = latest.current.pins.features.find((item) => item.properties.id === recordId);
        if (!feature) return;
        map.easeTo({ center: feature.geometry.coordinates, zoom: Math.max(map.getZoom(), SHOW_ZOOM) });
        latest.current.onSelect(recordId);
      },
      zoomIn: () => map.zoomIn(),
      zoomOut: () => map.zoomOut(),
    });
    return () => latest.current.onControls(null);
  }, [map]);

  return <div ref={container} className="rio-map-view__canvas" />;
}
