const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeConfig } = require('../frontend-src/config-shape');

// Умолчание reptyr — false, хотя в бою в config.yaml стоит true (вердикт —
// см. архив скилла claude-wt). Это не рассинхрон: без конфига пикер не знает,
// установлен ли reptyr на той стороне, и обещать перенос процесса вслепую
// нельзя — незнание должно вести к перехвату с подтверждением, а не к команде,
// которой на хосте нет.
test('пустой конфиг даёт рабочие значения по умолчанию', () => {
  const c = normalizeConfig(null);
  // Умолчания у хоста нет и быть не может: любое значение здесь — либо чужое
  // имя машины, либо ложь. Пустой хост пикер показывает как ненастроенный
  // конфиг (check_ssh_host в src-tauri/src/main.rs).
  assert.strictEqual(c.sshHost, '');
  assert.strictEqual(c.hotkey, 'Cmd+Shift+C');
  assert.strictEqual(c.caps.reptyr, false);
  assert.strictEqual(c.caps.takeover, false);
  assert.strictEqual(c.onlyLive, true);
  assert.strictEqual(c.hideOnBlur, true);
  assert.deepStrictEqual(c.terminal, { file: '/opt/homebrew/bin/kitty', args: ['--single-instance'] });
  // Пустое имя машины — фокуса не бывает. Умолчания у него нет по той же
  // причине, что и у sshHost: любое значение было бы чужим именем машины.
  assert.strictEqual(c.windowHost, '');
  assert.deepStrictEqual(c.mqtt, { configured: false });
  // Умолчания у маппинга нет по той же причине: примонтировано у всех
  // по-своему, а угаданный корень увёл бы действия открытия не туда молча.
  assert.deepStrictEqual(c.pathMap, { remote: '', local: '' });
  assert.deepStrictEqual(c.actions, []);
});

// Корни сетевых дисков Windows пишутся формой UNC, а не буквой диска: буква
// вместе с разделителем — шаблон из no-private-data.test.js.
test('маппинг годен только целиком', () => {
  const map = raw => normalizeConfig({ pathMap: raw }).pathMap;
  assert.deepStrictEqual(map({ remote: '/home/user', local: '\\\\nas\\home' }), {
    remote: '/home/user', local: '\\\\nas\\home',
  });
  // Половина пары ведёт в никуда — маппинга нет.
  assert.deepStrictEqual(map({ remote: '/home/user' }), { remote: '', local: '' });
  assert.deepStrictEqual(map({ local: '\\\\nas\\home' }), { remote: '', local: '' });
  assert.deepStrictEqual(map({ remote: '  ', local: '\\\\nas\\home' }), { remote: '', local: '' });
  assert.deepStrictEqual(map('мусор'), { remote: '', local: '' });
});

test('действие без id или без argv выбрасывается, а не роняет конфиг', () => {
  const c = normalizeConfig({
    actions: [
      { label: 'без id', argv: ['x'] },
      { id: 'без argv' },
      { id: 'пустой argv', argv: [] },
      // Не-строка в argv: молча выброшенный аргумент собрал бы не ту команду.
      { id: 'кривой argv', argv: ['x', 42] },
      'вообще не объект',
      { id: 'годное', argv: ['x'] },
    ],
  });
  assert.deepStrictEqual(c.actions.map(a => a.id), ['годное']);
});

test('подпись действия по умолчанию — его id', () => {
  const [a] = normalizeConfig({ actions: [{ id: 'explorer', argv: ['x'] }] }).actions;
  assert.strictEqual(a.label, 'explorer');
});

test('неразобранная комбинация обнуляется, но действие остаётся', () => {
  // Опечатка в хоткее не повод прятать пункт, до которого человек и так дойдёт
  // через ^K.
  const [a] = normalizeConfig({ actions: [{ id: 'x', hotkey: 'Хрен+E', argv: ['x'] }] }).actions;
  assert.strictEqual(a.hotkey, '');
  assert.strictEqual(a.parsedHotkey, null);
  assert.strictEqual(a.id, 'x');
});

test('встроенная клавиша окна выигрывает у настроенной', () => {
  // ^I занят информацией о сессии: настроенное действие остаётся, но без
  // клавиши, иначе подпись в меню обещала бы то, чего не происходит.
  const [a] = normalizeConfig({ actions: [{ id: 'x', hotkey: 'Ctrl+I', argv: ['x'] }] }).actions;
  assert.strictEqual(a.hotkey, '');
  // Та же буква с добавленным модификатором свободна.
  const [b] = normalizeConfig({ actions: [{ id: 'x', hotkey: 'Ctrl+Shift+I', argv: ['x'] }] }).actions;
  assert.strictEqual(b.hotkey, 'Ctrl+Shift+I');
});

test('из двух действий на одной комбинации клавишу получает первое', () => {
  const c = normalizeConfig({
    actions: [
      { id: 'first', hotkey: 'Ctrl+Shift+E', argv: ['x'] },
      // Та же комбинация, записанная в другом порядке: сверяются разобранные
      // клавиши, а не строки из файла.
      { id: 'second', hotkey: 'Shift+Ctrl+E', argv: ['x'] },
    ],
  });
  assert.deepStrictEqual(c.actions.map(a => a.hotkey), ['Ctrl+Shift+E', '']);
});

