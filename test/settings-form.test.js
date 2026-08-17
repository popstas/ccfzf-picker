const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeConfig } = require('../frontend-src/config-shape');
const { PAGES, configToFields, fieldsToPatch, validate } = require('../frontend-src/settings-form');

// Обе высоты присутствуют явно и нейтральны (0 — Default): без этого
// `configToFields` подставила бы отсутствующим ключам 65 (см. тесты про
// высоту ниже), и раунд-трип `configToFields → fieldsToPatch` без единой
// правки человека давал бы непустой патч на pickerSize — тесты ниже проверяют
// совсем другое и не должны спотыкаться об этот побочный эффект.
const NO_PICKER_SIZE = { pickerSize: { narrow: { height: 0 }, wide: { height: 0 } } };

test('страницы перечисляют поля без повторов', () => {
  // Одно поле на двух страницах означало бы два источника правды для одного
  // ключа: сохранив одну страницу, человек молча откатил бы вторую.
  const ids = PAGES.flatMap(p => p.fields.map(f => f.id));
  assert.deepStrictEqual([...new Set(ids)], ids);
  assert.deepStrictEqual(PAGES.map(p => p.id),
    ['general', 'window', 'columns', 'panels', 'hotkeys', 'mqtt', 'paths']);
});

test('windowHost живёт на General, mqtt и pathMap — на своих вкладках', () => {
  const ids = (page) => PAGES.find(p => p.id === page).fields.map(f => f.id);
  assert.ok(ids('general').includes('windowHost'));
  assert.ok(ids('mqtt').some(id => id.startsWith('mqtt.')));
  assert.ok(ids('paths').some(id => id.startsWith('pathMap.')));
  assert.ok(!PAGES.some(p => p.id === 'integrations'));
  assert.ok(!PAGES.some(p => p.id === 'ui'));
});

test('конфиг раскладывается по полям формы', () => {
  const fields = configToFields({
    sshHost: 'host',
    terminal: { file: '/usr/bin/wt', args: ['-w', '0'] },
    onlyLive: false,
    mqtt: { host: 'broker', port: 1883, base: 'home/room/pc', password: 'secret' },
  });
  assert.strictEqual(fields.sshHost, 'host');
  assert.strictEqual(fields['terminal.file'], '/usr/bin/wt');
  // Аргументы редактируются строкой по одному на строку: массив в поле ввода
  // не положить, а запятая встречается в самих аргументах.
  assert.strictEqual(fields['terminal.args'], '-w\n0');
  assert.strictEqual(fields.onlyLive, false);
  assert.strictEqual(fields['mqtt.port'], 1883);
  // Пароль в форму не кладётся вовсе: он ездил бы через мост в webview на
  // каждое открытие настроек, а показывать его незачем.
  assert.strictEqual(fields['mqtt.password'], '');
});

test('галка без ключа в конфиге показывает своё умолчание, а не false', () => {
  // onlyLive, hideOnBlur и backgroundRefresh при отсутствии ключа считаются
  // включёнными — так их читают и DEFAULTS в config-shape.js, и Rust через
  // unwrap_or(true). Пустая галка показывала бы выключенным то, что работает
  // включённым, и проверить это можно было бы только по поведению пикера.
  const fields = configToFields({ sshHost: 'host' });
  for (const id of ['onlyLive', 'hideOnBlur', 'backgroundRefresh']) {
    assert.strictEqual(fields[id], true, id);
  }
  // А те, у кого умолчание false, остаются пустыми: незнание про ту сторону
  // ведёт к resume, а не к перехвату чужого процесса под сигналом.
  assert.strictEqual(fields['caps.reptyr'], false);
  assert.strictEqual(fields['caps.takeover'], false);
});

