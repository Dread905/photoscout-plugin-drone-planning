import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PluginHost } from '../src/sdk/web-api.js';
import plugin from '../src/web.js';
import { droneMapSpec } from '../src/web/layers.js';
import { popupContent } from '../src/web/popups.js';
import { createCorner, createDetails, DISCLAIMER } from '../src/web/view.js';
import { airportsGeoJSON, airspacesGeoJSON } from '../src/web/drone.js';
import type { DroneContextResponse, PlannerState, PlannerStore } from '../src/web/types.js';
import { evaluateDroneAssessment } from '../src/server/assessment.js';

// --- a tiny DOM, enough for the popups and the injected stylesheet ---------------------------------------------

class FakeNode {
  className = '';
  textContent = '';
  dataset: Record<string, string> = {};
  children: FakeNode[] = [];
  constructor(public tag: string) {}
  append(...nodes: FakeNode[]) {
    this.children.push(...nodes);
  }
  remove() {
    removed.push(this);
  }
  /** Everything written as text below this node, with no markup interpretation. */
  text(): string {
    return this.textContent + this.children.map((c) => c.text()).join('');
  }
}
const removed: FakeNode[] = [];
const appended: FakeNode[] = [];
(globalThis as { document?: unknown }).document = {
  createElement: (tag: string) => new FakeNode(tag),
  head: { append: (n: FakeNode) => void appended.push(n) },
};

// --- views -------------------------------------------------------------------------------------------------

function baseState(over: Partial<PlannerState> = {}): PlannerState {
  return {
    context: null,
    aerodromes: null,
    loading: false,
    aerodromesLoading: false,
    error: '',
    aerodromesError: '',
    point: null,
    centre: { lat: -33.4, lng: 149.6 },
    radiusKm: 5,
    signedIn: true,
    ...over,
  };
}

function storeOf(state: PlannerState): PlannerStore {
  return { get: () => state, subscribe: () => () => {} };
}

const noActions = { setRadiusKm() {}, setPoint() {}, refresh() {}, openDetails() {}, closeDetails() {} };

function contextWith(over: Partial<DroneContextResponse> = {}): DroneContextResponse {
  return {
    configured: false,
    message: 'OpenAIP API key not configured',
    radiusM: 5000,
    airspaces: [],
    airports: [],
    fireHazards: [],
    weather: { windKmh: 12, gustKmh: 20, visibilityM: 30000, tempC: 20, cloudPct: 10 },
    rules: { checkedDate: '2026-10-13', reviewBy: '2027-04-01', stale: false },
    assessment: evaluateDroneAssessment({ evidence: [] }),
    sources: {},
    ...over,
  };
}

test('corner widget: shows the verdict, never a green light, and always the disclaimer', () => {
  const html = renderToStaticMarkup(
    React.createElement(createCorner({ react: React, store: storeOf(baseState({ context: contextWith() })), actions: noActions }))
  );
  assert.match(html, /Not checked/);
  assert.match(html, /No mapped restriction found/);
  assert.ok(html.includes(DISCLAIMER));
  assert.doesNotMatch(html, /\b(safe to fly|cleared|approved|legal to fly)\b/i);
  assert.match(html, /No OpenAIP API key is set/);
});

test('corner widget: a signed-out visitor is told what needs an account', () => {
  const html = renderToStaticMarkup(
    React.createElement(createCorner({ react: React, store: storeOf(baseState({ signedIn: false })), actions: noActions }))
  );
  assert.match(html, /Sign in for fire, weather, aircraft and airspace context/);
});

test('corner widget: overdue rules are called out', () => {
  const html = renderToStaticMarkup(
    React.createElement(createCorner({
      react: React,
      store: storeOf(baseState({ context: contextWith({ rules: { checkedDate: '2026-10-13', reviewBy: '2027-04-01', stale: true } }) })),
      actions: noActions,
    }))
  );
  assert.match(html, /past their review date/);
});

test('details panel: evidence, the not-checked gates and the pilot checklist are all there', () => {
  const html = renderToStaticMarkup(
    React.createElement(createDetails({ react: React, store: storeOf(baseState({ context: contextWith() })), actions: noActions }), { close() {} })
  );
  assert.match(html, /Not checked \(2\)/);
  assert.match(html, /NOTAMs/);
  assert.match(html, /Visual line of sight/);
  assert.match(html, /type="checkbox"/);
});

