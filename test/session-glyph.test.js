const { test } = require('node:test');
const assert = require('node:assert');
const {
  escapeHtml, statusDotHtml, formatAge, ageHtml, stateText, shortSessionId, stateHtml,
  sessionIdHtml, sessionName, hotkeyHtml, contextLevel, usageHtml,
  shortPath, rowTitle, titleAttr, windowHostHtml, windowHtml,
  prNumber, prBadgeHtml, wordSet, hidesProject, projectLine,
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
test('sessionIdHtml is its own column, independent of the event one', () => {
  const session = { live: true, id: 'e8afde49-4254-4c64-970e-46c05bf5d516', agentState: 'active' };
  assert.strictEqual(sessionIdHtml(session, true), '<div class="sid">e8af</div>');
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

// Хоткей проекта переехал из имени сессии в свою колонку: у сессий без проекта
// элемент остаётся пустым, иначе соседние колонки разъезжались бы по строкам.
test('hotkeyHtml is a column of its own, empty when the project has no key', () => {
  assert.strictEqual(hotkeyHtml({ hotkey: '^F12' }, true), '<div class="hk">^F12</div>');
  assert.strictEqual(hotkeyHtml({}, true), '<div class="hk"></div>');
  assert.strictEqual(hotkeyHtml({ hotkey: '^F12' }), '<div class="hk">^F12</div>');
  assert.strictEqual(hotkeyHtml({ hotkey: '^F12' }, false), '');
});

// Занятый хоткей обязан быть виден: до этой правки отказ регистрации стоил
// строки в stderr, которого у приложения из трея не читает никто, — и клавиша,
// отобранная соседом по системе, выглядела как сломанный конфиг.
test('незарегистрированный хоткей помечен в колонке', () => {
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
  const html = windowHostHtml({ windowHost: 'mac-host' });
  assert.match(html, /mac-host/);
  assert.match(html, /title="Window is on mac-host"/);
});

test('без чужой машины остаётся пустой элемент, а не пропуск', () => {
  // Правые колонки стоят друг за другом, и дырка сдвинула бы соседние строки.
  assert.strictEqual(windowHostHtml({ windowHost: '' }), '<div class="winhost"></div>');
});

test('выключенная галка убирает колонку целиком', () => {
  assert.strictEqual(windowHostHtml({ windowHost: 'mac-host' }, false), '');
});

test('имя машины экранируется', () => {
  // Строка приезжает из файла, написанного на чужой машине.
  assert.ok(!windowHostHtml({ windowHost: '<b>x' }).includes('<b>'));
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
    '<div class="win open" title="WezTerm">w</div>',
  );
  assert.strictEqual(
    windowHtml({ window: { hwnd: 1, process: 'WindowsTerminal.exe' } }, true, true),
    '<div class="win open" title="Windows Terminal">t</div>',
  );
});

test('терминалы Windows различаются между собой — wt не читается как wezterm', () => {
  // Ради этого правило и заведено поимённым: на popstas-pc рядом живут оба, и
  // общий знак ⌨ на них двоих не отвечал бы на единственный вопрос к пометке.
  const glyph = (named) => windowHtml({ window: { app: named } }, true, true);
  assert.strictEqual(glyph('wt.exe'), '<div class="win open" title="Windows Terminal">t</div>');
  assert.strictEqual(glyph('wezterm-gui.exe'), '<div class="win open" title="WezTerm">w</div>');
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
    '<div class="win open" title="Windows Terminal">t</div>',
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
