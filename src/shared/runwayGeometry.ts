/**
 * Pure geodesic geometry module for CASA Part 101 MOS Section 4.05 runway-derived markings.
 *
 * Implements:
 * - controlled-3nm-measurement-buffer: 3 NM (5556m) buffer of the runway centreline.
 * - controlled-approach-core: nominal 100m strip, 500m centreline rectangle out to 1.68 km,
 *   and symmetrical 15° trapezoids extending to 7 km from strip ends.
 * - controlled-approach-height-band: 7–8.5 km outer portion, explicitly labelled 90m/300ft height-aware band.
 * - heightBandHatch: generated vector diagonal hatch lines crossing the 7–8.5 km height bands.
 */

export interface RunwayThresholdPair {
  runwayId?: string;
  designator: string;
  endpoints: [GeoJSON.Position, GeoJSON.Position]; // [ [lng1, lat1], [lng2, lat2] ]
}

export interface RunwayAirportContext {
  airportId: string;
  airportName: string;
  icaoCode?: string;
  controlled?: boolean;
}

export interface RunwayPlanningFeatures {
  buffer3nm: GeoJSON.FeatureCollection<GeoJSON.Polygon>;
  approachCore: GeoJSON.FeatureCollection<GeoJSON.Polygon>;
  approachHeightBand: GeoJSON.FeatureCollection<GeoJSON.Polygon>;
  heightBandHatch: GeoJSON.FeatureCollection<GeoJSON.LineString>;
  allFeatures: GeoJSON.FeatureCollection;
}

const EARTH_RADIUS_M = 6371000;
export const CONTROLLED_3NM_BUFFER_METRES = 5556; // 3 NM = 3 * 1852 m

// CASA Part 101 MOS Section 4.05 parameters
const STRIP_HALF_WIDTH_M = 50; // Nominal 100 m wide runway strip
// OpenAIP provides runway threshold centres, not surveyed runway-strip ends. Do
// not invent an extension: this is explicitly threshold-derived planning
// geometry until an authoritative runway-strip dataset is licensed.
const STRIP_END_EXTENSION_M = 0;
const RECTANGLE_HALF_WIDTH_M = 500; // 500 m either side of runway centreline (1 km total)
const SPLAY_ANGLE_DEG = 15;
const TAN_15_DEG = Math.tan((SPLAY_ANGLE_DEG * Math.PI) / 180); // ~0.26794919
// Distance where 15° splay from strip edge reaches 500 m half-width: (500 - 50) / tan(15°) ~ 1679.4 m
const RECT_INTERSECT_DIST_M = (RECTANGLE_HALF_WIDTH_M - STRIP_HALF_WIDTH_M) / TAN_15_DEG;
const CORE_DISTANCE_M = 7000; // 7 km from strip end
const CORE_FAR_HALF_WIDTH_M = STRIP_HALF_WIDTH_M + CORE_DISTANCE_M * TAN_15_DEG; // ~1925.64 m (3.85 km splay width)
const HEIGHT_BAND_END_M = 8500; // 8.5 km from strip end
const HEIGHT_BAND_FAR_HALF_WIDTH_M = STRIP_HALF_WIDTH_M + HEIGHT_BAND_END_M * TAN_15_DEG; // ~2327.57 m (4.65 km splay width)

/**
 * Calculates Haversine distance in metres between two [lng, lat] positions.
 */
export function haversineDistance(p1: GeoJSON.Position, p2: GeoJSON.Position): number {
  const [lng1, lat1] = p1;
  const [lng2, lat2] = p2;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/**
 * Calculates initial bearing in degrees (0..360) from p1 to p2.
 */
export function initialBearing(p1: GeoJSON.Position, p2: GeoJSON.Position): number {
  const [lng1, lat1] = p1;
  const [lng2, lat2] = p2;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const dLngRad = ((lng2 - lng1) * Math.PI) / 180;

  const y = Math.sin(dLngRad) * Math.cos(lat2Rad);
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLngRad);
  const brng = (Math.atan2(y, x) * 180) / Math.PI;
  return (brng + 360) % 360;
}

