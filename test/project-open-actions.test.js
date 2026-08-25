// Что делает выбор проекта — настройка, и живёт она в трёх местах на двух
// языках: таблица `PROJECT_OPEN_ACTIONS` в `src-tauri/src/main.rs` решает по
// значению (её же читает проектный хоткей), `PROJECT_OPEN_ACTIONS` в
// `frontend-src/settings-form.js` показывает человеку список, а
// `config-shape.js` разбирает значение для страницы. Общего кода тут быть не
// может, и потому согласие держит этот сторож — тем же приёмом, что у
// `TRAY_CLICK_ACTIONS` и `terminal_name`.
//
// Ловит он самый тихий отказ из возможных. Предложи окно значение, которого
// Rust не знает, — оно запишется в `config.yaml`, разбор откатит его на
// умолчание, и клавиша будет делать не то, что выбрано. Ни ошибки, ни следа:
// ответа у публикации нет вовсе, а обе половинки по отдельности работают
// верно.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PAGES } = require('../frontend-src/settings-form');
const { DEFAULTS, normalizeConfig } = require('../frontend-src/config-shape');

const SRC = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const MAIN_RS = SRC('src-tauri', 'src', 'main.rs');
const HOTKEYS_RS = SRC('src-tauri', 'src', 'project_hotkeys.rs');
const SESSIONS_HTML = SRC('sessions.html');

/** Записи `PROJECT_OPEN_ACTIONS` из main.rs: значение конфига и подпись. */
function rustActions() {
  const table = MAIN_RS.match(/const PROJECT_OPEN_ACTIONS[^=]*=\s*\[([\s\S]*?)\];/);
  assert.ok(table, 'таблица PROJECT_OPEN_ACTIONS не найдена в main.rs');
  const rows = [...table[1].matchAll(/\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)];
  assert.ok(rows.length, 'в PROJECT_OPEN_ACTIONS не разобрано ни одной записи');
  return rows.map(([, value, label]) => ({ value, label }));
}

/** Обе выпадашки действия проекта — на разных вкладках, список у них один. */
function choiceFields() {
  const fields = PAGES.flatMap(p => p.fields)
    .filter(f => f.type === 'choice' && f.id.startsWith('project'));
  assert.strictEqual(fields.length, 2, 'выпадашек действия проекта не две');
  return fields;
}

test('окно настроек предлагает ровно те действия, которые умеет Rust', () => {
  const expected = rustActions();
  for (const field of choiceFields()) {
    assert.deepStrictEqual(
      field.options.map(o => ({ value: o.value, label: o.label })),
      expected,
      `список поля ${field.id} разошёлся с PROJECT_OPEN_ACTIONS`,
    );
  }
});

test('умолчания у обоих входов из той же таблицы', () => {
  // Названное мимо таблицы значило бы, что выпадашка открывается с пунктом,
  // которого в ней нет, — то есть ни с каким.
  const known = rustActions().map(a => a.value);
  const byId = Object.fromEntries(choiceFields().map(f => [f.id, f.default]));
  for (const [id, value] of Object.entries(byId)) {
    assert.ok(known.includes(value), `умолчание ${value} поля ${id} не из таблицы`);
  }
  // Сегодня они совпали: от выбора проекта ждут начала работы, а вернуться в
  // идущую сессию есть чем и без того — у неё своя строка в списке. Клавиши
  // это касается вдвойне: её жмут при скрытом пикере, чей снимок отстаёт до
  // восьми минут, и `focus` сбывался через раз.
  assert.strictEqual(byId.projectOpenAction, 'new');
  assert.strictEqual(byId.projectHotkeyAction, 'new');
});

test('умолчания те же, по каким живут страница и Rust', () => {
  // Разойдись они — окно показывало бы одно действие, а ненастроенный вход
  // делал бы другое: ключа в config.yaml нет, пока человек его не выбрал.
  assert.strictEqual(DEFAULTS.projectOpenAction, 'new');
  assert.ok(
    HOTKEYS_RS.includes('project_open_action(&raw, "projectHotkeyAction", "new")'),
    'проектный хоткей читает не тот ключ или не с тем умолчанием',
  );
});

