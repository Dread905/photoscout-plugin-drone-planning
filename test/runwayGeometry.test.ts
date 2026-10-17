import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRunwayPlanningMarkings,
  generateAirportRunwayMarkings,
  haversineDistance,
  type RunwayThresholdPair,
} from '../src/shared/runwayGeometry.js';

// Test coordinates: Bathurst Aerodrome (YBTH) Runway 17/35
// T1 (17 end): [149.651, -33.401]
// T2 (35 end): [149.655, -33.418]
const YBTH_RWY_17_35: RunwayThresholdPair = {
  runwayId: 'rwy-17-35',
  designator: '17/35',
  endpoints: [
    [149.651, -33.401],
    [149.655, -33.418],
  ],
};

// Second hypothetical intersecting runway 08/26
const YBTH_RWY_08_26: RunwayThresholdPair = {
  runwayId: 'rwy-08-26',
  designator: '08/26',
  endpoints: [
    [149.643, -33.410],
    [149.663, -33.410],
  ],
};

const AIRPORT_CONTEXT = {
  airportId: 'apt-ybth',
  airportName: 'Bathurst Aerodrome',
  icaoCode: 'YBTH',
  controlled: true,
};

test('runwayGeometry: generates 3NM measurement buffer around runway centreline', () => {
  const markings = generateRunwayPlanningMarkings(YBTH_RWY_17_35, AIRPORT_CONTEXT);

  assert.equal(markings.buffer3nm.features.length, 1);
  const bufFeature = markings.buffer3nm.features[0];

  assert.equal(bufFeature.geometry.type, 'Polygon');
  assert.equal(bufFeature.properties?.kind, 'controlled-3nm-measurement-buffer');
  assert.equal(bufFeature.properties?.runwayDesignator, '17/35');
  assert.equal(bufFeature.properties?.authority, 'provider_context');
  assert.ok(bufFeature.properties?.disclaimer.toLowerCase().includes('advisory'));
  assert.ok(bufFeature.properties?.disclaimer.toLowerCase().includes('not clearance'));

  const ring = bufFeature.geometry.coordinates[0];
  assert.ok(ring.length >= 32, 'Ring should have sufficient smooth vertices for curved caps');

  // Verify that the buffer is around the centreline, not a single point:
  // The distance between threshold 1 and threshold 2 is ~1.9 km.
  // The maximum extent of the buffer should be ~(1.9 km + 2 * 5.556 km) ~ 13 km.
  const t1 = YBTH_RWY_17_35.endpoints[0];
  const t2 = YBTH_RWY_17_35.endpoints[1];
  const rwyLength = haversineDistance(t1, t2);
  assert.ok(rwyLength > 1500 && rwyLength < 2500, `Runway length should be ~1.9 km, got ${rwyLength}`);

  let maxDistFromMidpoint = 0;
  const midPoint: [number, number] = [(t1[0] + t2[0]) / 2, (t1[1] + t2[1]) / 2];
  for (const pt of ring) {
    const d = haversineDistance(midPoint, pt);
    if (d > maxDistFromMidpoint) maxDistFromMidpoint = d;
  }
  // Max extent from midPoint along runway should be (rwyLength / 2) + 5556 m ~ 6.5 km
  assert.ok(
    maxDistFromMidpoint > 6000 && maxDistFromMidpoint < 7000,
    `Max extent along centreline buffer should be ~6.5km, got ${maxDistFromMidpoint}`
  );
});

test('runwayGeometry: generates controlled-approach-core covering runway strip and two 15° splays to 7 km', () => {
  const markings = generateRunwayPlanningMarkings(YBTH_RWY_17_35, AIRPORT_CONTEXT);

  assert.equal(markings.approachCore.features.length, 1);
  const coreFeature = markings.approachCore.features[0];

  assert.equal(coreFeature.geometry.type, 'Polygon');
  assert.equal(coreFeature.properties?.kind, 'controlled-approach-core');
  assert.equal(coreFeature.properties?.coreDistanceM, 7000);
  assert.equal(coreFeature.properties?.rectangleHalfWidthM, 500);
  assert.ok(coreFeature.properties?.lawReference.includes('MOS'));

  const ring = coreFeature.geometry.coordinates[0];
  // Verify extent reaches 7 km from strip ends
  const t1 = YBTH_RWY_17_35.endpoints[0];
  const t2 = YBTH_RWY_17_35.endpoints[1];
  let maxDistT1 = 0;
  let maxDistT2 = 0;
  for (const pt of ring) {
    const d1 = haversineDistance(t1, pt);
    const d2 = haversineDistance(t2, pt);
    if (d1 > maxDistT1) maxDistT1 = d1;
    if (d2 > maxDistT2) maxDistT2 = d2;
  }
  // Threshold-derived geometry must not invent a runway-strip extension.
  assert.ok(maxDistT1 > 8500, 'End 2 far cap should be > 8.5 km from End 1 threshold');
  assert.ok(maxDistT2 > 8500, 'End 1 far cap should be > 8.5 km from End 2 threshold');
});

test('runwayGeometry: generates controlled-approach-height-band between 7 km and 8.5 km with diagonal hatch lines', () => {
  const markings = generateRunwayPlanningMarkings(YBTH_RWY_17_35, AIRPORT_CONTEXT);

  // Two ends -> 2 height band polygon features
  assert.equal(markings.approachHeightBand.features.length, 2);
  for (const hb of markings.approachHeightBand.features) {
    assert.equal(hb.geometry.type, 'Polygon');
    assert.equal(hb.properties?.kind, 'controlled-approach-height-band');
    assert.equal(hb.properties?.heightBand, '90m/300ft height-aware band');
    assert.equal(hb.properties?.startDistanceM, 7000);
    assert.equal(hb.properties?.endDistanceM, 8500);
    assert.ok(hb.properties?.disclaimer.toLowerCase().includes('advisory'));
  }

  // Hatch lines must be generated geometry (LineString features), not third-party tiles
  assert.ok(markings.heightBandHatch.features.length > 0, 'Must generate vector diagonal hatch lines');
  for (const hatch of markings.heightBandHatch.features) {
    assert.equal(hatch.geometry.type, 'LineString');
    assert.equal(hatch.properties?.kind, 'controlled-approach-height-band-hatch');
    assert.equal(hatch.geometry.coordinates.length, 2);
  }
});

test('runwayGeometry: multi-runway airport renders every valid runway and preserves overlaps without collapsing to circle', () => {
  const airportMarkings = generateAirportRunwayMarkings(
    [YBTH_RWY_17_35, YBTH_RWY_08_26],
    AIRPORT_CONTEXT
  );

  // Both runways must produce distinct features
  assert.equal(airportMarkings.buffer3nm.features.length, 2, 'Must have 2 distinct 3NM runway buffers');
  assert.equal(airportMarkings.approachCore.features.length, 2, 'Must have 2 distinct approach cores');
  assert.equal(airportMarkings.approachHeightBand.features.length, 4, 'Must have 4 height band zones (2 per runway)');

  const designators = airportMarkings.buffer3nm.features.map((f) => f.properties?.runwayDesignator);
  assert.ok(designators.includes('17/35'));
  assert.ok(designators.includes('08/26'));
});
