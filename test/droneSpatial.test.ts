import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  intersectsCircle,
  filterAirspacesByRadius,
  filterFireHazardsByRadius,
  selectAirportsForPlanning,
  findClosestAircraft,
} from '../src/server/spatial.js';
import type { OpenAipAirspace, OpenAipAirport } from '../src/server/openaip.js';
import type { DroneFireHazard } from '../src/server/fireHazards.js';
import type { Plane } from '../src/server/sources.js';

test('drone spatial: excludes bounding-box false positives outside true circular radius', () => {
  // Center at Bathurst: -33.42, 149.58
  const centerLat = -33.42;
  const centerLng = 149.58;
  const radiusM = 5000; // 5 km

  // Point at ~6.4 km northeast: inside 5 km bbox corner, but outside 5 km circle
  // Lat delta +0.04 deg (~4.45 km), Lng delta +0.04 deg (~4.6 km) => hypotenuse ~6.4 km
  const cornerAirspace: OpenAipAirspace = {
    id: 'as-corner',
    name: 'Corner Bbox Airspace',
    type: 1,
    typeName: 'RESTRICTED',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [149.62, -33.38],
          [149.63, -33.38],
          [149.63, -33.37],
          [149.62, -33.37],
          [149.62, -33.38],
        ],
      ],
    },
  };

  // Airspace intersecting the 5 km circle (at 2 km distance)
  const insideAirspace: OpenAipAirspace = {
    id: 'as-inside',
    name: 'Inside Airspace',
    type: 1,
    typeName: 'RESTRICTED',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [149.58, -33.41],
          [149.60, -33.41],
          [149.60, -33.43],
          [149.58, -33.43],
          [149.58, -33.41],
        ],
      ],
    },
  };

  assert.equal(intersectsCircle(cornerAirspace.geometry, centerLat, centerLng, radiusM), false);
  assert.equal(intersectsCircle(insideAirspace.geometry, centerLat, centerLng, radiusM), true);

  const filtered = filterAirspacesByRadius([cornerAirspace, insideAirspace], centerLat, centerLng, radiusM);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'as-inside');
});

test('drone spatial: polygon containing the center point intersects circle', () => {
  const centerLat = -33.42;
  const centerLng = 149.58;
  const enclosingPoly: GeoJSON.Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [149.50, -33.50],
        [149.70, -33.50],
        [149.70, -33.30],
        [149.50, -33.30],
        [149.50, -33.50],
      ],
    ],
  };
  assert.equal(intersectsCircle(enclosingPoly, centerLat, centerLng, 1000), true);
});

test('drone spatial: does not treat a planning circle fully inside a polygon hole as intersecting', () => {
  const centerLat = -33.42;
  const centerLng = 149.58;
  const donut: GeoJSON.Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [149.50, -33.50], [149.66, -33.50], [149.66, -33.34], [149.50, -33.34], [149.50, -33.50],
      ],
      [
        [149.56, -33.44], [149.60, -33.44], [149.60, -33.40], [149.56, -33.40], [149.56, -33.44],
      ],
    ],
  };

  // The 500 m planning circle is completely within the no-airspace hole.
  assert.equal(intersectsCircle(donut, centerLat, centerLng, 500), false);
});

