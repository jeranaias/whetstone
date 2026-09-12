// WHETSTONE_API_KEY=... node example/demo.mjs
import { deriveRubric, firstQuestion, scoreTurn } from '../src/whetstone.js';
const source = 'Trigger control is a smooth, consistent rearward squeeze while maintaining aim until the bullet leaves the muzzle. Follow-through is continuing to apply the fundamentals after the shot — keeping the head on the stock and holding the trigger to the rear through recoil until the sear resets.';
const { criteria } = await deriveRubric('Explain trigger control and follow-through.', source);
console.log('criteria:', criteria.map((c) => c.elo));
const q = await firstQuestion(criteria, source);
console.log('\nQ:', q.question);
const weak = await scoreTurn({ criteria, eloIndex: 0, question: q.question, answer: 'You squeeze the trigger.', source });
console.log('weak answer →', weak.verdict, '| score', weak.score, '\nfeedback:', weak.feedback);
