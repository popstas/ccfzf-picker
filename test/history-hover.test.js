const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');
const STYLE = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));

/** Правило, в селекторе которого есть каждый названный кусок. */
function ruleWith(...needles) {
  for (const [, selector, body] of STYLE.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (needles.every(n => selector.includes(n))) return { selector: selector.trim(), body: body.trim(), at: STYLE.indexOf(selector) };
  }
  return null;
}

// Решение владельца 16.11.2026: «не затемнять сессии в history, когда на список
// сессий в истории наведён курсор». Гасит их галка «dim stale» (история почти
// вся старше порога), а наведение возвращало яркость одной строке под мышью.
// Теперь — всем строкам блока истории, пока курсор над ним.
test('курсор над блоком истории делает яркими все её старые строки', () => {
  const rule = ruleWith('[data-block="past"]:hover', '.row.stale');
  assert.ok(rule, 'правило для блока истории под курсором пропало');
  assert.match(rule.body, /opacity:\s*1/);
  // Истории по рабочим столам — те же блоки с ключом `past:<стол>`.
  assert.ok(rule.selector.includes('[data-block^="past:"]:hover'), rule.selector);
  // После общего правила `.row.stale` — иначе порядок в файле решил бы спор
  // против него.
  assert.ok(rule.at > STYLE.indexOf('.row.stale {'), 'правило стоит раньше .row.stale');
});

test('гашение по проекту (dim-other) курсор над историей не снимает', () => {
  const rule = ruleWith('[data-block="past"]:hover', '.row.stale');
  assert.ok(rule && rule.selector.includes(':not(.dim-other)'), rule && rule.selector);
});

// Стас 16.11.2026: «затемнение пропало, но также пропала подсветка строки при
// наведении на ряд». Старой строке фон под мышью снят (`.row.stale:not(.active):hover`),
// сигналом наведения был скачок яркости 0.5 → 1, — а в истории под курсором
// яркие теперь все, и строка под мышью ничем не выделялась. Внутри блока
// истории ей возвращается фон наведения; оба правила проверяются вместе.
test('в яркой истории строка под курсором снова подсвечена фоном', () => {
  const bright = ruleWith('[data-block="past"]:hover', '.row.stale');
  const row = ruleWith('[data-block="past"]', '.row.stale:not(.active):hover');
  assert.ok(bright && /opacity:\s*1/.test(bright.body), 'яркость истории под курсором пропала');
  assert.ok(row, 'подсветки строки под курсором в истории нет');
  assert.match(row.body, /background:\s*var\(--row-hover\)/);
  assert.ok(row.selector.includes('[data-block^="past:"]'), row.selector);
  // После `background: none` у старой строки — иначе порядок в файле решил бы
  // спор против подсветки.
  assert.ok(row.at > STYLE.indexOf('.row.stale:not(.active):hover { background: none; }'),
    'подсветка стоит раньше правила, которое её снимает');
});
