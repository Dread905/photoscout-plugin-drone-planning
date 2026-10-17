import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryKv } from './helpers.js';
import {
  fetchOpenAipContext,
  normalizeAirspaceType,
  boundsFromPointRadius,
  tileBbox,
  type OpenAipResult,
} from '../src/server/openaip.js';

const TEST_SECRET_KEY = 'secret-openaip-test-key-999888';

test('openaip: maps documented OpenAIP numeric airspace types correctly', () => {
  // OpenAIP Core API schema enum: 0 Other, 1 Restricted, 2 Danger,
  // 3 Prohibited, 4 CTR, 7 TMA, 17 Alert, 18 Warning, 26 CTA.
  assert.equal(normalizeAirspaceType(0), 'OTHER');
  assert.equal(normalizeAirspaceType(1), 'RESTRICTED');
  assert.equal(normalizeAirspaceType(2), 'DANGER');
  assert.equal(normalizeAirspaceType(3), 'PROHIBITED');
  assert.equal(normalizeAirspaceType(4), 'CTR');
  assert.equal(normalizeAirspaceType(7), 'TMA');
  assert.equal(normalizeAirspaceType(17), 'ALERT');
  assert.equal(normalizeAirspaceType(18), 'WARNING');
  assert.equal(normalizeAirspaceType(26), 'CTA');
});

test('openaip: missing requester key returns typed not_configured result without network call', async () => {
  const kv = memoryKv();
  let networkCalls = 0;

  const mockFetch: typeof fetch = async () => {
    networkCalls++;
    throw new Error('Network should not be called');
  };

  const result = await fetchOpenAipContext({
    kv,
    apiKey: '   ',
    lat: -33.42,
    lng: 149.57,
    radiusM: 5000,
    fetchFn: mockFetch,
  });

  assert.equal(networkCalls, 0, 'no network call should be made when key is missing');
  assert.equal(result.status, 'not_configured');
  if (result.status === 'not_configured') {
    assert.ok(result.message.toLowerCase().includes('not configured'));
  }
});

