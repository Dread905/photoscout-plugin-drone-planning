import {
  aerodromeToEvidence,
  aircraftContextToEvidence,
  airspaceToEvidence,
  evaluateDroneAssessment,
  weatherContextToEvidence,
} from './assessment.js';
import { createDroneFireHazards, createFireNotCheckedGate, fireHazardToEvidence, type DroneFireHazard } from './fireHazards.js';
import type { LocalAerodromesContextResponse } from './aerodromes.js';
import { fetchOpenAipContext, MAX_RADIUS_M, type OpenAipAirport, type OpenAipAirspace, type OpenAipKv, type OpenAipSourceMeta } from './openaip.js';
import { evaluatePopulationContext } from './population.js';
import { ruleCatalogStatus, type RuleCatalogStatus } from './ruleCatalog.js';
import {
  fetchBuildingCount,
  fetchPlanes,
  fetchRfs,
  fetchWeatherNow,
  isLikelyNsw,
  type FetchFn,
} from './sources.js';
import { filterAirspacesByRadius, filterFireHazardsByRadius, findClosestAircraft, selectAirportsForPlanning } from './spatial.js';
import type { DroneAssessmentResult, DroneEvidence, DroneEvidenceSource } from './types.js';

export interface ContextRequest {
  lat: number;
  lng: number;
  radiusM: number;
}

export interface ContextDeps {
  fetchFn: FetchFn;
  kv?: OpenAipKv;
  /** The OpenAIP key, or empty when the admin has not set one. */
  openAipKey?: string | null;
  /** The local aerodrome dataset around the same point and radius, so its aerodromes count towards the verdict. */
  local?: LocalAerodromesContextResponse;
  now?: () => number;
}

export interface DroneContextResponse {
  configured: boolean;
  message?: string;
  radiusM: number;
  airspaces: OpenAipAirspace[];
  airports: Array<OpenAipAirport & { distanceM?: number; outsidePlannedRadius?: boolean }>;
  fireHazards: DroneFireHazard[];
  weather?: { windKmh: number | null; gustKmh: number | null; visibilityM: number | null; tempC: number | null; cloudPct: number | null };
  aircraft?: {
    count: number;
    closest?: { hex: string; flight?: string; alt_baro?: number | null; distanceM?: number } | null;
    nearby: Array<{ hex: string; flight?: string; alt_baro?: number | null; distanceM?: number }>;
  };
  population?: { buildingCount: number; indicators: string[] };
  /** How fresh the encoded CASR rules are; `stale` once a rule is past its review date. */
  rules: RuleCatalogStatus;
  assessment: DroneAssessmentResult;
  sources: {
    rfs?: { fetchedAt: string; stale: boolean; attribution: string };
    weather?: { fetchedAt: string; attribution: string };
    aircraft?: { fetchedAt: string; attribution: string };
    openaip?: OpenAipSourceMeta;
  };
}

export class QueryError extends Error {}

