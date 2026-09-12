// A stateful mastery session — holds the rubric, the transcript, and progress, so you drive the
// whole discuss-to-mastery loop with three calls: start(), answer(), report(). The scoring function
// is injectable, which also makes the progression logic fully testable without a model.
import { deriveRubric, firstQuestion, scoreTurn } from './whetstone.js';

/**
 * A stateful mastery-assessment session over a single lesson.
 *
 * @example
 * const s = new Session({ objectives: 'Explain photosynthesis.', source });
 * await s.start();                 // → opening question
 * await s.answer('Plants make food.');
 * // …until s.complete === true
 * s.report();
 */
export class Session {
  /**
   * @param {object} config
   * @param {string|string[]} config.objectives - Learning objective(s) to assess.
   * @param {string} config.source - The lesson content to ground the rubric and scoring in.
   * @param {Function} [config.scorer] - Injectable scoring function with the same shape as
   *   `scoreTurn`; defaults to the model-backed scorer. Supplying a deterministic scorer makes the
   *   progression logic testable without a model.
   */
  constructor({ objectives, source, scorer } = {}) {
    if (scorer !== undefined && typeof scorer !== 'function') throw new TypeError('scorer must be a function');
    this.objectives = objectives;
    this.source = source;
    this.scorer = scorer || scoreTurn;
    this.criteria = null;
    this.eloIndex = 0;
    this.currentQuestion = null;
    this.transcript = [];
    this.results = [];
    this.score = 0;
    this.complete = false;
  }

  /**
   * Derive the rubric and return the opening question. Must be called before `answer`.
   * @returns {Promise<string>} The opening question.
   * @throws {Error} If the rubric cannot be derived.
   */
  async start() {
    const r = await deriveRubric(this.objectives, this.source);
    if (r.error) throw new Error(r.error);
    this.criteria = r.criteria;
    const q = await firstQuestion(this.criteria, this.source);
    this.eloIndex = q.eloIndex;
    this.currentQuestion = q.question;
    this.transcript.push({ role: 'assistant', text: q.question });
    return q.question;
  }

  /**
   * Score the learner's answer to the current question, advance progress, and return the turn result.
   * @param {string} text - The learner's answer.
   * @returns {Promise<object>} The scorer result (`{ verdict, feedback, ... }`), or
   *   `{ complete: true }` if the session was already complete.
   * @throws {Error} If the scorer returns an error, or if called before `start` seeds the rubric.
   */
  async answer(text) {
    if (this.complete) return { complete: true };
    if (!this.criteria) throw new Error('call start() before answer()');
    this.transcript.push({ role: 'user', text });
    const ctx = this.transcript.slice(-4).map((m) => `${m.role === 'assistant' ? 'Instructor' : 'Student'}: ${m.text}`).join('\n');
    const r = await this.scorer({ criteria: this.criteria, eloIndex: this.eloIndex, question: this.currentQuestion, answer: text, source: this.source, transcript: ctx });
    if (r.error) throw new Error(r.error);
    this.results.push({ eloIndex: this.eloIndex, verdict: r.verdict, score: r.score });
    this.transcript.push({ role: 'assistant', text: r.feedback });
    this.eloIndex = r.nextEloIndex;
    this.currentQuestion = r.nextQuestion;
    this.score = r.score;
    if (r.complete) this.complete = true;
    else if (r.nextQuestion) this.transcript.push({ role: 'assistant', text: r.nextQuestion });
    return r;
  }

  /**
   * Per-competency mastery summary for this session.
   * @returns {object} See {@link masteryReport}.
   */
  report() { return masteryReport(this); }
}

/**
 * Per-competency mastery summary for a session — ready to record to a gradebook.
 * @param {Session|object} session - A session (or session-shaped object) with `criteria`,
 *   `results`, `eloIndex`, `score`, `complete`, and `transcript`.
 * @returns {{complete: boolean, score: number,
 *   criteria: Array<{competency: string, verdict: string}>, exchanges: number}}
 */
export function masteryReport(session) {
  const crit = session.criteria || [];
  return {
    complete: !!session.complete,
    score: session.score ?? 0,
    criteria: crit.map((c, i) => {
      const last = [...(session.results || [])].reverse().find((r) => r.eloIndex === i);
      return { competency: c.elo, verdict: last?.verdict || (i < session.eloIndex ? 'mastered' : 'not yet assessed') };
    }),
    exchanges: (session.transcript || []).length,
  };
}
