const { test } = require('node:test');
const assert = require('node:assert');
const {
  escapeHtml, statusDotHtml, formatAge, ageHtml, stateText, shortSessionId, stateHtml,
  sessionIdHtml, sessionName, hotkeyHtml, contextLevel, usageHtml,
  shortPath, rowTitle, titleAttr, windowHostHtml, windowHtml,
  prNumber, prBadgeHtml, wordSet, hidesProject, projectLine, todoHtml, docsBadgeHtml, promptsHtml, commentHtml,
  todoText, projectCountHtml, projectCountText, projectColumnWidths,
} = require('../frontend-src/session-glyph');

test('shortPath collapses the agent home directory, and survives a missing path', () => {
  // The list shows it too, not just the tooltip, so the rule lives in one place.
  assert.strictEqual(shortPath('/home/user/projects/x'), '~/projects/x');
  assert.strictEqual(shortPath('/home/someone'), '~');
  assert.strictEqual(shortPath('/opt/home/x'), '/opt/home/x');
  assert.strictEqual(shortPath(undefined), '');
});

test('escapeHtml escapes ampersand, angle brackets, and double quotes', () => {
  assert.strictEqual(
    escapeHtml('a & b < c > d " e'),
    'a &amp; b &lt; c &gt; d &quot; e'
  );
});

test('escapeHtml neutralizes a hostile window title that tries to break out of an attribute and inject markup', () => {
  const hostile = 'Report" onmouseover="alert(1)"><script>alert(2)</script> & <img src=x onerror=alert(3)>';
  const out = escapeHtml(hostile);
  assert.strictEqual(
    out,
    'Report&quot; onmouseover=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt; &amp; &lt;img src=x onerror=alert(3)&gt;'
  );
  assert.ok(!out.includes('<script>'), 'must not leave an openable script tag');
  assert.ok(!out.includes('">'), 'must not leave a closed, escapable attribute');
});

test('escapeHtml leaves single quotes and other safe characters unchanged', () => {
  assert.strictEqual(escapeHtml("it's fine"), "it's fine");
});

test('escapeHtml coerces non-string input to a string first', () => {
  assert.strictEqual(escapeHtml(123), '123');
});

test('statusDotHtml paints each agent state its own colour class', () => {
  for (const state of ['active', 'question', 'idle']) {
    assert.strictEqual(
      statusDotHtml({ live: true, agentState: state }),
      `<div class="dot ${state}"></div>`
    );
  }
});

test('statusDotHtml paints "waiting for your input" as needing review, not as idle', () => {
  // The hook records the event; what it means is decided here. That
  // notification arrives a minute after the agent stopped, so the work is
  // finished and unread — the same thing a stop means.
  assert.strictEqual(
    statusDotHtml({ live: true, agentState: 'idle', agentEvent: 'attention' }),
    '<div class="dot review"></div>'
  );
});

test('statusDotHtml greys out a waiting session once its window was focused', () => {
  // Focus is the only honest "I looked at it" signal there is — the same one
  // Windows itself uses to drop the taskbar highlight.
  assert.strictEqual(
    statusDotHtml({ live: true, agentState: 'idle', agentEvent: 'attention', agentSeen: true }),
    '<div class="dot idle"></div>'
  );
});

test('statusDotHtml keeps a waiting session orange while it is unseen', () => {
  assert.strictEqual(
    statusDotHtml({ live: true, agentState: 'idle', agentEvent: 'attention', agentSeen: false }),
    '<div class="dot review"></div>'
  );
});

test('statusDotHtml lets being seen mute a pending question', () => {
  // Looking at the window does not answer the question — the agent stays
  // blocked — but a list that keeps calling after you have been there stops
  // meaning anything, so focus wins here too.
  assert.strictEqual(
    statusDotHtml({ live: true, agentState: 'question', agentEvent: 'attention', agentSeen: true }),
    '<div class="dot idle"></div>'
  );
});

test('statusDotHtml keeps an unseen question yellow', () => {
  assert.strictEqual(
    statusDotHtml({ live: true, agentState: 'question', agentEvent: 'attention', agentSeen: false }),
    '<div class="dot question"></div>'
  );
});

test('statusDotHtml leaves idle grey when it did not come from a notification', () => {
  assert.strictEqual(
    statusDotHtml({ live: true, agentState: 'idle', agentEvent: 'tool-done' }),
    '<div class="dot idle"></div>'
  );
  assert.strictEqual(
    statusDotHtml({ live: true, agentState: 'idle' }),
    '<div class="dot idle"></div>'
  );
});

test('statusDotHtml falls back to idle for a live session with no agent state', () => {
  // The hook may not be installed, or may not have fired yet. Green would
  // claim the agent is working right now, which is exactly what is unknown.
  assert.strictEqual(
    statusDotHtml({ live: true }),
    '<div class="dot idle"></div>'
  );
});

test('statusDotHtml ignores an agent state it does not know', () => {
  // The state file is written by another process on another machine; an
  // unknown string must not become a CSS class of its own.
  assert.strictEqual(
    statusDotHtml({ live: true, agentState: 'exploded' }),
    '<div class="dot idle"></div>'
  );
});

test('statusDotHtml marks a remembered-but-closed session closed', () => {
  assert.strictEqual(
    statusDotHtml({ live: false }),
    '<div class="dot closed"></div>'
  );
});

test('statusDotHtml keeps a closed session closed even when a state lingers', () => {
  // The window is gone; the last state the agent wrote before it went says
  // nothing about now.
  assert.strictEqual(
    statusDotHtml({ live: false, agentState: 'active' }),
    '<div class="dot closed"></div>'
  );
});