const num = (raw: unknown): number | null => {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Read lat, lng and radiusM from a query. The original did `Number(req.query.lat)`, which turns an empty
 * `?lat=&lng=` into 0, 0 (an ocean point) and an array (`?lat=1&lat=2`) into NaN; both are rejected here.
 */
export function parseContextQuery(query: Record<string, unknown>, defaultRadiusM = 5000): ContextRequest {
  const lat = num(query.lat);
  const lng = num(query.lng);
  if (lat == null || lng == null) throw new QueryError('lat and lng query parameters are required');
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new QueryError('lat must be between -90 and 90, lng between -180 and 180');
  let radiusM = defaultRadiusM;
  if (query.radiusM != null) {
    const r = num(query.radiusM);
    if (r == null || r <= 0 || r > MAX_RADIUS_M) throw new QueryError(`radiusM must be a positive number up to ${MAX_RADIUS_M}`);
    radiusM = r;
  }
  return { lat, lng, radiusM };
}


/** The whole planning context for one point and radius: every source, the evidence and the assessment. */
export async function buildDroneContext(deps: ContextDeps, req: ContextRequest): Promise<DroneContextResponse> {
  const { lat, lng, radiusM } = req;
  const { fetchFn } = deps;
  const now = deps.now ?? Date.now;

  // 1. Fire hazards from the NSW RFS feed (NSW only: say so elsewhere)
  let fireHazards: DroneFireHazard[] = [];
  const fireEvidence: DroneEvidence[] = [];
  let rfsMeta: { fetchedAt: string; stale: boolean; attribution: string } | undefined;
  if (!isLikelyNsw(lat, lng)) {
    fireEvidence.push(createFireNotCheckedGate('outside NSW; the RFS feed covers New South Wales only'));
  } else {
    try {
      const rfs = await fetchRfs(fetchFn);
      fireHazards = filterFireHazardsByRadius(createDroneFireHazards(rfs.incidents), lat, lng, radiusM);
      const source: DroneEvidenceSource = { name: 'NSW Rural Fire Service', fetchedAt: rfs.fetchedAt, stale: rfs.stale };
      rfsMeta = { fetchedAt: rfs.fetchedAt, stale: rfs.stale, attribution: 'Data provided by NSW Rural Fire Service (CC BY 4.0)' };
      fireEvidence.push(...fireHazards.map((h) => fireHazardToEvidence(h, source)));
      if (rfs.stale) fireEvidence.push(createFireNotCheckedGate('RFS feed data is stale'));
    } catch {
      fireEvidence.push(createFireNotCheckedGate('Feed unavailable'));
    }
  }

  // 2. Population context from mapped buildings
  let populationEvidence: DroneEvidence;
  let population: { buildingCount: number; indicators: string[] } | undefined;
  try {
    const buildingCount = await fetchBuildingCount(fetchFn, lat, lng, 350);
    populationEvidence = evaluatePopulationContext({ buildingCount });
    population = { buildingCount, indicators: [] };
  } catch {
    populationEvidence = evaluatePopulationContext({ osmUnavailable: true });
  }

  // 3. Weather now
  let weatherEvidence: DroneEvidence;
  let weather: { windKmh: number | null; gustKmh: number | null; visibilityM: number | null; tempC: number | null; cloudPct: number | null } | undefined;
  let weatherMeta: { fetchedAt: string; attribution: string } | undefined;
  try {
    const w = await fetchWeatherNow(fetchFn, lat, lng);
    weatherEvidence = weatherContextToEvidence(w.weather);
    weather = {
      windKmh: w.weather.windKmh,
      gustKmh: w.weather.gustKmh,
      visibilityM: w.weather.visibilityM,
      tempC: w.weather.tempC,
      cloudPct: w.weather.cloudPct,
    };
    weatherMeta = { fetchedAt: w.weather.observedAt ?? w.fetchedAt, attribution: 'Weather provided by Open-Meteo (CC BY 4.0)' };
  } catch {
    weatherEvidence = weatherContextToEvidence({ failed: true });
  }

  // 4. Aircraft awareness (ADS-B)
  let aircraftEvidence: DroneEvidence;
  let aircraft:
    | {
        count: number;
        closest?: { hex: string; flight?: string; alt_baro?: number | null; distanceM?: number } | null;
        nearby: Array<{ hex: string; flight?: string; alt_baro?: number | null; distanceM?: number }>;
      }
    | undefined;
  let aircraftMeta: { fetchedAt: string; attribution: string } | undefined;
  try {
    const planes = await fetchPlanes(fetchFn, lat, lng, 15);
    const { closest, sorted } = findClosestAircraft(planes as never, lat, lng);
    const slim = (p: { hex: string; flight?: string; alt_baro?: number | null; distanceM?: number }) => ({
      hex: p.hex,
      flight: p.flight,
      alt_baro: p.alt_baro,
      distanceM: p.distanceM,
    });
    aircraftEvidence = aircraftContextToEvidence({ count: planes.length, closest, nearby: sorted.map(slim) });
    aircraft = { count: planes.length, closest: closest ? slim(closest) : null, nearby: sorted.slice(0, 5).map(slim) };
    aircraftMeta = { fetchedAt: new Date(now()).toISOString(), attribution: 'Live aircraft positions via ADS-B (awareness context only)' };
  } catch {
    aircraftEvidence = aircraftContextToEvidence({ failed: true });
  }

  // Aerodromes from the local dataset count towards the verdict too. The original drew their zones on the map
  // but never fed them to the assessment, so without an OpenAIP key a point inside a drawn 3 NM zone read
  // "no mapped restriction found".
  const local = deps.local?.available ? deps.local.airports : [];
  const localSource: DroneEvidenceSource = {
    name: `Local aerodrome dataset: ${deps.local?.source?.name ?? 'aerodromes.json'}`,
    fetchedAt: deps.local?.source?.loadedAt,
  };
  const localEvidence = local.map((a) => aerodromeToEvidence(a, localSource, { plannedRadiusM: radiusM }));
  const localIcao = new Set(local.map((a) => a.icaoCode).filter((c): c is string => Boolean(c)));

  const contextEvidence = [...localEvidence, populationEvidence, weatherEvidence, aircraftEvidence];
  const rules = ruleCatalogStatus(new Date(now()));
  const common = {
    radiusM,
    fireHazards,
    weather,
    aircraft,
    population,
    rules,
  };
  const sources = { rfs: rfsMeta, weather: weatherMeta, aircraft: aircraftMeta };

  // 5. OpenAIP airspace and airports, with the admin's key
  const openAip = await fetchOpenAipContext({
    apiKey: deps.openAipKey,
    kv: deps.kv,
    lat,
    lng,
    radiusM,
    fetchFn: deps.fetchFn as typeof fetch,
    now,
  });

  if (openAip.status === 'not_configured') {
    return {
      ...common,
      configured: false,
      message: openAip.message,
      airspaces: [],
      airports: [],
      assessment: evaluateDroneAssessment({ evidence: [...fireEvidence, ...contextEvidence], now: new Date(now()) }),
      sources,
    };
  }

  if (openAip.status === 'error') {
    return {
      ...common,
      configured: true,
      message: openAip.error,
      airspaces: [],
      airports: [],
      assessment: evaluateDroneAssessment({ evidence: [...fireEvidence, ...contextEvidence], stale: true, now: new Date(now()) }),
      sources,
    };
  }

  const openAipSource: DroneEvidenceSource = {
    name: 'openAIP Core API',
    fetchedAt: openAip.source.fetchedAt,
    expiresAt: openAip.source.expiresAt,
    stale: openAip.source.stale,
  };

  const airspaces = filterAirspacesByRadius(openAip.data.airspaces, lat, lng, radiusM);
  const { airports } = selectAirportsForPlanning(openAip.data.airports, lat, lng, radiusM);

  const evidence: DroneEvidence[] = [
    ...airspaces.map((a) => airspaceToEvidence(a, openAipSource)),
    ...airports
      .filter((a) => !a.icaoCode || !localIcao.has(a.icaoCode))
      .map((a) => aerodromeToEvidence(a, openAipSource, { plannedRadiusM: radiusM })),
    ...fireEvidence,
    ...contextEvidence,
  ];
  if (openAip.source.truncated) {
    evidence.push({
      id: 'gate-openaip-truncated',
      category: 'airspace',
      severity: 'not_checked',
      authority: 'unknown',
      title: 'Airspace list incomplete',
      explanation: 'OpenAIP had more airspace or aerodrome records for this area than were read, so the map may be missing some. Zoom in or reduce the planned flight radius.',
      source: openAipSource,
      userAction: 'Check official aviation publications for airspace the map does not show.',
    });
  }

  return {
    ...common,
    configured: true,
    airspaces,
    airports,
    assessment: evaluateDroneAssessment({
      evidence,
      stale: openAip.source.stale || (rfsMeta?.stale ?? false),
      now: new Date(now()),
    }),
    sources: { ...sources, openaip: openAip.source },
  };
}
