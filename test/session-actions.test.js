const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { availableActions, prNumber } = require('../frontend-src/session-actions');
const { prBadgeHtml } = require('../frontend-src/session-glyph');
const { normalizeConfig } = require('../frontend-src/config-shape');
const { menuKeys } = require('../frontend-src/action-hotkey');

// Конфиг с одним настроенным действием открытия. UNC вместо буквы диска — см.
// комментарий в test/path-map.test.js.
const CONFIGURED = {
  pathMap: { remote: '/home/user', local: '\\\\nas\\home' },
  actions: [{ id: 'explorer', label: 'Open in Explorer', hotkey: 'Ctrl+Shift+E', argv: ['x'] }],
};

// Сессия Claude Desktop: Enter у неё уводит в приложение, и дорога в терминал
// остаётся только здесь. Правило «открытие висит на Enter, в меню его нет»
// этим не нарушено: в меню стоит не то, что делает Enter, а ровно то, чего он
// больше не делает.
const DESKTOP_ROW = {
  kind: 'interactive', id: 's1', cwd: '/p/site',
  entrypoint: 'claude-desktop', source: 'local',
};

test('у сессии приложения есть пункт «Resume in terminal»', () => {
  const ids = availableActions(DESKTOP_ROW).map(a => a.id);
  assert.ok(ids.includes('resume'), ids.join(','));
});

test('у терминальной сессии такого пункта нет — это дубль Enter', () => {
  const ids = availableActions({ ...DESKTOP_ROW, entrypoint: 'cli' }).map(a => a.id);
  assert.ok(!ids.includes('resume'), ids.join(','));
});

test('у сессии приложения с чужой машины пункта тоже нет', () => {
  // Enter там открывает терминал сам — пункт был бы дублем.
  const ids = availableActions({ ...DESKTOP_ROW, source: 'build-host' }).map(a => a.id);
  assert.ok(!ids.includes('resume'), ids.join(','));
});

test('информация о сессии есть всегда', () => {
  // Комментарий — рядом с ней и по той же причине: оба про сессию как
  // таковую, а не про её окно, живость или каталог, и потому есть у любой
  // строки с настоящим id.
  const ids = availableActions({ id: 'a' }).map(a => a.id);
  assert.deepStrictEqual(ids, ['comment', 'info']);
});

test('без конфига список действий прежний', () => {
  // Второй аргумент необязателен: вызов остаётся годным там, где конфига под
  // рукой нет.
  const row = { id: 'a', cwd: '/home/user/x' };
  assert.deepStrictEqual(availableActions(row).map(a => a.id), ['new', 'terminal', 'comment', 'info']);
  assert.deepStrictEqual(availableActions(row, {}).map(a => a.id), ['new', 'terminal', 'comment', 'info']);
});

test('настроенные действия идут первыми, когда путь переводится', () => {
  const ids = availableActions({ id: 'a', cwd: '/home/user/x' }, CONFIGURED).map(a => a.id);
  assert.deepStrictEqual(ids, ['explorer', 'new', 'terminal', 'comment', 'info']);
});

test('сессия вне общего дерева настроенных действий не получает', () => {
  // Пункт, открывающий несуществующую папку, хуже отсутствующего.
  const ids = availableActions({ id: 'a', cwd: '/etc/nginx' }, CONFIGURED).map(a => a.id);
  assert.deepStrictEqual(ids, ['new', 'terminal', 'comment', 'info']);
});

test('настроенное действие доносит до меню свою подпись и клавишу', () => {
  const [action] = availableActions({ id: 'a', cwd: '/home/user/x' }, CONFIGURED);
  assert.strictEqual(action.label, 'Open in Explorer');
  assert.strictEqual(action.hotkey, 'Ctrl+Shift+E');
});