test('умолчание галки не уезжает в патч само по себе', () => {
  // Иначе первое же сохранение вписало бы человеку в config.yaml три ключа,
  // которых он не трогал, — а файл этот ведёт окно и комментарии в нём при
  // перезаписи теряются. Снятая галка при этом обязана дойти.
  const original = { sshHost: 'host', ...NO_PICKER_SIZE };
  const fields = configToFields(original);
  assert.deepStrictEqual(fieldsToPatch(fields, original), {});
  assert.deepStrictEqual(
    fieldsToPatch({ ...fields, hideOnBlur: false }, original),
    { hideOnBlur: false },
  );
});

test('в патч уходит только изменённое', () => {
  const original = { sshHost: 'host', onlyLive: true, ...NO_PICKER_SIZE };
  const fields = configToFields(original);
  assert.deepStrictEqual(fieldsToPatch(fields, original), {});
  assert.deepStrictEqual(
    fieldsToPatch({ ...fields, sshHost: 'other' }, original),
    { sshHost: 'other' },
  );
});

test('пустой пароль не уезжает в патч', () => {
  // Иначе первое же сохранение стёрло бы настроенный пароль брокера — а
  // заметить это можно только по молчащему Enter на чужой машине.
  const original = { mqtt: { host: 'broker', base: 'home/room/pc' }, ...NO_PICKER_SIZE };
  const fields = configToFields(original);
  assert.deepStrictEqual(fieldsToPatch(fields, original), {});
  const patch = fieldsToPatch({ ...fields, 'mqtt.password': 'новый' }, original);
  assert.deepStrictEqual(patch, { mqtt: { password: 'новый' } });
});

test('строка аргументов возвращается массивом', () => {
  const original = { terminal: { file: '/usr/bin/wt', args: [] }, ...NO_PICKER_SIZE };
  const patch = fieldsToPatch({ ...configToFields(original), 'terminal.args': '-w\n0' }, original);
  assert.deepStrictEqual(patch, { terminal: { args: ['-w', '0'] } });
});

test('стёртое числовое поле не превращается в 0', () => {
  // `Number('')` в JS даёт 0 — но стёртое поле порта значит «не трогали»,
  // а не «порт 0»: 0 — недопустимый порт брокера, и сохранить его молча
  // значит сломать mqtt так, что ни одна проверка формы этого не поймает.
  const original = { mqtt: { host: 'broker', port: 1883, base: 'home/room/pc' }, ...NO_PICKER_SIZE };
  const fields = configToFields(original);
  assert.strictEqual(fields['mqtt.port'], 1883);
  const patch = fieldsToPatch({ ...fields, 'mqtt.port': '  ' }, original);
  assert.deepStrictEqual(patch, {});
});

test('число, отданное строкой из DOM, не считается изменением', () => {
  // Настоящий <input type="number"> (C6) всегда отдаёт value строкой.
  // Сравнение должно идти по приведённым значениям, иначе "1883" от DOM и
  // сохранённое число 1883 считались бы разным — и нетронутое поле порта
  // попадало бы в патч при каждом сохранении.
  const original = { mqtt: { host: 'broker', port: 1883, base: 'home/room/pc' }, ...NO_PICKER_SIZE };
  const fields = configToFields(original);
  const patch = fieldsToPatch({ ...fields, 'mqtt.port': '1883' }, original);
  assert.deepStrictEqual(patch, {});
});

test('пустой хост — отказ, а не пустой список', () => {
  // Без sshHost список брать неоткуда, и сохранить такое молча значит отдать
  // человеку пикер, который не работает и не говорит почему.
  const problems = validate({ ...configToFields({}), sshHost: '  ' });
  assert.ok(problems.some(p => p.includes('sshHost')), problems.join('; '));
});

test('комбинация, занятая самим окном пикера, не проходит', () => {
  // Ctrl+K — меню сессии внутри окна. Настроенный на неё глобальный хоткей
  // молча не сработал бы: окно забирает нажатие себе.
  const problems = validate({ ...configToFields({ sshHost: 'h' }), hotkey: 'Ctrl+K' });
  assert.ok(problems.some(p => p.includes('Ctrl+K')), problems.join('; '));
});