test('statusDotHtml treats a missing open flag as closed rather than open', () => {
  // Defaulting the other way would paint a dead slot green, which is the one
  // thing the dot exists to tell apart.
  assert.strictEqual(statusDotHtml({}), '<div class="dot closed"></div>');
});

test('statusDotHtml survives a missing session object', () => {
  assert.strictEqual(statusDotHtml(undefined), '<div class="dot closed"></div>');
});

test('statusDotHtml ignores the geometry fields the row no longer draws', () => {
  const session = {
    live: true,
    agentState: 'active',
    bounds: { x: 100, y: 50, width: 200, height: 100 },
    monitorBounds: { x: 0, y: 0, width: 1000, height: 500 },
  };
  assert.strictEqual(statusDotHtml(session), '<div class="dot active"></div>');
});

const NOW = 1785600000;

test('formatAge steps through seconds, minutes, hours and days', () => {
  assert.strictEqual(formatAge(NOW, NOW), '0s');
  assert.strictEqual(formatAge(NOW - 31, NOW), '31s');
  assert.strictEqual(formatAge(NOW - 59, NOW), '59s');
  assert.strictEqual(formatAge(NOW - 60, NOW), '1m');
  assert.strictEqual(formatAge(NOW - 59 * 60, NOW), '59m');
  assert.strictEqual(formatAge(NOW - 3600, NOW), '1h');
  assert.strictEqual(formatAge(NOW - 23 * 3600, NOW), '23h');
  assert.strictEqual(formatAge(NOW - 86400, NOW), '1d');
  assert.strictEqual(formatAge(NOW - 3 * 86400, NOW), '3d');
});

test('formatAge keeps the minutes past an hour', () => {
  // Час без минут отвечал «больше часа» на вопрос «сколько уже идёт ход»: и
  // 1h01m, и 1h59m читались одинаково. Ход длиной в час — обычное дело у
  // цикла /do и у ветки субагентов, то есть разрешение теряется ровно там,
  // где на колонку и смотрят.
  assert.strictEqual(formatAge(NOW - 3600 - 5 * 60, NOW), '1h 5m');
  assert.strictEqual(formatAge(NOW - 3600 - 59 * 60, NOW), '1h 59m');
  assert.strictEqual(formatAge(NOW - 23 * 3600 - 40 * 60, NOW), '23h 40m');
});

test('formatAge drops the minutes when there are none', () => {
  // `1h 0m` — три лишних знака про ничто, а колонка узкая.
  assert.strictEqual(formatAge(NOW - 3600, NOW), '1h');
  assert.strictEqual(formatAge(NOW - 2 * 3600 - 30, NOW), '2h');
});

test('formatAge returns nothing for a session that never reported activity', () => {
  assert.strictEqual(formatAge(null, NOW), '');
  assert.strictEqual(formatAge(0, NOW), '');
  assert.strictEqual(formatAge(undefined, NOW), '');
});

test('formatAge clamps a timestamp from the future to zero', () => {
  // Clocks on the two machines need not agree, and a negative age would
  // render as "-2m".
  assert.strictEqual(formatAge(NOW + 120, NOW), '0s');
});

test('rowTitle shortens the agent home directory to a tilde', () => {
  // It is the same for every session and eats a third of the line.
  assert.strictEqual(
    rowTitle({ cwd: '/home/user/projects/python/telegram-assistant' }),
    '~/projects/python/telegram-assistant'
  );
  // The user name is not hard-coded: agents live on other machines too.
  assert.strictEqual(rowTitle({ cwd: '/home/someone/x' }), '~/x');
  // Anything that is not a home directory is left alone.
  assert.strictEqual(rowTitle({ cwd: '/opt/home/x' }), '/opt/home/x');
});

test('rowTitle puts the user prompt above the agent summary', () => {
  assert.strictEqual(
    rowTitle({
      cwd: '/home/user',
      agentPrompt: 'добавь тесты',
      agentDescription: 'Готово.',
    }),
    '~\n\nдобавь тесты\nГотово.'
  );
});

test('rowTitle separates the path from what the agent last said with a blank line', () => {
  assert.strictEqual(
    rowTitle({ cwd: '/home/user', agentDescription: 'Закоммитил — ea527f0', agentMessage: 'Claude needs your permission' }),
    '~\n\nЗакоммитил — ea527f0\nClaude needs your permission'
  );
});

test('rowTitle shows the description a working session came with', () => {
  // Свежей сводки у неё нет: ход ещё идёт. Подставить последнюю — дело
  // sessionDescription (session-agent.js) на сборке строки; здесь строка только
  // показывается, сырые summary / lastSummary подсказка не склеивает, чтобы не
  // разойтись с той склейкой.
  assert.strictEqual(
    rowTitle({ cwd: '/home/user', agentSummary: '', agentDescription: 'Оба сделано.' }),
    '~\n\nОба сделано.'
  );
});

test('rowTitle drops the idle notification', () => {
  // 'waiting for your input' rides on every rested session and pushes out the
  // thing the tooltip is opened for. What it used to disambiguate — yellow dot
  // versus grey — the status says on its own now.
  assert.strictEqual(
    rowTitle({ cwd: '/home/user', agentMessage: 'Claude is waiting for your input' }),
    '~'
  );
});

test('rowTitle drops whichever part is missing', () => {
  assert.strictEqual(rowTitle({ cwd: '/home/user' }), '~');
  assert.strictEqual(rowTitle({ agentMessage: 'Claude needs your permission' }), 'Claude needs your permission');
  // Без пути пустая строка впереди не нужна — отбивать не от чего.
  assert.strictEqual(rowTitle({ agentDescription: 'Оба сделано.' }), 'Оба сделано.');
  assert.strictEqual(rowTitle({}), '');
  assert.strictEqual(rowTitle(undefined), '');
});

