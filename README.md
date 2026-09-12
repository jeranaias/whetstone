# 🪨 Whetstone

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

const source = 'Trigger control is a smooth, consistent rearward squeeze… Follow-through is continuing the fundamentals after the shot…';

const { criteria } = await deriveRubric('Explain trigger control and follow-through.', source);
// → criteria: ['Trigger Control Mechanics', 'Follow-Through and Sear Reset']

const { question } = await firstQuestion(criteria, source);
// → "How does the trigger squeeze relate to proper follow-through?"

await scoreTurn({ criteria, eloIndex: 0, question, answer: 'You squeeze the trigger.', source });
// → { verdict: 'developing', score: 0,
//     feedback: 'You named the basic action but missed the smooth rearward motion and…',
//     nextQuestion: 'How specifically should you apply pressure, and where does the finger sit?' }
```

A strong answer advances:

```js
// → { verdict: 'mastered', score: 50, nextEloIndex: 1,
//     nextQuestion: 'How does holding pressure through recoil relate to the sear reset?' }
```

…until all criteria are mastered, at which point `complete: true` and the final `score` is ready to
record.

## The loop

1. **`deriveRubric(objectives, source)`** → 2–4 assessable criteria, each with *developing / competent / mastered* indicators.
2. **`firstQuestion(criteria, source)`** → the opening probe.
3. **`scoreTurn({ criteria, eloIndex, question, answer, source, transcript })`** → `{ verdict, feedback, mastered, complete, nextQuestion, nextEloIndex, score }`.

Whetstone is stateless — you hold the transcript and pass it back, so it drops cleanly into a chat UI,
a CLI, or a batch grader.

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
