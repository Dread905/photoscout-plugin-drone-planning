import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateRunwayApproachCore, offsetPoint } from '../src/shared/runwayGeometry.js';
import { boundsFromPointRadius, fetchOpenAipContext, tileBbox } from '../src/server/openaip.js';
import {
  fetchPlanes,
  fetchWeatherNow,
  isLikelyNsw,
  parseOverpassCount,
  parseWeatherNow,
  toPlanes,
  _resetSourceCachesForTesting,
} from '../src/server/sources.js';
import { formatLimit } from '../src/web/drone.js';
import { memoryKv } from './helpers.js';

// --- runway geometry: the approach core must be a simple polygon that covers the runway ---------------------

type P = [number, number];

function segmentsCross(a: P, b: P, c: P, d: P): boolean {
  const side = (p: P, q: P, r: P) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
}

function selfIntersections(ring: P[]): number {
  const n = ring.length - 1; // the ring is closed: the last point repeats the first
  let crossings = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // first and last edges share a vertex
      if (segmentsCross(ring[i], ring[i + 1], ring[j], ring[j + 1])) crossings++;
    }
  }
  return crossings;
}

function inside(pt: P, ring: P[]): boolean {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}

test('approach core: the outline does not cross itself, for runways in every direction', () => {
  for (const bearingTo of [[0.02, 0], [0, 0.02], [0.02, 0.02], [-0.02, 0.01], [0.015, -0.02]]) {
    const t1: P = [151.17, -33.94];
    const t2: P = [t1[0] + bearingTo[0], t1[1] + bearingTo[1]];
    const ring = generateRunwayApproachCore(t1, t2) as P[];
    assert.equal(selfIntersections(ring), 0, `runway ${bearingTo.join(',')}`);
  }
});

test('approach core: covers the runway itself and the 500 m rectangle either side of it', () => {
  const t1: P = [151.17, -33.94];
  const t2: P = [151.19, -33.94]; // due east
  const ring = generateRunwayApproachCore(t1, t2) as P[];
  const mid: P = [(t1[0] + t2[0]) / 2, t1[1]];
  assert.ok(inside(mid, ring), 'mid-runway');
  assert.ok(inside(offsetPoint(mid, 0, 90, 300), ring), '300 m to the right');
  assert.ok(inside(offsetPoint(mid, 0, 90, -300), ring), '300 m to the left');
  assert.ok(!inside(offsetPoint(mid, 0, 90, 700), ring), '700 m to the right is outside the rectangle');
  assert.ok(inside(offsetPoint(t2, 3000, 90, 0), ring), 'on the extended centreline, 3 km past the threshold');
});

// --- OpenAIP: wide searches, truncation, cache reuse -----------------------------------------------------------