test('titleAttr omits the attribute entirely when there is nothing to say', () => {
  // An empty title= paints a blank tooltip box on hover, which is worse than
  // no tooltip at all.
  assert.strictEqual(titleAttr({}), '');
  assert.strictEqual(titleAttr(undefined), '');
});

test('titleAttr escapes a message that would break out of the attribute', () => {
  const out = titleAttr({ agentMessage: 'say "hi" <script>alert(1)</script>' });
  assert.strictEqual(
    out,
    ' title="say &quot;hi&quot; &lt;script&gt;alert(1)&lt;/script&gt;"'
  );
  assert.ok(!out.includes('<script>'), 'must not leave an openable script tag');
});

test('ageHtml always emits the element so the column cannot jump', () => {
  assert.strictEqual(ageHtml({ lastActivity: NOW - 7200 }, NOW), '<div class="age">2h</div>');
  assert.strictEqual(ageHtml({}, NOW), '<div class="age"></div>');
  assert.strictEqual(ageHtml(undefined, NOW), '<div class="age"></div>');
});

test('ageHtml shows the running turn, not the seconds since the last tool call', () => {
  // Работающая сессия дёргает хук десятки раз в минуту, поэтому lastActivity у
  // неё всегда «now» — вопрос «сколько уже крутится команда» отвечает turnAt.
  const working = { agentState: 'active', agentTurnAt: NOW - 570, lastActivity: NOW - 4 };
  assert.strictEqual(ageHtml(working, NOW), '<div class="age">9m</div>');
  // Ход кончился — колонка снова про активность: отметка хода остаётся стоять
  // на прошлом промпте, и показывать её у отдохнувшей сессии значило бы врать.
  assert.strictEqual(
    ageHtml({ agentState: 'review', agentTurnAt: NOW - 570, lastActivity: NOW - 7200 }, NOW),
    '<div class="age">2h</div>'
  );
  // Сессия старше правки в хуке: поля нет, колонка прежняя.
  assert.strictEqual(
    ageHtml({ agentState: 'active', lastActivity: NOW - 300 }, NOW),
    '<div class="age">5m</div>'
  );
});

test('contextLevel warns at thirty per cent and turns hot at forty', () => {
  // Границы включающие: ровно 30 — это уже предупреждение, а не последняя
  // спокойная строка.
  assert.strictEqual(contextLevel(29), '');
  assert.strictEqual(contextLevel(30), 'warn');
  assert.strictEqual(contextLevel(39), 'warn');
  assert.strictEqual(contextLevel(40), 'hot');
});

test('usageHtml puts the cost before the highlighted context', () => {
  // Тот же порядок, что и на панели: список и плата показывают одно и то же.
  assert.strictEqual(
    usageHtml({ agentContextPct: 13, agentCostUsd: 2 }),
    '<div class="usage"><span class="cost">$2</span> · <span class="ctx">13%</span></div>'
  );
  assert.ok(usageHtml({ agentContextPct: 47, agentCostUsd: 2 }).includes('class="ctx hot"'));
});

test('usageHtml печатает ноль, а не прячет его', () => {
  // Раньше ноль значил «данных нет» и колонка у такой сессии пустовала. На
  // глаз это читалось как поломка отрисовки: у соседей цифры есть, тут пусто.
  // Различить «ноль» и «неизвестно» всё равно нечем, и «0%» честнее пустоты.
  assert.strictEqual(usageHtml({ agentContextPct: 0, agentCostUsd: 2 }),
    '<div class="usage"><span class="cost">$2</span> · <span class="ctx">0%</span></div>');
  assert.strictEqual(usageHtml({}),
    '<div class="usage"><span class="cost">$0</span> · <span class="ctx">0%</span></div>');
  assert.strictEqual(usageHtml(undefined),
    '<div class="usage"><span class="cost">$0</span> · <span class="ctx">0%</span></div>');
});

test('нули показываются, а не прячутся', () => {
  // Раньше ноль значил «данных нет»: перехват статуслайна стоит не у каждой
  // сессии, и колонка у такой строки была пуста. Решение поменялось — ноль
  // это ноль, а пустая колонка выглядела как поломка отрисовки.
  const html = usageHtml({ agentCostUsd: 0, agentContextPct: 0 });
  assert.match(html, /\$0/);
  assert.match(html, /0%/);
});

test('нулевой контекст не подсвечивается', () => {
  const html = usageHtml({ agentCostUsd: 0, agentContextPct: 0 });
  assert.doesNotMatch(html, /ctx warn|ctx hot/);
});

test('выключенный чекбокс по-прежнему убирает свою величину', () => {
  const noCost = usageHtml({ agentCostUsd: 0, agentContextPct: 0 }, { showCost: false });
  assert.doesNotMatch(noCost, /\$/);
  assert.match(noCost, /0%/);
  assert.strictEqual(usageHtml({}, { showCost: false, showContext: false }), '');
});

test('stateText shows the state and the event that produced it', () => {
  // Neither half is enough on its own: review comes from both stop and fail,
  // and attention arrives for both a question and an idle notice.
  assert.strictEqual(
    stateText({ live: true, agentState: 'idle', agentEvent: 'attention' }),
    'idle · attention'
  );
  assert.strictEqual(
    stateText({ live: true, agentState: 'review', agentEvent: 'stop' }),
    'review · stop'
  );
});

test('stateText drops the event when it just repeats the state', () => {
  assert.strictEqual(stateText({ live: true, agentState: 'active', agentEvent: 'active' }), 'active');
  assert.strictEqual(stateText({ live: true, agentState: 'active' }), 'active');
});

