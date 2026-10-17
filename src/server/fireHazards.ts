import buffer from '@turf/buffer';
import type { FireIncident } from './sources.js';
import type { DroneEvidence, DroneEvidenceSource } from './types.js';

export const DRONE_FIRE_BUFFER_METRES = 2000;
export const DRONE_FIRE_POLICY_ID = 'photoscout-fire-hazard-2km-v1';
export const DRONE_FIRE_POLICY_DISCLAIMER =
  'Modelled fire-operation hazard buffer — do not launch; emergency approval may be required.';

export interface DroneFireHazard {
  id: string;
  title: string;
  category: string;
  status: string;
  sizeHa?: number;
  updated: string;
  link?: string;
  sourceGeometry: GeoJSON.Geometry;
  bufferGeometry: GeoJSON.Geometry;
  bufferMetres: number;
  bufferPolicyId: string;
  disclaimer: string;
}

export function createDroneFireBuffer(
  geometry: GeoJSON.Geometry,
  bufferMetres = DRONE_FIRE_BUFFER_METRES
): GeoJSON.Geometry | null {
  if (!geometry || typeof geometry !== 'object') return null;

  try {
    if (geometry.type === 'GeometryCollection') {
      const bufferedGeoms: GeoJSON.Geometry[] = [];
      for (const g of geometry.geometries) {
        const buffered = createDroneFireBuffer(g, bufferMetres);
        if (buffered) {
          if (buffered.type === 'GeometryCollection') {
            bufferedGeoms.push(...buffered.geometries);
          } else {
            bufferedGeoms.push(buffered);
          }
        }
      }
      if (bufferedGeoms.length === 0) return null;
      return {
        type: 'GeometryCollection',
        geometries: bufferedGeoms,
      };
    }

    const feature = buffer(geometry as any, bufferMetres, { units: 'meters' });
    if (!feature) return null;

    if ('geometry' in feature && feature.geometry) {
      return feature.geometry as GeoJSON.Geometry;
    }

    if ('features' in feature && Array.isArray(feature.features)) {
      const geoms = feature.features
        .map((f: any) => f.geometry)
        .filter(Boolean) as GeoJSON.Geometry[];
      if (geoms.length === 0) return null;
      if (geoms.length === 1) return geoms[0];
      return {
        type: 'GeometryCollection',
        geometries: geoms,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export function createDroneFireHazards(
  incidents: FireIncident[],
  options?: { bufferMetres?: number }
): DroneFireHazard[] {
  const bufferMetres = options?.bufferMetres ?? DRONE_FIRE_BUFFER_METRES;
  const hazards: DroneFireHazard[] = [];

  for (const inc of incidents) {
    if (!inc.geometry) continue;

    const buf = createDroneFireBuffer(inc.geometry, bufferMetres);
    if (!buf) continue;

    hazards.push({
      id: inc.id,
      title: inc.title,
      category: inc.category,
      status: inc.status,
      sizeHa: inc.sizeHa,
      updated: inc.updated,
      link: inc.link,
      sourceGeometry: inc.geometry,
      bufferGeometry: buf,
      bufferMetres,
      bufferPolicyId: DRONE_FIRE_POLICY_ID,
      disclaimer: DRONE_FIRE_POLICY_DISCLAIMER,
    });
  }

  return hazards;
}

export function fireHazardToEvidence(
  hazard: DroneFireHazard,
  source: DroneEvidenceSource
): DroneEvidence {
  return {
    id: `fire-${hazard.id}`,
    category: 'fire',
    severity: 'restriction',
    authority: 'legislation',
    ruleId: 'casr-101-238-e',
    title: `Active Fire Operation Hazard: ${hazard.title}`,
    explanation: `Modelled fire-operation hazard zone based on NSW RFS incident reporting (${hazard.status || 'Active'}). CASR 101.238(e) restricts flight over emergency operations without permission from the person in charge. Modelled 2 km PhotoScout product-policy buffer applied; not an official aviation boundary.`,
    geometry: hazard.bufferGeometry,
    source,
    userAction:
      'Do not launch near active fire emergency operations without permission from the incident controller.',
  };
}

export function createFireNotCheckedGate(reason?: string): DroneEvidence {
  const detail = reason ? ` (${reason})` : '';
  return {
    id: 'gate-fire-status',
    category: 'fire',
    severity: 'not_checked',
    authority: 'unknown',
    title: 'Fire operation status not checked',
    explanation: `Fire emergency operation status could not be verified from current feeds${detail} — check official NSW RFS warnings before flight.`,
    source: { name: 'NSW Rural Fire Service', stale: true },
    userAction:
      'Check official NSW RFS major incidents map and local emergency broadcasts.',
  };
}