test('страница разбирает значение так же, как Rust', () => {
  // Регистр и пробелы прощаются с обеих сторон: человек правит config.yaml
  // руками. Незнакомое, пустое и отсутствующее — умолчание, а не пустота:
  // пустое значение развилки оставило бы Enter без ветки вовсе.
  const at = (raw) => normalizeConfig({ projectOpenAction: raw }).projectOpenAction;
  assert.strictEqual(at('focus'), 'focus');
  assert.strictEqual(at(' Focus '), 'focus');
  assert.strictEqual(at('new'), 'new');
  for (const bad of ['не действие', '', '   ', undefined, null, 42, {}]) {
    assert.strictEqual(at(bad), 'new', `значение ${JSON.stringify(bad)} увело умолчание`);
  }
  assert.strictEqual(normalizeConfig({}).projectOpenAction, 'new');
});

/**
 * Настоящая `openProjectRow` из sessions.html, прогнанная в vm.
 *
 * Копию сюда не переносим: она разъехалась бы молча, а сторож остался бы
 * зелёным — тот же приём, что у `test/hide-before-request.test.js`.
 */
function openProjectRow(projectOpenAction) {
  const re = /\n {2}async function openProjectRow\([\s\S]*?\n {2}\}\n/;
  const source = SESSIONS_HTML.match(re);
  assert.ok(source, 'openProjectRow не найдена в sessions.html — тест сторожит не то');
  const calls = [];
  const ctx = {
    invoke: (cmd) => { calls.push(cmd); return Promise.resolve(); },
    CONFIG: { windowHost: 'pc-win', mqtt: { configured: true }, projectOpenAction },
    // Под Windows у своей строки настройка не решает ничего — там своя ветка
    // (поднять окно каталога либо открыть папку). Этот сторож про настройку.
    PICKER_OS: 'linux',
    window: {
      OpenTransport: {
        rowProjectDir: (row) => row.cwd,
        chooseProjectOpenAction: () => 'manager',
        isWindowsLocalRow: () => false,
      },
      OpenStrategy: { newSessionName: () => 'x-2' },
    },
    issuedNames: new Map(),
    newSessionHere: () => { calls.push('newSessionHere'); return Promise.resolve(); },
    openManagerHere: () => ({ host: 'pc-win', mqttBase: 'windows/pc-win' }),
    managerBase: () => 'windows/pc-win',
    // Пустой адрес — mqtt-ветка: этот сторож про настройку projectOpenAction,
    // а не про развилку транспорта.
    managerHttpHere: () => '',
    // Достижимость менеджера — заглушка с тем же именем, что и у настоящего
    // помощника: этот сторож про настройку projectOpenAction, а не про
    // развилку транспорта.
    managerReachable: () => true,
    render: () => {},
    error: '',
    row: { kind: 'project', cwd: '/home/user/projects/x' },
  };
  vm.createContext(ctx);
  vm.runInContext(`${source[0]}\nresult = openProjectRow(row);`, ctx, { filename: 'sessions.html' });
  return ctx.result.then(() => calls);
}

test('при new Enter на строке проекта заводит новую сессию', async () => {
  // Через ту же `newSessionHere`, а не своей копией: там уже написаны имя,
  // занятие имени, гашение и откат на местную дорогу. Вторая копия разошлась
  // бы с первой — ровно на этой мине подорвался `newSession` с argv терминала.
  const calls = await openProjectRow('new');
  assert.deepStrictEqual(calls, ['newSessionHere']);
});

test('при focus Enter по-прежнему просит поднять открытое окно', async () => {
  // Прежнее поведение обязано остаться достижимым: ключ затем и заведён.
  const calls = await openProjectRow('focus');
  assert.ok(calls.includes('open_project_mqtt'), calls.join(', '));
  assert.ok(!calls.includes('newSessionHere'), calls.join(', '));
});
