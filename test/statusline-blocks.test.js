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

// Usage лимитов собран из кусков в двух файлах, и `generate_handler!` в
// main.rs правят параллельно другие ветки: при разрешении конфликта команда
// или толчок теряются молча — блок просто не появится или не уйдёт после
// стирания адреса. Поведением не поймать, сторож текстовый.
test('usage лимитов: поток, команды, толчок на config-changed и слушатель на месте', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'main.rs'), 'utf8');
  const handler = main.match(/generate_handler!\[([\s\S]*?)\]/);
  assert.ok(handler, 'generate_handler! не найден');
  assert.match(handler[1], /claude_usage::claude_usage\b/);
  assert.match(handler[1], /claude_usage::claude_usage_refresh\b/);
  assert.match(main, /claude_usage::spawn\(/);
  assert.match(main, /claude_usage::claude_usage_refresh\(\);\s*let _ = app\.emit\("config-changed"/);
  assert.match(html, /listen\('claude-usage'/);
  assert.match(html, /<span id="usage-block" hidden><\/span>/);
});

// Подсказка не растягивается: за ней стоит блок usage, и растянутая
// подсказка уносила бы его вправо, к галкам.
test('подсказка про меню не растягивается на всю строку', () => {
  const rule = html.match(/#menu-hint \{([^}]*)\}/);
  assert.ok(rule, 'правила #menu-hint нет');
  assert.match(rule[1], /flex: 0 1 auto/);
});