function okPage(items: unknown[], totalPages = 1) {
  return new Response(JSON.stringify({ items, totalPages }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('openaip: a 50 km search at Sydney latitude is tiled instead of failing', async () => {
  // 50 km each way is ~1.09 degrees of longitude at -34, which the original rejected as "extent exceeds maximum".
  const [minLng, , maxLng] = boundsFromPointRadius(-33.9, 151.2, 50_000);
  assert.ok(maxLng - minLng > 1);
  const urls: string[] = [];
  const fetchFn: typeof fetch = async (url) => {
    urls.push(String(url));
    return okPage([]);
  };
  const result = await fetchOpenAipContext({ apiKey: 'k', kv: memoryKv(), lat: -33.9, lng: 151.2, radiusM: 50_000, fetchFn });
  assert.equal(result.status, 'ok');
  // two layers, at least two tiles each
  assert.ok(urls.length >= 4, `${urls.length} requests`);
  assert.equal(new Set(urls).size, urls.length);
});

test('tileBbox: every tile fits the span and together they cover the box', () => {
  const box: [number, number, number, number] = [150.6, -34.45, 151.7, -33.35];
  const tiles = tileBbox(box);
  assert.ok(tiles.length >= 4);
  for (const [a, b, c, d] of tiles) assert.ok(c - a <= 1 + 1e-9 && d - b <= 1 + 1e-9);
  assert.equal(Math.min(...tiles.map((t) => t[0])), box[0]);
  assert.ok(Math.abs(Math.max(...tiles.map((t) => t[2])) - box[2]) < 1e-9);
});

test('openaip: more pages than the cap is reported as truncated, not as a complete list', async () => {
  const fetchFn: typeof fetch = async (url) => {
    const page = Number(new URL(String(url)).searchParams.get('page'));
    return okPage([{ _id: `a${page}`, name: 'Zone', type: 1, geometry: { type: 'Point', coordinates: [149, -33] } }], 99);
  };
  const result = await fetchOpenAipContext({ apiKey: 'k', kv: memoryKv(), lat: -33, lng: 149, radiusM: 3000, maxPages: 2, fetchFn });
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') assert.equal(result.source.truncated, true);
});

test('openaip: planning points a few hundred metres apart share one cached answer', async () => {
  const kv = memoryKv();
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls++;
    return okPage([]);
  };
  await fetchOpenAipContext({ apiKey: 'k', kv, lat: -33.4190, lng: 149.5770, radiusM: 5000, fetchFn });
  const first = calls;
  await fetchOpenAipContext({ apiKey: 'k', kv, lat: -33.4215, lng: 149.5792, radiusM: 5000, fetchFn });
  assert.equal(calls, first, 'second search is served from the cache');
  assert.equal(kv.size(), 1, 'one cache row, not one per distinct coordinate');
});

// --- sources -------------------------------------------------------------------------------------------------

test('weather: reads the current conditions, not the first hour of a forecast that starts yesterday', async () => {
  _resetSourceCachesForTesting();
  let url = '';
  const fetchFn = async (u: string) => {
    url = u;
    return new Response(
      JSON.stringify({ current: { time: 1_760_000_000, temperature_2m: 18.4, wind_speed_10m: 22, wind_gusts_10m: 41, visibility: 24000, cloud_cover: 50 } }),
      { status: 200 }
    );
  };
  const { weather } = await fetchWeatherNow(fetchFn, -33.4, 149.6);
  assert.match(url, /[?&]current=/);
  assert.doesNotMatch(url, /past_days/);
  assert.equal(weather.gustKmh, 41);
  assert.equal(weather.observedAt, new Date(1_760_000_000 * 1000).toISOString());
});

test('weather: an answer without current conditions is an error, not zeros', () => {
  assert.throws(() => parseWeatherNow({ hourly: {} }), /current/);
});

test('aircraft: ground traffic and positions older than a minute are not "nearby"', () => {
  const planes = toPlanes([
    { hex: 'AAA111', lat: -33.4, lon: 149.6, alt_baro: 2500, seen: 3, flight: 'QFA1 ' },
    { hex: 'BBB222', lat: -33.4, lon: 149.6, alt_baro: 'ground', seen: 1 },
    { hex: 'CCC333', lat: -33.4, lon: 149.6, alt_baro: 3000, seen: 400 },
    { hex: 'DDD444', alt_baro: 3000, seen: 1 },
  ]);
  assert.deepEqual(planes.map((p) => p.hex), ['aaa111']);
  assert.equal(planes[0].flight, 'QFA1');
});

test('aircraft: one feed down is fine, both down is an error', async () => {
  _resetSourceCachesForTesting();
  const half = async (u: string) =>
    u.includes('adsb.lol') ? new Response('nope', { status: 503 }) : new Response(JSON.stringify({ ac: [{ hex: 'abc', lat: -33.4, lon: 149.6, alt_baro: 900, seen: 2 }] }), { status: 200 });
  assert.equal((await fetchPlanes(half, -33.4, 149.6, 15)).length, 1);
  _resetSourceCachesForTesting();
  await assert.rejects(fetchPlanes(async () => new Response('x', { status: 500 }), -33.4, 149.6, 15), /no aircraft feed/);
});

test('buildings: reads the count from an Overpass "out count" answer', () => {
  assert.equal(parseOverpassCount({ elements: [{ type: 'count', id: 0, tags: { nodes: '0', ways: '37', relations: '0', total: '37' } }] }), 37);
  assert.throws(() => parseOverpassCount({ elements: [] }), /count/);
});

test('fire coverage: the RFS feed only speaks for New South Wales', () => {
  assert.equal(isLikelyNsw(-33.42, 149.58), true); // Bathurst
  assert.equal(isLikelyNsw(-35.28, 149.13), true); // Canberra
  assert.equal(isLikelyNsw(-37.81, 144.96), false); // Melbourne
  assert.equal(isLikelyNsw(-27.47, 153.03), false); // Brisbane
});

// --- vertical limits ---------------------------------------------------------------------------------------

test('formatLimit: decodes OpenAIP unit and datum codes instead of printing them raw', () => {
  assert.equal(formatLimit({ value: 100, unit: 6, referenceDatum: 2 }), 'FL100');
  assert.equal(formatLimit({ value: 3500, unit: 1, referenceDatum: 1 }), '3500 ft AMSL');
  assert.equal(formatLimit({ value: 1200, unit: 0, referenceDatum: 0 }), '1200 m GND');
  assert.equal(formatLimit({ value: 0, unit: 1, referenceDatum: 0 }), 'GND');
  assert.equal(formatLimit(undefined), 'Unknown');
});
