const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');

// Выключатели блоков статуслайна лежат в config.yaml (см. config-shape.js), и
// менять их на месте обязана та же пара мест, что перекрашивает тему: загрузка
// и `config-changed`. Поведением это не поймать — страницу тесты не грузят, —
// поэтому сторож текстовый: применение стоит рядом с `applyTheme()` везде, где
// стоит она.
test('блоки статуслайна применяются везде, где перечитывается тема', () => {
  const themes = html.match(/applyTheme\(\);\n\s*applyStatusline\(\);/g) || [];
  const calls = html.match(/^\s*applyTheme\(\);$/gm) || [];
  assert.ok(calls.length >= 2, 'applyTheme зовётся хотя бы с загрузки и с config-changed');
  assert.strictEqual(themes.length, calls.length, 'applyStatusline отстала от applyTheme');
});

// `display: flex` у #sort-control по специфичности перебивает атрибут
// `hidden`: без явного правила выключенный переключатель оставался бы на месте.
test('спрятанный блок статуслайна действительно пропадает', () => {
  assert.match(html, /#statusline \[hidden\] \{ display: none; \}/);
});

// Подсказка не растягивается: за ней стоит блок usage, и растянутая
// подсказка уносила бы его вправо, к галкам.
test('подсказка про меню не растягивается на всю строку', () => {
  const rule = html.match(/#menu-hint \{([^}]*)\}/);
  assert.ok(rule, 'правила #menu-hint нет');
  assert.match(rule[1], /flex: 0 1 auto/);
});
