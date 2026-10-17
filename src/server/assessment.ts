import type {
  DroneEvidence,
  DroneEvidenceSource,
  DroneSeverity,
  DroneAssessmentResult,
} from './types.js';
import type { OpenAipAirspace, OpenAipAirport } from './openaip.js';

export interface DroneAssessmentInput {
  evidence?: DroneEvidence[];
  notChecked?: DroneEvidence[];
  pilotChecklist?: DroneEvidence[];
  stale?: boolean;
  now?: Date | string;
}

const SEVERITY_PRECEDENCE: Record<DroneSeverity, number> = {
  restriction: 1,
  caution: 2,
  not_checked: 3,
  pilot_responsibility: 4,
  info: 5,
};

export interface NotamProvider {
  name: string;
  configured: boolean;
  fetchNotams?(bounds: { lat: number; lng: number; radiusM: number }): Promise<DroneEvidence[]>;
}

export const notamProviderSlot: { provider: NotamProvider | null } = {
  provider: null,
};

export function createDefaultNotCheckedGates(): DroneEvidence[] {
  return [
    {
      id: 'gate-notam',
      category: 'notam',
      severity: 'not_checked',
      authority: 'unknown',
      title: 'NOTAMs',
      explanation:
        'Not checked — obtain current official aviation notices and temporary flight restrictions before flight.',
      source: { name: 'No authoritative provider configured' },
      userAction: 'Review official NAIPS / NOTAM briefing for tactical airspace activations.',
    },
    {
      id: 'gate-emergency',
      category: 'emergency',
      severity: 'not_checked',
      authority: 'unknown',
      title: 'Non-fire emergency operations',
      explanation:
        'Not checked — emergency operations (police, search and rescue, disaster response) may be underway; confirm with local sources.',
      source: { name: 'No authoritative provider configured' },
      userAction: 'Check local emergency broadcaster and do not operate near active emergency scenes.',
    },
  ];
}

export function createDefaultPilotChecklist(): DroneEvidence[] {
  return [
    {
      id: 'checklist-vlos',
      category: 'operator',
      severity: 'pilot_responsibility',
      authority: 'legislation',
      ruleId: 'casr-101-073',
      title: 'Visual line of sight (VLOS)',
      explanation:
        'The remote pilot must maintain direct visual contact with the RPA without visual aids other than corrective lenses.',
      source: { name: 'CASR 101.073' },
      userAction: 'Maintain direct unaided visual contact with aircraft throughout flight.',
    },
    {
      id: 'checklist-max-height',
      category: 'operator',
      severity: 'pilot_responsibility',
      authority: 'legislation',
      ruleId: 'casr-101-085',
      title: 'Maximum height (400 ft AGL / 120 m)',
      explanation:
        'Standard RPA operations must remain at or below 400 ft (120 m) above ground level.',
      source: { name: 'CASR 101.085' },
      userAction: 'Plan flight ceiling strictly at or below 400 ft (120 m) above ground level.',
    },
    {
      id: 'checklist-separation',
      category: 'operator',
      severity: 'pilot_responsibility',
      authority: 'legislation',
      ruleId: 'casr-101-245',
      title: '30 m separation from uninvolved people',
      explanation:
        'The remote pilot must maintain at least 30 metres horizontal separation from people not directly involved.',
      source: { name: 'CASR 101.245' },
      userAction: 'Establish and monitor minimum 30 m horizontal perimeter from uninvolved bystanders.',
    },
    {
      id: 'checklist-populous',
      category: 'operator',
      severity: 'pilot_responsibility',
      authority: 'legislation',
      ruleId: 'casr-101-245',
      title: 'Populous area evaluation',
      explanation:
        'Do not operate over populous areas where equipment failure could endanger persons or property.',
      source: { name: 'CASR 101.245, 101.025' },
      userAction: 'Conduct on-site evaluation of ground hazards, population density, and contingency landing paths.',
    },
    {
      id: 'checklist-hazard',
      category: 'operator',
      severity: 'pilot_responsibility',
      authority: 'legislation',
      ruleId: 'casr-101-055',
      title: 'Hazardous operation prevention',
      explanation:
        'An operation must not be conducted in a way that creates a hazard to other aircraft, persons, or property.',
      source: { name: 'CASR 101.055' },
      userAction: 'Review flight plan to ensure no hazard is created to aircraft, persons, or property.',
    },
    {
      id: 'checklist-landowner',
      category: 'operator',
      severity: 'pilot_responsibility',
      authority: 'product_policy',
      title: 'Landowner and site access',
      explanation:
        'Aviation rules do not grant property access; take-off and landing requires landowner/occupier permission.',
      source: { name: 'PhotoScout Pilot Checklist' },
      userAction: 'Obtain launch and recovery permission from landowner or managing authority.',
    },
    {
      id: 'checklist-weather',
      category: 'weather',
      severity: 'pilot_responsibility',
      authority: 'legislation',
      ruleId: 'casr-101-095',
      title: 'Daylight visual meteorological conditions',
      explanation:
        'Standard operations must be in daylight and visual meteorological conditions, remaining clear of cloud.',
      source: { name: 'CASR 101.095' },
      userAction: 'Confirm daylight conditions, sufficient visibility, and separation from clouds.',
    },
  ];
}