test('исправная форма претензий не вызывает', () => {
  assert.deepStrictEqual(validate(configToFields({ sshHost: 'host' })), []);
});

// ── второй глобальный хоткей в форме ────────────────────────────────────────
test('второй хоткей правится на той же странице, что и первый', () => {
  const page = PAGES.find(p => p.id === 'hotkeys');
  const ids = page.fields.map(f => f.id);
  assert.ok(ids.includes('projectsHotkey'), ids);
});

test('форма не даёт повесить оба хоткея на одну комбинацию', () => {
  // Система отдаёт сочетание одному слушателю, и второй регистрируется
  // отказом: молча не сработал бы именно он.
  const problems = validate({
    sshHost: 'host', hotkey: 'Cmd+Shift+C', projectsHotkey: 'cmd+shift+c',
  });
  assert.strictEqual(problems.length, 1, problems);
  assert.match(problems[0], /both hotkeys/);
});

test('разные комбинации возражений не вызывают', () => {
  assert.deepStrictEqual(
    validate({ sshHost: 'host', hotkey: 'Cmd+Shift+C', projectsHotkey: 'Alt+Cmd+Shift+C' }),
    [],
  );
});

test('пустой второй хоткей возражений не вызывает', () => {
  // Пусто значит «взять встроенное», а не «сломанная комбинация».
  assert.deepStrictEqual(validate({ sshHost: 'host', hotkey: 'Cmd+Shift+C' }), []);
});

// ── Выбор терминала: помощник, а не поле конфига ───────────────────────────

test('пресет терминала не уезжает в конфиг отдельным ключом', () => {
  // Своего ключа у него нет намеренно: второй источник правды разошёлся бы с
  // полями, которые человек правит руками. Попади он в FIELDS — патч унёс бы
  // в config.yaml выдуманный ключ `terminalPreset`.
  const patch = fieldsToPatch({ ...configToFields({}), terminalPreset: 'iterm2' }, {});
  assert.ok(!('terminalPreset' in patch), JSON.stringify(patch));
});

test('поля терминала пресет не отменяет, а заполняет', () => {
  // Путь у всех разный — один homebrew на arm и на intel даёт два разных
  // префикса, — поэтому оба поля остаются на месте и правятся руками.
  const ids = PAGES.find(p => p.id === 'general').fields.map(f => f.id);
  assert.ok(ids.includes('terminal.file'), ids.join(' '));
  assert.ok(ids.includes('terminal.args'), ids.join(' '));
  // И помощник стоит перед ними: сначала выбирают терминал, потом правят путь.
  assert.ok(ids.indexOf('terminalPreset') < ids.indexOf('terminal.file'));
});

// Выпадашка размера — первый тип поля, у которого значение не строка и не
// булево, и круг «конфиг → поле → патч» на нём проверяется отдельно: строка из
// DOM (`<select>` отдаёт её всегда) обязана сравняться с числом из конфига,
// иначе нетронутое поле попадало бы в патч на каждом сохранении.
test('размер окна ходит по кругу числом, а не строкой', () => {
  const config = { pickerSize: { narrow: { width: 0, height: 80 }, wide: { width: 0, height: 0 } } };
  const fields = configToFields(config);
  assert.strictEqual(fields['pickerSize.narrow.height'], 80);
  // Ключа нет вовсе — показывается 65%, а не встроенный размер (см. тест
  // ниже); тут ключ height есть и равен явному числу, случай другой.

  // Нетронутая форма патча не даёт, хотя из DOM всё пришло бы строками.
  const fromDom = { ...fields, 'pickerSize.narrow.height': '80' };
  assert.deepStrictEqual(fieldsToPatch(fromDom, config), {});

  // Тронутая — даёт число, а не строку: yaml иначе получил бы `'95'`.
  const patch = fieldsToPatch({ ...fields, 'pickerSize.wide.width': '95' }, config);
  assert.deepStrictEqual(patch, { pickerSize: { wide: { width: 95 } } });
});