test('views escape what they are given (React text nodes, no raw HTML)', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const ctx = contextWith({
    assessment: evaluateDroneAssessment({
      evidence: [{ id: 'x', category: 'airspace', severity: 'caution', authority: 'provider_context', title: hostile, explanation: hostile, source: { name: hostile }, userAction: hostile }],
    }),
  });
  const html = renderToStaticMarkup(
    React.createElement(createDetails({ react: React, store: storeOf(baseState({ context: ctx })), actions: noActions }), { close() {} })
  );
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

// --- popups ------------------------------------------------------------------------------------------------

test('popups: feed and dataset text becomes text, never markup', () => {
  const hostile = '<script>alert(1)</script>';
  for (const kind of ['airspace', 'airport', 'openaip', 'c3nm', 'core', 'band', 'fire'] as const) {
    const el = popupContent(kind, { name: hostile, title: hostile, airportName: hostile, icaoCode: hostile, status: hostile, category: hostile, disclaimer: hostile }, 'x') as unknown as FakeNode;
    assert.ok(el.text().includes(hostile), `${kind} shows the text as text`);
    const tags: string[] = [];
    const walk = (n: FakeNode) => {
      tags.push(n.tag);
      n.children.forEach(walk);
    };
    walk(el);
    assert.ok(!tags.includes('script'), `${kind} made no script element`);
  }
});

// --- the map overlay ---------------------------------------------------------------------------------------

test('layers: ids are scoped, every clickable layer has a popup, and the sources exist', () => {
  const spec = droneMapSpec((n) => `drone:${n}`, 'none');
  const sourceIds = new Set(Object.keys(spec.sources).map((n) => `drone:${n}`));
  for (const layer of spec.layers) {
    assert.ok(layer.id.startsWith('drone:'), layer.id);
    assert.ok('source' in layer && sourceIds.has(layer.source as string), `${layer.id} has a source`);
  }
  assert.equal(new Set(spec.layers.map((l) => l.id)).size, spec.layers.length, 'layer ids are unique');
  for (const id of spec.popups.keys()) assert.ok(spec.layers.some((l) => l.id === id));
});

test('airspaces: prohibited and restricted get their own colours, CTR counts as controlled', () => {
  const box: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
  const fc = airspacesGeoJSON([
    { id: 'a', name: 'A', type: 3, geometry: box },
    { id: 'b', name: 'B', typeName: 'RESTRICTED', geometry: box },
    { id: 'c', name: 'C', type: 4, geometry: box },
    { id: 'd', name: 'D', typeName: 'DANGER', geometry: box },
  ]);
  assert.deepEqual(fc.features.map((f) => f.properties?.kind), ['prohibited', 'restricted', 'controlled', 'caution']);
});

test('airports: a controlled aerodrome without runway thresholds gets a point and no invented buffer', () => {
  const g = airportsGeoJSON([{ id: 'x', name: 'X', controlled: true, geometry: { type: 'Point', coordinates: [149, -33] } }]);
  assert.equal(g.points.features.length, 1);
  assert.equal(g.points.features[0].properties?.runwayGeometryUnavailable, true);
  assert.equal(g.controlled3nm.features.length, 0);
});

// --- activating against a fake host -----------------------------------------------------------------------

interface FakeLegend {
  def: { key: string; layers?: readonly string[] };
  on: boolean;
  listeners: Array<(on: boolean) => void>;
}

function fakeHost(opts: { user: boolean }) {
  const legend: FakeLegend[] = [];
  const onReady: Array<(map: unknown) => void | (() => void)> = [];
  const corners: unknown[] = [];
  const sides: unknown[] = [];
  const clicks: Array<{ layers: readonly string[] }> = [];
  const fetched: string[] = [];
  const host = {
    id: 'map.24thframe.drone-planning',
    name: 'Drone planning',
    version: '0.1.0',
    apiVersion: '2.0.0',
    user: opts.user ? { id: 'u1', username: 'pilot', role: 'contributor' } : null,
    map: {
      scopedId: (n: string) => `map.24thframe.drone-planning:${n}`,
      onReady: (cb: (map: unknown) => void | (() => void)) => {
        onReady.push(cb);
        return () => {};
      },
      onClick: (layers: readonly string[]) => {
        clicks.push({ layers });
        return () => {};
      },
      showPopup: () => ({ close() {} }),
    },
    legend: {
      add: (def: FakeLegend['def']) => {
        const entry: FakeLegend = { def, on: false, listeners: [] };
        legend.push(entry);
        return {
          key: def.key,
          get on() {
            return entry.on;
          },
          setOn(on: boolean) {
            entry.on = on;
            entry.listeners.forEach((l) => l(on));
          },
          toggle() {},
          onChange: (cb: (on: boolean) => void) => {
            entry.listeners.push(cb);
            return () => {};
          },
          syncLayers() {},
        };
      },
    },
    settings: { addTab: () => () => {} },
    panel: {
      addCorner: (def: unknown) => void corners.push(def),
      addSide: (def: unknown) => {
        sides.push(def);
        return { isOpen: false, open() {}, close() {} };
      },
    },
    drive: { addAlertSource: () => () => {} },
    data: {
      url: (p: string) => p,
      fetch: async () => new Response('{}'),
      json: async (p: string) => {
        fetched.push(p);
        if (p.startsWith('/aerodromes')) return { available: false, status: 'unavailable', airports: [], aerodromes: [], source: null };
        return contextWith();
      },
      poll: () => ({ refresh() {}, stop() {} }),
    },
    assetUrl: (p: string) => p,
    ui: { react: React },
    log: { info() {}, warn() {}, error() {} },
    activity() {},
  } as unknown as PluginHost;
  return { host, legend, onReady, corners, sides, clicks, fetched };
}

function fakeMap() {
  const sources = new Map<string, { data?: unknown }>();
  const layers: string[] = [];
  const handlers = new Map<string, Array<(e?: unknown) => void>>();
  return {
    sources,
    layers,
    handlers,
    addSource: (id: string, spec: { data?: unknown }) => void sources.set(id, { ...spec }),
    addLayer: (l: { id: string }) => void layers.push(l.id),
    getSource: (id: string) => {
      const s = sources.get(id);
      return s && { setData: (d: unknown) => void (s.data = d) };
    },
    getCenter: () => ({ lat: -33.419, lng: 149.577 }),
    getCanvas: () => ({ style: { cursor: '' } }),
    dragPan: { enable() {}, disable() {} },
    on: (ev: string, a: unknown, b?: unknown) => {
      const fn = (typeof a === 'function' ? a : b) as (e?: unknown) => void;
      handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
    },
    off: (ev: string, a: unknown, b?: unknown) => {
      const fn = (typeof a === 'function' ? a : b) as (e?: unknown) => void;
      handlers.set(ev, (handlers.get(ev) ?? []).filter((f) => f !== fn));
    },
  };
}

test('activate: one legend toggle that owns every overlay layer, a corner widget, a side panel, popups on click', () => {
  const h = fakeHost({ user: true });
  plugin.activate(h.host);
  assert.equal(h.legend.length, 1);
  assert.equal(h.legend[0].def.key, 'drone');
  assert.ok((h.legend[0].def.layers?.length ?? 0) > 10);
  assert.equal(h.corners.length, 1);
  assert.equal((h.corners[0] as { whileOn: string }).whileOn, 'drone');
  assert.equal(h.sides.length, 1);
  assert.equal(h.clicks.length, 1);
  assert.ok(h.clicks[0].layers.every((id) => h.legend[0].def.layers?.includes(id)));
  assert.equal(h.onReady.length, 1);
  assert.equal(appended.length, 1, 'stylesheet added');
  plugin.deactivate?.();
  assert.ok(removed.includes(appended[0]), 'stylesheet removed again');
});

test('map ready: adds scoped sources and layers, and fetches nothing until the toggle is on', () => {
  const h = fakeHost({ user: true });
  plugin.activate(h.host);
  const map = fakeMap();
  const cleanup = h.onReady[0](map);
  assert.equal(map.sources.size, 10);
  assert.equal(map.layers.length, h.legend[0].def.layers?.length);
  assert.deepEqual(h.fetched, []);
  assert.equal(typeof cleanup, 'function');
  (cleanup as () => void)();
  assert.equal((map.handlers.get('moveend') ?? []).length, 0, 'listeners removed with the map');
});

test('toggle on: asks for the local aerodromes and the context around the map centre, then draws', async () => {
  const h = fakeHost({ user: true });
  plugin.activate(h.host);
  const map = fakeMap();
  const cleanup = h.onReady[0](map) as () => void;
  h.legend[0].on = true;
  h.legend[0].listeners.forEach((l) => l(true));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.fetched.length, 2);
  assert.match(h.fetched[0], /^\/aerodromes\?lat=-33\.41900&lng=149\.57700&radiusM=5000$/);
  assert.match(h.fetched[1], /^\/context\?lat=-33\.41900&lng=149\.57700&radiusM=5000$/);
  const radius = map.sources.get('map.24thframe.drone-planning:radius')?.data as GeoJSON.FeatureCollection;
  assert.equal(radius.features.length, 1, 'the planned-flight circle is drawn');
  cleanup();
});

test('toggle on while signed out: only the public aerodrome route is called', async () => {
  const h = fakeHost({ user: false });
  plugin.activate(h.host);
  const cleanup = h.onReady[0](fakeMap()) as () => void;
  h.legend[0].on = true;
  h.legend[0].listeners.forEach((l) => l(true));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(h.fetched.map((p) => p.split('?')[0]), ['/aerodromes']);
  cleanup();
});