test('drone spatial: controlled airport 3 NM buffer intersects flight radius even when airport point is outside', () => {
  const centerLat = -33.42;
  const centerLng = 149.58;
  const radiusM = 5000; // 5 km flight radius

  // Controlled airport at ~8 km distance (8000 m) WITH explicit runway threshold endpoints.
  // The runway centreline 3 NM buffer reaches down to ~2444 m from center, which is < 5000 m.
  const controlledAirportAt8km: OpenAipAirport = {
    id: 'apt-controlled-8km',
    name: 'Controlled Aerodrome 8km',
    controlled: true,
    geometry: { type: 'Point', coordinates: [149.58, -33.348] },
    runways: [
      {
        designator: '18/36',
        thresholdEndpoints: [
          [149.58, -33.340],
          [149.58, -33.356],
        ],
      },
    ],
  };

  // Uncontrolled airport at same ~8 km distance: no 3 NM buffer!
  const uncontrolledAirportAt8km: OpenAipAirport = {
    id: 'apt-uncontrolled-8km',
    name: 'Uncontrolled Aerodrome 8km',
    controlled: false,
    geometry: { type: 'Point', coordinates: [149.58, -33.348] },
  };

  // When both exist:
  const result = selectAirportsForPlanning(
    [controlledAirportAt8km, uncontrolledAirportAt8km],
    centerLat,
    centerLng,
    radiusM
  );

  // Controlled airport with valid runway intersects because runway 3 NM buffer reaches into radius
  const controlledItem = result.airports.find((a) => a.id === 'apt-controlled-8km');
  assert.ok(controlledItem, 'Controlled airport with runway 3 NM buffer intersecting radius must be included');
  assert.equal(controlledItem.outsidePlannedRadius, false);

  // Uncontrolled airport at 8 km does not intersect 5 km radius
  const uncontrolledItem = result.airports.find((a) => a.id === 'apt-uncontrolled-8km');
  assert.equal(uncontrolledItem, undefined, 'Uncontrolled airport outside radius must be excluded');
});

test('drone spatial: approach corridor reaching into planned radius keeps airport visible even if marker is far outside', () => {
  const centerLat = -33.42;
  const centerLng = 149.58;
  const radiusM = 5000; // 5 km flight radius

  // Airport center is ~10 km north of centerLat (distance ~10,000 m > 5,000 m)
  // Runway aligned north-south: runway 18 approach corridor extends ~8.5 km south towards centerLat!
  // It reaches ~10,000 m - 8,500 m = ~1,500 m from center, well inside the 5 km flight radius!
  const airportAt10kmWithCorridor: OpenAipAirport = {
    id: 'apt-corridor-reach-10km',
    name: 'Far Airport With Reaching Corridor',
    controlled: true,
    geometry: { type: 'Point', coordinates: [149.58, -33.330] }, // ~10 km north
    runways: [
      {
        designator: '18/36',
        thresholdEndpoints: [
          [149.58, -33.325],
          [149.58, -33.335],
        ],
      },
    ],
  };

  const result = selectAirportsForPlanning(
    [airportAt10kmWithCorridor],
    centerLat,
    centerLng,
    radiusM
  );

  assert.equal(result.airports.length, 1);
  const apt = result.airports[0];
  assert.equal(apt.id, 'apt-corridor-reach-10km');
  assert.equal(apt.outsidePlannedRadius, false, 'Must remain visible when approach corridor intersects radius');
});

test('drone spatial: controlled airport without runway geometry does NOT synthesize 3NM circle from point', () => {
  const centerLat = -33.42;
  const centerLng = 149.58;
  const radiusM = 5000; // 5 km flight radius

  // Controlled airport at ~8 km, but missing runway geometry
  const controlledAirportNoRunways: OpenAipAirport = {
    id: 'apt-controlled-no-rwy-8km',
    name: 'Controlled Field Without Runways',
    controlled: true,
    runwayGeometryUnavailable: true,
    geometry: { type: 'Point', coordinates: [149.58, -33.348] }, // ~8 km away
  };

  const result = selectAirportsForPlanning(
    [controlledAirportNoRunways],
    centerLat,
    centerLng,
    radiusM
  );

  // Since it is 8 km away (> 5 km) and NO 3NM point buffer is synthesized:
  // It must NOT intersect the radius!
  // It is only included as the single closest outside airport
  assert.equal(result.airports.length, 1);
  assert.equal(result.airports[0].id, 'apt-controlled-no-rwy-8km');
  assert.equal(result.airports[0].outsidePlannedRadius, true);
  assert.equal(result.airports[0].controlledBuffer, undefined, 'Must NOT synthesize airport-point 3NM buffer');
  assert.equal(result.airports[0].runwayGeometryUnavailable, true);
});

