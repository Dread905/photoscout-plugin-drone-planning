import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRONE_FIRE_BUFFER_METRES,
  DRONE_FIRE_POLICY_ID,
  DRONE_FIRE_POLICY_DISCLAIMER,
  createDroneFireBuffer,
  createDroneFireHazards,
  fireHazardToEvidence,
  createFireNotCheckedGate,
} from '../src/server/fireHazards.js';
import type { FireIncident } from '../src/server/sources.js';

const BANNED_WORDS = ['\\blegal\\b', '\\bsafe\\b', '\\bapproved\\b', '\\bcleared\\b', '\\bauthorised\\b'];

function assertNoBannedWords(text: string) {
  for (const pattern of BANNED_WORDS) {
    const re = new RegExp(pattern, 'i');
    assert.ok(!re.test(text), `Text contained banned word matching ${pattern}: "${text}"`);
  }
}

test('drone fire hazards: policy constants define explicit 2 km modelled buffer', () => {
  assert.equal(DRONE_FIRE_BUFFER_METRES, 2000, 'buffer must be exactly 2000 metres (2 km)');
  assert.equal(DRONE_FIRE_POLICY_ID, 'photoscout-fire-hazard-2km-v1');
  assert.ok(DRONE_FIRE_POLICY_DISCLAIMER.toLowerCase().includes('modelled'));
  assert.ok(!DRONE_FIRE_POLICY_DISCLAIMER.toLowerCase().includes('official restriction'));
  assertNoBannedWords(DRONE_FIRE_POLICY_DISCLAIMER);
});

test('drone fire hazards: buffers Point incident deterministically into a Polygon', () => {
  const pt: GeoJSON.Point = {
    type: 'Point',
    coordinates: [149.58, -33.42], // Bathurst area
  };

  const buffer = createDroneFireBuffer(pt, 2000);
  assert.ok(buffer, 'buffer should not be null');
  assert.equal(buffer.type, 'Polygon');
  const poly = buffer as GeoJSON.Polygon;
  assert.ok(poly.coordinates.length > 0);
  assert.ok(poly.coordinates[0].length >= 8, 'circle buffer should have multiple vertices');

  // Coordinates order must remain [lng, lat]
  const [lng, lat] = poly.coordinates[0][0];
  assert.ok(lng > 140 && lng < 160, `Longitude out of expected Australian bounds: ${lng}`);
  assert.ok(lat < -20 && lat > -45, `Latitude out of expected Australian bounds: ${lat}`);
});

test('drone fire hazards: buffers Polygon incident outward rather than collapsing to a point', () => {
  const poly: GeoJSON.Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [149.50, -33.40],
        [149.60, -33.40],
        [149.60, -33.50],
        [149.50, -33.50],
        [149.50, -33.40],
      ],
    ],
  };

  const buffer = createDroneFireBuffer(poly, 2000);
  assert.ok(buffer);
  assert.equal(buffer.type, 'Polygon');
  const bufferedPoly = buffer as GeoJSON.Polygon;

  // Outer ring of buffered polygon should extend beyond original coordinates
  const lons = bufferedPoly.coordinates[0].map(([lng]) => lng);
  const lats = bufferedPoly.coordinates[0].map(([, lat]) => lat);
  const minLng = Math.min(...lons);
  const maxLng = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);

  assert.ok(minLng < 149.50, 'buffered minLng should be strictly less than original');
  assert.ok(maxLng > 149.60, 'buffered maxLng should be strictly greater than original');
  assert.ok(minLat < -33.50, 'buffered minLat should be strictly less than original');
  assert.ok(maxLat > -33.40, 'buffered maxLat should be strictly greater than original');
});

