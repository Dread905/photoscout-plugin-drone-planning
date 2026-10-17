import type { LocalAerodromesContextResponse } from '../server/aerodromes.js';
import type { DroneContextResponse } from '../server/context.js';

// Type-only imports from the server half: they are erased by the build, so the web bundle takes no runtime
// code from it, and the two halves cannot drift apart on the shape of a reply.
export type { DroneContextResponse, LocalAerodromesContextResponse };
export type { DroneEvidence, DroneSeverity } from '../server/types.js';

export interface LatLng {
  lat: number;
  lng: number;
}

/** Everything the corner widget and the details panel draw. */
export interface PlannerState {
  context: DroneContextResponse | null;
  aerodromes: LocalAerodromesContextResponse | null;
  loading: boolean;
  aerodromesLoading: boolean;
  error: string;
  aerodromesError: string;
  /** The dropped pin, or null to plan around the map centre. */
  point: LatLng | null;
  /** The map centre, kept for the "Drop pin here" button. */
  centre: LatLng | null;
  radiusKm: number;
  signedIn: boolean;
}

export interface PlannerStore {
  get(): PlannerState;
  subscribe(listener: () => void): () => void;
}

export interface PlannerActions {
  setRadiusKm(km: number): void;
  /** Drop the pin at a point, or clear it (null) to follow the map centre again. */
  setPoint(point: LatLng | null): void;
  refresh(): void;
  openDetails(): void;
  closeDetails(): void;
}
