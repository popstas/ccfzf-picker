// Прогон живого ответа агрегатора через ту же проверку, что и тесты:
//   ccfzf --state | node scripts/check-state.js
const { validateState } = require('../frontend-src/state-shape');

let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    console.error(`not json: ${e.message}`);
    process.exit(1);
  }
  const problems = validateState(obj);
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  console.log(`ok: ${obj.sessions.length} sessions`);
});