test('stateText says nothing for a closed session or one with no state', () => {
  assert.strictEqual(stateText({ live: false, agentState: 'active', agentEvent: 'tool-done' }), '');
  assert.strictEqual(stateText({ live: true }), '');
  assert.strictEqual(stateText(undefined), '');
});

test('stateHtml always emits the element so the age column cannot jump', () => {
  assert.strictEqual(
    stateHtml({ live: true, agentState: 'active', agentEvent: 'tool-done' }),
    '<div class="state">active · tool-done</div>'
  );
  assert.strictEqual(stateHtml({ live: false }), '<div class="state"></div>');
});

test('stateHtml escapes an event string it did not choose', () => {
  const out = stateHtml({ live: true, agentState: 'idle', agentEvent: '<script>alert(1)</script>' });
  assert.ok(!out.includes('<script>'), 'must not leave an openable script tag');
});

test('statusDotHtml keeps a stopped session orange until its window is focused', () => {
  // stop and fail write review straight away; the "waiting for your input"
  // notice says the same thing a minute later. One meaning, one colour, and
  // both are cleared by the same thing — looking at the window.
  assert.strictEqual(
    statusDotHtml({ live: true, agentState: 'review', agentEvent: 'stop' }),
    '<div class="dot review"></div>'
  );
  assert.strictEqual(
    statusDotHtml({ live: true, agentState: 'review', agentEvent: 'stop', agentSeen: true }),
    '<div class="dot idle"></div>'
  );
});

// Раньше id и событие делили одну колонку: выключенное событие показывало id.
// Теперь у каждого свой чекбокс, и они независимы — в том числе оба сразу.
//
// Элемент строчный (`span`), а не блочный: id переехал из правой группы
// колонок в строку имени, а там соседи — подписи (`wname`, `pr`), и блок
// сломал бы им ряд.
test('sessionIdHtml is its own toggle, independent of the event one', () => {
  const session = { live: true, id: 'e8afde49-4254-4c64-970e-46c05bf5d516', agentState: 'active' };
  assert.strictEqual(sessionIdHtml(session, true), '<span class="sid">e8af</span>');
  assert.strictEqual(sessionIdHtml(session, false), '');
  assert.strictEqual(sessionIdHtml(session), '', 'id занимает место — по умолчанию выключен');
  assert.strictEqual(stateHtml(session, true), '<div class="state">active</div>');
});

// Выключенный чекбокс убирает колонку сразу у всего списка, и распорка под неё
// не нужна — в отличие от строки, у которой просто нет данных.
test('a toggled-off column leaves no element behind', () => {
  const session = { live: true, agentState: 'active', agentContextPct: 13, agentCostUsd: 2 };
  assert.strictEqual(stateHtml(session, false), '');
  assert.strictEqual(usageHtml(session, { showCost: false, showContext: false }), '');
  assert.strictEqual(
    usageHtml(session, { showCost: false, showContext: true }),
    '<div class="usage"><span class="ctx">13%</span></div>'
  );
  assert.strictEqual(
    usageHtml(session, { showCost: true, showContext: false }),
    '<div class="usage"><span class="cost">$2</span></div>'
  );
});

// Заголовок диалога рисуется и из строки списка (есть и title, и label), и из
// ответа меню действий (только label). Скобки с id в него больше не приезжают:
// их не приписывает и labelSessions.
test('sessionName takes whatever name the caller has', () => {
  assert.strictEqual(sessionName({ title: 'ExpertizeMe', label: 'ExpertizeMe' }), 'ExpertizeMe');
  assert.strictEqual(sessionName({ label: 'ExpertizeMe' }), 'ExpertizeMe');
  assert.strictEqual(sessionName({ title: 'build (nightly)' }), 'build (nightly)');
  // Имени нет вовсе — остаётся id: пустой заголовок ничего не сообщает.
  assert.strictEqual(sessionName({ label: '', id: 'ea567ed1-4308' }), 'ea567ed1-4308');
  assert.strictEqual(sessionName(undefined), '');
});

// Хоткей проекта — подпись в строке имени, а не колонка справа: колонкой он
// побывал между двумя правками, и обратно её ловит именно этот сторож. Пустой
// подписи не остаётся вовсе: сдвигать ей нечего (колонок рядом нет), а
// растянуть строку имени лишним отступом она могла бы.
test('hotkeyHtml is a badge in the name line, nothing at all without a key', () => {
  assert.strictEqual(hotkeyHtml({ hotkey: '^F12' }, true), '<span class="hk">^F12</span>');
  assert.strictEqual(hotkeyHtml({}, true), '');
  assert.strictEqual(hotkeyHtml({ hotkey: '' }, true), '');
  assert.strictEqual(hotkeyHtml(undefined, true), '');
  assert.strictEqual(hotkeyHtml({ hotkey: '^F12' }), '<span class="hk">^F12</span>');
  assert.strictEqual(hotkeyHtml({ hotkey: '^F12' }, false), '');
});

// Занятый хоткей обязан быть виден: до этой правки отказ регистрации стоил
// строки в stderr, которого у приложения из трея не читает никто, — и клавиша,
// отобранная соседом по системе, выглядела как сломанный конфиг.
test('незарегистрированный хоткей помечен в подписи', () => {
  const html = hotkeyHtml({ hotkey: 'Ctrl+F11', hotkeyTaken: true });
  assert.match(html, /class="hk taken"/);
  assert.match(html, /Ctrl\+F11/);
});

test('обычный хоткей рисуется без пометки', () => {
  const html = hotkeyHtml({ hotkey: 'Ctrl+F11' });
  assert.match(html, /class="hk"/);
});

test('shortSessionId names the agent that is writing, not the one it forked from', () => {
  assert.strictEqual(shortSessionId({ id: 'parent-id', agentSessionId: 'child-id-1234' }), 'chil');
  assert.strictEqual(shortSessionId({ id: 'parent-id-9999' }), 'pare');
  assert.strictEqual(shortSessionId(undefined), '');
});

