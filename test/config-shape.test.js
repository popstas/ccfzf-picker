const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeConfig } = require('../frontend-src/config-shape');

// Умолчание reptyr — false, хотя в бою в config.yaml стоит true (вердикт —
// см. архив скилла claude-wt). Это не рассинхрон: без конфига пикер не знает,
// установлен ли reptyr на той стороне, и обещать перенос процесса вслепую
// нельзя — незнание должно вести к перехвату с подтверждением, а не к команде,
// которой на хосте нет.
test('пустой конфиг даёт рабочие значения по умолчанию', () => {
  const c = normalizeConfig(null);
  // Умолчания у хоста нет и быть не может: любое значение здесь — либо чужое
  // имя машины, либо ложь. Пустой хост при выключенном localSource даёт
  // пустой список источников, а пустой список источников пикер показывает
  // как ненастроенный конфиг (sources_from в src-tauri/src/state_source.rs,
  // проверка в poller.rs).
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

test('menuKey у действия приводится к одной букве, мусор выбрасывается', () => {
  // Приводится здесь, а не при показе меню: разбирать одно и то же дважды —
  // тот самый второй список, за который в этом проекте уже платили.
  const cfg = normalizeConfig({
    actions: [
      { id: 'cursor', label: 'Cursor', argv: ['cursor', '{localPath}'], menuKey: ' O ' },
      { id: 'plain', label: 'Plain', argv: ['echo'] },
    ],
  });
  assert.strictEqual(cfg.actions[0].menuKey, 'o');
  assert.strictEqual(cfg.actions[1].menuKey, '');
});

// ── второй глобальный хоткей ────────────────────────────────────────────────
test('умолчание второго хоткея пустое, а не комбинация', () => {
  // Умолчаний у него два, по одному на систему, и живут они в Rust, где видно
  // систему. Запиши сюда одно из двух — и окно настроек, сохранившись на
  // другой системе, увезло бы в конфиг чужую клавишу.
  assert.strictEqual(normalizeConfig(null).projectsHotkey, '');
});

test('заданный второй хоткей проходит как написан', () => {
  assert.strictEqual(
    normalizeConfig({ projectsHotkey: 'Ctrl+Alt+P' }).projectsHotkey,
    'Ctrl+Alt+P',
  );
});

test('пустая строка второго хоткея остаётся пустой', () => {
  // Пусто значит «взять встроенное», и подменять её умолчанием тут нечем.
  assert.strictEqual(normalizeConfig({ projectsHotkey: '' }).projectsHotkey, '');
  assert.strictEqual(normalizeConfig({ projectsHotkey: 42 }).projectsHotkey, '');
});

// ── Размер окна долями экрана ──────────────────────────────────────────────

test('без ключа размер окна встроенный, а не нулевой процент', () => {
  // Ключа `pickerSize` у большинства нет вовсе, и его отсутствие обязано
  // читаться как «как было». Ноль здесь и значит «встроенный размер» — не
  // «схлопнуть окно».
  const size = normalizeConfig({}).pickerSize;
  assert.deepStrictEqual(size, { narrow: { width: 0, height: 0 }, wide: { width: 0, height: 0 } });
});

test('доли экрана читаются по стороне и по раскладке', () => {
  const size = normalizeConfig({
    pickerSize: { narrow: { height: 80 }, wide: { width: 95 } },
  }).pickerSize;
  assert.deepStrictEqual(size, {
    narrow: { width: 0, height: 80 },
    wide: { width: 95, height: 0 },
  });
});

test('испорченная доля выбрасывается, а не роняет конфиг', () => {
  const height = raw => normalizeConfig({ pickerSize: { narrow: { height: raw } } })
    .pickerSize.narrow.height;
  // 300 из этого списка ушёл: с приходом пикселей это больше не мусор, а
  // валидный размер, — см. отдельные проверки ниже.
  for (const bad of ['восемьдесят', null, undefined, {}, [], NaN, -10, Infinity]) {
    assert.strictEqual(height(bad), 0, `${JSON.stringify(bad)} должно читаться как встроенный размер`);
  }
  // Дробное меньше единицы — не доля и не пиксели, отсекается тем же нулём.
  assert.strictEqual(height(0.5), 0);
  assert.strictEqual(height(0), 0);
  // Границы диапазона — рабочие значения, а не отказ. Число строкой тоже
  // годится: yaml отдаёт `height: "80"` строкой, а значит это то же самое.
  assert.strictEqual(height(1), 1);
  assert.strictEqual(height(100), 100);
  assert.strictEqual(height('80'), 80);
});

// ≥101 — пиксели, а не доля экрана: тот же счётчик без верхней границы.
// Здесь только JS-сторона (Task 8); Rust читает то же число своим
// scale_axis/wanted_size в Task 9.
test('пиксели ≥ 101 проходят нормализацию', () => {
  assert.strictEqual(
    normalizeConfig({ pickerSize: { narrow: { width: 1400, height: 65 } } }).pickerSize.narrow.width,
    1400,
  );
  assert.strictEqual(
    normalizeConfig({ pickerSize: { wide: { width: 101 } } }).pickerSize.wide.width,
    101,
  );
  assert.strictEqual(
    normalizeConfig({ pickerSize: { wide: { width: 80 } } }).pickerSize.wide.width,
    80,
  );
  assert.strictEqual(
    normalizeConfig({ pickerSize: { wide: { width: 0 } } }).pickerSize.wide.width,
    0,
  );
});

// Проверок две — размер ставит Rust (`scale_axis` в main.rs), а показывает
// выбор страница, — и разойтись им нельзя: показанное «80%» при отвергнутом
// Rust'ом значении читалось бы как сломанное окно. Этот сторож — только
// первая линия: он сверяет, что нужные ветки вообще есть в тексте Rust,
// потому что выполнить сам Rust отсюда нечем. Поведение на конкретных числах
// сверяет следующий тест, боевой список.
test('границы доли те же, по которым судит Rust', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'main.rs'), 'utf8');
  const fn = src.match(/fn scale_axis\([\s\S]*?\n\}\n/);
  assert.ok(fn, 'scale_axis не найдена в main.rs — тест сторожит не то');
  assert.ok(fn[0].includes('(1.0..=100.0)'), 'диапазон долей в Rust разошёлся с диапазоном здесь');
  assert.ok(
    fn[0].includes('101.0') || fn[0].includes('>= 101'),
    'ветка пикселей (≥101) в Rust разошлась с диапазоном здесь',
  );
});