test('openaip: valid request sends key ONLY in server-side header, not query string', async () => {
  const kv = memoryKv();

  const capturedRequests: Array<{ url: string; headers: HeadersInit | undefined }> = [];

  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    capturedRequests.push({ url, headers: init?.headers });

    if (url.includes('/airspaces')) {
      return new Response(
        JSON.stringify({
          items: [
            {
              _id: 'airspace-1',
              name: 'R559 BATHURST',
              type: 1, // RESTRICTED
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [
                    [149.5, -33.5],
                    [149.6, -33.5],
                    [149.6, -33.4],
                    [149.5, -33.4],
                    [149.5, -33.5],
                  ],
                ],
              },
              lowerLimit: { value: 0, unit: 0, referenceDatum: 0 },
              upperLimit: { value: 4500, unit: 0, referenceDatum: 1 },
            },
          ],
          totalCount: 1,
          totalPages: 1,
          page: 1,
          limit: 50,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('/airports')) {
      return new Response(
        JSON.stringify({
          items: [
            {
              _id: 'airport-1',
              name: 'Bathurst Airport',
              icaoCode: 'YBTH',
              geometry: { type: 'Point', coordinates: [149.65, -33.41] },
              runways: [{ designator: '17/35', surface: 0, lengthM: 1705 }],
            },
          ],
          totalCount: 1,
          totalPages: 1,
          page: 1,
          limit: 50,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not found', { status: 404 });
  };

  const result = await fetchOpenAipContext({
    kv,
    apiKey: TEST_SECRET_KEY,
    lat: -33.42,
    lng: 149.57,
    radiusM: 10000,
    fetchFn: mockFetch,
  });

  assert.equal(result.status, 'ok');
  assert.equal(capturedRequests.length, 2);

  for (const req of capturedRequests) {
    // Key must NOT be in the URL query string
    assert.ok(!req.url.includes(TEST_SECRET_KEY), 'API key leaked in URL query parameters');
    // Key MUST be in the x-openaip-api-key header
    const headers = req.headers as Record<string, string>;
    assert.equal(headers['x-openaip-api-key'], TEST_SECRET_KEY);
  }

  if (result.status === 'ok') {
    assert.equal(result.data.airspaces.length, 1);
    assert.equal(result.data.airspaces[0].name, 'R559 BATHURST');
    assert.equal(result.data.airspaces[0].typeName, 'RESTRICTED');
    assert.equal(result.data.airports.length, 1);
    assert.equal(result.data.airports[0].icaoCode, 'YBTH');
    assert.equal(result.source.provider, 'openaip');
    assert.equal(result.source.stale, false);
    assert.ok(result.source.attribution.includes('openAIP'));

    // Check payload serialization does not contain the key
    const jsonStr = JSON.stringify(result);
    assert.ok(!jsonStr.includes(TEST_SECRET_KEY), 'API key leaked in result payload');
  }
});

test('openaip: rejects invalid coordinates and overlarge areas', async () => {
  const kv = memoryKv();

  // Invalid latitude (out of bounds)
  await assert.rejects(
    async () => {
      await fetchOpenAipContext({
        kv,
        apiKey: TEST_SECRET_KEY,
        lat: 95,
        lng: 149,
        radiusM: 5000,
      });
    },
    /latitude must be between -90 and 90/i
  );

  // Non-finite longitude
  await assert.rejects(
    async () => {
      await fetchOpenAipContext({
        kv,
        apiKey: TEST_SECRET_KEY,
        lat: -33,
        lng: NaN,
        radiusM: 5000,
      });
    },
    /finite/i
  );

  // Overlarge radius (> 50,000 m)
  await assert.rejects(
    async () => {
      await fetchOpenAipContext({
        kv,
        apiKey: TEST_SECRET_KEY,
        lat: -33,
        lng: 149,
        radiusM: 60000,
      });
    },
    /radius exceeds maximum/i
  );

  // A wide bbox is no longer an error: it is split into tiles of at most 1 degree.
  const tiles = tileBbox([140.0, -35.0, 142.5, -33.0]);
  assert.equal(tiles.length, 3 * 2);
  for (const [a, b, c, d] of tiles) assert.ok(c - a <= 1 && d - b <= 1);
});

test('openaip: boundsFromPointRadius calculates correct bbox and clamps safely', () => {
  const bbox = boundsFromPointRadius(-33.42, 149.57, 10000);
  assert.equal(bbox.length, 4);
  const [minLng, minLat, maxLng, maxLat] = bbox;
  assert.ok(minLng < 149.57 && maxLng > 149.57);
  assert.ok(minLat < -33.42 && maxLat > -33.42);
  assert.ok(maxLng - minLng < 1.0);
  assert.ok(maxLat - minLat < 1.0);
});

test('openaip: pagination is bounded and deduplicates records by source ID', async () => {
  const kv = memoryKv();

  let requestedPages = 0;

  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/airspaces')) {
      requestedPages++;
      // Return 2 items, one of which is repeated across pages
      return new Response(
        JSON.stringify({
          items: [
            { _id: 'airspace-dup', name: 'Duplicated Airspace', type: 1, geometry: { type: 'Point', coordinates: [149.5, -33.5] } },
            { _id: `airspace-p${requestedPages}`, name: `Airspace ${requestedPages}`, type: 2, geometry: { type: 'Point', coordinates: [149.5, -33.5] } },
          ],
          totalCount: 100,
          totalPages: 10, // Claims 10 pages exist
          page: requestedPages,
          limit: 2,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ items: [], totalPages: 1 }), { status: 200 });
  };

  const result = await fetchOpenAipContext({
    kv,
    apiKey: TEST_SECRET_KEY,
    lat: -33.42,
    lng: 149.57,
    radiusM: 5000,
    fetchFn: mockFetch,
    maxPages: 3, // Bounded at 3
  });

  assert.equal(result.status, 'ok');
  assert.ok(requestedPages <= 3, 'should not exceed maxPages limit');
  if (result.status === 'ok') {
    // Check that 'airspace-dup' is present only once
    const dupCount = result.data.airspaces.filter((a) => a.id === 'airspace-dup').length;
    assert.equal(dupCount, 1, 'items must be deduplicated by _id');
  }
});

test('openaip: stale cache is returned with explicit stale warning when upstream fails', async () => {
  const kv = memoryKv();

  let upstreamShouldFail = false;

  const mockFetch: typeof fetch = async (input) => {
    if (upstreamShouldFail) {
      return new Response('OpenAIP Internal Server Error', { status: 500 });
    }
    const url = String(input);
    if (url.includes('/airspaces')) {
      return new Response(
        JSON.stringify({
          items: [{ _id: 'a1', name: 'Airspace One', type: 0, geometry: { type: 'Point', coordinates: [149.5, -33.5] } }],
          totalPages: 1,
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ items: [], totalPages: 1 }), { status: 200 });
  };

  let simulatedTime = 1_000_000;
  const now = () => simulatedTime;

  // 1. Initial successful fetch
  const res1 = await fetchOpenAipContext({
    kv,
    apiKey: TEST_SECRET_KEY,
    lat: -33.42,
    lng: 149.57,
    radiusM: 5000,
    fetchFn: mockFetch,
    now,
    cacheTtlMs: 60_000, // 1 min TTL
  });

  assert.equal(res1.status, 'ok');
  if (res1.status === 'ok') {
    assert.equal(res1.source.stale, false);
  }

  // 2. Advance time past TTL (cache expires) and trigger upstream failure
  simulatedTime += 120_000; // 2 min later
  upstreamShouldFail = true;

  const res2 = await fetchOpenAipContext({
    kv,
    apiKey: TEST_SECRET_KEY,
    lat: -33.42,
    lng: 149.57,
    radiusM: 5000,
    fetchFn: mockFetch,
    now,
    cacheTtlMs: 60_000,
  });

  // Stale cache must be returned with stale: true
  assert.equal(res2.status, 'stale');
  if (res2.status === 'stale') {
    assert.equal(res2.source.stale, true);
    assert.equal(res2.data.airspaces.length, 1);
    assert.equal(res2.data.airspaces[0].name, 'Airspace One');
  }
});

test('openaip: upstream errors without cache return typed error without leaking credentials', async () => {
  const kv = memoryKv();

  const mockFetch: typeof fetch = async () => {
    return new Response(`Error with key ${TEST_SECRET_KEY}`, { status: 502 });
  };

  const result = await fetchOpenAipContext({
    kv,
    apiKey: TEST_SECRET_KEY,
    lat: -33.42,
    lng: 149.57,
    radiusM: 5000,
    fetchFn: mockFetch,
  });

  assert.equal(result.status, 'error');
  if (result.status === 'error') {
    assert.ok(!result.error.includes(TEST_SECRET_KEY), 'secret leaked in error message');
  }
});

test('openaip: malformed rows and items missing geometry are filtered safely', async () => {
  const kv = memoryKv();

  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/airspaces')) {
      return new Response(
        JSON.stringify({
          items: [
            null, // null item
            {}, // empty object
            { _id: 'no-geom', name: 'Missing Geometry' },
            {
              _id: 'valid-airspace',
              name: 'Valid Airspace',
              type: 2,
              geometry: { type: 'Point', coordinates: [149.5, -33.5] },
            },
          ],
          totalPages: 1,
        }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({
        items: [
          { _id: 'no-airport-geom', name: 'Airport without geom' },
          { _id: 'valid-airport', name: 'Valid Airport', geometry: { type: 'Point', coordinates: [149.5, -33.5] } },
        ],
        totalPages: 1,
      }),
      { status: 200 }
    );
  };

  const result = await fetchOpenAipContext({
    kv,
    apiKey: TEST_SECRET_KEY,
    lat: -33.42,
    lng: 149.57,
    radiusM: 5000,
    fetchFn: mockFetch,
  });

  assert.equal(result.status, 'ok');
  if (result.status === 'ok') {
    assert.equal(result.data.airspaces.length, 1);
    assert.equal(result.data.airspaces[0].id, 'valid-airspace');
    assert.equal(result.data.airports.length, 1);
    assert.equal(result.data.airports[0].id, 'valid-airport');
  }
});

test('openaip: parses explicit runway threshold endpoints and never synthesizes from heading/point/length', async () => {
  const kv = memoryKv();

  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/airspaces')) {
      return new Response(JSON.stringify({ items: [], totalPages: 1 }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        items: [
          // 1. Airport with reciprocal runway items with explicit thresholdLocation coordinates
          {
            _id: 'apt-explicit-paired',
            name: 'Bathurst Aerodrome',
            icaoCode: 'YBTH',
            controlled: true,
            geometry: { type: 'Point', coordinates: [149.6525, -33.4097] },
            runways: [
              {
                _id: 'rwy-17',
                designator: '17',
                trueHeading: 172,
                thresholdLocation: {
                  geometry: { type: 'Point', coordinates: [149.651, -33.401] },
                },
              },
              {
                _id: 'rwy-35',
                designator: '35',
                trueHeading: 352,
                thresholdLocation: {
                  geometry: { type: 'Point', coordinates: [149.655, -33.418] },
                },
              },
            ],
          },
          // 2. Airport with single runway object having explicit paired endpoints
          {
            _id: 'apt-single-obj-paired',
            name: 'Orange Airport',
            icaoCode: 'YORG',
            controlled: true,
            geometry: { type: 'Point', coordinates: [149.133, -33.383] },
            runways: [
              {
                _id: 'rwy-11-29',
                designator: '11/29',
                thresholdEndpoints: [
                  [149.125, -33.379],
                  [149.141, -33.387],
                ],
              },
            ],
          },
          // 3. Multi-runway airport (two separate physical runways, each with explicit endpoints)
          {
            _id: 'apt-multi-runway',
            name: 'Sydney Kingsford Smith',
            icaoCode: 'YSSY',
            controlled: true,
            geometry: { type: 'Point', coordinates: [151.177, -33.946] },
            runways: [
              {
                _id: 'rwy-16R',
                designator: '16R',
                thresholdLocation: { geometry: { type: 'Point', coordinates: [151.171, -33.931] } },
              },
              {
                _id: 'rwy-34L',
                designator: '34L',
                thresholdLocation: { geometry: { type: 'Point', coordinates: [151.179, -33.966] } },
              },
              {
                _id: 'rwy-07',
                designator: '07',
                thresholdLocation: { geometry: { type: 'Point', coordinates: [151.162, -33.941] } },
              },
              {
                _id: 'rwy-25',
                designator: '25',
                thresholdLocation: { geometry: { type: 'Point', coordinates: [151.189, -33.948] } },
              },
            ],
          },
          // 4. Missing one threshold: only 17 has coordinates, 35 has NONE -> NO fallback synthesis
          {
            _id: 'apt-missing-one-end',
            name: 'Partial Runway Airport',
            icaoCode: 'YPAR',
            controlled: true,
            geometry: { type: 'Point', coordinates: [150.0, -34.0] },
            runways: [
              {
                _id: 'rwy-17-only',
                designator: '17',
                trueHeading: 170,
                dimension: { length: { value: 1800, unit: 0 } },
                thresholdLocation: { geometry: { type: 'Point', coordinates: [150.01, -33.99] } },
              },
              {
                _id: 'rwy-35-no-coord',
                designator: '35',
                trueHeading: 350,
              },
            ],
          },
          // 5. Missing all threshold coordinates (only designator/heading/length) -> NO fallback synthesis
          {
            _id: 'apt-no-coords',
            name: 'No Coordinates Airport',
            icaoCode: 'YNOC',
            controlled: true,
            geometry: { type: 'Point', coordinates: [150.5, -34.5] },
            runways: [
              {
                designator: '12/30',
                trueHeading: 120,
                lengthM: 2000,
              },
            ],
          },
          // 6. Malformed coordinates (lat > 90, non-finite, corrupt) -> Discarded safely
          {
            _id: 'apt-malformed-coords',
            name: 'Corrupt Coords Airport',
            icaoCode: 'YBAD',
            controlled: true,
            geometry: { type: 'Point', coordinates: [150.8, -34.8] },
            runways: [
              {
                designator: '01/19',
                thresholdEndpoints: [
                  [150.8, 999.0], // invalid lat
                  [150.8, -34.8],
                ],
              },
            ],
          },
        ],
        totalPages: 1,
      }),
      { status: 200 }
    );
  };

  const result = await fetchOpenAipContext({
    kv,
    apiKey: TEST_SECRET_KEY,
    lat: -33.42,
    lng: 149.57,
    radiusM: 5000,
    fetchFn: mockFetch,
  });

  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;

  const apts = result.data.airports;
  assert.equal(apts.length, 6);

  // 1. Explicit paired reciprocal runways normalized with both threshold endpoints
  const apt1 = apts.find((a) => a.id === 'apt-explicit-paired')!;
  assert.ok(apt1.runways && apt1.runways.length > 0);
  const rwy1 = apt1.runways[0];
  assert.ok(rwy1.thresholdEndpoints, 'Must have thresholdEndpoints when both ends explicit');
  assert.deepEqual(rwy1.thresholdEndpoints, [
    [149.651, -33.401],
    [149.655, -33.418],
  ]);
  assert.equal(apt1.runwayGeometryUnavailable, false);

  // 2. Single runway object with explicit paired thresholdEndpoints
  const apt2 = apts.find((a) => a.id === 'apt-single-obj-paired')!;
  assert.ok(apt2.runways && apt2.runways.length > 0);
  const rwy2 = apt2.runways[0];
  assert.deepEqual(rwy2.thresholdEndpoints, [
    [149.125, -33.379],
    [149.141, -33.387],
  ]);
  assert.equal(apt2.runwayGeometryUnavailable, false);

  // 3. Multi-runway airport preserves both valid runways
  const apt3 = apts.find((a) => a.id === 'apt-multi-runway')!;
  assert.equal(apt3.runways?.length, 2, 'Must preserve both distinct runways');
  assert.ok(apt3.runways?.every((r) => r.thresholdEndpoints != null));
  assert.equal(apt3.runwayGeometryUnavailable, false);

  // 4. Missing one end: Must NOT synthesize from heading or length
  const apt4 = apts.find((a) => a.id === 'apt-missing-one-end')!;
  const rwy4WithGeom = apt4.runways?.filter((r) => r.thresholdEndpoints != null) ?? [];
  assert.equal(rwy4WithGeom.length, 0, 'Must NOT synthesize second threshold from heading/length');
  assert.equal(apt4.runwayGeometryUnavailable, true, 'Controlled airport with partial runway must flag unavailable');

  // 5. Missing all coordinates: Must NOT synthesize from airport point
  const apt5 = apts.find((a) => a.id === 'apt-no-coords')!;
  const rwy5WithGeom = apt5.runways?.filter((r) => r.thresholdEndpoints != null) ?? [];
  assert.equal(rwy5WithGeom.length, 0, 'Must NOT synthesize runway from airport point');
  assert.equal(apt5.runwayGeometryUnavailable, true);

  // 6. Malformed coords: filtered out
  const apt6 = apts.find((a) => a.id === 'apt-malformed-coords')!;
  const rwy6WithGeom = apt6.runways?.filter((r) => r.thresholdEndpoints != null) ?? [];
  assert.equal(rwy6WithGeom.length, 0, 'Malformed coordinates must be discarded');
  assert.equal(apt6.runwayGeometryUnavailable, true);
});
