import fs from 'node:fs';
import { selectAirportsForPlanning, type PlannedAirport, type PlanningAerodrome } from './spatial.js';

export interface LocalAerodromeProvenance {
  source: string;
  licence: string;
  authority: string;
  effectiveDate: string;
  sourceDate?: string;
  verifiedThresholds?: boolean;
  notes?: string;
}

export interface LocalRunwayThreshold {
  id?: string;
  designator: string;
  surface?: string | number | Record<string, unknown>;
  lengthM?: number;
  widthM?: number;
  thresholdEndpoints?: [GeoJSON.Position, GeoJSON.Position];
}

export interface LocalAerodromeRecord extends PlanningAerodrome {
  id: string;
  name: string;
  icaoCode?: string;
  iataCode?: string;
  type?: number | string;
  typeName?: string;
  controlled: boolean;
  geometry: GeoJSON.Point;
  runways?: LocalRunwayThreshold[];
  runwayGeometryUnavailable?: boolean;
  frequencies?: Array<{
    type?: string;
    frequency?: string;
    name?: string;
  }>;
  provenance: LocalAerodromeProvenance;
}

export interface AerodromeDatasetManifest {
  schemaVersion: string;
  datasetId: string;
  name: string;
  publishedAt: string;
  effectiveDate: string;
  licence: string;
  authority: string;
  records: LocalAerodromeRecord[];
}

export interface AerodromeDatasetMeta {
  datasetId: string;
  name: string;
  schemaVersion: string;
  publishedAt: string;
  effectiveDate: string;
  licence: string;
  authority: string;
  recordCount: number;
  loadedAt: string;
}

export interface AerodromeDatasetLoadResult {
  available: boolean;
  status: 'ok' | 'unavailable' | 'empty';
  message: string;
  manifest: AerodromeDatasetMeta | null;
  records: LocalAerodromeRecord[];
}

export type PlannedLocalAerodrome = PlannedAirport<LocalAerodromeRecord>;

export interface LocalAerodromesContextResponse {
  available: boolean;
  status: 'ok' | 'unavailable' | 'empty';
  message?: string;
  radiusM: number;
  aerodromes: PlannedLocalAerodrome[];
  airports: PlannedLocalAerodrome[];
  closestAirport: PlannedLocalAerodrome | null;
  closestAerodrome: PlannedLocalAerodrome | null;
  source: AerodromeDatasetMeta | null;
}

/** A finite [lng, lat] inside the world's bounds. */
function inRange(p: unknown): p is [number, number] {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
}

export function validateLocalRecord(raw: unknown): LocalAerodromeRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;

  if (typeof r.id !== 'string' || !r.id.trim()) return null;
  if (typeof r.name !== 'string' || !r.name.trim()) return null;
  if (typeof r.controlled !== 'boolean') return null;

  // Geometry validation: Point with valid coordinates [lng, lat]
  if (!r.geometry || r.geometry.type !== 'Point' || !Array.isArray(r.geometry.coordinates) || r.geometry.coordinates.length < 2) {
    return null;
  }
  const [lng, lat] = r.geometry.coordinates;
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    return null;
  }

  // Provenance validation: mandatory fields
  if (!r.provenance || typeof r.provenance !== 'object') return null;
  const p = r.provenance as Record<string, any>;
  if (typeof p.source !== 'string' || !p.source.trim()) return null;
  if (typeof p.licence !== 'string' || !p.licence.trim()) return null;
  if (typeof p.authority !== 'string' || !p.authority.trim()) return null;
  if (typeof p.effectiveDate !== 'string' || !p.effectiveDate.trim()) return null;

  // Runway threshold validation if present
  let validRunways: LocalRunwayThreshold[] | undefined = undefined;
  if (Array.isArray(r.runways)) {
    validRunways = [];
    for (const rwy of r.runways) {
      if (!rwy || typeof rwy !== 'object') continue;
      const designator = typeof rwy.designator === 'string' ? rwy.designator : 'Runway';
      let endpoints: [GeoJSON.Position, GeoJSON.Position] | undefined = undefined;
      if (Array.isArray(rwy.thresholdEndpoints) && rwy.thresholdEndpoints.length === 2) {
        const [ep1, ep2] = rwy.thresholdEndpoints;
        if (
          inRange(ep1) && inRange(ep2) && (ep1[0] !== ep2[0] || ep1[1] !== ep2[1])
        ) {
          endpoints = [[ep1[0], ep1[1]], [ep2[0], ep2[1]]];
        }
      }
      validRunways.push({
        id: typeof rwy.id === 'string' ? rwy.id : undefined,
        designator,
        surface: rwy.surface,
        lengthM: typeof rwy.lengthM === 'number' ? rwy.lengthM : undefined,
        widthM: typeof rwy.widthM === 'number' ? rwy.widthM : undefined,
        thresholdEndpoints: endpoints,
      });
    }
  }

  const provenance: LocalAerodromeProvenance = {
    source: p.source.trim(),
    licence: p.licence.trim(),
    authority: p.authority.trim(),
    effectiveDate: p.effectiveDate.trim(),
    sourceDate: typeof p.sourceDate === 'string' ? p.sourceDate.trim() : undefined,
    verifiedThresholds: Boolean(p.verifiedThresholds),
    notes: typeof p.notes === 'string' ? p.notes.trim() : undefined,
  };

  return {
    id: r.id.trim(),
    name: r.name.trim(),
    icaoCode: typeof r.icaoCode === 'string' ? r.icaoCode.trim() : undefined,
    iataCode: typeof r.iataCode === 'string' ? r.iataCode.trim() : undefined,
    type: r.type,
    typeName: typeof r.typeName === 'string' ? r.typeName.trim() : undefined,
    controlled: r.controlled,
    geometry: {
      type: 'Point',
      coordinates: [lng, lat],
    },
    runways: validRunways,
    runwayGeometryUnavailable: r.runwayGeometryUnavailable,
    frequencies: Array.isArray(r.frequencies) ? r.frequencies : undefined,
    provenance,
  };
}