// Список — источник истины для JS; тот же список по смыслу живёт в Rust
// (`scale_axis_boundary_table_matches_js` в main.rs) и обязан давать те же
// ответы на каждое число. Текстовый сторож выше ловит пропавшую ветку в
// исходнике, а не разошедшееся поведение — 300 когда-то читался Rust'ом как
// мусор, а этот список поймал бы именно такое расхождение, прогнав оба конца
// по одним числам, а не по упоминанию диапазона в тексте.
const SIZE_BOUNDARY_TABLE = [
  [0, 0], // встроенный размер
  [0.5, 0], // дробное меньше единицы — не доля и не пиксели
  [1, 1], // нижняя граница доли
  [100, 100], // верхняя граница доли
  [100.5, 0], // зазор между долей и пикселями — свой мусор
  [101, 101], // нижняя граница пикселей
  [1400, 1400], // рабочий размер в пикселях
  [-10, 0], // отрицательное
  [Infinity, 0], // не конечное — `Number.isFinite`/`f64::is_finite` отсекают
  [NaN, 0], // не число
];

test('таблица граничных значений размера совпадает с Rust', () => {
  for (const [raw, expected] of SIZE_BOUNDARY_TABLE) {
    const got = normalizeConfig({ pickerSize: { narrow: { width: raw } } }).pickerSize.narrow.width;
    assert.strictEqual(got, expected, `width=${raw}: ожидали ${expected}, получили ${got}`);
  }
});

// ── Затемнение старых строк ────────────────────────────────────────────────

test('stale по умолчанию выключен и несёт часовые пороги с opacity', () => {
  assert.deepStrictEqual(normalizeConfig({}).stale, {
    enabled: false,
    sessionHours: 2,
    projectHours: 24,
    opacity: 0.5,
  });
});

test('корректные stale-настройки проходят числами', () => {
  assert.deepStrictEqual(normalizeConfig({
    stale: { enabled: true, sessionHours: '3.5', projectHours: '36', opacity: '0.7' },
  }).stale, {
    enabled: true,
    sessionHours: 3.5,
    projectHours: 36,
    opacity: 0.7,
  });
});

test('старый projectDays полностью игнорируется', () => {
  const stale = normalizeConfig({ stale: { projectDays: 30 } }).stale;
  assert.strictEqual(stale.projectHours, 24);
  assert.ok(!Object.hasOwn(stale, 'projectDays'));
});

test('stale-числа не принимают значения других типов через Number coercion', () => {
  for (const [id, validValue, fallback] of [
    ['sessionHours', 3.5, 2],
    ['projectHours', 36, 24],
    ['opacity', 0.7, 0.5],
  ]) {
    for (const malformed of [true, [validValue], { valueOf: () => validValue }]) {
      const actual = normalizeConfig({ stale: { [id]: malformed } }).stale[id];
      assert.strictEqual(actual, fallback, `${id} принял ${Object.prototype.toString.call(malformed)}`);
    }
  }
});

