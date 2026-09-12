// A stateful mastery session — holds the rubric, the transcript, and progress, so you drive the
// whole discuss-to-mastery loop with three calls: start(), answer(), report(). The scoring function
// is injectable, which also makes the progression logic fully testable without a model.
import { deriveRubric, firstQuestion, scoreTurn } from './whetstone.js';

export class Session {
  constructor({ objectives, source, scorer } = {}) {
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

  async answer(text) {
    if (this.complete) return { complete: true };
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

  report() { return masteryReport(this); }
}

/** Per-competency mastery summary for a session — ready to record to a gradebook. */
export function masteryReport(session) {
  const crit = session.criteria || [];
  return {
    complete: session.complete,
    score: session.score ?? 0,
    criteria: crit.map((c, i) => {
      const last = [...(session.results || [])].reverse().find((r) => r.eloIndex === i);
      return { competency: c.elo, verdict: last?.verdict || (i < session.eloIndex ? 'mastered' : 'not yet assessed') };
    }),
    exchanges: (session.transcript || []).length,
  };
}
