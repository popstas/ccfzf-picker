const { test } = require('node:test');
const assert = require('node:assert');
const { GLYPHS, IMAGES, iconSpecs, actionIcon } = require('../frontend-src/action-icons');
const { availableActions } = require('../frontend-src/session-actions');

// Сторож на будущее: новый встроенный пункт приедет в меню без значка, и
// заметить это можно только глазами на той машине, где пикер стоит. Спрос
// идёт с actionIcon, а не с одного GLYPHS: значок пункту даёт любая из двух
// таблиц, и пункт с картинкой (`pr`) глифа не имеет вовсе. Список id берётся
// не из BUILTIN_ACTION_KEYS (там только те, у кого есть прямая клавиша —
// `open-remote` в неё уже пришлось дописывать руками), а прямым вызовом
// availableActions на строке, у которой есть всё сразу: живая сессия с pid
// (даёт attach), cwd (даёт new), pr_url с номером PR (даёт pr), lastActivity
// и agentSeen (даёт unread) — info в списке всегда. Строк две, потому что
// `seen` и `unread` — пара взаимоисключающих: одна строка показала бы только
// один из них, и второй приехал бы в меню без значка незамеченным.
test('у каждого встроенного пункта есть свой значок', () => {
  const row = {
    kind: 'session',
    cwd: '/home/user/projects/ccfzf',
    live: true,
    pid: 4242,
    pr_url: 'https://github.com/popstas/ccfzf/pull/3',
    lastActivity: 1785870255,
    agentSeen: 1785870300,
  };
  const ids = [
    ...availableActions(row),
    ...availableActions({ ...row, agentSeen: false }),
    // Третья строка — заголовок снимка: его единственный пункт (`restore`)
    // общая ветка сессии не отдаёт вовсе, и без отдельного спроса он приехал
    // бы в меню без значка.
    ...availableActions({ kind: 'snapshot', id: 'snap-1' }),
  ].map(a => a.id);
  assert.ok(ids.length > 1, 'availableActions вернул слишком мало — тест сторожит не то');
  // `open-remote` availableActions не отдаёт вовсе — этот пункт добавляет
  // страница (окно уже открыто на этой машине), а не сборка списка действий.
  // Дописан руками, потому и особый.
  for (const id of [...ids, 'open-remote', 'tile', 'cascade']) {
    assert.ok(
      GLYPHS[id] || IMAGES[id],
      `у встроенного пункта ${id} нет ни глифа, ни картинки — встанет запасной знак`,
    );
  }
});

// Стрелка `↗` значила «уедет наружу», а не «GitHub», и заменена значком
// службы. Сторож смотрит на вывод actionIcon, а не на таблицу: важно, что
// строка меню получит картинку.
test('у pr значок GitHub, а не глиф', () => {
  const icon = actionIcon({ id: 'pr' }, {});
  assert.strictEqual(icon.kind, 'img', 'pr должен приезжать картинкой');
  assert.ok(icon.src.startsWith('data:image/svg+xml'), 'картинка pr вшита в страницу');
  assert.ok(icon.src.includes('viewBox'), 'в data-URI должен лежать разобранный svg');
});

test('icon перевешивает argv[0], а без него берётся argv[0]', () => {
  const specs = iconSpecs({ actions: [
    { id: 'explorer', icon: '%SystemRoot%\\explorer.exe', argv: ['cmd', '/c', 'start'] },
    { id: 'cursor', icon: '', argv: ['Cursor.exe', '{localPath}'] },
  ] });
  assert.deepStrictEqual(
    specs.filter(s => s.id !== 'new'),
    [
      { id: 'explorer', path: '%SystemRoot%\\explorer.exe' },
      { id: 'cursor', path: 'Cursor.exe' },
    ],
  );
});

// Пункт `new` в конфиге не описан вовсе, а иконку у него взять есть откуда —
// у агента. На машине без агента запрос вернётся пустым, и встанет глиф.
// Кандидатов у него несколько: в `PATH` агента может не быть, а установщик
// на Windows кладёт его в каталог с версией в имени — оттого `*` в пути.
test('new спрашивается всегда, даже с пустым конфигом', () => {
  const specs = iconSpecs(null);
  assert.deepStrictEqual(specs.map(s => s.id), ['new', 'new']);
  assert.strictEqual(specs[0].path, 'claude.exe');
  assert.ok(specs[1].path.includes('*'), 'второй кандидат ищет каталог с версией по маске');
  assert.ok(specs[1].path.endsWith('claude.exe'), 'и всё же кончается именем агента');
});

test('действие без icon и без argv в запрос не попадает', () => {
  const specs = iconSpecs({ actions: [{ id: 'broken', icon: '', argv: [] }] });
  assert.deepStrictEqual(specs.filter(s => s.id !== 'new'), []);
});

test('картинка выигрывает у глифа, когда она есть', () => {
  const icon = actionIcon({ id: 'info' }, { info: 'data:image/png;base64,AAA' });
  assert.deepStrictEqual(icon, { kind: 'img', src: 'data:image/png;base64,AAA' });
});

test('без картинки встаёт глиф пункта, у неизвестного — запасной', () => {
  assert.deepStrictEqual(actionIcon({ id: 'info' }, {}), { kind: 'glyph', text: 'ⓘ', cls: '' });
  assert.deepStrictEqual(actionIcon({ id: 'unread' }, {}), { kind: 'glyph', text: '●', cls: 'unread' });
  assert.deepStrictEqual(actionIcon({ id: 'whatever' }, {}), { kind: 'glyph', text: '▸', cls: '' });
});
