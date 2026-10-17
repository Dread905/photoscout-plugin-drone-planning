import type { GeoJSONSourceSpecification, LayerSpecification } from 'maplibre-gl';

/** Which popup a clicked layer opens. */
export type PopupKind = 'airspace' | 'airport' | 'openaip' | 'c3nm' | 'core' | 'band' | 'fire';

/** Source names; the plugin passes each through `host.map.scopedId`. */
export const SOURCES = ['radius', 'airspaces', 'c3nm', 'core', 'band', 'hatch', 'airports', 'oaip', 'fire', 'pin'] as const;
export type SourceName = (typeof SOURCES)[number];

export const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

const AIRSPACE_KINDS = [
  { kind: 'prohibited', color: '#ef4444', fill: 0.25, width: 2 },
  { kind: 'restricted', color: '#f97316', fill: 0.2, width: 1.5 },
  { kind: 'controlled', color: '#38bdf8', fill: 0.15, width: 1.5 },
  { kind: 'caution', color: '#eab308', fill: 0.12, width: 1 },
] as const;

export interface DroneMapSpec {
  sources: Record<SourceName, GeoJSONSourceSpecification>;
  /** In draw order, bottom first. */
  layers: LayerSpecification[];
  /** Layer id to the popup it opens, for the layers a click should hit. */
  popups: Map<string, PopupKind>;
  /** The pin layer, which is dragged rather than clicked. */
  pinLayer: string;
}

/**
 * Every source and layer of the overlay, with ids from `scoped` (host.map.scopedId). The paint values are the
 * ones the core overlay used. Layers start hidden or shown as `visibility` says; the legend toggle owns them after.
 */
export function droneMapSpec(scoped: (name: string) => string, visibility: 'visible' | 'none'): DroneMapSpec {
  const src = (name: SourceName) => scoped(name);
  const geojson = (attribution?: string): GeoJSONSourceSpecification => ({ type: 'geojson', data: EMPTY, ...(attribution ? { attribution } : {}) });
  const layout = { visibility } as const;
  const popups = new Map<string, PopupKind>();
  const layers: LayerSpecification[] = [];
  const add = (layer: LayerSpecification, popup?: PopupKind) => {
    layers.push(layer);
    if (popup) popups.set(layer.id, popup);
  };

  add({ id: scoped('radius-fill'), type: 'fill', source: src('radius'), layout, paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.08 } });
  add({ id: scoped('radius-line'), type: 'line', source: src('radius'), layout, paint: { 'line-color': '#38bdf8', 'line-width': 2, 'line-dasharray': [3, 2] } });

  for (const { kind, color, fill, width } of AIRSPACE_KINDS) {
    const filter: ['==', ['get', string], string] = ['==', ['get', 'kind'], kind];
    add({ id: scoped(`airspace-${kind}-fill`), type: 'fill', source: src('airspaces'), filter, layout, paint: { 'fill-color': color, 'fill-opacity': fill } }, 'airspace');
    add({ id: scoped(`airspace-${kind}-line`), type: 'line', source: src('airspaces'), filter, layout, paint: { 'line-color': color, 'line-width': width } });
  }

  add({ id: scoped('c3nm-fill'), type: 'fill', source: src('c3nm'), layout, paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.08 } }, 'c3nm');
  add({ id: scoped('c3nm-line'), type: 'line', source: src('c3nm'), layout, paint: { 'line-color': '#d97706', 'line-width': 1.5, 'line-dasharray': [4, 2] } });
  add({ id: scoped('core-fill'), type: 'fill', source: src('core'), layout, paint: { 'fill-color': '#0f172a', 'fill-opacity': 0.35 } }, 'core');
  add({ id: scoped('core-line'), type: 'line', source: src('core'), layout, paint: { 'line-color': '#0f172a', 'line-width': 2 } });
  add({ id: scoped('band-fill'), type: 'fill', source: src('band'), layout, paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.08 } }, 'band');
  add({ id: scoped('band-line'), type: 'line', source: src('band'), layout, paint: { 'line-color': '#f59e0b', 'line-width': 1.5, 'line-dasharray': [2, 2] } });
  add({ id: scoped('hatch-line'), type: 'line', source: src('hatch'), layout, paint: { 'line-color': '#b45309', 'line-width': 1.5 } });

  add({ id: scoped('fire-fill'), type: 'fill', source: src('fire'), layout, paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.2 } }, 'fire');
  add({ id: scoped('fire-line'), type: 'line', source: src('fire'), layout, paint: { 'line-color': '#dc2626', 'line-width': 2, 'line-dasharray': [3, 3] } });

  add({
    id: scoped('airports-controlled'), type: 'circle', source: src('airports'), filter: ['==', ['get', 'controlled'], true], layout,
    paint: { 'circle-radius': 7, 'circle-color': '#ef4444', 'circle-stroke-color': '#0e1014', 'circle-stroke-width': 1.5 },
  }, 'airport');
  add({
    id: scoped('airports-other'), type: 'circle', source: src('airports'), filter: ['!=', ['get', 'controlled'], true], layout,
    paint: { 'circle-radius': 5, 'circle-color': '#f59e0b', 'circle-stroke-color': '#0e1014', 'circle-stroke-width': 1.5 },
  }, 'airport');
  add({
    id: scoped('oaip-airports'), type: 'circle', source: src('oaip'), layout,
    paint: {
      'circle-radius': ['case', ['==', ['get', 'controlled'], true], 6, 5],
      'circle-color': ['case', ['==', ['get', 'controlled'], true], '#7c3aed', '#a855f7'],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
    },
  }, 'openaip');

  const pinLayer = scoped('pin');
  add({
    id: pinLayer, type: 'circle', source: src('pin'), layout,
    paint: { 'circle-radius': 9, 'circle-color': '#38bdf8', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 },
  });

  const sources = Object.fromEntries(
    SOURCES.map((name) => [
      name,
      geojson(name === 'airspaces' ? 'Airspace: openAIP (CC BY-NC-SA 4.0)' : name === 'oaip' ? 'Airports: openAIP (CC BY-NC-SA 4.0)' : undefined),
    ])
  ) as Record<SourceName, GeoJSONSourceSpecification>;

  return { sources, layers, popups, pinLayer };
}
