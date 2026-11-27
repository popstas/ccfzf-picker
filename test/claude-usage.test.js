const { test } = require('node:test');
const assert = require('node:assert');
const { usageView, usageHtml, FRESH_DATA_MINUTES, HOT_MINUTES } = require('../frontend-src/claude-usage');

// Формулы — те же, что у `llm-usage-update-image` на домашнем сервере
// (`deviation_days_text`, `remaining_text`, `FRESH_DATA_MINUTES`): блок в
// пикере и картинка на панели обязаны говорить одно и то же.
const NOW = 1_800_000_000;
const iso = sec => new Date(sec * 1000).toISOString();
const fresh = { updated_at: iso(NOW - 60) };
const fiveHour = (usedPercent, leftMin) => ({ ...fresh, fiveHour: { usedPercent, resetsAtUnix: NOW + leftMin * 60 } });

test('пример из ноты: 43% за 54 минуты до сброса — отставание на 117 минут', () => {
  const v = usageView(fiveHour(43, 54), NOW);
  assert.strictEqual(v.fiveHour.pct, 43);
  assert.strictEqual(v.fiveHour.offset, '-117m');
  assert.strictEqual(v.fiveHour.left, '54m left');
  assert.strictEqual(v.fiveHour.offsetHot, false);
});

test('неделя: offset в днях, один знак, плюс у опережения', () => {
  // Осталось 3,5 дня — прошла половина недели; 60% против 50% — +10% = +0,7 дня.
  const v = usageView({ ...fresh, weekly: { usedPercent: 60, resetsAtUnix: NOW + 3.5 * 86400 } }, NOW);
  assert.strictEqual(v.week.pct, 60);
  assert.strictEqual(v.week.offset, '+0.7d');
  const behind = usageView({ ...fresh, weekly: { usedPercent: 40, resetsAtUnix: NOW + 3.5 * 86400 } }, NOW);
  assert.strictEqual(behind.week.offset, '-0.7d');
});

test('offset 5h красный строго больше +15m', () => {
  // 150 минут до сброса — прошла половина окна; 55% — ровно +15m, 56% — +18m.
  assert.strictEqual(HOT_MINUTES, 15);
  const edge = usageView(fiveHour(55, 150), NOW);
  assert.strictEqual(edge.fiveHour.offset, '+15m');
  assert.strictEqual(edge.fiveHour.offsetHot, false);
  const hot = usageView(fiveHour(56, 150), NOW);
  assert.strictEqual(hot.fiveHour.offset, '+18m');
  assert.strictEqual(hot.fiveHour.offsetHot, true);
});

test('время до сброса: минуты, часы с десятой, сброс прошёл', () => {
  assert.strictEqual(usageView(fiveHour(10, 89), NOW).fiveHour.left, '89m left');
  assert.strictEqual(usageView(fiveHour(10, 100), NOW).fiveHour.left, '1.7h left');
  assert.strictEqual(usageView(fiveHour(10, 0), NOW).fiveHour.left, 'reset due');
  assert.strictEqual(usageView(fiveHour(10, -5), NOW).fiveHour.left, 'reset due');
});

test('окно 5h не начато: без offset и без NaN', () => {
  const v = usageView({ ...fresh, fiveHour: { usedPercent: 0, resetsAtUnix: null } }, NOW);
  assert.strictEqual(v.fiveHour.offset, '');
  assert.strictEqual(v.fiveHour.left, 'not started');
  assert.strictEqual(v.fiveHour.offsetHot, false);
  assert.doesNotMatch(usageHtml(v), /NaN/);
});

test('нулевой offset — без знака: 0m и 0.0d', () => {
  assert.strictEqual(usageView(fiveHour(50, 150), NOW).fiveHour.offset, '0m');
  // −0,1% отставания округляется к нулю минут: минус у нуля не печатается.
  assert.strictEqual(usageView(fiveHour(50, 149.9), NOW).fiveHour.offset, '0m');
  const week = usageView({ ...fresh, weekly: { usedPercent: 50, resetsAtUnix: NOW + 3.5 * 86400 + 60 } }, NOW);
  assert.strictEqual(week.week.offset, '0.0d');
});

test('процент — целое 0..100, как int() скрипта', () => {
  assert.strictEqual(usageView(fiveHour('55', 60), NOW).fiveHour.pct, 55);
  assert.strictEqual(usageView(fiveHour(120, 60), NOW).fiveHour.pct, 100);
  assert.strictEqual(usageView(fiveHour(-3, 60), NOW).fiveHour.pct, 0);
  assert.strictEqual(usageView(fiveHour(55.9, 60), NOW).fiveHour.pct, 55);
});

test('свежесть: порог FRESH_DATA_MINUTES = 5.2, ошибка загрузки — тоже серый', () => {
  assert.strictEqual(FRESH_DATA_MINUTES, 5.2);
  const at = min => ({ ...fiveHour(10, 60), updated_at: iso(NOW - min * 60) });
  assert.strictEqual(usageView(at(5), NOW).stale, false);
  assert.strictEqual(usageView(at(6), NOW).stale, true);
  assert.strictEqual(usageView(at(1), NOW, { failed: true }).stale, true);
  // Отметки нет вовсе — поручиться за свежесть нечем.
  const { updated_at, ...noStamp } = fiveHour(10, 60);
  assert.strictEqual(usageView(noStamp, NOW).stale, true);
  // Число секунд вместо ISO скрипт тоже понимает.
  assert.strictEqual(usageView({ ...fiveHour(10, 60), updated_at: NOW - 30 }, NOW).stale, false);
});

test('данных нет — блока нет', () => {
  assert.strictEqual(usageView(null, NOW), null);
  assert.strictEqual(usageView({}, NOW), null);
  assert.strictEqual(usageView('oops', NOW), null);
});

test('строка блока: обе части через черту, порядок как в ноте', () => {
  const data = {
    ...fresh,
    fiveHour: { usedPercent: 43, resetsAtUnix: NOW + 54 * 60 },
    weekly: { usedPercent: 60, resetsAtUnix: NOW + 3.5 * 86400 },
  };
  const text = usageHtml(usageView(data, NOW)).replace(/<[^>]+>/g, '');
  assert.strictEqual(text, '5h: 43% -117m 54m left | week: 60% +0.7d');
});

test('красный offset — классом hot, и только на свежих данных', () => {
  const hot = usageHtml(usageView(fiveHour(56, 150), NOW));
  assert.match(hot, /class="usage-off hot"/);
  const stale = usageHtml(usageView({ ...fiveHour(56, 150), updated_at: iso(NOW - 3600) }, NOW));
  assert.doesNotMatch(stale, /hot/);
});

test('одна часть без другой рисуется без черты', () => {
  const week = usageHtml(usageView({ ...fresh, weekly: { usedPercent: 60, resetsAtUnix: NOW + 3.5 * 86400 } }, NOW));
  assert.strictEqual(week.replace(/<[^>]+>/g, ''), 'week: 60% +0.7d');
});