export function airspaceToEvidence(
  airspace: OpenAipAirspace,
  source: DroneEvidenceSource
): DroneEvidence {
  const typeName = (airspace.typeName || '').toUpperCase();
  const isRestriction = typeName === 'RESTRICTED' || typeName === 'PROHIBITED';

  if (isRestriction) {
    return {
      id: `airspace-${airspace.id}`,
      category: 'airspace',
      severity: 'restriction',
      authority: 'legislation',
      ruleId: 'casr-101-065',
      title: `${typeName} Airspace: ${airspace.name}`,
      explanation: `OpenAIP mapped ${typeName.toLowerCase()} airspace. Verify current status and operating hours with official aviation publications before planning flight.`,
      geometry: airspace.geometry,
      source,
      userAction:
        'Verify current status with official aviation publications and obtain controlling authority permission if required.',
    };
  }

  return {
    id: `airspace-${airspace.id}`,
    category: 'airspace',
    severity: 'caution',
    authority: 'provider_context',
    ruleId: 'casr-101-065',
    title: `Airspace Caution: ${airspace.name} (${typeName})`,
    explanation: `OpenAIP mapped ${typeName.toLowerCase()} airspace context. Review vertical limits and airspace classification.`,
    geometry: airspace.geometry,
    source,
    userAction: 'Review operating limits and airspace classification before flight.',
  };
}

export function fireIncidentToEvidence(
  incident: {
    id: string;
    title: string;
    category?: string;
    status?: string;
    updated?: string;
    geometry?: GeoJSON.Geometry;
  },
  source: DroneEvidenceSource
): DroneEvidence {
  return {
    id: `fire-${incident.id}`,
    category: 'fire',
    severity: 'restriction',
    authority: 'legislation',
    ruleId: 'casr-101-238-e',
    title: `Active Fire Operation: ${incident.title}`,
    explanation: `Emergency firefighting operation reported by NSW RFS (${incident.status || 'Active'}). CASR 101.238(e) prohibits flight over emergency operations without permission from the person in charge.`,
    geometry: incident.geometry,
    source,
    userAction:
      'Do not launch near active fire emergency operations without permission from the incident controller.',
  };
}

export function populousCautionToEvidence(details: {
  reason?: string;
  indicators?: string[];
}): DroneEvidence {
  return {
    id: 'caution-populous',
    category: 'population',
    severity: 'caution',
    authority: 'regulator_guidance',
    ruleId: 'casr-101-245',
    title: 'Likely populous area / people exposure',
    explanation: `Environmental context indicates potential people or property exposure (${details.reason || 'built-up area'}). Statutory populous-area manual assessment required by pilot.`,
    source: { name: 'PhotoScout Population Heuristic' },
    userAction:
      'Conduct on-site manual assessment of people, populous area risk, and maintain minimum 30 m separation.',
  };
}

