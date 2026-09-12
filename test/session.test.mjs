import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, masteryReport } from '../src/session.js';

// a fake scorer: "good" answers master and advance; anything else stays developing
function fakeScorer({ criteria, eloIndex, answer }) {
  const mastered = /good|correct|complete|thorough/i.test(answer);
  const nextIndex = mastered ? eloIndex + 1 : eloIndex;
  const complete = mastered && nextIndex >= criteria.length;
  const score = Math.round((nextIndex / criteria.length) * 100);
  return { verdict: mastered ? 'mastered' : 'developing', feedback: mastered ? 'Well done.' : 'Not yet — try again.', mastered, complete, nextQuestion: complete ? '' : 'Next probing question.', nextEloIndex: nextIndex, score };
}

test('Session progresses criterion by criterion to completion', async () => {
  const s = new Session({ objectives: 'x', source: 'y', scorer: fakeScorer });
  // seed state directly (bypass the model-backed start)
  s.criteria = [{ elo: 'A' }, { elo: 'B' }];
  s.currentQuestion = 'Q1';
  s.transcript.push({ role: 'assistant', text: 'Q1' });

  let r = await s.answer('a weak attempt');
  assert.equal(r.verdict, 'developing');
  assert.equal(s.eloIndex, 0);         // did not advance
  assert.equal(s.complete, false);

  r = await s.answer('a good, thorough answer');
  assert.equal(r.verdict, 'mastered');
  assert.equal(s.eloIndex, 1);         // advanced to criterion B

  r = await s.answer('another good, complete answer');
  assert.equal(s.complete, true);      // both criteria mastered
  assert.equal(s.score, 100);
});

test('masteryReport summarizes per-competency', async () => {
  const s = new Session({ scorer: fakeScorer });
  s.criteria = [{ elo: 'A' }, { elo: 'B' }];
  s.results = [{ eloIndex: 0, verdict: 'mastered', score: 50 }];
  s.eloIndex = 1; s.score = 50;
  const rep = masteryReport(s);
  assert.equal(rep.criteria.length, 2);
  assert.equal(rep.criteria[0].verdict, 'mastered');
});