test('SIZE_CHOICES содержит 100', () => {
  const field = PAGES.flatMap(p => p.fields).find(f => f.id === 'pickerSize.narrow.height');
  assert.strictEqual(field.type, 'size');
  assert.ok(field.options.some(o => o.value === 100));
});

// Подложка позади пикера — две галки на странице Window size, после полей
// размера: решение «затемнять ли» относится к тому же выбору «каким видеть
// окно», что и сам размер, и на отдельную страницу его заводить незачем.
test('scrim.narrow и scrim.wide — булевы поля на странице Window size, после размеров', () => {
  const ids = PAGES.find(p => p.id === 'window').fields.map(f => f.id);
  assert.ok(ids.includes('scrim.narrow'));
  assert.ok(ids.includes('scrim.wide'));
  assert.ok(ids.indexOf('pickerSize.wide.height') < ids.indexOf('scrim.narrow'));
  const byId = id => PAGES.find(p => p.id === 'window').fields.find(f => f.id === id);
  assert.strictEqual(byId('scrim.narrow').type, 'bool');
  assert.strictEqual(byId('scrim.wide').type, 'bool');
  assert.strictEqual(byId('scrim.narrow').label, 'Dim the desktop behind the list');
  assert.strictEqual(byId('scrim.wide').label, 'Dim the desktop behind the wide view');
});

test('scrim без ключа в конфиге показывает выключенным, а патч несёт включённый флаг', () => {
  const original = { sshHost: 'host', ...NO_PICKER_SIZE };
  const fields = configToFields(original);
  assert.strictEqual(fields['scrim.narrow'], false);
  assert.strictEqual(fields['scrim.wide'], false);
  const patch = fieldsToPatch({ ...fields, 'scrim.wide': true }, original);
  assert.deepStrictEqual(patch, { scrim: { wide: true } });
});

// Отсутствующая высота — это то немногое число, за которое отвечает сам
// пикер (`wanted_size` берёт долю по умолчанию), и форма обязана показать не
// «Default», а ту же долю, 65%, — иначе человек читал бы включённую по
// умолчанию функцию как выключенную. Явный ноль в файле — это Default,
// записанный кем-то намеренно (в том числе самой формой при возврате
// человеком к встроенному размеру), и превращать его обратно в 65 нельзя.
test('отсутствующая высота в форме — 65, явный ноль — Default', () => {
  assert.strictEqual(configToFields({})['pickerSize.narrow.height'], 65);
  assert.strictEqual(configToFields({})['pickerSize.wide.height'], 65);
  // Ширины отсутствие ключа не трогает — путать «сколько сессий влезет» с
  // «насколько окно широкое» нечем.
  assert.strictEqual(configToFields({})['pickerSize.narrow.width'], 0);
  assert.strictEqual(configToFields({})['pickerSize.wide.width'], 0);
  assert.strictEqual(configToFields({
    pickerSize: { narrow: { width: 0, height: 0 }, wide: { width: 0, height: 0 } },
  })['pickerSize.narrow.height'], 0);
  assert.strictEqual(configToFields({
    pickerSize: { narrow: { width: 0, height: 0 }, wide: { width: 0, height: 0 } },
  })['pickerSize.wide.height'], 0);
});