export function aerodromeToEvidence(
  airport: OpenAipAirport & {
    controlledBuffer?: GeoJSON.Geometry;
    outsidePlannedRadius?: boolean;
    distanceM?: number;
  },
  source: DroneEvidenceSource,
  options?: {
    plannedRadiusM?: number;
  }
): DroneEvidence {
  const isOutside = airport.outsidePlannedRadius === true;
  const distKm = airport.distanceM != null ? (airport.distanceM / 1000).toFixed(1) : undefined;
  const radiusKm = options?.plannedRadiusM != null ? Math.round(options.plannedRadiusM / 1000) : undefined;

  if (airport.controlled === true) {
    const title = isOutside
      ? `Controlled aerodrome proximity (outside planned radius): ${airport.name}`
      : `Controlled aerodrome proximity: ${airport.name}`;

    let explanation: string;
    let userAction: string;

    if (airport.runwayGeometryUnavailable) {
      explanation = isOutside
        ? `Closest mapped aerodrome in provider search area (${distKm ?? '–'} km away, outside planned ${radiusKm ?? '–'} km flight radius). Verified controlled aerodrome (${airport.icaoCode || 'ICAO'}). Runway geometry unavailable — verify current aerodrome data. Do not operate towards this aerodrome without confirming CASA conditions.`
        : `Verified controlled aerodrome (${airport.icaoCode || 'ICAO'}). Runway geometry unavailable — verify current aerodrome data. Runway threshold coordinates not supplied by provider; 3 NM centreline buffer and approach paths cannot be derived. Confirm applicable CASA conditions and verify current aerodrome data before flight.`;
      userAction =
        'Verify current aerodrome boundaries, movement areas, and approach/departure corridors in Airservices Australia publications before flight.';
    } else {
      explanation = isOutside
        ? `Closest mapped aerodrome in provider search area (${distKm ?? '–'} km away, outside planned ${radiusKm ?? '–'} km flight radius). Verified controlled aerodrome (${airport.icaoCode || 'ICAO'}). 3 NM planning buffer does not intersect the planned flight radius. Do not operate towards this aerodrome without confirming CASA conditions.`
        : `Verified controlled aerodrome (${airport.icaoCode || 'ICAO'}). A 3 NM planning buffer is shown because standard conditions can depend on aircraft category, including the 250 g threshold, and any applicable permission or exemption. Confirm the CASA condition that applies to this operation before flight.`;
      userAction = isOutside
        ? 'Advisory context: monitor for traffic if extending flight boundaries and confirm controlled-aerodrome conditions before operating within 3 NM.'
        : 'Confirm aircraft category/weight, approval status, and applicable controlled-aerodrome conditions before operating within 3 NM.';
    }

    return {
      id: `airport-${airport.id}`,
      category: 'airport',
      severity: 'caution',
      authority: 'legislation',
      ruleId: 'casr-101-075',
      title,
      explanation,
      geometry: airport.geometry,
      source,
      userAction,
      ...(isOutside ? { outsidePlannedRadius: true } : {}),
    };
  }

  const title = isOutside
    ? `Aerodrome proximity (outside planned radius): ${airport.name}`
    : `Aerodrome proximity: ${airport.name}`;
  const explanation = isOutside
    ? `Closest mapped aerodrome in provider search area (${distKm ?? '–'} km away, outside planned ${radiusKm ?? '–'} km flight radius; openAIP provider bounds, not a globally exhaustive search). Pilot must check for aircraft movements and approach/departure corridors.`
    : `Aerodrome or landing site nearby (${airport.icaoCode || 'advisory context'}). Pilot must check for aircraft movement and approach/departure paths.`;
  const userAction = isOutside
    ? 'Advisory context: monitor for aircraft traffic if operating towards this aerodrome.'
    : 'Check for aerodrome traffic and avoid approach and departure paths.';

  return {
    id: `airport-${airport.id}`,
    category: 'airport',
    severity: 'caution',
    authority: 'provider_context',
    ruleId: 'casr-101-075',
    title,
    explanation,
    geometry: airport.geometry,
    source,
    userAction,
    ...(isOutside ? { outsidePlannedRadius: true } : {}),
  };
}

