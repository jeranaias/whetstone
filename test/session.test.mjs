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

test('start() runs offline with injected deriveRubric/firstQuestion and progresses to mastery', async () => {
  const deriveRubric = async () => ({ criteria: [{ elo: 'A' }, { elo: 'B' }] });
  const firstQuestion = async (criteria) => ({ question: `Explain ${criteria[0].elo}`, eloIndex: 0 });
  const s = new Session({ objectives: 'o', source: 'src', deriveRubric, firstQuestion, scorer: fakeScorer });
  const q0 = await s.start();
  assert.match(q0, /Explain A/);
  await s.answer('a weak attempt');            // developing → stays on A
  assert.equal(s.eloIndex, 0);
  await s.answer('a good, thorough answer');   // master A → B
  assert.equal(s.eloIndex, 1);
  const last = await s.answer('a good, complete answer'); // master B → complete
  assert.equal(last.complete, true);
  assert.equal(s.complete, true);
  assert.equal(s.stalled, false);
  assert.equal(s.score, 100);
  const rep = s.report();
  assert.equal(rep.complete, true);
  assert.equal(rep.stalled, false);
  assert.equal(rep.score, 100);
  assert.ok(rep.criteria.every((c) => c.verdict === 'mastered'));
});

test('the per-criterion attempt cap terminates a stuck learner with a partial score', async () => {
  const stuck = ({ eloIndex }) => ({ verdict: 'competent', feedback: 'closer', mastered: false, complete: false, nextQuestion: 'try again', nextEloIndex: eloIndex, score: 33 });
  const s = new Session({ scorer: stuck, maxAttemptsPerCriterion: 3 });
  s.criteria = [{ elo: 'A' }, { elo: 'B' }];
  s.currentQuestion = 'Q'; s.transcript.push({ role: 'assistant', text: 'Q' });
  await s.answer('1'); assert.equal(s.complete, false);
  await s.answer('2'); assert.equal(s.complete, false);
  const r = await s.answer('3');                  // 3rd non-advancing attempt hits the cap
  assert.equal(s.complete, true);
  assert.equal(s.stalled, true);
  assert.equal(r.stalled, true);
  assert.equal(s.score, 33);                      // partial score recorded, not lost
  assert.equal(s.report().stalled, true);
});

test('the maxTurns cap terminates the session', async () => {
  const stuck = ({ eloIndex }) => ({ verdict: 'developing', feedback: 'no', mastered: false, complete: false, nextQuestion: 'again', nextEloIndex: eloIndex, score: 0 });
  const s = new Session({ scorer: stuck, maxTurns: 2 });
  s.criteria = [{ elo: 'A' }]; s.currentQuestion = 'Q'; s.transcript.push({ role: 'assistant', text: 'Q' });
  await s.answer('1'); assert.equal(s.complete, false);
  await s.answer('2'); assert.equal(s.complete, true); assert.equal(s.stalled, true);
});

test('a non-complete turn with an empty follow-up re-probes the current criterion', async () => {
  const emptyFollowup = ({ eloIndex }) => ({ verdict: 'developing', feedback: 'keep going', mastered: false, complete: false, nextQuestion: '', nextEloIndex: eloIndex, score: 0 });
  const s = new Session({ scorer: emptyFollowup });
  s.criteria = [{ elo: 'A' }];
  s.currentQuestion = 'Original probe about A';
  s.transcript.push({ role: 'assistant', text: 'Original probe about A' });
  const r = await s.answer('hmm');
  assert.equal(s.complete, false);
  assert.ok(s.currentQuestion && s.currentQuestion.length > 0);  // never a silent dead-end
  assert.equal(r.nextQuestion, s.currentQuestion);
  assert.equal(s.transcript[s.transcript.length - 1].text, s.currentQuestion); // reprobe was recorded
});

test('completion forces no next question even if the scorer supplies one', async () => {
  const done = () => ({ verdict: 'mastered', feedback: 'done', mastered: true, complete: true, nextQuestion: 'leftover question', nextEloIndex: 1, score: 100 });
  const s = new Session({ scorer: done });
  s.criteria = [{ elo: 'A' }]; s.currentQuestion = 'Q'; s.transcript.push({ role: 'assistant', text: 'Q' });
  const r = await s.answer('great');
  assert.equal(s.complete, true);
  assert.equal(s.currentQuestion, null);
  assert.equal(r.nextQuestion, '');
  assert.equal(s.transcript.some((m) => m.text === 'leftover question'), false);
});

test('a scorer error leaves the transcript and results untouched (no dangling user turn)', async () => {
  const boom = () => ({ error: 'model exploded' });
  const s = new Session({ scorer: boom });
  s.criteria = [{ elo: 'A' }]; s.currentQuestion = 'Q';
  s.transcript.push({ role: 'assistant', text: 'Q' });
  const before = s.transcript.length;
  await assert.rejects(() => s.answer('my answer'), /model exploded/);
  assert.equal(s.transcript.length, before);
  assert.equal(s.results.length, 0);
  assert.equal(s.transcript.some((m) => m.role === 'user'), false);
});

test('answering an already-complete session is a no-op that never calls the scorer', async () => {
  let called = false;
  const s = new Session({ scorer: () => { called = true; throw new Error('should not run'); } });
  s.criteria = [{ elo: 'A' }]; s.complete = true;
  const r = await s.answer('anything');
  assert.deepEqual(r, { complete: true });
  assert.equal(called, false);
});

test('the scorer must return an integer nextEloIndex within range', async () => {
  const s = new Session({ scorer: () => ({ verdict: 'developing', feedback: '', nextEloIndex: 9, score: 0 }) });
  s.criteria = [{ elo: 'A' }]; s.currentQuestion = 'Q'; s.transcript.push({ role: 'assistant', text: 'Q' });
  await assert.rejects(() => s.answer('x'), /invalid nextEloIndex/);
});

test('a complete flag inconsistent with nextEloIndex is rejected', async () => {
  const s = new Session({ scorer: () => ({ verdict: 'mastered', feedback: '', complete: true, nextEloIndex: 0, score: 0 }) });
  s.criteria = [{ elo: 'A' }, { elo: 'B' }]; s.currentQuestion = 'Q'; s.transcript.push({ role: 'assistant', text: 'Q' });
  await assert.rejects(() => s.answer('x'), /inconsistent/);
});

test('the retained transcript is windowed while the exchange count is preserved', async () => {
  const step = ({ eloIndex }) => ({ verdict: 'developing', feedback: 'f', mastered: false, complete: false, nextQuestion: 'q', nextEloIndex: eloIndex, score: 0 });
  const s = new Session({ scorer: step, maxTranscript: 5, maxAttemptsPerCriterion: Infinity });
  s.criteria = [{ elo: 'A' }]; s.currentQuestion = 'Q'; s._push({ role: 'assistant', text: 'Q' });
  for (let i = 0; i < 10; i++) await s.answer('a' + i);
  assert.ok(s.transcript.length <= 5);      // transcript is capped
  assert.ok(s.report().exchanges > 5);      // but the true exchange count survives windowing
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
