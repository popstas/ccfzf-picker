// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PickerSnapshots = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся.
  const filterApi = typeof module === 'object' && module.exports
    ? require('./picker-filter')
    : globalThis.PickerFilter;
  // `normHost` берётся у соседа, а не пишется здесь третьей копией: правило
  // приведения имени машины одно на весь пикер, и разойдись копии — снимок
  // считался бы своим в одном месте и чужим в соседнем. Загрузка это
  // выдерживает: session-windows.js стоит в sessions.html раньше (447 против
  // 473) и в prepare-frontend.js тоже.
  const { normHost } = typeof module === 'object' && module.exports
    ? require('./session-windows')
    : globalThis.SessionWindows;

  /**
   * Строки режима снимков: день, снимки этого дня и их сессии — одним потоком.
   *
   * Сворачивание есть ровно у дня. У снимка его нет и не заводилось: заголовок
   * снимка и его сессии идут вместе, и второй способ навигации там, где хватает
   * стрелок, пришлось бы объяснять человеку. День — другое дело: снимков за
   * неделю набирается столько, что вчерашние оттесняют сегодняшние с экрана,
   * а восстанавливают почти всегда последний.
   */

  // Месяц из своей таблицы, а не toLocaleDateString: у того вид зависит от
  // локали системы, а всё видимое человеку у нас английское. Таблица приехала
  // из picker-sections.js, где считалась дата свёрнутой истории; теперь она
  // здесь, и копия у неё по-прежнему одна.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** Имя строки: каталог проекта, а не полный путь. */
  function projectBasename(session) {
    const cwd = session?.cwd != null ? String(session.cwd).trim() : '';
    if (cwd) {
      const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return String(session?.title ?? '').trim() || '—';
  }

  /**
   * Час снимка — и только час.
   *
   * Дата отсюда ушла вместе с появлением заголовка дня: снимок стоит под своим
   * днём, и дата в каждой строке повторяла бы его дословно. Различает снимки
   * внутри дня именно время.
   *
   * Нет отметки — показывается id: строка без опознавательных знаков хуже
   * строки с непонятным, но своим именем.
   */
  function formatSnapshotTime(snapshot) {
    const sec = Number(snapshot?.created);
    if (Number.isFinite(sec) && sec > 0) {
      const d = new Date(sec * 1000);
      const p = n => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    return String(snapshot?.id ?? '');
  }

  /**
   * День снимка — `YYYY-MM-DD` по местным часам.
   *
   * Местным, потому что «когда я это снимал» человек меряет своими часами: тот
   * же довод, по которому местной была дата в заголовке свёрнутой истории.
   * Снимок без отметки времени дня не имеет вовсе — пустая строка, и по ней
   * такие собираются в свою группу в конце.
   */
  function snapshotDay(snapshot) {
    const sec = Number(snapshot?.created);
    if (!Number.isFinite(sec) || sec <= 0) return '';
    const d = new Date(sec * 1000);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** Подпись дня: `Aug 16`. Год не пишется — снимки живут днями, а не годами. */
  function dayLabel(day) {
    if (!day) return 'No date';
    const [, month, date] = day.split('-').map(Number);
    return `${MONTHS[month - 1] ?? '?'} ${date}`;
  }

  function plural(n, one) {
    return `${n} ${one}${n === 1 ? '' : 's'}`;
  }

  /**
   * Сессии, у которых окно открыто прямо сейчас.
   *
   * Считается по тому же ответу агрегатора, что и весь список: поле `window`
   * приезжает от оконного трекера. Отдельного вызова, как в windows-mqtt, тут
   * не нужно — всё уже пришло.
   */
  function openIdsFromState(state) {
    const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
    return new Set(sessions.filter(s => s && s.window).map(s => s.id));
  }

  /**
   * Снимки этой машины.
   *
   * Раскладку восстанавливают там, где снимали, а список у пикера один на все
   * источники: агрегатор складывает снимки всех трекеров вместе. Снимок
   * соседней машины здесь не помог бы ничем — восстановить её раскладку на
   * своём экране человеку нечего.
   *
   * Снимок без имени машины считается своим. Старый агрегатор владельца не
   * пишет, а трекер тогда был ровно один, и все снимки были его; отбрось мы
   * такие, режим опустел бы там, где работал. Пикер и агрегатор обновляются
   * порознь, и порядок нам не подвластен.
   */
  function snapshotsHere(state, configHost) {
    const all = Array.isArray(state?.snapshots) ? state.snapshots : [];
    const mine = normHost(configHost);
    return all.filter(s => {
      if (!s) return false;
      const host = normHost(s.host);
      return host ? host === mine : true;
    });
  }

  /**
   * Куда просить о восстановлении этого снимка.
   *
   * Адрес называет снимок, а не машина-менеджер: у каждой машины свой префикс
   * топиков, и просьба обязана уйти той, что снимок сняла. Пустая строка значит
   * «спроси свой конфиг» — так пикер вёл себя до появления поля, и так он
   * обязан вести себя со старым агрегатором.
   */
  function snapshotBase(snapshot) {
    const base = snapshot && typeof snapshot.mqttBase === 'string' ? snapshot.mqttBase.trim() : '';
    return base;
  }

  /**
   * Строки снимков, отобранные запросом и разложенные по дням.
   *
   * Отбор идёт по строкам сессий; заголовок сам по себе не ищется — искать по
   * дате незачем, а совпадение по ней оставляло бы на экране снимок, ни одна
   * сессия которого запросу не отвечает. Снимок без подошедших уходит целиком,
   * а день, из которого так ушли все снимки, не заводится вовсе.
   *
   * Порядок — свежий день первым, и внутри дня свежий снимок первым: снимки
   * сортируются по `created` убыванием, а дни идут в порядке первой встречи.
   * Снимок без отметки времени этой сортировкой сам оседает в конец, и там же
   * оказывается его день `No date`.
   *
   * Развёрнут по умолчанию только первый день — тот, что свежее всех.
   * Остальные свёрнуты: снимков за неделю набирается столько, что вчерашние
   * оттесняют сегодняшние с экрана, а восстанавливают почти всегда последний.
   * Умолчание живёт здесь, а `collapsedDays` — только отступления человека:
   * то же правило, что у `collapsed` в `buildSections`, и по той же причине —
   * так умолчание можно менять, не переписывая никому запомненное.
   *
   * Непустой запрос разворачивает все дни и лишает заголовок сворачивания
   * (`foldable: false`). Разворачивает — потому что искали снимок, а не счёт;
   * лишает — потому что свёрнутость под запросом назначена сверху, и Enter на
   * таком заголовке молчал бы, тут же затирая записанное. Молчащий
   * переключатель хуже отсутствующего, и страница рисует такой заголовок
   * подписью, а не строкой (см. `snapshotItem` в sessions.html).
   */
  function buildSnapshotRows(snapshots, openIds, query, collapsedDays) {
    const open = openIds instanceof Set ? openIds : new Set(openIds ?? []);
    const q = String(query ?? '').trim().toLowerCase();
    const override = collapsedDays && typeof collapsedDays === 'object' ? collapsedDays : {};
    const searching = q !== '';

    // Свежий снимок первым. Копия, а не сортировка на месте: список приезжает
    // из ответа агрегатора, и переставлять его строки под чужой рукой нельзя.
    const sorted = [...(snapshots ?? [])].sort(
      (a, b) => (Number(b?.created) || 0) - (Number(a?.created) || 0));

    const days = [];
    const byDay = new Map();
    for (const snap of sorted) {
      const all = snap?.sessions ?? [];
      const rows = all
        .map(s => ({
          kind: 'snapshot-session',
          key: `snap:${snap.id}:${s.id}`,
          id: s.id,
          snapshotId: snap.id,
          cwd: String(s?.cwd ?? ''),
          label: projectBasename(s),
          open: open.has(s.id),
          // Источник — снимка, не сессии внутри него: `merge_state.rs` метит
          // саму запись снимка, а сессии внутри неё своей метки не несут.
          // Восстановление идёт на машину, которая снимок сняла.
          source: String(snap?.source ?? ''),
        }))
        // Сосед обязателен, без запасной ветки: подмена заглушкой молча
        // теряет обрезку `/home`-префикса и не даёт неверному порядку
        // тегов упасть — а именно на этом падении держится сторож порядка.
        //
        // Через filterApi, а не своим includes: перевод раскладки живёт в
        // matchesText, и третий отбор, оставленный при своём, молчал бы в
        // снимках при работающем поиске в сессиях.
        .filter(r => filterApi.matchesText(`${r.label} ${filterApi.searchableCwd(r.cwd)}`, q));
      // Снимок без сессий — ни строки: восстанавливать в нём нечего, а
      // заголовок обещал бы обратное.
      if (!rows.length) continue;
      const day = snapshotDay(snap);
      if (!byDay.has(day)) {
        byDay.set(day, { day, rows: [], snapshots: 0, sessions: 0 });
        days.push(byDay.get(day));
      }
      const group = byDay.get(day);
      group.snapshots += 1;
      group.sessions += rows.length;
      group.rows.push({
        kind: 'snapshot',
        key: `g:snap:${snap.id}`,
        id: snap.id,
        label: formatSnapshotTime(snap),
        total: all.length,
        missing: all.filter(s => !open.has(s.id)).length,
      }, ...rows);
    }

    const out = [];
    days.forEach((group, at) => {
      const collapsed = searching ? false
        : (typeof override[group.day] === 'boolean' ? override[group.day] : at !== 0);
      out.push({
        kind: 'snapshot-day',
        key: `g:snapday:${group.day || 'none'}`,
        day: group.day,
        label: dayLabel(group.day),
        // Счётчика два, и оба нужны: снимков — сколько строк день прячет,
        // сессий — сколько окон встанет, если день восстановить целиком.
        snapshots: group.snapshots,
        sessions: group.sessions,
        meta: `${plural(group.snapshots, 'snapshot')} · ${plural(group.sessions, 'session')}`,
        collapsed,
        foldable: !searching,
      });
      if (!collapsed) out.push(...group.rows);
    });
    return out;
  }

  /**
   * Сколько снимков в списке строк — счёт для заголовка секции.
   *
   * Считается по заголовкам дней, а не по строкам: строки свёрнутого дня в
   * список не попадают вовсе, и `rows.length` менялся бы на каждое
   * сворачивание — «Snapshots - 18» превращалось бы в «Snapshots - 2» без
   * единого исчезнувшего снимка.
   */
  function snapshotCount(rows) {
    return (rows ?? []).reduce(
      (n, r) => n + (r && r.kind === 'snapshot-day' ? r.snapshots : 0), 0);
  }

  return {
    buildSnapshotRows, snapshotCount, openIdsFromState, formatSnapshotTime,
    snapshotDay, dayLabel, projectBasename, snapshotsHere, snapshotBase,
  };
});