// Показанная человеку подмена (65 вместо 0) и база, с которой сверяется
// патч, обязаны быть разными функциями: сверься патч с тем же `configToFields`,
// что рисует форму, обе стороны читали бы 65 одинаково, патч выходил бы
// пустым, и высота никогда не долетела бы до config.yaml — то есть подмена
// делала бы ровно противоположное задуманному, молча.
test('подмена 65 не топит патч: отсутствующий ключ патчится, явный ноль — нет', () => {
  const missing = configToFields({});
  const patchFromMissing = fieldsToPatch(missing, {});
  assert.ok('pickerSize' in patchFromMissing, 'патч не увидел отсутствующую высоту');
  assert.strictEqual(patchFromMissing.pickerSize.narrow.height, 65);

  const zeroed = {
    pickerSize: { narrow: { width: 0, height: 0 }, wide: { width: 0, height: 0 } },
  };
  const fieldsFromZeroed = configToFields(zeroed);
  const patchFromZeroed = fieldsToPatch(fieldsFromZeroed, zeroed);
  assert.deepStrictEqual(patchFromZeroed, {}, 'явный ноль не должен снова стать патчем на 65');
});

// Пиксели — вписанные вручную (или подобранные раньше) — форма обязана
// довести до конфига как есть: fromField у size — тот же путь, что у choice,
// и границу 101 он не проверяет вовсе, её сторожит validate.
test('пиксели ≥ 101 доходят до патча числом', () => {
  const patch = fieldsToPatch(
    { ...configToFields({}), 'pickerSize.narrow.width': 1400 }, {},
  );
  assert.strictEqual(patch.pickerSize.narrow.width, 1400);
});

test('validate размера принимает 0, доли 1-100 и пиксели ≥ 101', () => {
  const base = configToFields({});
  const ok = (width) => validate({ ...base, sshHost: 'host', 'pickerSize.narrow.width': width });
  assert.deepStrictEqual(ok(0), []);
  assert.deepStrictEqual(ok(50), []);
  assert.deepStrictEqual(ok(100), []);
  assert.deepStrictEqual(ok(1400), []);
  assert.notDeepStrictEqual(ok(0.5), []);
  assert.notDeepStrictEqual(ok(-10), []);
  // Зазор между долей и пикселями: не дотягивает ни до 100% (доля кончается
  // на 100), ни до 101 пикселя. Тот же зазор отвергает `scale_axis` в Rust —
  // разойдись они, форма пропустила бы то, что окно потом откатит молча.
  assert.notDeepStrictEqual(ok(100.5), []);
});

// Ревью Task 8: этот путь не про поле пикселей (то само не даёт написать
// 1–100 и не пишет пиксели меньше 101 вовсе) — он про config.yaml, правленный
// руками мимо формы. `toField`/`baselineFields` там ничего не отсекают
// (числа пропускаются как есть), и единственный сторож на этом пути —
// `validate` в момент сохранения: полный проход raw-конфиг → configToFields →
// validate, а не собранный вручную `fields`, — чтобы не остаться голословным
// про «где-то ловится».
test('испорченное вручную значение в config.yaml ловит validate, а не только форма', () => {
  const config = {
    sshHost: 'host',
    pickerSize: { narrow: { width: -5000, height: 0.3 }, wide: { width: 0, height: 0 } },
  };
  const fields = configToFields(config);
  // Значения дошли до формы как есть — обрезать их тут некому.
  assert.strictEqual(fields['pickerSize.narrow.width'], -5000);
  assert.strictEqual(fields['pickerSize.narrow.height'], 0.3);
  const problems = validate(fields);
  assert.ok(problems.some(p => p.includes('pickerSize.narrow.width')), problems.join('; '));
  assert.ok(problems.some(p => p.includes('pickerSize.narrow.height')), problems.join('; '));
});

// Ноль — не «пусто», а полноценный выбор: он значит «встроенный размер».
// Пропусти его патч, как пропускает пустую строку, и вернуться с 80% на
// Default стало бы нечем — удалять ключи merge_patch не умеет.
test('возврат к встроенному размеру записывается, а не пропускается', () => {
  // wide.height задан явно (0), а не пропущен: иначе отсутствие подставило бы
  // 65 и добавило бы в патч лишний `pickerSize.wide.height`, замутив
  // проверку про narrow.
  const config = { pickerSize: { narrow: { height: 80 }, wide: { height: 0 } } };
  const fields = configToFields(config);
  const patch = fieldsToPatch({ ...fields, 'pickerSize.narrow.height': '0' }, config);
  assert.deepStrictEqual(patch, { pickerSize: { narrow: { height: 0 } } });
});