/**
 * Calculates destination point given starting point, distance in metres, and bearing in degrees.
 */
export function destinationPoint(
  start: GeoJSON.Position,
  distanceM: number,
  bearingDeg: number
): [number, number] {
  if (distanceM === 0) return [start[0], start[1]];
  const [lng, lat] = start;
  const dByR = distanceM / EARTH_RADIUS_M;
  const latRad = (lat * Math.PI) / 180;
  const lngRad = (lng * Math.PI) / 180;
  const bRad = (bearingDeg * Math.PI) / 180;

  const pLatRad = Math.asin(
    Math.sin(latRad) * Math.cos(dByR) +
      Math.cos(latRad) * Math.sin(dByR) * Math.cos(bRad)
  );
  const pLngRad =
    lngRad +
    Math.atan2(
      Math.sin(bRad) * Math.sin(dByR) * Math.cos(latRad),
      Math.cos(dByR) - Math.sin(latRad) * Math.sin(pLatRad)
    );

  const finalLng = (((pLngRad * 180) / Math.PI + 540) % 360) - 180;
  const finalLat = (pLatRad * 180) / Math.PI;
  return [finalLng, finalLat];
}

/**
 * Projects a point along a line at distance `alongM` and perpendicular offset `lateralM` (positive=right, negative=left).
 */
export function offsetPoint(
  origin: GeoJSON.Position,
  alongM: number,
  alongBearingDeg: number,
  lateralM: number
): [number, number] {
  const ptAlong = destinationPoint(origin, alongM, alongBearingDeg);
  if (lateralM === 0) return ptAlong;
  const lateralBearing = lateralM > 0 ? (alongBearingDeg + 90) % 360 : (alongBearingDeg + 270) % 360;
  return destinationPoint(ptAlong, Math.abs(lateralM), lateralBearing);
}

/**
 * Generates the 3 NM (5556 m) buffer polygon around the runway centreline segment.
 */
