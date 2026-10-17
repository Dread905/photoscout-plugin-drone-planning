export type DroneSeverity =
  | 'restriction'
  | 'caution'
  | 'not_checked'
  | 'pilot_responsibility'
  | 'info';

export type DroneAuthority =
  | 'legislation'
  | 'regulator_guidance'
  | 'provider_context'
  | 'product_policy'
  | 'unknown';

export interface DroneRule {
  id: string;
  provision: string;
  title: string;
  authority: DroneAuthority;
  checkedDate: string;
  reviewBy: string;
  explanation: string;
  requiredInputs: readonly string[];
  sourceRef?: string;
}

export interface DroneEvidenceSource {
  name: string;
  fetchedAt?: string;
  expiresAt?: string;
  stale?: boolean;
  url?: string;
}

export interface DroneEvidence {
  id: string;
  category:
    | 'airspace'
    | 'airport'
    | 'fire'
    | 'population'
    | 'notam'
    | 'emergency'
    | 'weather'
    | 'aircraft'
    | 'operator';
  severity: DroneSeverity;
  authority: DroneAuthority;
  ruleId?: string;
  title: string;
  explanation: string;
  geometry?: GeoJSON.Geometry;
  source: DroneEvidenceSource;
  userAction: string;
  /** Set on an aerodrome whose mapped zones lie outside the planned flight circle (it is shown as the closest one). */
  outsidePlannedRadius?: boolean;
}

export interface DroneAssessmentResult {
  overallSeverity: DroneSeverity;
  summary: string;
  evidence: DroneEvidence[];
  notChecked: DroneEvidence[];
  pilotChecklist: DroneEvidence[];
  stale?: boolean;
  evaluatedAt: string;
}
