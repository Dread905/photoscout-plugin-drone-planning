import type { DroneEvidence } from './types.js';

export interface PopulationContextInput {
  buildingCount?: number;
  roadCount?: number;
  hasMajorRoads?: boolean;
  events?: Array<{ title: string; distanceM?: number }>;
  osmUnavailable?: boolean;
}

export function evaluatePopulationContext(
  input: PopulationContextInput
): DroneEvidence {
  if (input.osmUnavailable === true) {
    return {
      id: 'population-not-checked',
      category: 'population',
      severity: 'not_checked',
      authority: 'unknown',
      ruleId: 'casr-101-245',
      title: 'Populous area context',
      explanation:
        'Ground context data (buildings and roads) not available for this location. Remote pilot must manually assess whether area is populous under CASR 101.025.',
      source: { name: 'PhotoScout Population Heuristic' },
      userAction:
        'Conduct on-site manual assessment of people, building density, and populous area risk before flight.',
    };
  }

  const indicators: string[] = [];

  const buildingCount = input.buildingCount ?? 0;
  if (buildingCount > 0) {
    indicators.push(`${buildingCount} building${buildingCount === 1 ? '' : 's'} mapped in vicinity`);
  }

  if (input.hasMajorRoads) {
    indicators.push('major traffic corridor / arterial road detected');
  } else if ((input.roadCount ?? 0) >= 8) {
    indicators.push(`dense road network (${input.roadCount} road segments)`);
  }

  if (input.events && input.events.length > 0) {
    const eventNames = input.events.map((e) => e.title).join(', ');
    indicators.push(`active public/community event nearby: ${eventNames}`);
  }

  const isPopulousLikely =
    buildingCount >= 5 ||
    Boolean(input.hasMajorRoads) ||
    (input.roadCount ?? 0) >= 8 ||
    (input.events && input.events.length > 0);

  if (isPopulousLikely) {
    const details = indicators.length > 0 ? indicators.join('; ') : 'dense built-up area';
    return {
      id: 'caution-populous',
      category: 'population',
      severity: 'caution',
      authority: 'regulator_guidance',
      ruleId: 'casr-101-245',
      title: 'Likely people/property exposure',
      explanation: `Environmental context indicates potential people or property exposure (${details}). Statutory populous-area manual assessment required by pilot.`,
      source: { name: 'PhotoScout Population Heuristic' },
      userAction:
        'Conduct on-site manual assessment of people, populous area risk, and maintain minimum 30 m separation.',
    };
  }

  return {
    id: 'info-population',
    category: 'population',
    severity: 'info',
    authority: 'regulator_guidance',
    ruleId: 'casr-101-245',
    title: 'Low mapped building density',
    explanation:
      'Low mapped building and road footprint density detected in mapped context. Remote pilot must still verify on-site that people are not present and 30 m separation can be maintained.',
    source: { name: 'PhotoScout Population Heuristic' },
    userAction:
      'Verify on-site that no gatherings or uninvolved people are within 30 m before launching.',
  };
}
