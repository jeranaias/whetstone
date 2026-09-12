// Whetstone — a conversational tutor that sharpens a learner to mastery.
// It derives a mastery rubric from a lesson's objectives, probes the learner, scores each answer
// against the rubric grounded ONLY in the lesson, coaches the specific gap, advances criterion by
// criterion, and reports a mastery score. Model calls go to any OpenAI-compatible chat endpoint.
const ENDPOINT = process.env.WHETSTONE_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = process.env.WHETSTONE_MODEL || 'google/gemini-3-flash-preview';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The three mastery levels, in ascending order. */
export const LEVELS = ['developing', 'competent', 'mastered'];

/**
 * Call the configured OpenAI-compatible chat endpoint and return the model's parsed JSON reply.
 * Retries transient failures (429/503, network, timeout) with linear backoff.
 * @param {string} system - System prompt.
 * @param {string} user - User prompt.
 * @param {number} [tries=4] - Maximum attempts.
 * @param {number} [timeoutMs=60000] - Per-attempt timeout.
 * @returns {Promise<object>} Parsed JSON object, or `{ error }` on failure.
 */
async function ask(system, user, tries = 4, timeoutMs = 60000) {
  const KEY = process.env.WHETSTONE_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!KEY) return { error: 'set WHETSTONE_API_KEY (or OPENROUTER_API_KEY)' };
  for (let a = 1; a <= tries; a++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(ENDPOINT, { method: 'POST', signal: ctrl.signal,
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
      if ((res.status === 429 || res.status === 503) && a < tries) { await sleep(3000 * a); continue; }
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const t = (await res.json()).choices?.[0]?.message?.content ?? '';
      try { return JSON.parse(t); } catch {}
      const m = t.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch {} }
      return { error: 'no-json' };
    } catch (e) {
      if (a < tries) { await sleep(3000 * a); continue; }
      return { error: e?.name === 'AbortError' ? 'timeout' : String(e) };
    } finally { clearTimeout(timer); }
  }
  return { error: 'failed' };
}

/**
 * Progress score (0–100) for a mastery session: full credit for every criterion already mastered,
 * plus partial credit for how far the current criterion has advanced. Pure and deterministic.
 * @param {object} args
 * @param {number} args.criteriaCount - Total number of criteria in the rubric (> 0).
 * @param {number} args.eloIndex - Zero-based index of the criterion just scored.
 * @param {string} args.verdict - One of `LEVELS`; anything unknown counts as no partial credit.
 * @returns {number} Score rounded to a whole percent in [0, 100].
 */
export function computeScore({ criteriaCount, eloIndex, verdict }) {
  if (!Number.isFinite(criteriaCount) || criteriaCount <= 0) return 0;
  const mastered = verdict === 'mastered';
  const rawNext = mastered ? (Number.isFinite(eloIndex) ? eloIndex : 0) + 1 : (Number.isFinite(eloIndex) ? eloIndex : 0);
  const nextIndex = Math.min(Math.max(0, rawNext), criteriaCount); // clamp advancement to the rubric size
  const partial = mastered ? 0 : Math.max(0, LEVELS.indexOf(verdict)) / LEVELS.length;
  const pct = Math.round(((nextIndex + partial) / criteriaCount) * 100);
  return Math.min(100, Math.max(0, pct)); // documented range is [0, 100]
}

/**
 * Derive a mastery rubric from learning objectives, grounded only in the lesson content. A single
 * broad objective is decomposed into 2–4 assessable sub-competencies; each criterion carries
 * observable indicators at the developing/competent/mastered levels.
 * @param {string|string[]} objectives - One objective or a list of them.
 * @param {string} source - The lesson content to ground the rubric in.
 * @returns {Promise<{criteria: Array<{elo: string, indicators: object}>}|{error: string}>}
 */
export async function deriveRubric(objectives, source) {
  const list = (Array.isArray(objectives) ? objectives : [objectives]).filter(Boolean);
  if (list.length === 0) return { error: 'objectives required' };
  const sys = `You build a MASTERY rubric from learning objectives, grounded ONLY in the provided lesson content. If a single broad objective is given, DECOMPOSE it into 2-4 assessable sub-competencies; otherwise one criterion per objective. For each criterion, give observable indicators of what a learner demonstrates at three levels: "developing","competent","mastered". Specific to the lesson — never invented. Output JSON only: {"criteria":[{"elo":"<competency>","indicators":{"developing":"...","competent":"...","mastered":"..."}}]}`;
  const r = await ask(sys, `Lesson content:\n"""${(source || '').slice(0, 4000)}"""\n\nObjectives:\n${list.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\nBuild the mastery rubric.`);
  return Array.isArray(r.criteria) && r.criteria.length ? { criteria: r.criteria } : { error: r.error || 'no rubric' };
}

