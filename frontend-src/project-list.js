// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProjectList = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся. Порядок тегов в sessions.html это выдерживает —
  // session-groups.js стоит выше project-list.js.
  const groupsApi = typeof module === 'object' && module.exports
    ? require('./session-groups')
    : globalThis.SessionGroups;

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
   *
   * **Порядок задаётся здесь, и той же самой `compareSessions`, что у
   * сессий.** Раньше его не задавали вовсе: список оставался в том, в каком
   * его отдал `ccfzf --state`, — а это mtime по секундам, и два проекта с
   * почти одинаковой свежестью менялись местами от опроса к опросу. Подача
   * тикает раз в секунду, и попасть мышью по такой строке нельзя.
   *
   * Своего сравнения тут нет намеренно, и это не экономия: округление до
   * минуты (`recentKey`) и устойчивое разведение равных (`tieBreak`) —
   * одно правило, и две его копии разошлись бы на первой же правке. Полей у
   * строки проекта ровно те три, которых оно просит: `label`, `id` и
   * `lastActivity` — и названы они так же, как у сессии, как раз затем, чтобы
   * общий код не объяснял себе второе имя того же смысла.
   *
   * Режим всегда `recent`, а не тот, что крутит человек `^O`: у проекта нет
   * ни стоимости, ни времени запуска агента, и в остальных режимах
   * `missingLast` утопил бы весь список в конец одинаковым способом. Свежесть
   * — единственное, что у проекта есть.
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
        //
        // trim по той же причине, по какой он стоит в Rust при разборе
        // ответа: хоткей у менеджера пишет человек, пробелы вокруг него —
        // обычное дело, и разойдись эти два вида, комбинация в колонке
        // отличалась бы от той, о которой отчитался Rust.
        hotkey: typeof p.hotkey === 'string' ? p.hotkey.trim() : '',
      }))
      .sort((a, b) => groupsApi.compareSessions(a, b, 'recent'));
  }

  /**
   * Отказы, как их присылает Rust: записи `{cwd, hotkey, reason}`.
   *
   * Мусор отсеивается здесь, а не в каждом читателе: приезжает это по двум
   * дорогам — событием `project-hotkeys` и командой `project_hotkeys_taken`, —
   * и обе идут через JSON.
   */
  function takenEntries(taken) {
    return (Array.isArray(taken) ? taken : []).filter(e => e && typeof e === 'object');
  }

  /**
   * Что сказать человеку про каждую причину: единственное число, множественное.
   *
   * Одной формулировки на все отказы не хватает, и дело не в стиле. «Занято
   * другим приложением» на комбинации, названной дважды в самом конфиге
   * менеджера, — неправда: человек пойдёт искать чужое приложение, которого
   * нет. Число тоже считается: «Ctrl+F11, Ctrl+F12 is taken» — то, что выходило
   * раньше на любом втором отказе.
   */
  const TAKEN_REASONS = {
    system: ['is taken by another app', 'are taken by another app'],
    duplicate: ['is set on more than one project', 'are set on more than one project'],
    reserved: ["is the picker's own hotkey", "are the picker's own hotkeys"],
    unparsable: ['is not a valid hotkey', 'are not valid hotkeys'],
  };
  // Причина, которой эта страница не знает: Rust умеет назвать новую раньше,
  // чем страница научится её переводить. Молчать об отказе нельзя и в этом
  // случае — ради видимости отказа всё и затевалось.
  const UNKNOWN_REASON = ['did not register', 'did not register'];

  /**
   * Проставить «клавиша не встала» на уже собранных строках проектов.
   *
   * Отдельно от buildProjectList: та строит строку из ответа агрегатора, а
   * занятость клавиши агрегатору неизвестна — об этом отчитывается Rust,
   * событием `project-hotkeys` или командой `project_hotkeys_taken`, и оба
   * пути сводятся к одному и тому же набору записей, что и разбирает эта
   * функция.
   *
   * Помечается строка по каталогу, а не по комбинации. У внутреннего
   * столкновения комбинация общая: два проекта названы на один Ctrl+F11,
   * первый её получил, второй нет. Пометка по комбинации перечеркнула бы
   * обоих — и того, у кого клавиша как раз работает.
   */
  function markHotkeysTaken(rows, taken) {
    const set = new Set(takenEntries(taken).map(e => e.cwd).filter(Boolean));
    for (const row of rows) row.hotkeyTaken = set.has(row.cwd);
    return rows;
  }

  /**
   * Строка статуслайна про не вставшие клавиши — по одной части на причину.
   *
   * Единственное место, где человек узнаёт об отказе: колонка `hk` видна
   * только в режиме проектов и только с включённой галкой.
   */
  function hotkeysTakenMessage(taken) {
    const byReason = new Map();
    for (const entry of takenEntries(taken)) {
      const hotkey = typeof entry.hotkey === 'string' ? entry.hotkey.trim() : '';
      if (!hotkey) continue;
      const reason = typeof entry.reason === 'string' ? entry.reason : '';
      if (!byReason.has(reason)) byReason.set(reason, []);
      const keys = byReason.get(reason);
      // Одна и та же комбинация внутри причины — один раз: дважды названный
      // хоткей приезжает записью на каждого проигравшего, и без этого вышло бы
      // «Ctrl+F11, Ctrl+F11 are…».
      if (!keys.includes(hotkey)) keys.push(hotkey);
    }
    const parts = [];
    for (const [reason, keys] of byReason) {
      const text = TAKEN_REASONS[reason] || UNKNOWN_REASON;
      parts.push(`${keys.join(', ')} ${keys.length > 1 ? text[1] : text[0]}`);
    }
    return parts.join('; ');
  }

  return { buildProjectList, markHotkeysTaken, hotkeysTakenMessage };
});