export function weatherContextToEvidence(details: {
  windKmh?: number | null;
  gustKmh?: number | null;
  visibilityM?: number | null;
  cloudPct?: number | null;
  tempC?: number | null;
  failed?: boolean;
}): DroneEvidence {
  if (details.failed) {
    return {
      id: 'weather-not-checked',
      category: 'weather',
      severity: 'not_checked',
      authority: 'unknown',
      ruleId: 'casr-101-095',
      title: 'Weather awareness context',
      explanation:
        'Weather forecast feed unavailable. Pilot must check current weather and confirm daylight visual meteorological conditions.',
      source: { name: 'Open-Meteo' },
      userAction: 'Check local weather conditions and verify visual line of sight conditions before launch.',
    };
  }

  const gust = details.gustKmh != null ? Math.round(details.gustKmh) : null;
  const wind = details.windKmh != null ? Math.round(details.windKmh) : null;
  const vis = details.visibilityM != null ? Math.round(details.visibilityM) : null;

  const isWindy = (gust != null && gust >= 35) || (wind != null && wind >= 30);
  const isLowVis = vis != null && vis < 5000;

  if (isWindy || isLowVis) {
    const reasons: string[] = [];
    if (isWindy) reasons.push(`wind ${wind ?? '–'} km/h with gusts to ${gust ?? '–'} km/h`);
    if (isLowVis) reasons.push(`reduced visibility (${vis} m)`);

    return {
      id: 'caution-weather',
      category: 'weather',
      severity: 'caution',
      authority: 'regulator_guidance',
      ruleId: 'casr-101-095',
      title: 'Weather conditions context',
      explanation: `Forecast indicates ${reasons.join(', ')}. Pilot must confirm daylight visual meteorological conditions and aircraft limits before flight.`,
      source: { name: 'Open-Meteo Weather' },
      userAction: 'Confirm conditions are within manufacturer operating limits and CASR 101.095 daylight VMC.',
    };
  }

  return {
    id: 'info-weather',
    category: 'weather',
    severity: 'info',
    authority: 'regulator_guidance',
    ruleId: 'casr-101-095',
    title: 'Weather awareness context',
    explanation: `Forecast indicates wind ${wind ?? '–'} km/h, visibility ${vis != null ? `${vis} m` : 'adequate'}. Operational context only — pilot must confirm on-site visual meteorological conditions.`,
    source: { name: 'Open-Meteo Weather' },
    userAction: 'Confirm daylight and visual meteorological conditions at launch site.',
  };
}