/**
 * Ask the opening probing question for the first criterion of a rubric.
 * @param {Array<{elo: string}>} criteria - The rubric criteria (from `deriveRubric`).
 * @param {string} source - The lesson content, used to ground the question.
 * @returns {Promise<{question: string, eloIndex: number, fallback?: boolean, error?: string}>}
 *   `fallback:true` (with the underlying `error`) marks a canned question used because the model
 *   did not return one; the question is always non-empty so the flow can continue.
 */
export async function firstQuestion(criteria, source) {
  if (!Array.isArray(criteria) || criteria.length === 0) throw new TypeError('criteria must be a non-empty array');
  const elo = criteria[0]?.elo || '';
  const r = await ask(
    `You are a rigorous but supportive tutor beginning a mastery check. Ask ONE open question that makes the learner explain the competency in their own words, grounded in the lesson. Output JSON only: {"question":"..."}`,
    `Lesson:\n"""${(source || '').slice(0, 3000)}"""\nCompetency: ${elo}\nAsk the opening question.`);
  if (typeof r.question === 'string' && r.question.trim() !== '') return { question: r.question, eloIndex: 0 };
  return { question: `In your own words, explain: ${elo}`, eloIndex: 0, fallback: true, error: r.error || 'no question' };
}

/**
 * Score one answer against the rubric for the current criterion, coach the gap, and decide the next
 * step. On mastery, advances to the next criterion and asks its opening question; otherwise asks a
 * focused follow-up targeting the gap.
 * @param {object} args
 * @param {Array<{elo: string, indicators: object}>} args.criteria - The rubric criteria.
 * @param {number} args.eloIndex - Index of the criterion being assessed.
 * @param {string} args.question - The question that was asked.
 * @param {string} args.answer - The learner's answer.
 * @param {string} args.source - The lesson content (ground truth).
 * @param {string} [args.transcript] - Recent prior exchange, for context.
 * @returns {Promise<{verdict: string, feedback: string, mastered: boolean, complete: boolean,
 *   nextQuestion: string, nextEloIndex: number, score: number}|{error: string}>}
 */
export async function scoreTurn({ criteria, eloIndex, question, answer, source, transcript }) {
  if (!Array.isArray(criteria) || criteria.length === 0) throw new TypeError('criteria must be a non-empty array');
  if (typeof answer !== 'string' || answer.trim() === '') return { error: 'answer required' };
  const idx = Number.isInteger(eloIndex) && eloIndex >= 0 && eloIndex < criteria.length ? eloIndex : 0;
  const c = criteria[idx];
  const sys = `You assess a learner's answer against a mastery rubric for ONE competency, using ONLY the lesson content as ground truth. Verdict is "developing","competent", or "mastered" per the indicators. Coach: say what was right and precisely what's missing, grounded. If not yet "mastered", ask a focused follow-up that targets the gap; if "mastered", set followup to "". Output JSON only: {"verdict":"...","feedback":"<2-3 sentences>","followup":"<question or empty>"}`;
  const user = `Lesson:\n"""${(source || '').slice(0, 3000)}"""\nCompetency: ${c.elo}\nIndicators: ${JSON.stringify(c.indicators)}\n${transcript ? 'Prior exchange:\n' + transcript + '\n' : ''}Question asked: ${question}\nLearner answer: "${answer}"\n\nScore it.`;
  const r = await ask(sys, user);
  if (r.error) return { error: r.error };
  const verdict = LEVELS.includes(r.verdict) ? r.verdict : 'developing';
  const mastered = verdict === 'mastered';
  const nextIndex = mastered ? idx + 1 : idx;
  const complete = mastered && nextIndex >= criteria.length;
  let nextQuestion = complete ? '' : (r.followup || ''); // complete → no question, ever
  let nextEloIndex = idx;
  if (mastered && !complete) {
    const nq = await firstQuestion(criteria.slice(nextIndex), source);
    nextQuestion = nq.question; nextEloIndex = nextIndex;
  }
  // A non-mastered turn with an empty model follow-up would be a silent dead-end: re-probe the
  // current criterion so nextQuestion is never empty unless the session is complete.
  if (!complete && (typeof nextQuestion !== 'string' || nextQuestion.trim() === '')) {
    nextQuestion = (typeof question === 'string' && question.trim() !== '') ? question : `In your own words, explain: ${c.elo}`;
  }
  const score = computeScore({ criteriaCount: criteria.length, eloIndex: idx, verdict });
  return { verdict, feedback: r.feedback || '', mastered, complete, nextQuestion, nextEloIndex, score };
}