// Сквозной сторож на весь шов настроенной буквы: normalizeConfig кладёт
// menuKey в разобранное действие, availableActions обязана пронести его
// в объект пункта меню, а menuKeys — превратить в настоящую букву. Тест на
// объектах availableActions с уже готовым menuKey (как в CONFIGURED выше) эту
// дорогу не проверяет: он не видит normalizeConfig и не поймал бы потерю поля
// при пересборке пункта — что и произошло во всех трёх ветках availableActions.
test('буква из config.yaml доезжает до меню всей дорогой: normalizeConfig → availableActions → menuKeys', () => {
  const cfg = normalizeConfig({
    pathMap: { remote: '/home/user', local: '\\\\nas\\home' },
    actions: [{ id: 'cursor', label: 'Open in Cursor', menuKey: 'o', argv: ['cursor', '{localPath}'] }],
  });

  const sessionRow = { id: 'a', cwd: '/home/user/x' };
  const projectRow = { kind: 'project', id: '/home/user/x', cwd: '/home/user/x' };
  const snapshotSessionRow = { kind: 'snapshot-session', id: 'a', cwd: '/home/user/x' };

  for (const row of [sessionRow, projectRow, snapshotSessionRow]) {
    const menuActions = availableActions(row, cfg);
    const letters = menuKeys(menuActions);
    const index = menuActions.findIndex(a => a.id === 'cursor');
    assert.ok(index >= 0, `настроенное действие пропало у строки kind=${row.kind}`);
    assert.strictEqual(
      letters[index], 'o',
      `буква настроенного действия не дошла до меню у строки kind=${row.kind}`,
    );
  }
});

test('переклейку предлагают только живой сессии с pid', () => {
  const attach = row => availableActions(row).find(a => a.id === 'attach');
  assert.strictEqual(attach({ id: 'a', live: true, pid: 42 }).label, 'Copy reptyr command');
  // Мёртвой тянуть нечего, даже если pid откуда-то остался.
  assert.ok(!attach({ id: 'a', live: false, pid: 42 }));
  assert.ok(!attach({ id: 'a', live: true, pid: 0 }));
});

test('PR предлагается, когда ссылка разбирается в номер', () => {
  const actions = availableActions({ id: 'a', pr_url: 'https://github.com/o/r/pull/42' });
  const pr = actions.find(a => a.id === 'pr');
  assert.strictEqual(pr.label, 'Open PR #42');
});

test('мусор вместо ссылки на PR пункта не даёт', () => {
  const ids = availableActions({ id: 'a', pr_url: 'не ссылка' }).map(a => a.id);
  assert.ok(!ids.includes('pr'));
});

// «Читали» на маке — это agentSeen: отметку ставит открытие сессии, и она же
// гасит кружок. Возврат в непрочитанное бессмыслен и без записи агента
// (agentUpdated === 0: нечего отматывать), и у строки, которая и так
// непрочитана. Спрашивается именно agentUpdated: у lastActivity появился откат
// на время транскрипта, и ненулевой он теперь у всякой сессии — в том числе у
// той, про которую хук не писал ни разу.
test('вернуть в непрочитанное можно только то, что читали', () => {
  const unread = row => availableActions(row).some(x => x.id === 'unread');
  assert.ok(unread({ id: 'a', agentSeen: true, agentUpdated: 5 }));
  assert.ok(!unread({ id: 'a', agentSeen: false, agentUpdated: 5 }));
  assert.ok(!unread({ id: 'a', agentSeen: true, agentUpdated: 0 }));
  // Время транскрипта записи агента не заменяет: пункт был бы обещанием.
  assert.ok(!unread({ id: 'a', agentSeen: true, agentUpdated: 0, lastActivity: 5 }));
});

// Зеркало предыдущего: пометить просмотренным есть смысл ровно там, где
// непрочитанное — то есть у строки с записью агента, которую ещё не читали.
test('пометить просмотренным можно только непрочитанное', () => {
  const seen = row => availableActions(row).some(x => x.id === 'seen');
  assert.ok(seen({ id: 'a', agentSeen: false, agentUpdated: 5 }));
  assert.ok(!seen({ id: 'a', agentSeen: true, agentUpdated: 5 }));
  assert.ok(!seen({ id: 'a', agentSeen: false, agentUpdated: 0 }));
  assert.ok(!seen({ id: 'a', agentSeen: false, agentUpdated: 0, lastActivity: 5 }));
});

// Два пункта об одном и том же и обязаны исключать друг друга: строка, где
// предлагают оба сразу, значила бы, что условия разошлись.
test('«просмотрено» и «непрочитано» не предлагаются вместе', () => {
  for (const agentSeen of [true, false]) {
    const ids = availableActions({ id: 'a', agentSeen, agentUpdated: 5 }).map(a => a.id);
    assert.strictEqual(
      Number(ids.includes('seen')) + Number(ids.includes('unread')), 1,
      `agentSeen=${agentSeen}: ровно один из пары`,
    );
  }
});

