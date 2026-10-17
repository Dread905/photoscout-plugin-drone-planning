import type { DroneRule, DroneAuthority } from './types.js';

export type { DroneRule, DroneAuthority };

export const RULE_CATALOG: readonly DroneRule[] = Object.freeze([
  {
    id: 'casr-101-055',
    provision: 'CASR 101.055',
    title: 'Hazardous operation prohibition',
    authority: 'legislation',
    checkedDate: '2026-10-13',
    reviewBy: '2027-04-01',
    explanation:
      'The remote pilot must not operate an aircraft in a way that creates a hazard to another aircraft, another person, or property. This is an overarching pilot operating duty rather than a geometry check.',
    requiredInputs: ['pilot_confirmation'],
    sourceRef: 'Civil Aviation Safety Regulations 1998, reg 101.055',
  },
  {
    id: 'casr-101-065',
    provision: 'CASR 101.065',
    title: 'Prohibited and restricted airspace',
    authority: 'legislation',
    checkedDate: '2026-10-13',
    reviewBy: '2027-04-01',
    explanation:
      'Operating in prohibited or restricted airspace requires permission from the controlling authority. Mapped airspace geometry provides advisory planning context to verify current status with official sources.',
    requiredInputs: ['airspace_geometry', 'pilot_confirmation'],
    sourceRef: 'Civil Aviation Safety Regulations 1998, reg 101.065',
  },
  {
    id: 'casr-101-073',
    provision: 'CASR 101.073',
    title: 'Visual line of sight requirement',
    authority: 'legislation',
    checkedDate: '2026-10-13',
    reviewBy: '2027-04-01',
    explanation:
      'The remote pilot must keep the aircraft within direct visual line of sight at all times, without visual aids other than corrective lenses.',
    requiredInputs: ['pilot_confirmation'],
    sourceRef: 'Civil Aviation Safety Regulations 1998, reg 101.073',
  },
  {
    id: 'casr-101-075',
    provision: 'CASR 101.075 / 101.080',
    title: 'Aerodrome movement areas and runways',
    authority: 'legislation',
    checkedDate: '2026-10-13',
    reviewBy: '2027-04-01',
    explanation:
      'Operating over movement areas, runways, or approach and departure paths of an aerodrome requires permission or specific operator conditions. Verified aerodrome geometry informs proximity checks.',
    requiredInputs: ['aerodrome_geometry', 'pilot_confirmation'],
    sourceRef: 'Civil Aviation Safety Regulations 1998, reg 101.075, 101.080',
  },
  {
    id: 'casr-101-085',
    provision: 'CASR 101.085',
    title: 'Maximum operating height 400 ft AGL',
    authority: 'legislation',
    checkedDate: '2026-10-13',
    reviewBy: '2027-04-01',
    explanation:
      'Standard RPA operations must remain at or below 400 ft (120 m) above ground level unless explicit exemptions or permissions apply.',
    requiredInputs: ['flight_altitude_plan', 'pilot_confirmation'],
    sourceRef: 'Civil Aviation Safety Regulations 1998, reg 101.085',
  },
  {
    id: 'casr-101-095',
    provision: 'CASR 101.095',
    title: 'Daylight and visual conditions',
    authority: 'legislation',
    checkedDate: '2026-10-13',
    reviewBy: '2027-04-01',
    explanation:
      'Standard RPA operations must be conducted in daylight and visual meteorological conditions, remaining clear of cloud, unless specific night flight permissions apply.',
    requiredInputs: ['weather_context', 'pilot_confirmation'],
    sourceRef: 'Civil Aviation Safety Regulations 1998, reg 101.095',
  },
  {
    id: 'casr-101-238',
    provision: 'CASR 101.238',
    title: 'Standard RPA operating conditions baseline',
    authority: 'legislation',
    checkedDate: '2026-10-13',
    reviewBy: '2027-04-01',
    explanation:
      'Baseline statutory conditions governing standard RPA flights, encompassing visual line of sight, maximum altitude, distance from people, aerodromes, and emergency operations.',
    requiredInputs: ['operating_conditions_checklist'],
    sourceRef: 'Civil Aviation Safety Regulations 1998, reg 101.238',
  },
  {
    id: 'casr-101-245',
    provision: 'CASR 101.245 / 101.280',
    title: 'Separation from people and populous areas',
    authority: 'legislation',
    checkedDate: '2026-10-13',
    reviewBy: '2027-04-01',
    explanation:
      'The remote pilot must maintain at least 30 metres horizontal distance from people not directly involved, and must not operate over populous areas where equipment failure could endanger persons or property.',
    requiredInputs: ['population_density_context', 'pilot_confirmation'],
    sourceRef: 'Civil Aviation Safety Regulations 1998, reg 101.245, 101.280, 101.025',
  },
  {
    id: 'casr-101-238-e',
    provision: 'CASR 101.238(e)',
    title: 'Emergency operations and public safety',
    authority: 'legislation',
    checkedDate: '2026-10-13',
    reviewBy: '2027-04-01',
    explanation:
      'The remote pilot must not operate over an area where emergency operations (fire, police, or rescue) are being conducted without permission from the person in charge of the emergency operation.',
    requiredInputs: ['emergency_incident_geometry', 'pilot_confirmation'],
    sourceRef: 'Civil Aviation Safety Regulations 1998, reg 101.238(e)',
  },
]);

const RULE_MAP = new Map<string, DroneRule>(RULE_CATALOG.map((r) => [r.id, r]));

export function getRule(id: string): DroneRule | undefined {
  return RULE_MAP.get(id);
}

export function getAllRules(): readonly DroneRule[] {
  return RULE_CATALOG;
}

export function validateRuleFreshness(rule: DroneRule, referenceDate: Date = new Date()): boolean {
  const reviewTime = Date.parse(rule.reviewBy);
  if (Number.isNaN(reviewTime)) return false;
  return referenceDate.getTime() <= reviewTime;
}

export interface RuleCatalogStatus {
  /** The most recent `checkedDate` among the rules. */
  checkedDate: string;
  /** The earliest `reviewBy` among the rules. */
  reviewBy: string;
  /** True once any rule is past its `reviewBy` date. The original never checked this at run time. */
  stale: boolean;
}

/** How fresh the encoded rules are, for the response, so the panel can say when they are overdue for review. */
export function ruleCatalogStatus(now: Date = new Date()): RuleCatalogStatus {
  const checked = RULE_CATALOG.map((r) => r.checkedDate).sort();
  const review = RULE_CATALOG.map((r) => r.reviewBy).sort();
  return {
    checkedDate: checked[checked.length - 1] ?? '',
    reviewBy: review[0] ?? '',
    stale: RULE_CATALOG.some((r) => !validateRuleFreshness(r, now)),
  };
}