test('повтор id выбрасывается: два пункта с одним именем не различить', () => {
  const c = normalizeConfig({
    actions: [
      { id: 'x', label: 'первое', argv: ['a'] },
      { id: 'x', label: 'второе', argv: ['b'] },
    ],
  });
  assert.deepStrictEqual(c.actions.map(a => a.label), ['первое']);
});

test('брокер считается настроенным только с адресом и префиксом сразу', () => {
  // Те же два условия, что и в Broker::is_configured на стороне Rust: без
  // адреса публиковать нечем, без префикса топиков — некуда.
  const has = (mqtt) => normalizeConfig({ mqtt }).mqtt.configured;
  assert.strictEqual(has({ host: 'broker', base: 'home/room/pc' }), true);
  assert.strictEqual(has({ host: 'broker' }), false);
  assert.strictEqual(has({ base: 'home/room/pc' }), false);
  assert.strictEqual(has({ host: '  ', base: 'home/room/pc' }), false);
  assert.strictEqual(has({ host: 42, base: 'home/room/pc' }), false);
  assert.strictEqual(has(undefined), false);
});

test('имя машины чистится от пробелов, мусор выключает фокус', () => {
  // Пробел вокруг имени — самая частая опечатка в yaml, и она сделала бы поле
  // непустым, но несовпадающим: фокус молча не работал бы, а причина не видна.
  assert.strictEqual(normalizeConfig({ windowHost: '  desktop-box ' }).windowHost, 'desktop-box');
  for (const windowHost of [42, {}, null, ['desktop-box']]) {
    assert.strictEqual(normalizeConfig({ windowHost }).windowHost, '', String(windowHost));
  }
});

test('заданные значения перекрывают умолчания', () => {
  const c = normalizeConfig({ sshHost: 'other', caps: { reptyr: true, takeover: true } });
  assert.strictEqual(c.sshHost, 'other');
  assert.strictEqual(c.caps.reptyr, true);
  assert.strictEqual(c.caps.takeover, true);
});

// Единственное поле с умолчанием true, поэтому его выключение проверяется
// отдельно: `false` не должен потеряться на проверке «значение задано».
test('поля с умолчанием true выключаются только явным false', () => {
  for (const key of ['onlyLive', 'hideOnBlur']) {
    assert.strictEqual(normalizeConfig({ [key]: false })[key], false, key);
    assert.strictEqual(normalizeConfig({ [key]: 'нет' })[key], true, key);
    assert.strictEqual(normalizeConfig({})[key], true, key);
  }
});

// Ключ уехал в windows11-manager: единственный источник хоткеев — его
// claudeWt.projects, а сюда список приезжает ответом агрегатора. Оставшийся в
// файле человека ключ читать нельзя — два списка снова разошлись бы.
test('projects из конфига не читается вовсе', () => {
  const cfg = normalizeConfig({
    sshHost: 'host', projects: [{ path: '/p/one', hotkey: 'Ctrl+F11' }],
  });
  assert.equal(cfg.projects, undefined);
});

test('backgroundRefresh по умолчанию включён', () => {
  // Умолчание true, а не false: фоновый опрос кормит панель openHASP, и
  // выключенным по умолчанию он молча лишал бы её обновлений.
  assert.strictEqual(normalizeConfig({}).backgroundRefresh, true);
  assert.strictEqual(normalizeConfig(null).backgroundRefresh, true);
  assert.strictEqual(normalizeConfig({ backgroundRefresh: false }).backgroundRefresh, false);
  // Нелогическое значение — умолчание, как у соседних ключей.
  assert.strictEqual(normalizeConfig({ backgroundRefresh: 'нет' }).backgroundRefresh, true);
});

// Иконку действия берут из отдельного ключа, а не из argv[0], потому что у
// самого частого действия argv[0] — это `cmd`: проводник открывается через
// `cmd /c start` (правило в CLAUDE.md), и иконка вышла бы от командной строки.
test('icon у действия доезжает до нормализованного конфига', () => {
  const c = normalizeConfig({
    actions: [{
      id: 'explorer',
      label: 'Open in Explorer',
      argv: ['cmd', '/c', 'start', '', '{localPathSlash}'],
      icon: '%SystemRoot%\\explorer.exe',
    }],
  });
  assert.strictEqual(c.actions[0].icon, '%SystemRoot%\\explorer.exe');
});

// То же правило, что у hotkey: испорченный ключ обнуляется, но действие
// остаётся в меню. Спрятать пункт из-за опечатки в иконке — потерять доступ к
// нему вовсе, а иконка тут украшение.
test('мусорный icon обнуляется, а действие остаётся в списке', () => {
  const c = normalizeConfig({ actions: [{ id: 'cursor', argv: ['cursor', '{localPath}'], icon: 42 }] });
  assert.strictEqual(c.actions.length, 1, 'опечатка в иконке не повод прятать пункт');
  assert.strictEqual(c.actions[0].icon, '');
});
