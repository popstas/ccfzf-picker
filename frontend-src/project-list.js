// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProjectList = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Строки проектов из ответа агрегатора.
   *
   * Проекты приезжают тем же `ccfzf --state`, что и сессии: там уже собраны и
   * каталоги, и живые id, а проект без единой сессии приходит из marks — по
   * cwd приехавших сессий такой не восстановить, и ради него режим и заведён.
   *
   * `cwd`, а не только `path`: под этим именем путь читают pathMap,
   * availableActions и поиск. Одно поле вместо двух — иначе строка проекта
   * пошла бы мимо половины уже написанного.
   *
   * `liveCount` и `sessionCount`, а не `live` и `sessions`: у строки сессии
   * `live` — булево, и отрисовка вешает по нему класс. Счётчик под тем же
   * именем молча означал бы «живая» при любом ненулевом числе.
   */
  function buildProjectList({ projects } = {}) {
    const list = Array.isArray(projects) ? projects : [];
    return list
      .filter(p => p && typeof p.path === 'string' && p.path)
      .map(p => ({
        kind: 'project',
        // id — ключ строки в DOM и то, по чему меню находит строку заново
        // после перерисовки. У проекта уникален путь, других id у него нет.
        id: p.path,
        cwd: p.path,
        label: (typeof p.name === 'string' && p.name) ? p.name : p.path,
        mark: Boolean(p.mark),
        sessionCount: Number(p.sessions) || 0,
        liveCount: Number(p.live) || 0,
        // Под тем же именем, что у сессии: колонку возраста рисует общая
        // ageHtml, и второе имя для того же смысла ей пришлось бы объяснять.
        lastActivity: Number(p.mtime) || 0,
        // Под тем же именем, что у сессии: колонку `hk` рисует общая
        // hotkeyHtml, и второе имя для того же смысла ей пришлось бы
        // объяснять. Пустая строка, а не undefined, — та же причина.
        hotkey: typeof p.hotkey === 'string' ? p.hotkey : '',
      }));
  }

  /**
   * Проставить «клавиша не встала» на уже собранных строках проектов.
   *
   * Отдельно от buildProjectList: та строит строку из ответа агрегатора, а
   * занятость клавиши агрегатору неизвестна — об этом отчитывается Rust,
   * событием `project-hotkeys` или командой `project_hotkeys_taken`, и оба
   * пути сводятся к одному и тому же набору строк, что и разбирает эта
   * функция — Set или обычный массив, без разницы вызывающему.
   */
  function markHotkeysTaken(rows, taken) {
    const set = taken instanceof Set ? taken : new Set(Array.isArray(taken) ? taken : []);
    for (const row of rows) row.hotkeyTaken = set.has(row.hotkey);
    return rows;
  }

  return { buildProjectList, markHotkeysTaken };
});
