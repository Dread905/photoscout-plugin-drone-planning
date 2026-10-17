import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent, MapTouchEvent } from 'maplibre-gl';
import type { PluginHost, WebPlugin } from './sdk/web-api.js';
import {
  airportsGeoJSON,
  airspacesGeoJSON,
  droneFireHazardsGeoJSON,
  flightRadiusGeoJSON,
  openAipAirportsGeoJSON,
} from './web/drone.js';
import { droneMapSpec, EMPTY, SOURCES, type SourceName } from './web/layers.js';
import { popupContent } from './web/popups.js';
import { DRONE_CSS } from './web/style.js';
import type { DroneContextResponse, LatLng, LocalAerodromesContextResponse, PlannerActions, PlannerState, PlannerStore } from './web/types.js';
import { createCorner, createDetails } from './web/view.js';

/**
 * Drone Planning, web half. The "Drone planning" legend toggle draws the overlay (planned-flight circle, airspace,
 * aerodrome zones, fire buffers) and shows a corner widget; "Evidence and checklist" opens the details panel.
 * Data comes from this plugin's two routes through `host.data`. It imports types only from the app.
 */

const RADIUS_DEFAULT_KM = 5;
/** Wait this long after the map stops moving before asking for a new context. */
const MOVE_DEBOUNCE_MS = 700;
/** And after the radius slider or a pin drag. */
const CONTROL_DEBOUNCE_MS = 400;

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : 'Request failed');
const isAbort = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError';

/** The injected stylesheet, kept so `deactivate` can remove it. */
let styleEl: HTMLStyleElement | null = null;