test('испорченное stale-поле сбрасывает только себя', () => {
  assert.deepStrictEqual(normalizeConfig({
    stale: { enabled: 'yes', sessionHours: 0, projectHours: 10, opacity: 2 },
  }).stale, {
    enabled: false,
    sessionHours: 2,
    projectHours: 10,
    opacity: 0.5,
  });
  assert.deepStrictEqual(normalizeConfig({ stale: null }).stale, {
    enabled: false,
    sessionHours: 2,
    projectHours: 24,
    opacity: 0.5,
  });
});

// ── Подложка позади пикера ─────────────────────────────────────────────────

test('scrim по умолчанию выключен в обеих раскладках', () => {
  assert.deepStrictEqual(normalizeConfig({}).scrim, { narrow: false, wide: false });
  assert.deepStrictEqual(normalizeConfig({ scrim: null }).scrim, { narrow: false, wide: false });
});

test('scrim принимает один флаг, не трогая соседний', () => {
  assert.deepStrictEqual(normalizeConfig({ scrim: { wide: true } }).scrim,
    { narrow: false, wide: true });
  assert.deepStrictEqual(normalizeConfig({ scrim: { narrow: true } }).scrim,
    { narrow: true, wide: false });
});

// ── На каком мониторе открывать пикер ──────────────────────────────────────

// Умолчание — главный монитор: место окна должно быть одним и тем же от
// открытия к открытию, чтобы рука вела глаз туда, где список появится.
// Правило то же, по которому судит Rust (`show_on_active_display` в main.rs):
// разойдись они, окно вставало бы не там, где обещает галка.
test('showOnActiveDisplay по умолчанию выключен', () => {
  assert.strictEqual(normalizeConfig({}).showOnActiveDisplay, false);
  assert.strictEqual(normalizeConfig({ showOnActiveDisplay: null }).showOnActiveDisplay, false);
  assert.strictEqual(normalizeConfig({ showOnActiveDisplay: 'yes' }).showOnActiveDisplay, false);
});

test('showOnActiveDisplay принимает булево как есть', () => {
  assert.strictEqual(normalizeConfig({ showOnActiveDisplay: true }).showOnActiveDisplay, true);
  assert.strictEqual(normalizeConfig({ showOnActiveDisplay: false }).showOnActiveDisplay, false);
});

// Галка соседняя, но не половинка предыдущей: та про окно списка, эта про окно
// терминала. Независимость проверяется прямо — связав их когда-нибудь, ошибку
// увидели бы только глазами, на второй машине.
test('openOnActiveDisplay по умолчанию выключен и не связан с соседкой', () => {
  assert.strictEqual(normalizeConfig({}).openOnActiveDisplay, false);
  assert.strictEqual(normalizeConfig({ openOnActiveDisplay: null }).openOnActiveDisplay, false);
  assert.strictEqual(normalizeConfig({ openOnActiveDisplay: 'yes' }).openOnActiveDisplay, false);
  assert.strictEqual(normalizeConfig({ showOnActiveDisplay: true }).openOnActiveDisplay, false);
  assert.strictEqual(normalizeConfig({ openOnActiveDisplay: true }).showOnActiveDisplay, false);
});

test('openOnActiveDisplay принимает булево как есть', () => {
  assert.strictEqual(normalizeConfig({ openOnActiveDisplay: true }).openOnActiveDisplay, true);
  assert.strictEqual(normalizeConfig({ openOnActiveDisplay: false }).openOnActiveDisplay, false);
});

test('editor: умолчание cursor, пустая строка возвращает его же', () => {
  // Ключ нужен ради встроенных пунктов «Open plan» / «Open spec»: они обязаны
  // работать из коробки, иначе значок в строке обещал бы то, чего нет.
  // Умолчание — cursor: им и открывают.
  assert.strictEqual(normalizeConfig({}).editor, 'cursor');
  assert.strictEqual(normalizeConfig({ editor: '   ' }).editor, 'cursor');
  assert.strictEqual(normalizeConfig({ editor: 42 }).editor, 'cursor');
});

test('editor: названный редактор доезжает подрезанным', () => {
  assert.strictEqual(normalizeConfig({ editor: '  code  ' }).editor, 'code');
});

test('localSource — булев флаг с умолчанием true', () => {
  // Умолчание включено: свои сессии человек ждёт в списке, ничего не
  // настраивая, а забытая галка выглядит пропажей сессий, а не настройкой.
  // Выключается только явным false — на Windows, где местного ccfzf нет.
  assert.strictEqual(normalizeConfig({}).localSource, true);
  assert.strictEqual(normalizeConfig({ localSource: false }).localSource, false);
  // Не булево — то же, что отсутствие ключа, то есть умолчание.
  assert.strictEqual(normalizeConfig({ localSource: 'да' }).localSource, true);
});
