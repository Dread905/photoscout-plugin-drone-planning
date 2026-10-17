import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateDroneAssessment,
  createDefaultNotCheckedGates,
  createDefaultPilotChecklist,
  airspaceToEvidence,
  fireIncidentToEvidence,
  populousCautionToEvidence,
  aerodromeToEvidence,
  weatherContextToEvidence,
  aircraftContextToEvidence,
  notamProviderSlot,
  type DroneAssessmentInput,
} from '../src/server/assessment.js';
import type { DroneEvidence, DroneSeverity } from '../src/server/types.js';

const BANNED_WORDS_REGEX = /\b(safe|legal|approved|cleared|authorised|authorized)\b/i;

function assertNoBannedWords(obj: unknown, path = ''): void {
  if (typeof obj === 'string') {
    assert.ok(
      !BANNED_WORDS_REGEX.test(obj),
      `Found banned word in ${path}: "${obj}"`
    );
  } else if (Array.isArray(obj)) {
    obj.forEach((item, index) => assertNoBannedWords(item, `${path}[${index}]`));
  } else if (obj && typeof obj === 'object') {
    for (const [key, val] of Object.entries(obj)) {
      assertNoBannedWords(val, `${path}.${key}`);
    }
  }
}

test('drone assessment: prohibited or restricted airspace becomes restriction with "verify current status", not "illegal"', () => {
  const restrictedAirspace = {
    id: 'openaip-r123',
    name: 'R559 BATHURST',
    type: 0,
    typeName: 'RESTRICTED',
    geometry: {
      type: 'Polygon' as const,
      coordinates: [[[149.5, -33.5], [149.6, -33.5], [149.6, -33.4], [149.5, -33.4], [149.5, -33.5]]],
    },
  };

  const evidence = airspaceToEvidence(restrictedAirspace, {
    name: 'OpenAIP',
    fetchedAt: '2026-10-13T12:00:00Z',
    stale: false,
  });

  assert.equal(evidence.severity, 'restriction');
  assert.equal(evidence.ruleId, 'casr-101-065');
  assert.ok(evidence.explanation.toLowerCase().includes('verify current status'));
  assert.ok(!evidence.explanation.toLowerCase().includes('illegal'));

  const result = evaluateDroneAssessment({ evidence: [evidence] });
  assert.equal(result.overallSeverity, 'restriction');
  assert.equal(result.evidence.length, 1);
  assertNoBannedWords(result);
});

test('drone assessment: missing NOTAM data always produces not_checked gate, never green or pass', () => {
  // Empty input (no mapped restrictions or cautions)
  const result = evaluateDroneAssessment({});

  assert.equal(result.overallSeverity, 'not_checked');
  assert.ok(result.summary.includes('No mapped restriction found — pilot checks still required'));

  const notamGate = result.notChecked.find((e) => e.category === 'notam');
  assert.ok(notamGate, 'NOTAM gate must be present in notChecked');
  assert.equal(notamGate.severity, 'not_checked');
  assert.ok(notamGate.explanation.toLowerCase().includes('official'));

  const emergencyGate = result.notChecked.find((e) => e.category === 'emergency');
  assert.ok(emergencyGate, 'Other emergency operations gate must be present');
  assert.equal(emergencyGate.severity, 'not_checked');

  assertNoBannedWords(result);
});

test('drone assessment: fire and emergency operation becomes restriction citing rule casr-101-238-e', () => {
  const incident = {
    id: 'rfs-incident-42',
    title: 'Bushfire - Mount Panorama',
    category: 'Emergency Warning',
    status: 'Out of Control',
    updated: '2026-10-13T10:00:00Z',
    geometry: { type: 'Point' as const, coordinates: [149.55, -33.45] },
  };

  const evidence = fireIncidentToEvidence(incident, {
    name: 'NSW Rural Fire Service',
    fetchedAt: '2026-10-13T10:05:00Z',
    stale: false,
  });

  assert.equal(evidence.severity, 'restriction');
  assert.equal(evidence.ruleId, 'casr-101-238-e');
  assert.ok(evidence.userAction.toLowerCase().includes('emergency'));

  const result = evaluateDroneAssessment({ evidence: [evidence] });
  assert.equal(result.overallSeverity, 'restriction');
  assertNoBannedWords(result);
});

test('drone assessment: likely-populous result remains caution and requires manual pilot assessment', () => {
  const evidence = populousCautionToEvidence({
    reason: 'Dense building footprint and road corridor nearby',
    indicators: ['buildings', 'traffic_corridor'],
  });

  assert.equal(evidence.severity, 'caution');
  assert.equal(evidence.ruleId, 'casr-101-245');
  assert.ok(evidence.explanation.toLowerCase().includes('manual assessment required'));

  const result = evaluateDroneAssessment({ evidence: [evidence] });
  assert.equal(result.overallSeverity, 'caution');
  assertNoBannedWords(result);
});