export function aircraftContextToEvidence(details: {
  count?: number;
  closest?: { hex: string; flight?: string; alt_baro?: number | null; distanceM?: number } | null;
  nearby?: Array<{ hex: string; flight?: string; alt_baro?: number | null; distanceM?: number }>;
  failed?: boolean;
}): DroneEvidence {
  if (details.failed) {
    return {
      id: 'aircraft-not-checked',
      category: 'aircraft',
      severity: 'not_checked',
      authority: 'unknown',
      ruleId: 'casr-101-055',
      title: 'Aircraft activity context',
      explanation:
        'Live aircraft feed unavailable. Remote pilot must maintain continuous visual scan for all aircraft.',
      source: { name: 'ADS-B Aircraft Feed' },
      userAction: 'Maintain continuous visual and listening watch for manned aircraft.',
    };
  }

  const count = details.count ?? 0;
  const closest = details.closest;

  if (count > 0 && closest) {
    const distKm = closest.distanceM != null ? (closest.distanceM / 1000).toFixed(1) : undefined;
    const distText = distKm != null ? `${distKm} km away` : '';
    const altText = closest.alt_baro != null ? `${closest.alt_baro} ft` : 'altitude unknown';
    const ident = closest.flight ? `${closest.flight.trim()} (${closest.hex})` : closest.hex;

    return {
      id: 'caution-aircraft',
      category: 'aircraft',
      severity: 'caution',
      authority: 'provider_context',
      ruleId: 'casr-101-055',
      title: 'Nearby aircraft activity context',
      explanation: `${count} aircraft broadcasting ADS-B detected. Closest: ${ident} at ${distText}, ${altText}. Awareness context only: pilot must maintain continuous visual and listening watch. Incomplete coverage: non-broadcast aircraft or aircraft below receiver line-of-sight are not detected.`,
      source: { name: 'ADS-B Aircraft Feed' },
      userAction: 'Maintain continuous visual and listening watch; give way to all manned aircraft.',
    };
  } else if (count > 0) {
    return {
      id: 'caution-aircraft',
      category: 'aircraft',
      severity: 'caution',
      authority: 'provider_context',
      ruleId: 'casr-101-055',
      title: 'Nearby aircraft activity context',
      explanation: `${count} aircraft broadcasting ADS-B detected in vicinity. Awareness context only: pilot must maintain continuous visual scan. Incomplete coverage: non-broadcast aircraft or aircraft below receiver coverage are not detected.`,
      source: { name: 'ADS-B Aircraft Feed' },
      userAction: 'Maintain continuous visual and listening watch; give way to all manned aircraft.',
    };
  }

  return {
    id: 'info-aircraft',
    category: 'aircraft',
    severity: 'info',
    authority: 'provider_context',
    ruleId: 'casr-101-055',
    title: 'Aircraft activity context',
    explanation:
      'No broadcast ADS-B aircraft detected in provider coverage. Incomplete coverage: aircraft without broadcast ADS-B Out or operating below receiver line-of-sight are not detected; pilot must maintain continuous visual and listening scan.',
    source: { name: 'ADS-B Aircraft Feed' },
    userAction: 'Maintain continuous visual and listening scan for non-broadcast aircraft.',
  };
}

export function evaluateDroneAssessment(
  input: DroneAssessmentInput
): DroneAssessmentResult {
  const evidenceList = [...(input.evidence ?? [])];
  evidenceList.sort((a, b) => SEVERITY_PRECEDENCE[a.severity] - SEVERITY_PRECEDENCE[b.severity]);

  const defaultGates = createDefaultNotCheckedGates();
  const gateMap = new Map<string, DroneEvidence>();
  for (const g of defaultGates) gateMap.set(g.id, g);
  for (const g of input.notChecked ?? []) gateMap.set(g.id, g);
  const notChecked = Array.from(gateMap.values());

  const pilotChecklist = input.pilotChecklist ?? createDefaultPilotChecklist();

  const hasRestriction = evidenceList.some((e) => e.severity === 'restriction');
  const hasCaution = evidenceList.some((e) => e.severity === 'caution');

  let overallSeverity: DroneSeverity;
  let summary: string;

  if (hasRestriction) {
    overallSeverity = 'restriction';
    summary =
      'Mapped restriction identified — verify conditions and permissions with controlling authority';
  } else if (hasCaution) {
    overallSeverity = 'caution';
    summary = 'Mapped caution identified — pilot risk assessment required';
  } else if (notChecked.length > 0) {
    overallSeverity = 'not_checked';
    summary = 'No mapped restriction found — pilot checks still required';
  } else {
    overallSeverity = 'info';
    summary = 'No mapped restriction found — pilot checks still required';
  }

  const isStale =
    input.stale === true || evidenceList.some((e) => e.source?.stale === true);

  const evaluatedAt =
    input.now instanceof Date
      ? input.now.toISOString()
      : typeof input.now === 'string'
        ? input.now
        : new Date().toISOString();

  return {
    overallSeverity,
    summary,
    evidence: evidenceList,
    notChecked,
    pilotChecklist,
    stale: isStale,
    evaluatedAt,
  };
}
