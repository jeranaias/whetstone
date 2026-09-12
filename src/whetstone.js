// Whetstone — a conversational tutor that sharpens a learner to mastery.
// It derives a mastery rubric from a lesson's objectives, probes the learner, scores each answer
// against the rubric grounded ONLY in the lesson, coaches the specific gap, advances criterion by
// criterion, and reports a mastery score. Model calls go to any OpenAI-compatible chat endpoint.
const ENDPOINT = process.env.WHETSTONE_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = process.env.WHETSTONE_MODEL || 'google/gemini-3-flash-preview';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEVELS = ['developing', 'competent', 'mastered'];

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

/** Derive a mastery rubric (indicators per criterion at developing/competent/mastered). */
export async function deriveRubric(objectives, source) {
  const list = (Array.isArray(objectives) ? objectives : [objectives]).filter(Boolean);
  const sys = `You build a MASTERY rubric from learning objectives, grounded ONLY in the provided lesson content. If a single broad objective is given, DECOMPOSE it into 2-4 assessable sub-competencies; otherwise one criterion per objective. For each criterion, give observable indicators of what a learner demonstrates at three levels: "developing","competent","mastered". Specific to the lesson — never invented. Output JSON only: {"criteria":[{"elo":"<competency>","indicators":{"developing":"...","competent":"...","mastered":"..."}}]}`;
  const r = await ask(sys, `Lesson content:\n"""${(source || '').slice(0, 4000)}"""\n\nObjectives:\n${list.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\nBuild the mastery rubric.`);
  return r.criteria ? { criteria: r.criteria } : { error: r.error || 'no rubric' };
}

/** The opening probing question for the first criterion. */
export async function firstQuestion(criteria, source) {
  const elo = criteria[0]?.elo || '';
  const r = await ask(
    `You are a rigorous but supportive tutor beginning a mastery check. Ask ONE open question that makes the learner explain the competency in their own words, grounded in the lesson. Output JSON only: {"question":"..."}`,
    `Lesson:\n"""${(source || '').slice(0, 3000)}"""\nCompetency: ${elo}\nAsk the opening question.`);
  return { question: r.question || `In your own words, explain: ${elo}`, eloIndex: 0 };
}

/** Score one answer against the rubric for the current criterion; coach and decide the next step. */
export async function scoreTurn({ criteria, eloIndex, question, answer, source, transcript }) {
  const c = criteria[eloIndex] || criteria[0];
  const sys = `You assess a learner's answer against a mastery rubric for ONE competency, using ONLY the lesson content as ground truth. Verdict is "developing","competent", or "mastered" per the indicators. Coach: say what was right and precisely what's missing, grounded. If not yet "mastered", ask a focused follow-up that targets the gap; if "mastered", set followup to "". Output JSON only: {"verdict":"...","feedback":"<2-3 sentences>","followup":"<question or empty>"}`;
  const user = `Lesson:\n"""${(source || '').slice(0, 3000)}"""\nCompetency: ${c.elo}\nIndicators: ${JSON.stringify(c.indicators)}\n${transcript ? 'Prior exchange:\n' + transcript + '\n' : ''}Question asked: ${question}\nLearner answer: "${answer}"\n\nScore it.`;
  const r = await ask(sys, user);
  if (r.error) return { error: r.error };
  const verdict = LEVELS.includes(r.verdict) ? r.verdict : 'developing';
  const mastered = verdict === 'mastered';
  const nextIndex = mastered ? eloIndex + 1 : eloIndex;
  const complete = mastered && nextIndex >= criteria.length;
  let nextQuestion = r.followup || '';
  let nextEloIndex = eloIndex;
  if (mastered && !complete) {
    const nq = await firstQuestion(criteria.slice(nextIndex), source);
    nextQuestion = nq.question; nextEloIndex = nextIndex;
  }
  const score = Math.round(((nextIndex + (mastered ? 0 : LEVELS.indexOf(verdict) / 3)) / criteria.length) * 100);
  return { verdict, feedback: r.feedback || '', mastered, complete, nextQuestion, nextEloIndex, score };
}
