// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionActions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся.
  const glyphApi = typeof module === 'object' && module.exports
    ? require('./session-glyph')
    : globalThis.SessionGlyph;
  const openApi = typeof module === 'object' && module.exports
    ? require('./open-strategy')
    : globalThis.OpenStrategy;
  const pathApi = typeof module === 'object' && module.exports
    ? require('./path-map')
    : globalThis.PathMap;
  // Признак сессии Claude Desktop берётся у развилки Enter, а не пишется
  // здесь вторым условием: пункт «Resume in terminal» существует ровно
  // потому, что Enter у такой строки уводит в приложение. Разойдись правила —
  // в меню стоял бы пункт про дорогу, которой Enter не ходит, или наоборот.
  // Загрузка это выдерживает: open-transport.js стоит раньше и в
  // sessions.html, и в prepare-frontend.js.
  const transportApi = typeof module === 'object' && module.exports
    ? require('./open-transport')
    : globalThis.OpenTransport;

  // Номер PR берётся у отрисовщика строки, а не разбирается здесь вторым
  // регэкспом. Два разбора одной ссылки разъезжаются молча: строка показала бы
  // бейдж «↗ #3» там, где меню не даёт пункта, или наоборот. Заодно это
  // единственное место, где проверяется форма ссылки перед тем, как она уйдёт
  // в аргумент команды открытия браузера, — дублировать такую проверку опасно.
  const prNumber = glyphApi.prNumber;

  /**
   * Что пикер может предложить для этой строки.
   *
   * Информация есть всегда: она рисуется из той же строки и ничего не
   * запрашивает. Возврат в непрочитанное бессмыслен и без записи агента
   * (`lastActivity === 0` — нечего отматывать), и у строки, которую и так не
   * читали: на маке «читал» — это `agentSeen`, отметку ставит открытие сессии.
   *
   * Открытия сессии в списке нет намеренно: оно висит на Enter и на клике, а не
   * прячется в меню.
   *
   * Настроенные действия открытия папки идут первыми: они самые частые, а
   * встроенные — про случай (есть PR, есть pid). Появляются они только там, где
   * путь сессии удалось перевести на эту машину: пункт, открывающий несуществующую
   * папку, хуже отсутствующего.
   *
   * `config` необязателен — без него список прежний. Так вызов остаётся годным
   * и там, где конфига под рукой нет (тесты формы строки).
   */
  function availableActions(row, config) {
    const actions = [];
    const cfg = config || {};
    // Строка проекта — это каталог, и всё, что держится за сессию, ей не
    // подходит: у неё нет ни записи агента, ни pid, ни истории. Ветка стоит
    // до всего остального, чтобы это правило было видно одним куском.
    if ((row || {}).kind === 'project') {
      const forProject = [
        { id: 'new', label: 'New session' },
        // Шелл в том же каталоге, без агента: «зайти руками» — обычный ход
        // рядом с «начать сессию». Каталог у строки проекта есть всегда, так
        // что условия ему, в отличие от общей ветки, не нужно.
        { id: 'terminal', label: 'Open terminal' },
      ];
      if (pathApi.mapRowPath(row, cfg.pathMap) !== null) {
        for (const a of cfg.actions || []) {
          forProject.push({ id: a.id, label: a.label, hotkey: a.hotkey, menuKey: a.menuKey });
        }
      }
      return forProject;
    }
    // Зелийная сессия — терминал, а не работа агента: записи агента, pid и
    // истории у неё нет, а каталог у её панелей может быть разный. Сейчас её
    // отсеял бы и пустой cwd, но держаться на этом нельзя: первое же действие,
    // не спрашивающее каталога, утекло бы в строку, которой оно ничего не
    // сделает. Открытие в меню не значится намеренно — оно висит на Enter.
    if ((row || {}).kind === 'zellij') return [{ id: 'info', label: 'Session info' }];
    // Заголовок снимка — не сессия, а запись о раскладке: ни каталога, ни
    // записи агента, ни pid у него нет вовсе. Общая ветка предлагала ему одну
    // «Session info», и карточка та рисовалась по строке, в которой сессии
    // нет, — то есть пустой.
    //
    // Восстановление стоит в меню вопреки правилу «открытие висит на Enter, в
    // меню его нет»: другого дела у заголовка не бывает, и без этого пункта
    // меню оказалось бы пустым. Пустое меню на строке, у которой действие есть,
    // читается как поломка.
    if ((row || {}).kind === 'snapshot') return [{ id: 'restore', label: 'Restore snapshot' }];
    // Заголовок дня — переключатель, и ничего кроме: под ним снимков
    // несколько, и «восстанови их все» никто не просил, а всё сессионное
    // нарисовало бы по нему ту же пустоту, что и по заголовку снимка. Меню
    // выходит пустым, и такое openMenu не открывает вовсе — то же, что у
    // строки снимка без каталога.
    if ((row || {}).kind === 'snapshot-day') return [];
    // Строка внутри снимка несёт настоящий id сессии и настоящий каталог, но
    // ни одного поля самой сессии: живости, записи агента, pid и ссылки на PR
    // в ней нет. Каталог честен — на нём и держатся оба пункта; всё
    // сессионное нарисовало бы по такой строке пустоту.
    //
    // Восстановления здесь нет намеренно, в отличие от заголовка: Enter на
    // этой строке уже восстанавливает её окно (а у открытого — поднимает), и
    // дубль в меню был бы тем самым «открытием в меню», которого правило не
    // велит. Заголовку исключение сделано пустотой, а у этой строки меню не
    // пустое. Пустым оно всё же бывает — у строки без каталога; такое меню
    // не открывается вовсе, см. openMenu в sessions.html.
    //
    // Пункт «Open on <host>» сюда не входит и входить не должен: его
    // добавляет страница (`actionsFor`), и он честен — id настоящий, менеджер
    // найдёт сессию по нему.
    if ((row || {}).kind === 'snapshot-session') {
      const forSnapshot = [];
      if (pathApi.mapRowPath(row, cfg.pathMap) !== null) {
        for (const a of cfg.actions || []) {
          forSnapshot.push({ id: a.id, label: a.label, hotkey: a.hotkey, menuKey: a.menuKey });
        }
      }
      if (row.cwd) {
        forSnapshot.push({ id: 'new', label: 'New session' });
        forSnapshot.push({ id: 'terminal', label: 'Open terminal' });
      }
      return forSnapshot;
    }
    if (pathApi.mapRowPath(row, cfg.pathMap) !== null) {
      for (const a of cfg.actions || []) actions.push({ id: a.id, label: a.label, hotkey: a.hotkey, menuKey: a.menuKey });
    }
    const num = prNumber((row || {}).pr_url);
    if (num) actions.push({ id: 'pr', label: `Open PR #${num}` });
    // Спека и план — файлы внутри `cwd`, и открыть их можно только там, где
    // путь переводится на эту машину: то же правило и та же проверка, что у
    // действий с папкой выше. Без pathMap пункт вёл бы в никуда.
    //
    // План первым: спека отвечает «что решили», план — «где сейчас», и из
    // списка приходят за вторым. Тот же порядок, что и у значка в строке
    // (docKindOf в session-glyph.js).
    if (pathApi.mapRowPath(row, cfg.pathMap) !== null) {
      for (const [id, label] of [['plan', 'Open plan'], ['spec', 'Open spec']]) {
        const rel = (row || {})[id];
        if (typeof rel === 'string' && rel) actions.push({ id, label });
      }
    }
    if (row && row.lastActivity && row.agentSeen) actions.push({ id: 'unread', label: 'Mark unread' });
    // Зеркало предыдущего, и условие у него зеркальное же: отмечать
    // просмотренным нечего у строки без записи агента и незачем у той, что уже
    // просмотрена. Оба пункта разом не появляются никогда — это сторожит тест.
    if (row && row.lastActivity && !row.agentSeen) actions.push({ id: 'seen', label: 'Mark seen' });
    // Переклейка предлагается только там, где ей есть за что тянуть: живая
    // сессия с известным pid. Пикер эту команду не выполняет — отдаёт человеку,
    // см. buildAttachCommand.
    if (row && row.live && openApi.buildAttachCommand(row)) {
      actions.push({ id: 'attach', label: 'Copy reptyr command' });
    }
    // Сессию приложения Enter возвращает в приложение (`chooseEnterAction`),
    // и дорога в терминал остаётся только здесь. Правило «открытие висит на
    // Enter, в меню его нет» этим не нарушено: в меню стоит не то, что делает
    // Enter, а ровно то, чего он у этой строки больше не делает.
    //
    // Буква своя (`menuKey`), а не запись в BUILTIN_ACTION_KEYS: та даёт не
    // только букву в меню, но и глобальный Ctrl-хоткей, а `Ctrl+E` у человека
    // уже занят настроенным действием — встроенная ветка съедала бы у него
    // событие молча. Совпади буква с чужой, `menuKeys` оставит пункт без неё,
    // и это правильный отказ: пункт остаётся, клавиша нет.
    if (transportApi.isDesktopRow(row)) {
      actions.push({ id: 'resume', label: 'Resume in terminal', menuKey: 'e' });
    }
    // Новая сессия в том же каталоге: «начать заново рядом» — обычный ход,
    // когда в текущей сессии кончился контекст. Только там, где каталог
    // известен: пункт, который ничего не сделает, хуже отсутствующего — то же
    // правило, что и у действий папки выше.
    if (row && row.cwd) actions.push({ id: 'new', label: 'New session' });
    // Тот же каталог, но без агента. Условие то же, что у соседа выше:
    // терминал открывают в каталоге, и пункт, которому каталога не назвали,
    // ничего бы не сделал. pathMap здесь ни при чём — терминал уходит на
    // машину источника через ssh, а не открывает путь на этой.
    if (row && row.cwd) actions.push({ id: 'terminal', label: 'Open terminal' });
    // Комментарий — у любой строки с настоящим id: он про сессию, а не про её
    // окно, живость или каталог. Живёт общим списком на машине агрегатора, и
    // потому же не спрашивает ни pathMap, ни трекера.
    if (row && row.id) actions.push({ id: 'comment', label: 'Edit comment' });
    actions.push({ id: 'info', label: 'Session info' });
    return actions;
  }

  return { prNumber, availableActions };
});