export function generateRunway3nmBuffer(
  t1: GeoJSON.Position,
  t2: GeoJSON.Position,
  capSteps = 16
): [number, number][] {
  const bearing = initialBearing(t1, t2);
  const revBearing = (bearing + 180) % 360;
  const ring: [number, number][] = [];

  // Semi-circle around T2: from (bearing + 90) clockwise through bearing to (bearing - 90 / bearing + 270)
  for (let i = 0; i <= capSteps; i++) {
    const angle = (bearing + 90 - (i * 180) / capSteps + 360) % 360;
    ring.push(destinationPoint(t2, CONTROLLED_3NM_BUFFER_METRES, angle));
  }

  // Semi-circle around T1: from (revBearing + 90) clockwise through revBearing to (revBearing - 90)
  for (let i = 0; i <= capSteps; i++) {
    const angle = (revBearing + 90 - (i * 180) / capSteps + 360) % 360;
    ring.push(destinationPoint(t1, CONTROLLED_3NM_BUFFER_METRES, angle));
  }

  // Close ring
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

/**
 * Generates the unified controlled-approach-core polygon:
 * Runway strip + 500m centreline rectangle (1 km wide) out to ~1.68 km + 15° splay out to 7 km at both ends.
 */
export function generateRunwayApproachCore(
  t1: GeoJSON.Position,
  t2: GeoJSON.Position
): [number, number][] {
  const bearing = initialBearing(t1, t2);
  const revBearing = (bearing + 180) % 360;

  // Threshold-derived strip endpoints. See STRIP_END_EXTENSION_M above.
  const s1 = destinationPoint(t1, STRIP_END_EXTENSION_M, revBearing);
  const s2 = destinationPoint(t2, STRIP_END_EXTENSION_M, bearing);

  // End 2 points (along bearing from s2)
  // Far end: 7 km out, half-width CORE_FAR_HALF_WIDTH_M
  const e2FarLeft = offsetPoint(s2, CORE_DISTANCE_M, bearing, -CORE_FAR_HALF_WIDTH_M);
  const e2FarRight = offsetPoint(s2, CORE_DISTANCE_M, bearing, CORE_FAR_HALF_WIDTH_M);
  // Splay narrows to rectangle at RECT_INTERSECT_DIST_M (~1.68 km)
  const e2RectRight = offsetPoint(s2, RECT_INTERSECT_DIST_M, bearing, RECTANGLE_HALF_WIDTH_M);
  const e2RectLeft = offsetPoint(s2, RECT_INTERSECT_DIST_M, bearing, -RECTANGLE_HALF_WIDTH_M);

  // End 1 points (along revBearing from s1)
  const e1RectRight = offsetPoint(s1, RECT_INTERSECT_DIST_M, revBearing, -RECTANGLE_HALF_WIDTH_M); // Right relative to runway traversal
  const e1FarRight = offsetPoint(s1, CORE_DISTANCE_M, revBearing, -CORE_FAR_HALF_WIDTH_M);
  const e1FarLeft = offsetPoint(s1, CORE_DISTANCE_M, revBearing, CORE_FAR_HALF_WIDTH_M);
  const e1RectLeft = offsetPoint(s1, RECT_INTERSECT_DIST_M, revBearing, RECTANGLE_HALF_WIDTH_M);

  // Walk the outline once, without crossing the strip: end 2 (left, right), down the right edge to end 1,
  // end 1 (right, left), back up the left edge. offsetPoint's sides are relative to the bearing it is given,
  // so the end-1 names below are mirrored: e1Rect/FarRight (lateral -) is on the runway's right.
  return [
    e2FarLeft,
    e2FarRight,
    e2RectRight,
    e1RectRight,
    e1FarRight,
    e1FarLeft,
    e1RectLeft,
    e2RectLeft,
    e2FarLeft, // close
  ];
}

/**
 * Generates the controlled-approach-height-band trapezoid between 7 km and 8.5 km from a strip end.
 */
export function generateRunwayHeightBandTrapezoid(
  stripEnd: GeoJSON.Position,
  alongBearingDeg: number
): [number, number][] {
  const innerLeft = offsetPoint(stripEnd, CORE_DISTANCE_M, alongBearingDeg, -CORE_FAR_HALF_WIDTH_M);
  const innerRight = offsetPoint(stripEnd, CORE_DISTANCE_M, alongBearingDeg, CORE_FAR_HALF_WIDTH_M);
  const outerRight = offsetPoint(stripEnd, HEIGHT_BAND_END_M, alongBearingDeg, HEIGHT_BAND_FAR_HALF_WIDTH_M);
  const outerLeft = offsetPoint(stripEnd, HEIGHT_BAND_END_M, alongBearingDeg, -HEIGHT_BAND_FAR_HALF_WIDTH_M);

  return [innerLeft, innerRight, outerRight, outerLeft, innerLeft];
}

/**
 * Generates vector diagonal hatch lines crossing a height band trapezoid (between 7 km and 8.5 km).
 * Lines are angled diagonally (~45°) across the corridor and spaced regularly.
 */
export function generateHeightBandHatchLines(
  stripEnd: GeoJSON.Position,
  alongBearingDeg: number,
  stepM = 250
): Array<[[number, number], [number, number]]> {
  const lines: Array<[[number, number], [number, number]]> = [];
  const uMin = CORE_DISTANCE_M;
  const uMax = HEIGHT_BAND_END_M;

  // In local (u, v) coordinates: u along centreline (7000..8500), v lateral offset (-w(u)..w(u)).
  // Diagonal lines: u - v = c
  // Range of c: (uMin - w(uMin)) to (uMax + w(uMax))
  const cMin = uMin - CORE_FAR_HALF_WIDTH_M;
  const cMax = uMax + HEIGHT_BAND_FAR_HALF_WIDTH_M;

  for (let c = cMin + stepM; c < cMax; c += stepM) {
    // Intersect the line u - v = c (i.e. v = u - c) with the 4 trapezoid edges:
    // 1. Inner: u = uMin => v = uMin - c
    // 2. Outer: u = uMax => v = uMax - c
    // 3. Right edge: v = +(STRIP_HALF_WIDTH_M + u * TAN_15_DEG) => u - c = STRIP_HALF_WIDTH_M + u * TAN_15_DEG
    //    => u * (1 - TAN_15_DEG) = c + STRIP_HALF_WIDTH_M => u = (c + STRIP_HALF_WIDTH_M) / (1 - TAN_15_DEG)
    // 4. Left edge: v = -(STRIP_HALF_WIDTH_M + u * TAN_15_DEG) => u - c = -STRIP_HALF_WIDTH_M - u * TAN_15_DEG
    //    => u * (1 + TAN_15_DEG) = c - STRIP_HALF_WIDTH_M => u = (c - STRIP_HALF_WIDTH_M) / (1 + TAN_15_DEG)

    const candidates: Array<[number, number]> = [];

    // Edge 1: u = uMin
    const vInner = uMin - c;
    if (Math.abs(vInner) <= CORE_FAR_HALF_WIDTH_M + 1) {
      candidates.push([uMin, vInner]);
    }

    // Edge 2: u = uMax
    const vOuter = uMax - c;
    if (Math.abs(vOuter) <= HEIGHT_BAND_FAR_HALF_WIDTH_M + 1) {
      candidates.push([uMax, vOuter]);
    }

    // Edge 3: right edge
    const uRight = (c + STRIP_HALF_WIDTH_M) / (1 - TAN_15_DEG);
    if (uRight >= uMin && uRight <= uMax) {
      const vRight = STRIP_HALF_WIDTH_M + uRight * TAN_15_DEG;
      candidates.push([uRight, vRight]);
    }

    // Edge 4: left edge
    const uLeft = (c - STRIP_HALF_WIDTH_M) / (1 + TAN_15_DEG);
    if (uLeft >= uMin && uLeft <= uMax) {
      const vLeft = -(STRIP_HALF_WIDTH_M + uLeft * TAN_15_DEG);
      candidates.push([uLeft, vLeft]);
    }

    // Deduplicate candidate points
    const validPoints: Array<[number, number]> = [];
    for (const [u, v] of candidates) {
      if (!validPoints.some(([eu, ev]) => Math.abs(eu - u) < 5 && Math.abs(ev - v) < 5)) {
        validPoints.push([u, v]);
      }
    }

    if (validPoints.length === 2) {
      const p1 = offsetPoint(stripEnd, validPoints[0][0], alongBearingDeg, validPoints[0][1]);
      const p2 = offsetPoint(stripEnd, validPoints[1][0], alongBearingDeg, validPoints[1][1]);
      lines.push([p1, p2]);
    }
  }

  return lines;
}

/**
 * Generates all planning markings for a single runway with explicit threshold endpoints.
 */
export function generateRunwayPlanningMarkings(
  runway: RunwayThresholdPair,
  airport: RunwayAirportContext
): RunwayPlanningFeatures {
  const [t1, t2] = runway.endpoints;
  const bearing = initialBearing(t1, t2);
  const revBearing = (bearing + 180) % 360;
  const s1 = destinationPoint(t1, STRIP_END_EXTENSION_M, revBearing);
  const s2 = destinationPoint(t2, STRIP_END_EXTENSION_M, bearing);

  const baseProps = {
    airportId: airport.airportId,
    airportName: airport.airportName,
    icaoCode: airport.icaoCode,
    runwayId: runway.runwayId || runway.designator,
    runwayDesignator: runway.designator,
    authority: 'provider_context',
    controlled: airport.controlled === true,
  };

  // 1. 3 NM measurement buffer
  const bufferRing = generateRunway3nmBuffer(t1, t2);
  const bufferFeature: GeoJSON.Feature<GeoJSON.Polygon> = {
    type: 'Feature',
    id: `${airport.airportId}-${runway.runwayId || runway.designator}-3nm-buffer`,
    properties: {
      ...baseProps,
      kind: 'controlled-3nm-measurement-buffer',
      bufferRadiusM: CONTROLLED_3NM_BUFFER_METRES,
      geometryDerivation: 'Threshold-centreline approximation of CASR 101.238(d)(v) 3 NM runway measurement-point buffer',
      geometryVersion: '2020-08-rectified-mos-4.05',
      lawReference: 'CASR 101.238(d)(v)',
      disclaimer: 'Advisory threshold-derived planning buffer — not clearance. Conditions depend on aircraft weight/category, height and permissions; verify current authoritative aerodrome data.',
    },
    geometry: {
      type: 'Polygon',
      coordinates: [bufferRing],
    },
  };

  // 2. Approach core
  const coreRing = generateRunwayApproachCore(t1, t2);
  const coreFeature: GeoJSON.Feature<GeoJSON.Polygon> = {
    type: 'Feature',
    id: `${airport.airportId}-${runway.runwayId || runway.designator}-approach-core`,
    properties: {
      ...baseProps,
      kind: 'controlled-approach-core',
      coreDistanceM: CORE_DISTANCE_M,
      maxSplayWidthM: Math.round(CORE_FAR_HALF_WIDTH_M * 2),
      rectangleHalfWidthM: RECTANGLE_HALF_WIDTH_M,
      geometryDerivation: 'Threshold-derived approximation of CASA Part 101 MOS s 4.05 controlled-aerodrome approach/departure core',
      geometryVersion: '2020-08-rectified-mos-4.05',
      lawReference: 'CASR Part 101 MOS s 4.05',
      disclaimer: 'Advisory threshold-derived approach/departure corridor — not clearance. Applicability depends on aircraft category, height and permissions; verify current authoritative aerodrome data.',
    },
    geometry: {
      type: 'Polygon',
      coordinates: [coreRing],
    },
  };

  // 3. Height band polygons (End 2 and End 1)
  const hbFeatures: GeoJSON.Feature<GeoJSON.Polygon>[] = [];
  const hbRing2 = generateRunwayHeightBandTrapezoid(s2, bearing);
  const hbRing1 = generateRunwayHeightBandTrapezoid(s1, revBearing);

  const hbDisclaimer = 'Advisory threshold-derived height-aware band (7 km to 8.5 km from threshold). Rules may apply from 90 m (300 ft) above aerodrome elevation; verify current authoritative aerodrome data.';

  hbFeatures.push({
    type: 'Feature',
    id: `${airport.airportId}-${runway.runwayId || runway.designator}-height-band-end2`,
    properties: {
      ...baseProps,
      kind: 'controlled-approach-height-band',
      endIndex: 2,
      startDistanceM: CORE_DISTANCE_M,
      endDistanceM: HEIGHT_BAND_END_M,
      heightBand: '90m/300ft height-aware band',
      geometryDerivation: 'CASA Part 101 MOS Section 4.05(2)(b)(ii) controlled-aerodrome crosshatched height band (90 m / 300 ft above aerodrome)',
      geometryVersion: '2020-08-rectified-mos-4.05',
      lawReference: 'CASR Part 101 MOS s 4.05(2)(b)(ii)',
      disclaimer: hbDisclaimer,
    },
    geometry: {
      type: 'Polygon',
      coordinates: [hbRing2],
    },
  });

  hbFeatures.push({
    type: 'Feature',
    id: `${airport.airportId}-${runway.runwayId || runway.designator}-height-band-end1`,
    properties: {
      ...baseProps,
      kind: 'controlled-approach-height-band',
      endIndex: 1,
      startDistanceM: CORE_DISTANCE_M,
      endDistanceM: HEIGHT_BAND_END_M,
      heightBand: '90m/300ft height-aware band',
      geometryDerivation: 'CASA Part 101 MOS Section 4.05(2)(b)(ii) controlled-aerodrome crosshatched height band (90 m / 300 ft above aerodrome)',
      geometryVersion: '2020-08-rectified-mos-4.05',
      lawReference: 'CASR Part 101 MOS s 4.05(2)(b)(ii)',
      disclaimer: hbDisclaimer,
    },
    geometry: {
      type: 'Polygon',
      coordinates: [hbRing1],
    },
  });

  // 4. Diagonal hatch lines for each height band
  const hatchLines2 = generateHeightBandHatchLines(s2, bearing);
  const hatchLines1 = generateHeightBandHatchLines(s1, revBearing);
  const hatchFeatures: GeoJSON.Feature<GeoJSON.LineString>[] = [];

  let hatchIdx = 0;
  for (const line of [...hatchLines2, ...hatchLines1]) {
    hatchFeatures.push({
      type: 'Feature',
      id: `${airport.airportId}-${runway.runwayId || runway.designator}-hatch-${hatchIdx++}`,
      properties: {
        ...baseProps,
        kind: 'controlled-approach-height-band-hatch',
        heightBand: '90m/300ft height-aware band',
      },
      geometry: {
        type: 'LineString',
        coordinates: line,
      },
    });
  }

  const allFeatures: GeoJSON.Feature[] = [
    bufferFeature,
    coreFeature,
    ...hbFeatures,
    ...hatchFeatures,
  ];

  return {
    buffer3nm: { type: 'FeatureCollection', features: [bufferFeature] },
    approachCore: { type: 'FeatureCollection', features: [coreFeature] },
    approachHeightBand: { type: 'FeatureCollection', features: hbFeatures },
    heightBandHatch: { type: 'FeatureCollection', features: hatchFeatures },
    allFeatures: { type: 'FeatureCollection', features: allFeatures },
  };
}

/**
 * Generates combined runway markings for an airport with multiple runways.
 * Preserves all runways and overlaps without collapsing to an airport-centre circle.
 */
export function generateAirportRunwayMarkings(
  runways: RunwayThresholdPair[],
  airport: RunwayAirportContext
): RunwayPlanningFeatures {
  const allBuffers: GeoJSON.Feature<GeoJSON.Polygon>[] = [];
  const allCores: GeoJSON.Feature<GeoJSON.Polygon>[] = [];
  const allHeightBands: GeoJSON.Feature<GeoJSON.Polygon>[] = [];
  const allHatches: GeoJSON.Feature<GeoJSON.LineString>[] = [];

  for (const rwy of runways) {
    if (!rwy.endpoints || rwy.endpoints.length < 2) continue;
    const markings = generateRunwayPlanningMarkings(rwy, airport);
    allBuffers.push(...markings.buffer3nm.features);
    allCores.push(...markings.approachCore.features);
    allHeightBands.push(...markings.approachHeightBand.features);
    allHatches.push(...markings.heightBandHatch.features);
  }

  const allFeatures: GeoJSON.Feature[] = [
    ...allBuffers,
    ...allCores,
    ...allHeightBands,
    ...allHatches,
  ];

  return {
    buffer3nm: { type: 'FeatureCollection', features: allBuffers },
    approachCore: { type: 'FeatureCollection', features: allCores },
    approachHeightBand: { type: 'FeatureCollection', features: allHeightBands },
    heightBandHatch: { type: 'FeatureCollection', features: allHatches },
    allFeatures: { type: 'FeatureCollection', features: allFeatures },
  };
}
