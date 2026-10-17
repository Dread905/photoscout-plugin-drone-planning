import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePopulationContext,
  type PopulationContextInput,
} from '../src/server/population.js';

const BANNED_WORDS = ['\\blegal\\b', '\\bsafe\\b', '\\bapproved\\b', '\\bcleared\\b', '\\bauthorised\\b'];

function assertNoBannedWords(text: string) {
  for (const pattern of BANNED_WORDS) {
    const re = new RegExp(pattern, 'i');
    assert.ok(!re.test(text), `Text contained banned word matching ${pattern}: "${text.slice(0, 300)}"`);
  }
}

test('drone population: dense building footprint generates likely-populous caution, not restriction', () => {
  const input: PopulationContextInput = {
    buildingCount: 15,
    roadCount: 10,
    hasMajorRoads: false,
  };

  const evidence = evaluatePopulationContext(input);
  assert.equal(evidence.severity, 'caution');
  assert.equal(evidence.category, 'population');
  assert.equal(evidence.ruleId, 'casr-101-245');
  assert.equal(evidence.authority, 'regulator_guidance');
  assert.ok(evidence.title.includes('Likely people/property exposure'));
  assert.ok(evidence.explanation.includes('building'));
  assert.ok(evidence.explanation.includes('Statutory populous-area manual assessment required'));

  assertNoBannedWords(evidence.title);
  assertNoBannedWords(evidence.explanation);
  assertNoBannedWords(evidence.userAction);
});

test('drone population: major road corridor or high road count generates caution', () => {
  const input: PopulationContextInput = {
    buildingCount: 1,
    roadCount: 12,
    hasMajorRoads: true,
  };

  const evidence = evaluatePopulationContext(input);
  assert.equal(evidence.severity, 'caution');
  assert.ok(evidence.explanation.toLowerCase().includes('road'));
  assertNoBannedWords(evidence.explanation);
});

test('drone population: active nearby event generates caution', () => {
  const input: PopulationContextInput = {
    buildingCount: 2,
    roadCount: 2,
    events: [{ title: 'Bathurst Community Festival', distanceM: 300 }],
  };

  const evidence = evaluatePopulationContext(input);
  assert.equal(evidence.severity, 'caution');
  assert.ok(evidence.explanation.includes('Bathurst Community Festival'));
  assertNoBannedWords(evidence.explanation);
});

test('drone population: missing or unavailable OSM context data produces not_checked gate, never a pass', () => {
  const input: PopulationContextInput = {
    osmUnavailable: true,
  };

  const evidence = evaluatePopulationContext(input);
  assert.equal(evidence.severity, 'not_checked');
  assert.ok(evidence.title.includes('Populous') || evidence.title.includes('context'));
  assert.ok(evidence.explanation.toLowerCase().includes('not available') || evidence.explanation.toLowerCase().includes('not checked'));
  assertNoBannedWords(evidence.explanation);
});

test('drone population: low mapped density produces transparent guidance without claiming safety', () => {
  const input: PopulationContextInput = {
    buildingCount: 0,
    roadCount: 1,
    hasMajorRoads: false,
    events: [],
  };

  const evidence = evaluatePopulationContext(input);
  assert.notEqual(evidence.severity, 'restriction');
  assert.ok(evidence.explanation.toLowerCase().includes('verify'));
  assertNoBannedWords(evidence.title);
  assertNoBannedWords(evidence.explanation);
  assertNoBannedWords(evidence.userAction);
});
