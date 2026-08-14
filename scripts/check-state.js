// Прогон живого ответа агрегатора через ту же проверку, что и тесты:
//   ccfzf --state | node scripts/check-state.js
const { validateState, projectProblems, snapshotProblems } = require('../frontend-src/state-shape');

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
  // Претензии к записям проектов выходом не считаются — ровно как в пикере:
  // такая запись просто не доедет до списка, а сессии живут своей жизнью.
  const soft = projectProblems(obj);
  for (const p of soft) console.error(`projects (не фатально): ${p}`);
  // И снимки — по той же причине: их записи приезжают от оконного трекера
  // через агрегатор, то есть с третьей машины, и порча там не повод объявить
  // весь ответ негодным. Без этой строки ручная проверка формы молчала бы про
  // снимки вообще: validateState смотрит только, массив ли поле.
  for (const p of snapshotProblems(obj)) console.error(`snapshots (не фатально): ${p}`);
  console.log(`ok: ${obj.sessions.length} sessions`);
});