test('drone assessment: aerodrome handling distinguishes controlled from uncontrolled/unknown', () => {
  // Verified controlled aerodrome
  const controlledAirport = aerodromeToEvidence(
    {
      id: 'apt-1',
      name: 'Sydney Kingsford Smith',
      icaoCode: 'YSSY',
      controlled: true,
      geometry: { type: 'Point', coordinates: [151.17, -33.94] },
    },
    { name: 'OpenAIP' }
  );

  // Aircraft category/weight and approval facts are not known to the app, so a
  // controlled-aerodrome buffer is a conditional warning rather than a blanket
  // restriction. The pilot must confirm which CASA condition applies.
  assert.equal(controlledAirport.severity, 'caution');
  assert.ok(controlledAirport.title.includes('Controlled aerodrome'));
  assert.equal(controlledAirport.ruleId, 'casr-101-075');
  assert.ok(controlledAirport.explanation.includes('250 g'));
  assert.ok(controlledAirport.explanation.toLowerCase().includes('category'));

  // Uncontrolled / unknown status airport
  const uncontrolledAirport = aerodromeToEvidence(
    {
      id: 'apt-2',
      name: 'Bathurst Aerodrome',
      icaoCode: 'YBTH',
      controlled: false,
      geometry: { type: 'Point', coordinates: [149.65, -33.41] },
    },
    { name: 'OpenAIP' }
  );

  assert.equal(uncontrolledAirport.severity, 'caution');
  assert.ok(uncontrolledAirport.title.includes('Aerodrome proximity'));

  assertNoBannedWords(controlledAirport);
  assertNoBannedWords(uncontrolledAirport);
});

test('drone assessment: stale source data surfaces explicit stale caution', () => {
  const staleAirspace = airspaceToEvidence(
    {
      id: 'openaip-d1',
      name: 'D538 SINGLETON',
      type: 1, // DANGER
      typeName: 'DANGER',
      geometry: { type: 'Point', coordinates: [151.0, -32.5] },
    },
    {
      name: 'OpenAIP',
      fetchedAt: '2026-10-12T00:00:00Z',
      stale: true,
    }
  );

  const result = evaluateDroneAssessment({ evidence: [staleAirspace] });
  assert.equal(result.stale, true);
  const staleEvidence = result.evidence.find((e) => e.source.stale === true);
  assert.ok(staleEvidence, 'stale evidence item must be tagged stale');
  assertNoBannedWords(result);
});

test('drone assessment: default pilot responsibility checklist contains all required manual items', () => {
  const checklist = createDefaultPilotChecklist();
  assert.ok(checklist.length >= 6, 'must contain at least 6 checklist items');

  const categories = checklist.map((c) => c.category);
  assert.ok(categories.includes('operator'));

  for (const item of checklist) {
    assert.equal(item.severity, 'pilot_responsibility');
    assert.ok(item.userAction && item.userAction.length > 10);
  }

  assertNoBannedWords(checklist);
});

test('drone assessment: evaluation output never produces banned conclusion words', () => {
  const allSeverities: DroneSeverity[] = ['restriction', 'caution', 'not_checked', 'pilot_responsibility', 'info'];

  const testEvidence: DroneEvidence[] = [
    {
      id: 'test-1',
      category: 'airspace',
      severity: 'caution',
      authority: 'provider_context',
      title: 'Airspace caution',
      explanation: 'Airspace advisory notification without clearance.',
      source: { name: 'Test' },
      userAction: 'Check operating limits before flight.',
    },
  ];

  const result = evaluateDroneAssessment({ evidence: testEvidence });
  assertNoBannedWords(result);
});

test('drone assessment: weatherContextToEvidence handles high winds, low visibility, and feed failure without claiming safety', () => {
  const windy = weatherContextToEvidence({ windKmh: 25, gustKmh: 42, visibilityM: 10000 });
  assert.equal(windy.severity, 'caution');
  assert.equal(windy.ruleId, 'casr-101-095');
  assert.ok(windy.explanation.includes('wind'));
  assertNoBannedWords(windy);

  const lowVis = weatherContextToEvidence({ windKmh: 10, gustKmh: 15, visibilityM: 3000 });
  assert.equal(lowVis.severity, 'caution');
  assert.ok(lowVis.explanation.includes('visibility'));
  assertNoBannedWords(lowVis);

  const normal = weatherContextToEvidence({ windKmh: 12, gustKmh: 18, visibilityM: 10000 });
  assert.equal(normal.severity, 'info');
  assertNoBannedWords(normal);

  const failed = weatherContextToEvidence({ failed: true });
  assert.equal(failed.severity, 'not_checked');
  assert.ok(failed.explanation.includes('unavailable'));
  assertNoBannedWords(failed);
});

test('drone assessment: aircraftContextToEvidence handles nearby traffic, clear sky, and feed failure without claiming clearance', () => {
  const traffic = aircraftContextToEvidence({ count: 2, nearby: [{ hex: '7c0001' }] });
  assert.equal(traffic.severity, 'caution');
  assert.equal(traffic.ruleId, 'casr-101-055');
  assert.ok(traffic.explanation.includes('2 aircraft'));
  assert.ok(traffic.explanation.includes('Incomplete coverage'));
  assertNoBannedWords(traffic);

  const clear = aircraftContextToEvidence({ count: 0, nearby: [] });
  assert.equal(clear.severity, 'info');
  assert.ok(clear.explanation.includes('Incomplete coverage'));
  assertNoBannedWords(clear);

  const failed = aircraftContextToEvidence({ failed: true });
  assert.equal(failed.severity, 'not_checked');
  assert.ok(failed.explanation.includes('unavailable'));
  assertNoBannedWords(failed);
});

test('drone assessment: notamProviderSlot provides interface slot for future authoritative NOTAM provider', () => {
  assert.equal(typeof notamProviderSlot, 'object');
  assert.equal(notamProviderSlot.provider, null);
});
