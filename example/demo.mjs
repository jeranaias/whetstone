// Runnable demo. Set a key first:
//   WHETSTONE_API_KEY=... node example/demo.mjs
import { deriveRubric, firstQuestion, scoreTurn, Session } from '../src/index.js';

const source =
  'Photosynthesis is how plants turn light energy into chemical energy. In the chloroplasts, ' +
  'chlorophyll absorbs sunlight, which splits water into hydrogen and oxygen; the oxygen is ' +
  'released. The plant then uses the captured energy to combine carbon dioxide with the hydrogen ' +
  'to build glucose, a sugar it stores as food.';

// --- Low-level loop: you hold the state ---
const { criteria, error } = await deriveRubric('Explain how photosynthesis works.', source);
if (error) { console.error('deriveRubric failed:', error); process.exit(1); }
console.log('criteria:', criteria.map((c) => c.elo));

const { question } = await firstQuestion(criteria, source);
console.log('\nQ:', question);

const weak = await scoreTurn({ criteria, eloIndex: 0, question, answer: 'Plants use the sun.', source });
console.log('weak answer →', weak.verdict, '| score', weak.score);
console.log('feedback:', weak.feedback);
if (weak.nextQuestion) console.log('follow-up:', weak.nextQuestion);

// --- Or let a Session hold the state for you ---
console.log('\n--- Session ---');
const s = new Session({ objectives: 'Explain how photosynthesis works.', source });
console.log('Q:', await s.start());
const turn = await s.answer(
  'Chlorophyll in the chloroplasts absorbs sunlight and splits water, releasing oxygen; the ' +
  'captured energy then combines carbon dioxide with hydrogen to build glucose.');
console.log('answer →', turn.verdict, '| score', turn.score);
console.log('\nreport:', JSON.stringify(s.report(), null, 2));