test('stateText marks a session whose work moved to a background agent', () => {
  // Окно закрыто, а работа идёт: `claude agents` уводит сессию в форк без
  // своего окна, и «закрыто» про него ничего не сообщает.
  assert.strictEqual(
    stateText({ live: false, agentBackground: true, agentState: 'active', agentEvent: 'tool-done' }),
    'bg active · tool-done'
  );
  assert.strictEqual(
    stateText({ live: false, agentBackground: false, agentState: 'active' }),
    ''
  );
});

test('prNumber takes the number from the tail of a pull request url', () => {
  assert.strictEqual(prNumber('https://github.com/popstas/ccfzf/pull/3'), '3');
  assert.strictEqual(prNumber('https://github.com/popstas/ccfzf/pull/128'), '128');
});

test('prNumber returns an empty string for anything else', () => {
  assert.strictEqual(prNumber('https://github.com/popstas/ccfzf/issues/3'), '');
  assert.strictEqual(prNumber(''), '');
  assert.strictEqual(prNumber(undefined), '');
});

test('prNumber rejects a payload hidden inside the owner/repo segment, not just after the number', () => {
  // Ссылка уходит в команду открытия браузера без экранирования: `[^/]+`
  // пропускал бы что угодно, кроме слэша, включая эти символы внутри сегмента.
  assert.strictEqual(prNumber('https://github.com/a&whoami/b/pull/1'), '');
  assert.strictEqual(prNumber('https://github.com/a/b|whoami/pull/1'), '');
  assert.strictEqual(prNumber('https://github.com/a"whoami/b/pull/1'), '');
  assert.strictEqual(prNumber('https://github.com/a b/whoami/pull/1'), '');
  assert.strictEqual(prNumber('https://github.com/a\nwhoami/b/pull/1'), '');
});

test('prBadgeHtml renders the badge only for sessions with a pull request', () => {
  assert.strictEqual(
    prBadgeHtml({ pr_url: 'https://github.com/popstas/ccfzf/pull/3' }),
    '<span class="pr">↗ #3</span>',
  );
  assert.strictEqual(prBadgeHtml({ pr_url: '' }), '');
  assert.strictEqual(prBadgeHtml({}), '');
});

// ── колонка с машиной чужого окна ───────────────────────────────────────────
test('машина чужого окна выводится с подсказкой', () => {
  const html = windowHostHtml({ windowHost: 'mac-host', window: { host: 'mac-host' } });
  assert.match(html, /mac-host/);
  assert.match(html, /title="Window is on mac-host"/);
});

test('без чужой машины остаётся пустой элемент, а не пропуск', () => {
  // Правые колонки стоят друг за другом, и дырка сдвинула бы соседние строки.
  assert.strictEqual(windowHostHtml({ windowHost: '' }), '<div class="winhost"></div>');
});

test('windowHost без записи окна ничего не рисует', () => {
  // С двумя источниками windowHost ставится и без окна вовсе (ambiguous в
  // session-list.js) — просто по имени источника. «Window is on <host>» тогда
  // было бы неправдой: окна там нет, только чужая сессия без трекера.
  assert.strictEqual(
    windowHostHtml({ windowHost: 'remote-host', window: null, windows: [] }),
    '<div class="winhost"></div>',
  );
});

test('выключенная галка убирает колонку целиком', () => {
  assert.strictEqual(windowHostHtml({ windowHost: 'mac-host', window: { host: 'mac-host' } }, false), '');
});

test('имя машины экранируется', () => {
  // Строка приезжает из файла, написанного на чужой машине.
  assert.ok(!windowHostHtml({ windowHost: '<b>x', window: { host: '<b>x' } }).includes('<b>'));
});

// ── basename проекта под именем строки ──────────────────────────────────────

test('ccfzf_picker совпадает с ccfzf-picker', () => {
  assert.strictEqual(hidesProject('ccfzf_picker', '/x/ccfzf-picker'), true);
  assert.strictEqual(projectLine('ccfzf_picker', '/x/ccfzf-picker'), '');
});

test('mac-wezterm показывает basename', () => {
  assert.strictEqual(hidesProject('mac-wezterm', '/x/projects/js/ccfzf-picker'), false);
  assert.strictEqual(projectLine('mac-wezterm', '/x/ccfzf-picker'), 'ccfzf-picker');
});

test('короткое picker гасит ccfzf-picker', () => {
  // Правило одностороннее: подмножество — тоже совпадение, не только равенство.
  assert.strictEqual(hidesProject('picker', '/x/ccfzf-picker'), true);
});

test('пустые имя или cwd не гасят', () => {
  assert.strictEqual(hidesProject('', '/x/ccfzf-picker'), false);
  assert.strictEqual(hidesProject('n', ''), false);
});

test('wordSet режет по не-буквенно-цифровым символам и понижает регистр', () => {
  assert.deepStrictEqual(wordSet('Ccfzf_Picker-2'), new Set(['ccfzf', 'picker', '2']));
  assert.deepStrictEqual(wordSet(''), new Set());
  assert.deepStrictEqual(wordSet(undefined), new Set());
});

test('projectLine берёт последний непустой сегмент пути — и по /, и по \\', () => {
  assert.strictEqual(projectLine('other', '/x/y/ccfzf-picker/'), 'ccfzf-picker');
  assert.strictEqual(projectLine('other', 'X:\\Users\\user\\ccfzf-picker'), 'ccfzf-picker');
});

// ── глиф терминала в колонке окна ───────────────────────────────────────────