// Пункт меню и бейдж в строке разбирают одну и ту же ссылку. Пока номер им даёт
// одна функция, разойтись они не могут — тест сторожит именно это: ссылка,
// которая дала бейдж, обязана дать и пункт меню, и наоборот.
test('пункт меню и бейдж PR судят по ссылке одинаково', () => {
  const links = [
    'https://github.com/o/r/pull/3',
    'https://github.com/o/r/pull/3/files',
    'https://github.com/o/r/pull/',
    'http://github.com/o/r/pull/3',
    'https://github.com/o/r/issues/3',
    '',
  ];
  for (const pr_url of links) {
    const inMenu = availableActions({ id: 'a', pr_url }).some(x => x.id === 'pr');
    const inRow = prBadgeHtml({ pr_url }) !== '';
    assert.strictEqual(inMenu, inRow, `расходятся на ${pr_url || '(пусто)'}`);
    assert.strictEqual(inMenu, prNumber(pr_url) !== '');
  }
});

test('новая сессия предлагается и сессии, и проекту', () => {
  const forSession = availableActions({ id: 'a', cwd: '/p', live: true, pid: 42 })
    .map(a => a.id);
  assert.ok(forSession.includes('new'), forSession);

  const forProject = availableActions({ kind: 'project', id: '/p', cwd: '/p' })
    .map(a => a.id);
  assert.deepStrictEqual(forProject, ['new', 'terminal']);
});

test('строке проекта не предлагают того, чему нужна сессия', () => {
  // PR, «прочитано» и reptyr держатся за запись агента и за pid — у каталога
  // нет ни того, ни другого. Карточка сессии у проекта тоже пуста.
  const ids = availableActions({
    kind: 'project', id: '/p', cwd: '/p',
    pr_url: 'https://github.com/o/r/pull/3', live: true, pid: 42,
    lastActivity: 1, agentUpdated: 1, agentSeen: true,
  }).map(a => a.id);
  assert.deepStrictEqual(ids, ['new', 'terminal']);
});

test('у проекта есть действия папки, когда путь переводится', () => {
  const ids = availableActions(
    { kind: 'project', id: '/remote/p', cwd: '/remote/p' },
    { pathMap: { remote: '/remote', local: '/local' },
      actions: [{ id: 'explorer', label: 'Open in Explorer', hotkey: 'Ctrl+Shift+E' }] },
  ).map(a => a.id);
  assert.deepStrictEqual(ids, ['new', 'terminal', 'explorer']);
});

test('строке зелийной сессии предлагается только информация', () => {
  // Ни записи агента, ни pid, ни каталога — всё сессионное ей не подходит, а
  // присоединение висит на Enter и в меню не прячется.
  const actions = availableActions({ kind: 'zellij', id: 'zellij:home', zellij: 'home', live: true });
  assert.deepStrictEqual(actions, [{ id: 'info', label: 'Session info' }]);
});

// Заголовок снимка — не сессия: ни каталога, ни записи агента, ни pid у него
// нет вовсе, и общая ветка предлагала ему одну «Session info», рисовавшую
// карточку сессии по строке, в которой сессии нет. Восстановление в меню
// стоит вопреки общему правилу «открытие висит на Enter»: другого дела у
// заголовка нет, и без этого пункта меню было бы пустым.
test('заголовку снимка предлагается только восстановление', () => {
  const actions = availableActions({ kind: 'snapshot', id: 'snap-1', label: '20:13 · 2026-08-15' });
  assert.deepStrictEqual(actions, [{ id: 'restore', label: 'Restore snapshot' }]);
});

test('заголовку снимка не предлагают того, чему нужна сессия', () => {
  // Поля сессии в такой строке взяться неоткуда, но если они когда-нибудь
  // появятся — меню обязано остаться прежним: снимок это запись о месте окна,
  // а не работа агента.
  const ids = availableActions({
    kind: 'snapshot', id: 'snap-1', cwd: '/home/user/x',
    pr_url: 'https://github.com/o/r/pull/3', live: true, pid: 42,
    lastActivity: 1, agentUpdated: 1, agentSeen: true,
  }, CONFIGURED).map(a => a.id);
  assert.deepStrictEqual(ids, ['restore']);
});