/** The last dataset read, keyed by file, size and mtime, so a public route does not re-parse the file on every request. */
let loaded: { key: string; result: AerodromeDatasetLoadResult } | null = null;

/** Read the dataset at `filePath`, re-reading only when the file changed. */
export function loadLocalAerodromes(filePath: string): AerodromeDatasetLoadResult {
  let key = '';
  try {
    const st = fs.statSync(filePath);
    key = `${filePath}|${st.size}|${st.mtimeMs}`;
  } catch {
    // fall through: readLocalAerodromes reports the missing file
  }
  if (key && loaded?.key === key) return loaded.result;
  const result = readLocalAerodromes(filePath);
  loaded = key ? { key, result } : null;
  return result;
}

function readLocalAerodromes(filePath: string): AerodromeDatasetLoadResult {

  if (!fs.existsSync(filePath)) {
    return {
      available: false,
      status: 'unavailable',
      message: 'Local aerodrome dataset not installed',
      manifest: null,
      records: [],
    };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object') {
      return {
        available: false,
        status: 'unavailable',
        message: 'Invalid aerodrome dataset file structure',
        manifest: null,
        records: [],
      };
    }

    if (typeof parsed.schemaVersion !== 'string' || !parsed.schemaVersion.startsWith('1.')) {
      return {
        available: false,
        status: 'unavailable',
        message: `Unsupported aerodrome dataset schema version: ${parsed.schemaVersion}`,
        manifest: null,
        records: [],
      };
    }

    if (!Array.isArray(parsed.records)) {
      return {
        available: false,
        status: 'unavailable',
        message: 'Aerodrome dataset missing records list',
        manifest: null,
        records: [],
      };
    }

    const validRecords: LocalAerodromeRecord[] = [];
    for (const item of parsed.records) {
      const rec = validateLocalRecord(item);
      if (rec) {
        validRecords.push(rec);
      }
    }

    const manifest: AerodromeDatasetMeta = {
      datasetId: String(parsed.datasetId || 'unknown'),
      name: String(parsed.name || 'Local Aerodromes'),
      schemaVersion: parsed.schemaVersion,
      publishedAt: String(parsed.publishedAt || ''),
      effectiveDate: String(parsed.effectiveDate || ''),
      licence: String(parsed.licence || ''),
      authority: String(parsed.authority || ''),
      recordCount: validRecords.length,
      loadedAt: new Date().toISOString(),
    };

    if (validRecords.length === 0) {
      return {
        available: true,
        status: 'empty',
        message: 'Local aerodrome dataset contains 0 valid records',
        manifest,
        records: [],
      };
    }

    return {
      available: true,
      status: 'ok',
      message: `Loaded ${validRecords.length} aerodromes`,
      manifest,
      records: validRecords,
    };
  } catch (err) {
    return {
      available: false,
      status: 'unavailable',
      message: `Failed to load aerodrome dataset: ${(err as Error).message}`,
      manifest: null,
      records: [],
    };
  }
}

export function queryLocalAerodromes(params: {
  lat: number;
  lng: number;
  radiusM: number;
  /** The dataset file: <dataDir>/aerodromes.json. */
  filePath: string;
}): LocalAerodromesContextResponse {
  const { lat, lng, radiusM, filePath } = params;
  const dataset = loadLocalAerodromes(filePath);

  if (!dataset.available) {
    return {
      available: false,
      status: 'unavailable',
      message: dataset.message,
      radiusM,
      aerodromes: [],
      airports: [],
      closestAirport: null,
      closestAerodrome: null,
      source: null,
    };
  }

  if (dataset.records.length === 0) {
    return {
      available: true,
      status: dataset.status,
      message: dataset.message,
      radiusM,
      aerodromes: [],
      airports: [],
      closestAirport: null,
      closestAerodrome: null,
      source: dataset.manifest,
    };
  }

  const { airports, closestAirport } = selectAirportsForPlanning(
    dataset.records,
    lat,
    lng,
    radiusM
  );

  return {
    available: true,
    status: 'ok',
    radiusM,
    aerodromes: airports,
    airports,
    closestAirport,
    closestAerodrome: closestAirport,
    source: dataset.manifest,
  };
}