test('drone fire hazards: buffers GeometryCollection containing points and polygons', () => {
  const gc: GeoJSON.GeometryCollection = {
    type: 'GeometryCollection',
    geometries: [
      {
        type: 'Point',
        coordinates: [149.55, -33.45],
      },
      {
        type: 'Polygon',
        coordinates: [
          [
            [149.50, -33.40],
            [149.60, -33.40],
            [149.60, -33.50],
            [149.50, -33.50],
            [149.50, -33.40],
          ],
        ],
      },
    ],
  };

  const buffer = createDroneFireBuffer(gc, 2000);
  assert.ok(buffer);
  assert.ok(
    buffer.type === 'GeometryCollection' || buffer.type === 'MultiPolygon',
    `buffer type was ${buffer.type}`
  );
});

test('drone fire hazards: createDroneFireHazards preserves incident metadata and adds modelled buffer', () => {
  const sampleIncident: FireIncident = {
    id: 'rfs-12345',
    title: 'Mount Panorama Grass Fire',
    category: 'Emergency Warning',
    status: 'Out of Control',
    sizeHa: 45,
    updated: '2026-10-13T12:00:00Z',
    link: 'https://www.rfs.nsw.gov.au/incident/12345',
    geometry: {
      type: 'Point',
      coordinates: [149.56, -33.45],
    },
  };

  const hazards = createDroneFireHazards([sampleIncident]);
  assert.equal(hazards.length, 1);
  const h = hazards[0];
  assert.equal(h.id, 'rfs-12345');
  assert.equal(h.title, 'Mount Panorama Grass Fire');
  assert.equal(h.category, 'Emergency Warning');
  assert.equal(h.status, 'Out of Control');
  assert.equal(h.sizeHa, 45);
  assert.equal(h.updated, '2026-10-13T12:00:00Z');
  assert.equal(h.bufferMetres, 2000);
  assert.equal(h.bufferPolicyId, 'photoscout-fire-hazard-2km-v1');
  assert.ok(h.bufferGeometry);
  assert.equal(h.bufferGeometry.type, 'Polygon');
  assert.ok(h.disclaimer.includes('Modelled'));
  assert.ok(!h.disclaimer.includes('official restriction'));
  assertNoBannedWords(JSON.stringify(h));
});

test('drone fire hazards: fireHazardToEvidence creates restriction under CASR 101.238(e)', () => {
  const sampleIncident: FireIncident = {
    id: 'rfs-999',
    title: 'Blue Mountains Bush Fire',
    category: 'Watch and Act',
    status: 'Being Controlled',
    updated: '2026-10-13T10:00:00Z',
    link: 'https://www.rfs.nsw.gov.au/incident/999',
    geometry: {
      type: 'Point',
      coordinates: [150.3, -33.7],
    },
  };

  const [hazard] = createDroneFireHazards([sampleIncident]);
  const evidence = fireHazardToEvidence(hazard, {
    name: 'NSW Rural Fire Service',
    fetchedAt: '2026-10-13T10:05:00Z',
  });

  assert.equal(evidence.category, 'fire');
  assert.equal(evidence.severity, 'restriction');
  assert.equal(evidence.ruleId, 'casr-101-238-e');
  assert.ok(evidence.explanation.includes('CASR 101.238(e)'));
  assert.ok(evidence.explanation.toLowerCase().includes('modelled'));
  assert.ok(!evidence.explanation.toLowerCase().includes('official restriction'));
  assert.ok(!evidence.explanation.toLowerCase().includes('legally defined buffer'));
  assertNoBannedWords(JSON.stringify(evidence));
});

test('drone fire hazards: stale or missing fire feed produces Fire operation status not checked gate', () => {
  const gate = createFireNotCheckedGate('Feed unavailable');
  assert.equal(gate.category, 'fire');
  assert.equal(gate.severity, 'not_checked');
  assert.equal(gate.title, 'Fire operation status not checked');
  assert.ok(gate.explanation.includes('Fire emergency operation status could not be verified'));
  assert.equal(gate.source.name, 'NSW Rural Fire Service');
  assert.equal(gate.source.stale, true);
  assertNoBannedWords(JSON.stringify(gate));
});