test('windowHtml оставляет прежний глиф без записи о терминале', () => {
  // Трекер сегодня не пишет ни app, ни process — откат к ▣ честнее, чем
  // подстановка пресета терминала пикера (у соседних строк терминалы разные).
  assert.strictEqual(
    windowHtml({ window: { hwnd: 1 } }, true, true),
    '<div class="win open">▣</div>',
  );
});

test('windowHtml меняет глиф, когда трекер назвал знакомый терминал', () => {
  assert.strictEqual(
    windowHtml({ window: { hwnd: 1, app: 'wezterm-gui.exe' } }, true, true),
    '<div class="win open" title="WezTerm">z</div>',
  );
  assert.strictEqual(
    windowHtml({ window: { hwnd: 1, process: 'WindowsTerminal.exe' } }, true, true),
    '<div class="win open" title="Windows Terminal">w</div>',
  );
});

test('терминалы Windows различаются между собой — wt не читается как wezterm', () => {
  // Ради этого правило и заведено поимённым: на popstas-pc рядом живут оба, и
  // общий знак ⌨ на них двоих не отвечал бы на единственный вопрос к пометке.
  const glyph = (named) => windowHtml({ window: { app: named } }, true, true);
  assert.strictEqual(glyph('wt.exe'), '<div class="win open" title="Windows Terminal">w</div>');
  assert.strictEqual(glyph('wezterm-gui.exe'), '<div class="win open" title="WezTerm">z</div>');
  assert.notStrictEqual(glyph('wt.exe'), glyph('wezterm-gui.exe'));
});

test('маковский Terminal.app не читается как Windows Terminal', () => {
  // Порядок в таблице значим: `windowsterminal` проверяется первым, иначе
  // отображаемое имя `Terminal` увело бы обе строки под один глиф.
  assert.strictEqual(
    windowHtml({ window: { app: 'Terminal' } }, true, true),
    '<div class="win open" title="Terminal">T</div>',
  );
  assert.strictEqual(
    windowHtml({ window: { app: 'WindowsTerminal.exe' } }, true, true),
    '<div class="win open" title="Windows Terminal">w</div>',
  );
});

test('маковские имена приложений узнаются наравне с exe', () => {
  // На маке трекер называет отображаемое имя, а не файл: `kitty`, `iTerm2`.
  assert.strictEqual(
    windowHtml({ window: { app: 'kitty' } }, true, true),
    '<div class="win open" title="kitty">k</div>',
  );
  assert.strictEqual(
    windowHtml({ window: { app: 'iTerm2' } }, true, true),
    '<div class="win open" title="iTerm2">i</div>',
  );
  assert.strictEqual(
    windowHtml({ window: { app: 'Ghostty' } }, true, true),
    '<div class="win open" title="Ghostty">g</div>',
  );
});

test('имя терминала приписывается к подсказке рядом со столом, а не вместо', () => {
  // Стол называет трекер Windows, терминал — оба; обе части нужны, и обе
  // склеиваются одной подсказкой.
  assert.strictEqual(
    windowHtml({ window: { desktop: 2, app: 'kitty' } }, true, true),
    '<div class="win open" title="Desktop 2 · kitty">k</div>',
  );
  assert.strictEqual(
    windowHtml({ window: { desktop: 2, app: 'kitty' } }, true, false),
    '<div class="win open" title="Desktop 2">▣</div>',
  );
});

test('windowHtml не подменяет глиф, пока галка выключена', () => {
  assert.strictEqual(
    windowHtml({ window: { hwnd: 1, app: 'kitty' } }, true, false),
    '<div class="win open">▣</div>',
  );
});

test('windowHtml не подменяет глиф у незнакомого приложения', () => {
  // Регэксп общий на все терминалы: незнакомое приложение остаётся ▣.
  assert.strictEqual(
    windowHtml({ window: { hwnd: 1, app: 'notepad.exe' } }, true, true),
    '<div class="win open">▣</div>',
  );
});

// ── глиф на каждое окно сессии ──────────────────────────────────────────────

test('у сессии с двумя окнами глиф на каждое', () => {
  const html = windowHtml({ windows: [
    { app: 'kitty', host: 'mac-host' },
    { app: 'WindowsTerminal.exe', host: 'windows-box', desktop: 1 },
  ] }, true, true);
  assert.strictEqual((html.match(/class="win open"/g) || []).length, 2);
  assert.ok(html.includes('Windows Terminal'), html);
});

test('подсказка называет машину каждого окна', () => {
  const html = windowHtml({ windows: [
    { app: 'kitty', host: 'mac-host' },
    { app: 'WindowsTerminal.exe', host: 'windows-box', desktop: 1 },
  ] }, true, true);
  assert.ok(html.includes('title="kitty · mac-host"'), html);
  assert.ok(html.includes('title="Desktop 1 · Windows Terminal · windows-box"'), html);
});

test('две машины в колонке названы обе', () => {
  const html = windowHostHtml(
    { windowHost: 'mac-host, other-box', window: { host: 'mac-host' } }, true);
  assert.ok(html.includes('>mac-host, other-box<'), html);
  assert.ok(html.includes('Windows are on'), html);
});

test('имя окна показывается только тогда, когда оно расходится с именем сессии', () => {
  const { windowNameHtml } = require('../frontend-src/session-glyph');
  // Разошлись — имя окна показано: иначе сессию, которую человек завёл под
  // именем `tray-build-time`, в списке не опознать вовсе.
  assert.match(
    windowNameHtml({ title: 'esm-migration', windowTitle: 'tray-build-time' }),
    /tray-build-time/,
  );
  // Совпали по словам — молчим: та же мерка, что у второй строки с каталогом
  // (hidesProject), и по той же причине — вторая подпись с тем же смыслом
  // только отнимает место.
  assert.strictEqual(windowNameHtml({ title: 'ccfzf-picker', windowTitle: 'ccfzf_picker' }), '');
  // Окна нет — показывать нечего.
  assert.strictEqual(windowNameHtml({ title: 'esm-migration', windowTitle: '' }), '');
  assert.strictEqual(windowNameHtml(null), '');
});

