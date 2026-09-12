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
   * @param {Function} [config.deriveRubric] - Injectable rubric builder with the same shape as
   *   `deriveRubric`; defaults to the model-backed one. Lets `start()` run offline in tests.
   * @param {Function} [config.firstQuestion] - Injectable opening-question generator with the same
   *   shape as `firstQuestion`; defaults to the model-backed one. Lets `start()` run offline.
   * @param {number} [config.maxTurns=Infinity] - Hard cap on total `answer()` calls; on the turn
   *   that reaches it the session terminates `complete:true` with `stalled:true`.
   * @param {number} [config.maxAttemptsPerCriterion=6] - Cap on consecutive non-advancing attempts
   *   on one criterion; exceeding it terminates the session `complete:true` with `stalled:true` so a
   *   learner who never masters a criterion cannot loop forever. Set to `Infinity` to disable.
   * @param {number} [config.maxTranscript=100] - Rolling window: the retained transcript is trimmed
   *   to at most this many of the most recent entries.
   */
  constructor({ objectives, source, scorer, deriveRubric: deriveRubricFn, firstQuestion: firstQuestionFn, maxTurns = Infinity, maxAttemptsPerCriterion = 6, maxTranscript = 100 } = {}) {
    if (scorer !== undefined && typeof scorer !== 'function') throw new TypeError('scorer must be a function');
    if (deriveRubricFn !== undefined && typeof deriveRubricFn !== 'function') throw new TypeError('deriveRubric must be a function');
    if (firstQuestionFn !== undefined && typeof firstQuestionFn !== 'function') throw new TypeError('firstQuestion must be a function');
    if (!(maxTurns > 0)) throw new RangeError('maxTurns must be > 0');
    if (!(maxAttemptsPerCriterion > 0)) throw new RangeError('maxAttemptsPerCriterion must be > 0');
    if (!(Number.isFinite(maxTranscript) && maxTranscript > 0)) throw new RangeError('maxTranscript must be a positive finite number');
    this.objectives = objectives;
    this.source = source;
    this.scorer = scorer || scoreTurn;
    this._deriveRubric = deriveRubricFn || deriveRubric;
    this._firstQuestion = firstQuestionFn || firstQuestion;
    this.maxTurns = maxTurns;
    this.maxAttemptsPerCriterion = maxAttemptsPerCriterion;
    this.maxTranscript = maxTranscript;
    this.criteria = null;
    this.eloIndex = 0;
    this.currentQuestion = null;
    this.transcript = [];
    this.results = [];
    this.score = 0;
    this.complete = false;
    this.stalled = false;      // true when terminated by a cap rather than by mastery
    this.turns = 0;            // total answer() calls scored
    this.attempts = 0;         // consecutive non-advancing attempts on the current criterion
    this.exchanges = 0;        // total transcript entries ever recorded (survives windowing)
  }

  /** Record a transcript entry, keep the running count, and window the retained transcript. */
  _push(entry) {
    this.transcript.push(entry);
    this.exchanges += 1;
    if (this.transcript.length > this.maxTranscript) {
      this.transcript.splice(0, this.transcript.length - this.maxTranscript);
    }
  }

  /**
   * Derive the rubric and return the opening question. Must be called before `answer`.
   * @returns {Promise<string>} The opening question.
   * @throws {Error} If the rubric cannot be derived.
   */
  async start() {
    const r = await this._deriveRubric(this.objectives, this.source);
    if (r.error) throw new Error(r.error);
    if (!Array.isArray(r.criteria) || r.criteria.length === 0) throw new Error('no rubric');
    this.criteria = r.criteria;
    const q = await this._firstQuestion(this.criteria, this.source);
    this.eloIndex = Number.isInteger(q.eloIndex) ? q.eloIndex : 0;
    this.currentQuestion = q.question;
    this._push({ role: 'assistant', text: q.question });
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
    // Build context from the PRIOR exchange only; the current answer is passed explicitly. The user
    // turn is not recorded yet, so a scorer error leaves no dangling turn in the transcript.
    const ctx = this.transcript.slice(-4).map((m) => `${m.role === 'assistant' ? 'Instructor' : 'Student'}: ${m.text}`).join('\n');
    const r = await this.scorer({ criteria: this.criteria, eloIndex: this.eloIndex, question: this.currentQuestion, answer: text, source: this.source, transcript: ctx });
    if (r.error) throw new Error(r.error);

    // Validate the scorer's advancement and derive completion rather than trusting its flag.
    const n = this.criteria.length;
    if (!Number.isInteger(r.nextEloIndex) || r.nextEloIndex < 0 || r.nextEloIndex > n) {
      throw new Error(`scorer returned invalid nextEloIndex: ${r.nextEloIndex}`);
    }
    const scorerComplete = r.nextEloIndex >= n;
    if (typeof r.complete === 'boolean' && r.complete !== scorerComplete) {
      throw new Error('scorer complete flag is inconsistent with nextEloIndex');
    }
    const advanced = r.nextEloIndex > this.eloIndex;

    // Count this turn and the attempts on the current criterion, then apply the termination caps.
    this.turns += 1;
    this.attempts += 1;
    let complete = scorerComplete;
    let stalled = false;
    if (!complete) {
      const hitTurnCap = this.turns >= this.maxTurns;
      const hitAttemptCap = !advanced && this.attempts >= this.maxAttemptsPerCriterion;
      if (hitTurnCap || hitAttemptCap) { complete = true; stalled = true; } // terminate; keep partial score
    }

    // Re-probe the current criterion if a non-complete turn produced no next question.
    let nextQuestion = complete ? '' : r.nextQuestion;
    if (!complete && (typeof nextQuestion !== 'string' || nextQuestion.trim() === '')) {
      nextQuestion = (typeof this.currentQuestion === 'string' && this.currentQuestion.trim() !== '')
        ? this.currentQuestion
        : `In your own words, explain: ${this.criteria[this.eloIndex]?.elo ?? ''}`;
    }

    // Only now, after a clean scorer result, record the exchange and commit state.
    this._push({ role: 'user', text });
    this.results.push({ eloIndex: this.eloIndex, verdict: r.verdict, score: r.score });
    if (r.feedback) this._push({ role: 'assistant', text: r.feedback });
    this.eloIndex = r.nextEloIndex;
    this.attempts = advanced ? 0 : this.attempts; // reset the per-criterion counter on advance
    this.score = r.score;
    this.complete = complete;
    if (stalled) this.stalled = true;
    this.currentQuestion = complete ? null : nextQuestion;
    if (!complete && nextQuestion) this._push({ role: 'assistant', text: nextQuestion });
    return { ...r, complete, stalled, nextEloIndex: r.nextEloIndex, nextQuestion };
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
 * @returns {{complete: boolean, stalled: boolean, score: number,
 *   criteria: Array<{competency: string, verdict: string}>, exchanges: number}}
 */
export function masteryReport(session) {
  const crit = session.criteria || [];
  return {
    complete: !!session.complete,
    stalled: !!session.stalled,
    score: session.score ?? 0,
    criteria: crit.map((c, i) => {
      const last = [...(session.results || [])].reverse().find((r) => r.eloIndex === i);
      return { competency: c.elo, verdict: last?.verdict || (i < session.eloIndex ? 'mastered' : 'not yet assessed') };
    }),
    // Prefer the running total so a windowed transcript still reports the true exchange count.
    exchanges: typeof session.exchanges === 'number' ? session.exchanges : (session.transcript || []).length,
  };
}
