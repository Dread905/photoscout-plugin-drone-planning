import { test } from 'node:test';
import assert from 'node:assert/strict';

// Import target under test (will fail until implemented)
import {
  RULE_CATALOG,
  getRule,
  getAllRules,
  validateRuleFreshness,
  type DroneRule,
} from '../src/server/ruleCatalog.js';

const BANNED_CONCLUSION_REGEX = /\b(safe|legal|approved|cleared|authorised|authorized)\b/i;

test('drone rule catalogue: contains valid, versioned Australian CASR rules', () => {
  const rules = getAllRules();
  assert.ok(rules.length >= 9, 'should catalog all required CASR Part 101 provisions');

  const validAuthorities = new Set([
    'legislation',
    'regulator_guidance',
    'provider_context',
    'product_policy',
    'unknown',
  ]);

  const seenIds = new Set<string>();

  for (const rule of rules) {
    // Stable ID
    assert.ok(rule.id && typeof rule.id === 'string', `rule id must be non-empty string, got ${rule.id}`);
    assert.ok(!seenIds.has(rule.id), `duplicate rule id: ${rule.id}`);
    seenIds.add(rule.id);

    // Provision / source identifier
    assert.ok(rule.provision && typeof rule.provision === 'string', `rule ${rule.id} missing provision`);

    // Title
    assert.ok(rule.title && typeof rule.title === 'string', `rule ${rule.id} missing title`);

    // Authority classification
    assert.ok(
      validAuthorities.has(rule.authority),
      `rule ${rule.id} has invalid authority: ${rule.authority}`
    );

    // Checked and reviewBy dates (ISO format YYYY-MM-DD)
    assert.match(
      rule.checkedDate,
      /^\d{4}-\d{2}-\d{2}$/,
      `rule ${rule.id} checkedDate must be YYYY-MM-DD`
    );
    assert.match(
      rule.reviewBy,
      /^\d{4}-\d{2}-\d{2}$/,
      `rule ${rule.id} reviewBy must be YYYY-MM-DD`
    );
    assert.ok(
      Date.parse(rule.reviewBy) >= Date.parse(rule.checkedDate),
      `rule ${rule.id} reviewBy must be >= checkedDate`
    );

    // Explanation
    assert.ok(
      rule.explanation && rule.explanation.length > 20,
      `rule ${rule.id} explanation must be descriptive`
    );

    // Machine-readable input requirements
    assert.ok(
      Array.isArray(rule.requiredInputs) && rule.requiredInputs.length > 0,
      `rule ${rule.id} must specify machine-readable requiredInputs`
    );
    for (const input of rule.requiredInputs) {
      assert.ok(typeof input === 'string' && input.length > 0);
    }

    // No conclusion wording such as legal, safe, approved, or cleared
    assert.ok(
      !BANNED_CONCLUSION_REGEX.test(rule.title),
      `rule ${rule.id} title contains banned conclusion language: ${rule.title}`
    );
    assert.ok(
      !BANNED_CONCLUSION_REGEX.test(rule.explanation),
      `rule ${rule.id} explanation contains banned conclusion language: ${rule.explanation}`
    );
  }
});

test('drone rule catalogue: required CASR Part 101 rules exist by stable ID', () => {
  const expectedIds = [
    'casr-101-055',
    'casr-101-065',
    'casr-101-073',
    'casr-101-075',
    'casr-101-085',
    'casr-101-095',
    'casr-101-238',
    'casr-101-245',
    'casr-101-238-e',
  ];

  for (const id of expectedIds) {
    const rule = getRule(id);
    assert.ok(rule, `expected rule ${id} to exist`);
    assert.equal(rule.id, id);
  }

  assert.equal(getRule('non-existent-rule'), undefined);
});

test('drone rule catalogue: validateRuleFreshness flags expired review dates', () => {
  const freshRule: DroneRule = {
    id: 'test-fresh',
    provision: 'TEST 1.0',
    title: 'Test Rule',
    authority: 'legislation',
    checkedDate: '2026-10-01',
    reviewBy: '2027-01-01',
    explanation: 'Test explanation with no banned terms.',
    requiredInputs: ['pilot_confirmation'],
  };

  const nowBefore = new Date('2026-11-01T00:00:00Z');
  const nowAfter = new Date('2027-02-01T00:00:00Z');

  assert.equal(validateRuleFreshness(freshRule, nowBefore), true);
  assert.equal(validateRuleFreshness(freshRule, nowAfter), false);
});