// ── Затемнение старых строк ────────────────────────────────────────────────

test('stale-настройки находятся в General и показывают defaults', () => {
  const ids = PAGES.find(page => page.id === 'general').fields.map(field => field.id);
  assert.ok(ids.includes('stale.enabled'), ids);
  assert.ok(ids.includes('stale.sessionHours'), ids);
  assert.ok(ids.includes('stale.projectHours'), ids);
  assert.ok(ids.includes('stale.opacity'), ids);

  const fields = configToFields(NO_PICKER_SIZE);
  assert.strictEqual(fields['stale.enabled'], false);
  assert.strictEqual(fields['stale.sessionHours'], 2);
  assert.strictEqual(fields['stale.projectHours'], 168);
  assert.strictEqual(fields['stale.opacity'], 0.5);
  assert.deepStrictEqual(fieldsToPatch(fields, NO_PICKER_SIZE), {});
});

test('stale-настройка уезжает точечным числовым патчем', () => {
  const original = {
    stale: { enabled: true, sessionHours: 2, projectHours: 168, opacity: 0.5 },
    ...NO_PICKER_SIZE,
  };
  const fields = configToFields(original);
  assert.deepStrictEqual(
    fieldsToPatch({ ...fields, 'stale.opacity': '0.7' }, original),
    { stale: { opacity: 0.7 } },
  );
  assert.deepStrictEqual(
    fieldsToPatch({ ...fields, 'stale.projectHours': '14' }, original),
    { stale: { projectHours: 14 } },
  );
});

test('stale.enabled одинаково строго читается runtime и формой', () => {
  for (const enabled of ['yes', 1, [], {}]) {
    const config = { stale: { enabled } };
    assert.strictEqual(normalizeConfig(config).stale.enabled, false, String(enabled));
    assert.strictEqual(configToFields(config)['stale.enabled'], false, String(enabled));
  }

  for (const enabled of [true, false]) {
    assert.strictEqual(configToFields({ stale: { enabled } })['stale.enabled'], enabled);
  }
  assert.strictEqual(configToFields({ onlyLive: 'yes' }).onlyLive, true);
});

test('форма отвергает плохие stale-пороги и opacity', () => {
  const valid = { ...configToFields({}), sshHost: 'host' };
  assert.deepStrictEqual(validate(valid), []);

  assert.deepStrictEqual(validate({
    ...valid,
    'stale.sessionHours': '3.5',
    'stale.projectHours': '14',
    'stale.opacity': '0.7',
  }), []);

  for (const [id, value] of [
    ['stale.sessionHours', ''],
    ['stale.sessionHours', 0],
    ['stale.projectHours', -1],
    ['stale.opacity', 0.09],
    ['stale.opacity', 1.01],
    ['stale.opacity', 'none'],
  ]) {
    const problems = validate({ ...valid, [id]: value });
    assert.ok(problems.some(problem => problem.includes(id)), `${id}=${value}: ${problems}`);
  }
});

test('валидация stale-чисел отвергает значения других типов до Number coercion', () => {
  const valid = { ...configToFields({}), sshHost: 'host' };
  for (const [id, validValue] of [
    ['stale.sessionHours', 3.5],
    ['stale.projectHours', 14],
    ['stale.opacity', 0.7],
  ]) {
    for (const malformed of [true, [validValue], { valueOf: () => validValue }]) {
      const problems = validate({ ...valid, [id]: malformed });
      assert.ok(
        problems.some(problem => problem.includes(id)),
        `${id} принял ${Object.prototype.toString.call(malformed)}: ${problems}`,
      );
    }
  }
});