// Строка внутри снимка несёт настоящий id сессии и настоящий каталог, но ни
// одного поля самой сессии. Каталог честен — на нём и держатся оба
// оставленных пункта; всё, что читает работу агента (info, pr, seen/unread,
// attach), по такой строке нарисовало бы пустоту.
test('строке внутри снимка предлагают каталог, а не сессию', () => {
  const row = {
    kind: 'snapshot-session', id: 'abc123', snapshotId: 'snap-1',
    cwd: '/home/user/x', label: 'x', open: false,
  };
  assert.deepStrictEqual(availableActions(row, CONFIGURED).map(a => a.id), ['explorer', 'new', 'terminal']);
  assert.deepStrictEqual(availableActions(row).map(a => a.id), ['new', 'terminal']);
});

test('строке внутри снимка не предлагают того, чему нужна сессия', () => {
  const ids = availableActions({
    kind: 'snapshot-session', id: 'abc123', snapshotId: 'snap-1', cwd: '/home/user/x',
    pr_url: 'https://github.com/o/r/pull/3', live: true, pid: 42,
    lastActivity: 1, agentUpdated: 1, agentSeen: true,
  }).map(a => a.id);
  assert.deepStrictEqual(ids, ['new', 'terminal']);
});

test('строка внутри снимка без каталога меню не набирает', () => {
  // Пустой список — не оплошность: восстановление у неё висит на Enter, а
  // каталога, за который можно тянуть, нет. Меню на такой строке не
  // открывается вовсе (sessions.html), и пустая рамка человеку не показывается.
  const ids = availableActions({ kind: 'snapshot-session', id: 'abc123', cwd: '' }, CONFIGURED);
  assert.deepStrictEqual(ids, []);
});

// Сторож на будущее, и сторожит он решение, а не поведение: у каждого вида
// строки, который может оказаться под курсором, меню решено поимённо. Новый
// вид, заведённый потом, молча свалился бы в общую ветку сессии и получил бы
// её пункты — по строке, у которой их нечем наполнить. Строка здесь одна на
// всех и несёт всё сразу: так видно не «что есть у этого вида», а «что вид
// пропускает».
//
// `section` и `block-subhead` в список не входят намеренно: до меню они не
// доезжают — заголовок секции отсекает openMenu, а подзаголовок не строка
// списка вовсе и в `rows` не попадает.
test('меню решено для каждого вида строки, а не досталось ему по умолчанию', () => {
  const everything = {
    id: 'abc123', cwd: '/home/user/x', live: true, pid: 42,
    pr_url: 'https://github.com/o/r/pull/3', lastActivity: 1, agentUpdated: 1, agentSeen: true,
    zellij: 'home', snapshotId: 'snap-1',
  };
  const decided = {
    interactive: ['explorer', 'pr', 'unread', 'attach', 'new', 'terminal', 'comment', 'info'],
    // Комментария у зелийной строки нет намеренно: настоящего id сессии у
    // неё не бывает, а комментарий ключуется именно им — общий список на
    // машине агрегатора хранится по id.
    zellij: ['info'],
    project: ['new', 'terminal', 'explorer'],
    snapshot: ['restore'],
    // Пусто, и это решение, а не пропуск: под днём снимков несколько, и
    // «восстанови их все» никто не просил. Такое меню openMenu не открывает.
    'snapshot-day': [],
    'snapshot-session': ['explorer', 'new', 'terminal'],
  };
  for (const [kind, ids] of Object.entries(decided)) {
    assert.deepStrictEqual(
      availableActions({ ...everything, kind }, CONFIGURED).map(a => a.id), ids,
      `вид ${kind}`,
    );
  }
});