test('имя окна экранируется: оно приезжает с чужой машины', () => {
  const { windowNameHtml } = require('../frontend-src/session-glyph');
  const html = windowNameHtml({ title: 'x', windowTitle: '<img src=x>' });
  assert.ok(!html.includes('<img'), 'заголовок окна пишет чужой трекер, и в разметку он не уходит');
});

// --- Счётчики docs/TODO.md у строки проекта (Task T4) ---------------------
//
// Приезжают полем `todo` от агрегатора: список секций по заголовкам первого
// уровня. Форматирует их читатель — то же правило, по которому он же считает
// возраст: вторая форма на стороне агрегатора разошлась бы с колонкой.

test('todoHtml показывает ведущую секцию, а остаток — числом', () => {
  // Ведущая секция — как в statusline-block.sh: сделано из всего в ней.
  // Остальные сворачиваются в одно число открытых: полная разбивка уезжает в
  // подсказку, потому что в колонке у неё нет ширины — у ccfzf-picker она
  // самая длинная из двадцати трёх проектов с TODO на живой машине.
  const sections = [
    { label: 'next', done: 0, todo: 4 },
    { label: 'future', done: 0, todo: 4 },
    { label: 'minor', done: 0, todo: 8 },
  ];
  assert.strictEqual(todoHtml({ todo: sections }, true),
    '<div class="todo">☑ 0/4 next <span class="rest">+12</span></div>');
});

test('todoHtml без хвоста не приписывает +0', () => {
  assert.strictEqual(todoHtml({ todo: [{ label: 'next', done: 1, todo: 2 }] }, true),
    '<div class="todo">☑ 1/3 next</div>');
});

test('todoHtml обходится без метки, когда её нет', () => {
  // Галочки до первого заголовка — обычное дело у мелкого проекта. Пустая
  // метка значит «называть нечем», и лишний пробел за ней был бы виден.
  assert.strictEqual(todoHtml({ todo: [{ label: '', done: 2, todo: 0 }] }, true),
    '<div class="todo">☑ 2/2</div>');
});

test('todoHtml молчит, когда считать нечего или галка выключена', () => {
  // Пустого элемента здесь быть не должно: у двадцати проектов из сорока пяти
  // docs/TODO.md нет вовсе, и пустая колонка стояла бы у половины списка.
  // Это та же развилка, что у usageHtml с обеими выключенными галками.
  assert.strictEqual(todoHtml({ todo: [] }, true), '');
  assert.strictEqual(todoHtml({}, true), '');
  assert.strictEqual(todoHtml({ todo: [{ label: 'next', done: 0, todo: 1 }] }, false), '');
});

test('todoHtml экранирует метку из файла', () => {
  // Метку пишет человек в своём docs/TODO.md, а файл этот приезжает с чужой
  // машины через агрегатор: в разметку она попадает как данные, а не как
  // разметка.
  assert.match(todoHtml({ todo: [{ label: '<b>x', done: 0, todo: 1 }] }, true),
    /&lt;b&gt;x/);
});

test('todoHtml не верит числам из ответа', () => {
  // Поле приезжает по сети из файла на чужой машине. NaN в колонке выглядел бы
  // поломкой пикера, а не испорченным входом.
  assert.strictEqual(todoHtml({ todo: [{ label: 'next', done: 'нет', todo: null }] }, true),
    '<div class="todo">☑ 0/0 next</div>');
  assert.strictEqual(todoHtml({ todo: 'нет' }, true), '');
});

test('подсказка строки несёт полную разбивку по секциям', () => {
  // Ради этого разбивка и не влезает в строку: вопрос «а где именно они»
  // задают редко, и ответ на него место в колонке не окупает.
  const title = rowTitle({
    cwd: '/home/user/p',
    todo: [{ label: 'next', done: 0, todo: 4 }, { label: 'minor', done: 1, todo: 8 }],
  });
  assert.match(title, /next 0\/4 · minor 1\/9/);
});

test('подсказка без счёта остаётся прежней', () => {
  assert.strictEqual(rowTitle({ cwd: '/home/user/p' }), rowTitle({ cwd: '/home/user/p', todo: [] }));
});

// --- Спека и план сессии (Task T5) ---------------------------------------

test('docsBadgeHtml ставит один знак, когда бумаги есть', () => {
  // Знак один на обе бумаги: их у сессии почти всегда две сразу, и два
  // одинаковых значка рядом отвечали бы на один и тот же вопрос дважды.
  assert.strictEqual(docsBadgeHtml({ plan: 'docs/superpowers/plans/a.md' }),
    '<span class="docs" title="plan">▤</span>');
  assert.strictEqual(docsBadgeHtml({ spec: 'docs/superpowers/specs/a-design.md' }),
    '<span class="docs" title="spec">▤</span>');
});

test('docsBadgeHtml называет план, когда есть обе', () => {
  // План главнее спеки: спека отвечает «что решили», план — «где сейчас», и
  // из списка приходят за вторым.
  assert.strictEqual(
    docsBadgeHtml({ plan: 'docs/superpowers/plans/a.md', spec: 'docs/superpowers/specs/a.md' }),
    '<span class="docs" title="plan">▤</span>');
});

test('docsBadgeHtml молчит без бумаг', () => {
  // Пустого элемента быть не должно: бумаг нет у трёх сессий из четырёх, и
  // пустой значок стоял бы почти в каждой строке.
  assert.strictEqual(docsBadgeHtml({}), '');
  assert.strictEqual(docsBadgeHtml({ plan: '' }), '');
  assert.strictEqual(docsBadgeHtml(null), '');
});