const plugin: WebPlugin = {
  activate(host: PluginHost) {
    const scoped = (name: string) => host.map.scopedId(name);
    const spec = droneMapSpec(scoped, 'none');

    // --- state shared by the widget, the panel and the map controller ---
    let state: PlannerState = {
      context: null,
      aerodromes: null,
      loading: false,
      aerodromesLoading: false,
      error: '',
      aerodromesError: '',
      point: null,
      centre: null,
      radiusKm: RADIUS_DEFAULT_KM,
      signedIn: host.user != null,
    };
    const listeners = new Set<() => void>();
    const patch = (next: Partial<PlannerState>): void => {
      state = { ...state, ...next };
      for (const listener of [...listeners]) listener();
    };
    const store: PlannerStore = {
      get: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };

    // The controller of the map that is open now; null between map pages.
    let controller: { schedule(delayMs: number): void; clear(): void } | null = null;

    const toggle = host.legend.add({
      key: 'drone',
      label: 'Drone planning',
      title: 'Advisory drone planning: airspace, aerodromes, fire hazards and CASR Part 101 cautions',
      swatch: { kind: 'line', color: '#ef4444' },
      defaultOn: false,
      menu: 'scout',
      layers: spec.layers.map((l) => l.id),
    });

    // --- panels ---
    const actions: PlannerActions = {
      setRadiusKm: (km) => {
        patch({ radiusKm: Math.min(50, Math.max(1, Math.round(km))) });
        controller?.schedule(CONTROL_DEBOUNCE_MS);
      },
      setPoint: (point) => {
        patch({ point });
        controller?.schedule(0);
      },
      refresh: () => controller?.schedule(0),
      openDetails: () => details.open({}),
      closeDetails: () => details.close(),
    };
    const views = { react: host.ui.react, store, actions };
    const Details = createDetails(views);
    const details = host.panel.addSide<Record<string, never>>({
      id: 'details',
      label: 'Drone planning evidence and checklist',
      component: ({ close }) => host.ui.react.createElement(Details, { close }),
    });
    host.panel.addCorner({ id: 'planner', whileOn: 'drone', component: createCorner(views) });

    // --- styles, once, removed again on deactivate ---
    styleEl?.remove();
    styleEl = document.createElement('style');
    styleEl.dataset.plugin = host.id;
    styleEl.textContent = DRONE_CSS;
    document.head.append(styleEl);

    // --- popups on click ---
    host.map.onClick([...spec.popups.keys()], (e) => {
      const kind = spec.popups.get(e.layerId);
      const feature = e.features[0];
      if (!kind || !feature) return;
      host.map.showPopup(e.lngLat, popupContent(kind, (feature.properties ?? {}) as Record<string, unknown>, e.layerId));
    });

    // --- the map ---
    host.map.onReady((map) => {
      for (const name of SOURCES) map.addSource(scoped(name), spec.sources[name]);
      for (const layer of spec.layers) {
        map.addLayer({ ...layer, layout: { ...layer.layout, visibility: toggle.on ? 'visible' : 'none' } } as typeof layer);
      }
      const setData = (name: SourceName, data: GeoJSON.FeatureCollection): void => {
        (map.getSource(scoped(name)) as GeoJSONSource | undefined)?.setData(data);
      };
      const clearData = (): void => {
        for (const name of SOURCES) if (name !== 'pin') setData(name, EMPTY);
      };

      const here = (): LatLng => {
        const c = map.getCenter();
        return { lat: c.lat, lng: c.lng };
      };
      const target = (): LatLng => state.point ?? here();

      let removed = false;
      let seq = 0;
      let abort: AbortController | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const query = (t: LatLng) => `lat=${t.lat.toFixed(5)}&lng=${t.lng.toFixed(5)}&radiusM=${state.radiusKm * 1000}`;

      const run = (): void => {
        timer = null;
        if (removed || !toggle.on) return;
        const mine = ++seq;
        abort?.abort();
        const ctl = new AbortController();
        abort = ctl;
        const t = target();
        patch({ loading: host.user != null, aerodromesLoading: true, centre: here(), signedIn: host.user != null });
        setData('radius', flightRadiusGeoJSON(t.lat, t.lng, state.radiusKm));
        setData('pin', state.point ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [state.point.lng, state.point.lat] } }] } : EMPTY);

        // Local aerodromes: public, no account or key needed.
        host.data
          .json<LocalAerodromesContextResponse>(`/aerodromes?${query(t)}`, { signal: ctl.signal })
          .then((res) => {
            if (mine !== seq || removed) return;
            patch({ aerodromes: res, aerodromesLoading: false, aerodromesError: '' });
            const g = airportsGeoJSON(res.airports ?? []);
            setData('airports', g.points);
            setData('c3nm', g.controlled3nm);
            setData('core', g.approachCore);
            setData('band', g.approachHeightBand);
            setData('hatch', g.heightBandHatch);
          })
          .catch((err: unknown) => {
            if (mine !== seq || removed || isAbort(err)) return;
            patch({ aerodromesLoading: false, aerodromesError: errMessage(err) });
          });

        // Everything else needs a signed-in session.
        if (host.user == null) {
          patch({ loading: false, context: null, error: '' });
          setData('airspaces', EMPTY);
          setData('oaip', EMPTY);
          setData('fire', EMPTY);
          return;
        }
        host.data
          .json<DroneContextResponse>(`/context?${query(t)}`, { signal: ctl.signal })
          .then((res) => {
            if (mine !== seq || removed) return;
            patch({ context: res, loading: false, error: '' });
            setData('airspaces', airspacesGeoJSON(res.airspaces ?? []));
            setData('oaip', res.configured && res.airports?.length ? openAipAirportsGeoJSON(res.airports) : EMPTY);
            setData('fire', droneFireHazardsGeoJSON(res.fireHazards ?? []));
          })
          .catch((err: unknown) => {
            if (mine !== seq || removed || isAbort(err)) return;
            // A dynamic failure clears the provider layers and keeps the local aerodrome zones.
            patch({ loading: false, error: errMessage(err) });
            setData('airspaces', EMPTY);
            setData('oaip', EMPTY);
          });
      };

      const schedule = (delayMs: number): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(run, delayMs);
      };
      const clear = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
        seq++;
        abort?.abort();
        abort = null;
        clearData();
        setData('pin', EMPTY);
        patch({ context: null, aerodromes: null, loading: false, aerodromesLoading: false, error: '', aerodromesError: '' });
      };
      controller = { schedule, clear };

      // Follow the map centre until a pin is dropped.
      const onMoveEnd = (): void => {
        patch({ centre: here() });
        if (toggle.on && !state.point) schedule(MOVE_DEBOUNCE_MS);
      };
      map.on('moveend', onMoveEnd);

      // Drag the pin: maplibre's own Marker class is not part of the plugin API, so the pin is a circle layer
      // and the drag is mouse and touch events on it.
      let dragging = false;
      const startDrag = (e: MapMouseEvent | MapTouchEvent): void => {
        if (!toggle.on || !state.point) return;
        e.preventDefault();
        dragging = true;
        map.dragPan.disable();
        map.getCanvas().style.cursor = 'grabbing';
      };
      const moveDrag = (e: MapMouseEvent | MapTouchEvent): void => {
        if (!dragging) return;
        const point = { lat: e.lngLat.lat, lng: e.lngLat.lng };
        state = { ...state, point };
        setData('pin', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [point.lng, point.lat] } }] });
      };
      const endDrag = (): void => {
        if (!dragging) return;
        dragging = false;
        map.dragPan.enable();
        map.getCanvas().style.cursor = '';
        patch({ point: state.point });
        schedule(CONTROL_DEBOUNCE_MS);
      };
      map.on('mousedown', spec.pinLayer, startDrag);
      map.on('touchstart', spec.pinLayer, startDrag);
      map.on('mousemove', moveDrag);
      map.on('touchmove', moveDrag);
      map.on('mouseup', endDrag);
      map.on('touchend', endDrag);

      const stopToggle = toggle.onChange((on) => {
        if (on) {
          patch({ centre: here() });
          schedule(0);
        } else {
          clear();
          details.close();
        }
      });
      patch({ centre: here() });
      if (toggle.on) schedule(0);

      return () => {
        removed = true;
        stopToggle();
        if (timer) clearTimeout(timer);
        abort?.abort();
        map.off('moveend', onMoveEnd);
        map.off('mousedown', spec.pinLayer, startDrag);
        map.off('touchstart', spec.pinLayer, startDrag);
        map.off('mousemove', moveDrag);
        map.off('touchmove', moveDrag);
        map.off('mouseup', endDrag);
        map.off('touchend', endDrag);
        if (dragging) (map as MapLibreMap).dragPan.enable();
        if (controller?.schedule === schedule) controller = null;
      };
    });
  },

  deactivate() {
    styleEl?.remove();
    styleEl = null;
  },
};

export default plugin;
