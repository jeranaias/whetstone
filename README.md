# 🪨 Whetstone

[![CI](https://github.com/jeranaias/whetstone/actions/workflows/ci.yml/badge.svg)](https://github.com/jeranaias/whetstone/actions/workflows/ci.yml) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**A conversational tutor that sharpens a learner to mastery — grounded in the lesson.**

A multiple-choice quiz tells you whether someone guessed right. It doesn't tell you whether they
*understand*. Whetstone has the conversation instead: it derives a rubric from the lesson's
objectives, then talks with the learner — probing, scoring each answer against the rubric, coaching
the exact gap, and moving on only once the learner has actually demonstrated the competency. Then it
hands back a score.

Every judgment is grounded **only in the lesson content** — Whetstone assesses against the source, not
against the model's opinions.

```js
import { deriveRubric, firstQuestion, scoreTurn } from 'whetstone';

const source = 'Photosynthesis is how plants turn light energy into chemical energy. Chlorophyll absorbs sunlight, which splits water and releases oxygen; the plant then combines carbon dioxide with the captured energy to build glucose…';

const { criteria } = await deriveRubric('Explain how photosynthesis works.', source);
// → criteria: ['Light Capture', 'Glucose Synthesis']

const { question } = await firstQuestion(criteria, source);
// → "What does chlorophyll do when sunlight reaches a leaf?"

await scoreTurn({ criteria, eloIndex: 0, question, answer: 'Plants use the sun.', source });
// → { verdict: 'developing', score: 0,
//     feedback: 'You have the general idea, but you did not say what captures the light or…',
//     nextQuestion: 'Which molecule absorbs the sunlight, and what happens to water as a result?' }
```

A strong answer advances:

```js
// → { verdict: 'mastered', score: 50, nextEloIndex: 1,
//     nextQuestion: 'Once the energy is captured, how does the plant build glucose?' }
```

…until all criteria are mastered, at which point `complete: true` and the final `score` is ready to
record.

## The loop

1. **`deriveRubric(objectives, source)`** → 2–4 assessable criteria, each with *developing / competent / mastered* indicators.
2. **`firstQuestion(criteria, source)`** → the opening probe.
3. **`scoreTurn({ criteria, eloIndex, question, answer, source, transcript })`** → `{ verdict, feedback, mastered, complete, nextQuestion, nextEloIndex, score }`.

Whetstone is stateless — you hold the transcript and pass it back, so it drops cleanly into a chat UI,
a CLI, or a batch grader.

## Or just run a session

Don't want to juggle state? `Session` holds the rubric, transcript, and progress for you — three calls:

```js
import { Session } from 'whetstone';

const s = new Session({ objectives: 'Explain how photosynthesis works.', source });
console.log(await s.start());        // → opening question
await s.answer('Plants use the sun.');   // → { verdict: 'developing', feedback, nextQuestion }
await s.answer('Chlorophyll absorbs sunlight and splits water, releasing oxygen; the captured energy combines carbon dioxide into glucose.');
// … until s.complete === true

s.report();
// → { complete: true, stalled: false, score: 100,
//     criteria: [{ competency: 'Light Capture', verdict: 'mastered' }, …],
//     exchanges: 6 }
```

A `Session` always terminates. A learner who never masters a criterion is capped by
`maxAttemptsPerCriterion` (default 6) — and optionally by a whole-session `maxTurns` — after which the
session ends with `complete: true`, `stalled: true`, and the partial `score` it had reached. The
retained transcript is windowed to `maxTranscript` (default 100) entries, while `report().exchanges`
still reports the true running total.

Every model touchpoint is injectable — `new Session({ scorer, deriveRubric, firstQuestion })` — so the
whole progression, including `start()`, runs **without a model**. That is exactly how the test suite
exercises it: deterministic stand-ins drive rubric derivation, the opening question, and scoring, with
no network calls. See `test/`.

## Bring your own model

| Variable | Default |
|---|---|
| `WHETSTONE_API_KEY` | *(required; `OPENROUTER_API_KEY` also accepted)* |
| `WHETSTONE_ENDPOINT` | `https://openrouter.ai/api/v1/chat/completions` |
| `WHETSTONE_MODEL` | `google/gemini-3-flash-preview` |

## Try it

```bash
npm install whetstone
export WHETSTONE_API_KEY=...
node example/demo.mjs
```

## License

Apache-2.0.