test('drone spatial: always includes closest mapped airport even when outside planned radius', () => {
  const centerLat = -33.42;
  const centerLng = 149.58;
  const radiusM = 2000; // 2 km flight radius

  // Nearest airport is at ~8 km (outside 2 km radius)
  const aptAt8km: OpenAipAirport = {
    id: 'apt-nearest-8km',
    name: 'Regional Airfield',
    controlled: false,
    geometry: { type: 'Point', coordinates: [149.58, -33.348] },
  };

  // Farther airport at ~15 km
  const aptAt15km: OpenAipAirport = {
    id: 'apt-farther-15km',
    name: 'Distant Field',
    controlled: false,
    geometry: { type: 'Point', coordinates: [149.58, -33.285] },
  };

  const result = selectAirportsForPlanning([aptAt8km, aptAt15km], centerLat, centerLng, radiusM);

  assert.equal(result.airports.length, 1);
  assert.equal(result.airports[0].id, 'apt-nearest-8km');
  assert.equal(result.airports[0].outsidePlannedRadius, true);
  assert.ok(result.airports[0].distanceM > 7000);
  assert.equal(result.closestAirport?.id, 'apt-nearest-8km');
});

test('drone spatial: filters fire hazards by 2 km buffer intersection with flight radius', () => {
  const centerLat = -33.42;
  const centerLng = 149.58;
  const radiusM = 5000;

  // Fire hazard at ~6 km: 2 km buffer reaches to ~4 km from center => intersects 5 km circle
  const intersectingHazard: DroneFireHazard = {
    id: 'fire-near',
    title: 'Near Fire',
    category: 'Advice',
    status: 'Under Control',
    updated: '2026-10-14T00:00:00Z',
    sourceGeometry: { type: 'Point', coordinates: [149.58, -33.366] },
    bufferGeometry: {
      type: 'Polygon',
      coordinates: [
        [
          [149.56, -33.35],
          [149.60, -33.35],
          [149.60, -33.38],
          [149.56, -33.38],
          [149.56, -33.35],
        ],
      ],
    },
    bufferMetres: 2000,
    bufferPolicyId: 'p1',
    disclaimer: 'Modelled buffer',
  };

  // Fire hazard at ~15 km: buffer does not intersect
  const distantHazard: DroneFireHazard = {
    id: 'fire-distant',
    title: 'Distant Fire',
    category: 'Advice',
    status: 'Under Control',
    updated: '2026-10-14T00:00:00Z',
    sourceGeometry: { type: 'Point', coordinates: [149.58, -33.285] },
    bufferGeometry: {
      type: 'Polygon',
      coordinates: [
        [
          [149.56, -33.27],
          [149.60, -33.27],
          [149.60, -33.30],
          [149.56, -33.30],
          [149.56, -33.27],
        ],
      ],
    },
    bufferMetres: 2000,
    bufferPolicyId: 'p1',
    disclaimer: 'Modelled buffer',
  };

  const filtered = filterFireHazardsByRadius([intersectingHazard, distantHazard], centerLat, centerLng, radiusM);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'fire-near');
});

test('drone spatial: finds closest ADS-B aircraft and sorts by distance regardless of radius', () => {
  const centerLat = -33.42;
  const centerLng = 149.58;

  const planes: Plane[] = [
    { hex: '7c1111', flight: 'FAR202', lat: -33.60, lon: 149.58, track: 90, gs: 250, alt_baro: 12000, t: 'B738', seen: 2 },
    { hex: '7c2222', flight: 'NEAR101', lat: -33.44, lon: 149.58, track: 180, gs: 120, alt_baro: 3500, t: 'C172', seen: 1 },
    { hex: '7c3333', flight: 'MID303', lat: -33.50, lon: 149.58, track: 270, gs: 180, alt_baro: 7500, t: 'PC12', seen: 5 },
  ];

  const { closest, sorted } = findClosestAircraft(planes, centerLat, centerLng);
  assert.ok(closest);
  assert.equal(closest.hex, '7c2222');
  assert.equal(closest.flight, 'NEAR101');
  assert.ok(closest.distanceM < 3000);
  assert.equal(sorted[0].hex, '7c2222');
  assert.equal(sorted[1].hex, '7c3333');
  assert.equal(sorted[2].hex, '7c1111');
});
