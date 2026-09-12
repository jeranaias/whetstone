import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScore, deriveRubric, scoreTurn, LEVELS } from '../src/whetstone.js';
import { masteryReport } from '../src/session.js';

test('computeScore gives full credit per mastered criterion', () => {
  // mastered criterion 0 of 2 → advanced past 1 of 2 → 50%
  assert.equal(computeScore({ criteriaCount: 2, eloIndex: 0, verdict: 'mastered' }), 50);
  // mastered final criterion → 100%
  assert.equal(computeScore({ criteriaCount: 2, eloIndex: 1, verdict: 'mastered' }), 100);
  assert.equal(computeScore({ criteriaCount: 4, eloIndex: 3, verdict: 'mastered' }), 100);
});

test('computeScore gives partial credit for the in-progress criterion', () => {
  // developing on criterion 0 → no progress
  assert.equal(computeScore({ criteriaCount: 3, eloIndex: 0, verdict: 'developing' }), 0);
  // competent on criterion 0 of 3 → (0 + 1/3)/3 ≈ 11%
  assert.equal(computeScore({ criteriaCount: 3, eloIndex: 0, verdict: 'competent' }), 11);
  // competent on criterion 1 of 2 → (1 + 1/3)/2 ≈ 67%
  assert.equal(computeScore({ criteriaCount: 2, eloIndex: 1, verdict: 'competent' }), 67);
});

test('computeScore is defensive about bad input', () => {
  assert.equal(computeScore({ criteriaCount: 0, eloIndex: 0, verdict: 'mastered' }), 0);
  assert.equal(computeScore({ criteriaCount: -1, eloIndex: 0, verdict: 'mastered' }), 0);
  // unknown verdict counts as no partial credit, not a crash
  assert.equal(computeScore({ criteriaCount: 2, eloIndex: 0, verdict: 'nonsense' }), 0);
});

test('LEVELS is the ordered mastery scale', () => {
  assert.deepEqual(LEVELS, ['developing', 'competent', 'mastered']);
});

test('deriveRubric rejects empty objectives without a model call', async () => {
  assert.deepEqual(await deriveRubric([], 'source'), { error: 'objectives required' });
  assert.deepEqual(await deriveRubric(null, 'source'), { error: 'objectives required' });
});

test('scoreTurn rejects an empty answer without a model call', async () => {
  const criteria = [{ elo: 'A', indicators: {} }];
  assert.deepEqual(await scoreTurn({ criteria, eloIndex: 0, answer: '', source: 's' }), { error: 'answer required' });
  assert.deepEqual(await scoreTurn({ criteria, eloIndex: 0, answer: '   ', source: 's' }), { error: 'answer required' });
});

test('scoreTurn validates criteria shape', async () => {
  await assert.rejects(() => scoreTurn({ criteria: [], eloIndex: 0, answer: 'x', source: 's' }), TypeError);
});

test('masteryReport labels assessed, implied, and pending competencies', () => {
  const session = {
    complete: false,
    score: 50,
    eloIndex: 2,
    criteria: [{ elo: 'A' }, { elo: 'B' }, { elo: 'C' }],
    // A was explicitly scored; B has no result but is behind eloIndex → implied mastered; C pending
    results: [{ eloIndex: 0, verdict: 'competent', score: 20 }, { eloIndex: 0, verdict: 'mastered', score: 33 }],
    transcript: [{}, {}, {}],
  };
  const rep = masteryReport(session);
  assert.equal(rep.complete, false);
  assert.equal(rep.score, 50);
  assert.equal(rep.exchanges, 3);
  assert.equal(rep.criteria.length, 3);
  assert.equal(rep.criteria[0].competency, 'A');
  assert.equal(rep.criteria[0].verdict, 'mastered');       // uses the LAST result for that index
  assert.equal(rep.criteria[1].verdict, 'mastered');       // behind eloIndex → implied
  assert.equal(rep.criteria[2].verdict, 'not yet assessed');
});

test('masteryReport tolerates a bare/empty session', () => {
  const rep = masteryReport({});
  assert.deepEqual(rep, { complete: false, score: 0, criteria: [], exchanges: 0 });
});