// Пункт, который меню предлагает, а runAction не умеет, молчит: `runAction`
// сперва проверяет, есть ли id в списке (есть), потом перебирает свои ветки и,
// не найдя ни одной, просто выходит. Ни ошибки, ни следа — человек видит, что
// нажатие ничего не сделало, и объяснения этому нет нигде. Так и приехало бы
// восстановление снимка, добавленное в availableActions и забытое в
// sessions.html.
//
// Сторож текстовый, потому что поведением это не поймать: чтобы выполнить
// runAction по-настоящему, нужны invoke, restoreSnabshot и половина страницы.
// Список id спрашивается у самой availableActions, а не переписывается сюда
// вторым перечислением — оно разошлось бы с первым на первой же правке.
// Конфига в спросе нет намеренно: настроенные действия runAction выполняет
// общей веткой по CONFIG.actions, своей у них не бывает.
test('каждый встроенный пункт меню обработан в runAction', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');
  const src = html.match(/\n {2}function runAction\(row, id\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(src, 'runAction не найден в sessions.html — тест сторожит не то');

  const rich = {
    id: 'abc123', cwd: '/home/user/x', live: true, pid: 42,
    pr_url: 'https://github.com/o/r/pull/3', lastActivity: 1, agentUpdated: 1, agentSeen: true,
  };
  const ids = new Set([
    ...availableActions(rich),
    ...availableActions({ ...rich, agentSeen: false }),
    ...availableActions({ kind: 'snapshot', id: 'snap-1' }),
    ...availableActions({ kind: 'project', id: '/p', cwd: '/p' }),
    // Сессия приложения: у неё свой пункт, и он тоже обязан быть разобран.
    ...availableActions(DESKTOP_ROW),
    // Этот пункт availableActions не отдаёт вовсе — его добавляет страница
    // (`actionsFor`), когда окно можно открыть на машине трекера.
    { id: 'open-remote' },
    // Раскладки — тем же порядком: их страница добавляет там, где окно строки
    // стоит на своей машине.
    { id: 'tile' }, { id: 'cascade' },
  ].map(a => a.id));
  assert.ok(ids.size > 1, 'список пунктов вышел слишком коротким — тест сторожит не то');

  for (const id of ids) {
    assert.ok(
      src[0].includes(`id === '${id}'`),
      `пункт ${id} есть в меню, но runAction его не разбирает — нажатие промолчит`,
    );
  }
});

// Пункты раскладки предлагает страница, а не availableActions: условие у них
// про машину, а не про строку, — то же, что у Enter на строке с открытым
// окном. Сторож текстовый, как и соседний: `actionsFor` живёт в sessions.html
// и без половины страницы не исполняется. Второе правило про то же самое
// («а тут проверим mqtt.configured и хост руками») разошлось бы с первым
// молча: пункты остались бы на экране, а просьба уходила бы в никуда — ответа
// у публикации нет.
test('пункты раскладки предлагаются по тому же правилу, что и подъём окна', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');
  const src = html.match(/\n {2}function actionsFor\(row\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(src, 'actionsFor не найдена в sessions.html — тест сторожит не то');
  assert.ok(src[0].includes('rowCanFocus(row)'),
    'условие пунктов раскладки разошлось с правилом Enter — второе такое правило разъедется молча');
  for (const id of ['tile', 'cascade']) {
    assert.ok(src[0].includes(`id: '${id}'`), `пункта ${id} нет в actionsFor`);
  }
});

// --- Спека и план в меню ^K (Task T5) ------------------------------------

test('план и спека дают пункты меню, план первым', () => {
  // План главнее спеки — за ним и приходят: спека отвечает «что решили», план
  // — «где сейчас».
  const acts = availableActions({
    kind: 'session',
    cwd: '/home/user/p',
    plan: 'docs/superpowers/plans/a.md',
    spec: 'docs/superpowers/specs/a-design.md',
  }, { pathMap: { remote: '/home/user', local: '/local' }, actions: [] });
  const docs = acts.filter(a => a.id === 'plan' || a.id === 'spec').map(a => a.id);
  assert.deepStrictEqual(docs, ['plan', 'spec']);
});

test('без pathMap пунктов бумаг нет вовсе', () => {
  // Файл лежит на машине агрегатора, и открыть его здесь можно только через
  // переведённый путь. То же правило, что у действий с папкой: пункт меню,
  // ведущий в никуда, хуже отсутствующего.
  const acts = availableActions({
    kind: 'session', cwd: '/home/user/p', plan: 'docs/superpowers/plans/a.md',
  }, { pathMap: {}, actions: [] });
  assert.deepStrictEqual(acts.filter(a => a.id === 'plan'), []);
});

test('есть только спека — только её пункт', () => {
  const acts = availableActions({
    kind: 'session', cwd: '/home/user/p', spec: 'docs/superpowers/specs/a-design.md',
  }, { pathMap: { remote: '/home/user', local: '/local' }, actions: [] });
  const docs = acts.filter(a => a.id === 'plan' || a.id === 'spec').map(a => a.id);
  assert.deepStrictEqual(docs, ['spec']);
});

// --- Сессия приложения и своя строка под Windows --------------------------

test('сессии приложения не предлагают reptyr', () => {
  // pid у неё настоящий — агрегатор находит процесс, — то есть без оговорки
  // пункт стоял бы в меню и давал команду, которой не за что взяться: reptyr
  // перевешивает процесс на другой терминал, а терминала у сессии Claude
  // Desktop нет вовсе.
  const live = { ...DESKTOP_ROW, live: true, pid: 42 };
  assert.ok(!availableActions(live).some(a => a.id === 'attach'));
  // Та же строка, заведённая терминалом, пункт сохраняет: разница именно в
  // происхождении, а не в живости или pid.
  assert.ok(availableActions({ ...live, entrypoint: 'cli' }).some(a => a.id === 'attach'));
});

// Пункты, которые на своей строке под Windows не сработают. Причин две
// разные, и обе молчаливые: `new`, `terminal`, `attach` и `resume` уходят
// через `/bin/sh -c` (`commandParts`), которого там нет, а `comment` зовёт
// местный агрегатор мимо bash-обёртки, где ветка `--comment` не разбирается
// вовсе. Мерка на обе одна — `isWindowsLocalRow`.
const SHELL_ITEMS = ['new', 'terminal', 'attach', 'resume', 'comment'];

// Строка, несущая всё сразу: так видно не «что осталось», а «что мерка
// пропускает» — тем же приёмом, что и сторож видов строк выше.
const WIN_ROW = {
  kind: 'interactive', id: 'abc123', cwd: 'X:\\projects\\demo', live: true, pid: 42,
  entrypoint: 'claude-desktop', source: 'local',
};

test('под Windows у своей строки не остаётся ни одного пункта через шелл', () => {
  const ids = availableActions(WIN_ROW, CONFIGURED, { os: 'windows' }).map(a => a.id);
  for (const id of SHELL_ITEMS) assert.ok(!ids.includes(id), `${id} остался: ${ids.join(',')}`);
  // Пустым меню при этом не становится: настроенное действие с папкой и
  // «Session info» работают там как прежде.
  assert.deepStrictEqual(ids, ['explorer', 'info']);
});

test('под Windows строка с ssh-источника пункты сохраняет', () => {
  // Мерка по строке, а не по системе пикера: команда такой строки уходит
  // `ssh -t host`, и все пять пунктов честно работают. Спрятать их значило
  // бы отобрать рабочее.
  const ids = availableActions(
    { ...WIN_ROW, cwd: '/home/user/site', source: 'build-host', entrypoint: 'cli' },
    CONFIGURED, { os: 'windows' },
  ).map(a => a.id);
  for (const id of ['new', 'terminal', 'attach', 'comment']) {
    assert.ok(ids.includes(id), `${id} пропал: ${ids.join(',')}`);
  }
});

test('на маке своя строка пункты сохраняет', () => {
  const ids = availableActions(
    { ...WIN_ROW, cwd: '/home/user/site', entrypoint: 'cli' }, CONFIGURED, { os: 'macos' },
  ).map(a => a.id);
  for (const id of ['new', 'terminal', 'attach', 'comment']) {
    assert.ok(ids.includes(id), `${id} пропал: ${ids.join(',')}`);
  }
});

test('несказанная система оставляет список прежним', () => {
  // Пункт, спрятанный по догадке, хуже показанного: у вызова без `opts` —
  // а такие есть в соседних тестах формы строки — поведение обязано остаться
  // тем же, что и до появления мерки.
  const withOpts = availableActions(WIN_ROW, CONFIGURED, {}).map(a => a.id);
  assert.deepStrictEqual(availableActions(WIN_ROW, CONFIGURED).map(a => a.id), withOpts);
  assert.ok(withOpts.includes('new'), withOpts.join(','));
});

test('под Windows своя строка проекта и строка снимка теряют те же два пункта', () => {
  // Копий у `new` и `terminal` три — общая ветка, строка проекта и строка
  // внутри снимка, — и правило обязано стоять при каждой, иначе оно работало
  // бы через строку.
  const project = availableActions(
    { kind: 'project', id: 'X:\\projects\\demo', cwd: 'X:\\projects\\demo', source: 'local' },
    CONFIGURED, { os: 'windows' },
  ).map(a => a.id);
  assert.deepStrictEqual(project, ['explorer']);
  const snap = availableActions(
    { kind: 'snapshot-session', id: 'abc123', cwd: 'X:\\projects\\demo', source: 'local' },
    CONFIGURED, { os: 'windows' },
  ).map(a => a.id);
  assert.deepStrictEqual(snap, ['explorer']);
});