test('docsBadgeHtml не верит нестроке', () => {
  assert.strictEqual(docsBadgeHtml({ plan: 42 }), '');
});

// --- Размер сессии: число реплик человека (Task T2) ----------------------

test('promptsHtml показывает число реплик своей колонкой', () => {
  assert.strictEqual(promptsHtml({ promptCount: 97 }, true),
    '<div class="prompts">✎97</div>');
});

test('promptsHtml печатает ноль, а не пустоту', () => {
  // Ноль здесь честен: сессия, в которой человек ещё ничего не написал,
  // бывает — её только что завели. Пустота на её месте читалась бы как
  // «данных нет», а различать эти два случая нечем. То же решение и та же
  // причина, что у usageHtml с нулевой ценой.
  assert.strictEqual(promptsHtml({ promptCount: 0 }, true),
    '<div class="prompts">✎0</div>');
});

test('promptsHtml молчит при выключенной галке', () => {
  // Колонки нет вовсе, а не пустой элемент: правые колонки стоят друг за
  // другом, и пустой div сдвигал бы соседей.
  assert.strictEqual(promptsHtml({ promptCount: 5 }, false), '');
});

test('promptsHtml не верит нечислу из ответа', () => {
  assert.strictEqual(promptsHtml({ promptCount: 'много' }, true),
    '<div class="prompts">✎0</div>');
  assert.strictEqual(promptsHtml({}, true), '<div class="prompts">✎0</div>');
});

// --- Комментарий человека к сессии (Task T3) -----------------------------

test('commentHtml рисует строку под ответом', () => {
  assert.strictEqual(commentHtml({ comment: 'чинит окна' }, true),
    '<div class="comment">чинит окна</div>');
});

test('commentHtml молчит без комментария и при выключенной галке', () => {
  // Пустой строки быть не должно: она заняла бы высоту у каждой сессии без
  // комментария, а таких почти все.
  assert.strictEqual(commentHtml({}, true), '');
  assert.strictEqual(commentHtml({ comment: '' }, true), '');
  assert.strictEqual(commentHtml({ comment: 'есть' }, false), '');
});

test('commentHtml экранирует текст', () => {
  // Пишет его человек, и приезжает он с чужой машины через агрегатор: в
  // разметку попадает как данные.
  assert.match(commentHtml({ comment: '<b>жирно' }, true), /&lt;b&gt;жирно/);
});

// ── Ширины колонок строки проекта ────────────────────────────────────────────
//
// Правая группа прижата вправо, поэтому левый край колонки задаётся шириной
// всех колонок правее неё. Пока ширина считалась по содержимому, «172 · 4●» у
// одного проекта сдвигал счёт задач у него же, и левые края стояли лесенкой.

test('счёт задач голым текстом — та же формула, что и в разметке', () => {
  const row = { todo: [{ label: 'week', done: 0, todo: 28 }, { label: 'minor', done: 1, todo: 27 }] };
  assert.strictEqual(todoText(row), '☑ 0/28 week +27');
  // Разметка складывается из тех же кусков: разойдись они, колонка встала бы
  // уже своего содержимого, и хвост «+N» срезало бы.
  assert.strictEqual(todoHtml(row),
    '<div class="todo">☑ 0/28 week <span class="rest">+27</span></div>');
  // Хвоста нет — нет и пустого `span`.
  assert.strictEqual(todoText({ todo: [{ label: 'next', done: 1, todo: 0 }] }), '☑ 1/1 next');
  assert.strictEqual(todoText({}), '');
});

test('счёт сессий проекта: живые называются только когда они есть', () => {
  assert.strictEqual(projectCountText({ sessionCount: 172, liveCount: 4 }), '172 · 4●');
  assert.strictEqual(projectCountText({ sessionCount: 11, liveCount: 0 }), '11');
  // Мусор из ответа не должен доезжать до колонки словом «undefined».
  assert.strictEqual(projectCountText({}), '0');
  assert.strictEqual(projectCountHtml({ sessionCount: 7 }), '<div class="count">7</div>');
});

test('ширина колонки считается по самому длинному значению списка', () => {
  const now = 1786045920;
  const projects = [
    { sessionCount: 17, liveCount: 1, lastActivity: now - 14,
      todo: [{ label: 'next', done: 0, todo: 3 }, { label: 'x', done: 0, todo: 2 }] },
    { sessionCount: 172, liveCount: 4, lastActivity: now - 3780,
      todo: [{ label: 'week', done: 0, todo: 28 }] },
    { sessionCount: 18, liveCount: 0, lastActivity: now - 4 * 3600 },
  ];
  const widths = projectColumnWidths(projects, now);
  // «☑ 0/3 next +2» — 13 знаков, из них ☑ считается за полтора.
  assert.strictEqual(widths.todo, 13.5);
  // «172 · 4●» — 8 знаков, два из них вне ASCII.
  assert.strictEqual(widths.count, 9);
  // «1h 3m» — самый длинный возраст в списке.
  assert.strictEqual(widths.age, 5);
});

test('пустой список колонок не роняет мерку', () => {
  assert.deepStrictEqual(projectColumnWidths([], 0), { todo: 0, count: 0, age: 0 });
  assert.deepStrictEqual(projectColumnWidths(undefined, 0), { todo: 0, count: 0, age: 0 });
  // Ни у одного проекта нет счёта задач — колонки не будет вовсе, и ширина у
  // неё нулевая, а не пол-строки пустоты.
  assert.strictEqual(projectColumnWidths([{ sessionCount: 1 }], 0).todo, 0);
});
