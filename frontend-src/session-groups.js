/** Pure shaping of the claude-wt session list for the picker. No I/O. */
// Loaded twice: as a <script> in sessions.html and as a module in the tests.
// The project has no bundler, and duplicating this logic to make it testable
// would be worse than this shim.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionGroups = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся.
  const listApi = typeof module === 'object' && module.exports
    ? require('./session-list')
    : globalThis.SessionList;
  const zellijApi = typeof module === 'object' && module.exports
    ? require('./zellij-list')
    : globalThis.ZellijList;

  // Сессия с неизвестным столом сортируется перед всеми настоящими.
  const DESKTOP_UNKNOWN = -1;

  const SORT_MODES = ['cost', 'oldest', 'newest', 'recent', 'name'];
  const DEFAULT_SORT = 'recent';

  function normalizeSort(mode) {
    return SORT_MODES.includes(mode) ? mode : DEFAULT_SORT;
  }

  function cycleSort(mode) {
    const current = normalizeSort(mode);
    const i = SORT_MODES.indexOf(current);
    return SORT_MODES[(i + 1) % SORT_MODES.length];
  }

  // Знак между именем и пометкой. Один на обе пометки: два разных читались бы
  // как два разных вида строки.
  const TWIN_MARK = ' · ';

  /**
   * Двойник — совпадение имени, каталога **и** живости.
   *
   * Живость в ключе затем, что живая и закрытая тёзки рядом не стоят: они
   * уезжают в разные секции (`live`/`remote:<host>` против `past`), а под
   * умолчанием `onlyLive` закрытой в списке нет вовсе. Пометка там не
   * различает ничего, а место в строке занимает — и достаётся именно хвост
   * id, потому что имя машины у такой пары одинаково пустое: у живой оно
   * значит «своя машина», у закрытой — «окна нет и быть не может».
   */
  function twinKey(s) {
    return JSON.stringify([s.label, s.cwd || '', !!s.live]);
  }

  /**
   * Приписать пометку строкам, у которых совпали имя, каталог и живость —
   * когда это ДЕЙСТВИТЕЛЬНО разные сессии, а не карточки одной.
   *
   * Двойник — это ДРУГОЙ id с тем же именем и каталогом: у сессии с
   * несколькими окнами (`buildSessionList`) несколько карточек делят один id
   * и совпадают по `twinKey` точно так же, как настоящие тёзки, — а
   * различаются как раз тем полем, по которому ищут двойников (`windowHost` в
   * первом проходе). Карточки одной сессии друг другу двойниками не
   * считаются, и это решает `needsMark` ниже: она смотрит только на пары с
   * РАЗНЫМИ id.
   *
   * Была версия, где «нужна ли пометка вообще» решал представитель сессии
   * (пометка её первой карточки), а применялась она ко всем карточкам сессии
   * одинаковой. Ревью нашло на ней Critical: представителем случайно
   * оказывается чужая карточка (когда на неё смотрели позже своей — порядок
   * карточек это как раз «свежайший взгляд первым»), и её метка расползается
   * на местную карточку той же сессии. Метка обязана быть СВОЕЙ у каждой
   * карточки — представитель здесь не участвует вовсе, группировка идёт по
   * `twinKey` напрямую, как до всей этой истории с окнами.
   *
   * Пометка, одинаковая у всей группы, пропускается: она не отвечает на
   * вопрос «которая из двух», а место в строке занимает. Пустая пометка —
   * тоже ответ: своя машина названа пустотой, и голая строка рядом с
   * помеченной читается как «здесь».
   */
  function withTwinMarks(list, markOf) {
    const groups = new Map();
    list.forEach((s, i) => {
      const key = twinKey(s);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    });
    const out = list.slice();
    for (const indexes of groups.values()) {
      if (indexes.length < 2) continue;
      const marks = indexes.map(i => String(markOf(list[i]) || '').trim());
      const ids = indexes.map(i => list[i].id);
      // Различать нечего, если единственные расхождения в метках — внутри
      // одной и той же сессии (там же и совпадающий id): такая пара — не
      // тёзки, а окно и его сосед.
      let needsMark = false;
      for (let a = 0; a < indexes.length && !needsMark; a++) {
        for (let b = a + 1; b < indexes.length; b++) {
          if (ids[a] !== ids[b] && marks[a] !== marks[b]) { needsMark = true; break; }
        }
      }
      if (!needsMark) continue;
      indexes.forEach((i, n) => {
        if (!marks[n]) return;
        out[i] = { ...list[i], label: `${list[i].label}${TWIN_MARK}${marks[n]}` };
      });
    }
    return out;
  }

  /**
   * Имя, под которым сессию видно везде: строка списка, поиск, заголовок
   * диалога.
   *
   * Хвост из четырёх знаков id отсюда однажды уже убирали — у короткого id
   * появилась своя колонка, и хвост стал вторым способом показать то же самое.
   * Возвращается он не целиком, а ровно двойникам, и это не отмена того
   * решения, а его сужение: колонка id по умолчанию выключена, и две строки с
   * дословно одинаковыми именем и каталогом не различались в списке ничем.
   * Поймано на живой паре — работающая сессия и простаивающая тёзка, — и
   * человек видел только одну.
   *
   * Пометок две, и порядок между ними не случаен. Сперва имя машины окна: оно
   * отвечает на вопрос, который и задают («а эта где?»), и уже есть в строке
   * как колонка. Хвост id достаётся тем, кого имя машины не развело, — двум
   * окнам на одной машине.
   *
   * Считается по уже отсеянному списку (`onlyLive`/`onlyWindow` работают
   * выше): пометка нужна там, где обе строки видны рядом. Отбор по запросу
   * идёт позже, на странице, и пометка у найденной строки остаётся — так она
   * не мигает от набора.
   *
   * Ничего, кроме показа и поиска, на label не завязано: строки списка
   * узнаются по `s:<id>`, фокус уходит тоже по id.
   */
  function labelSessions(sessions) {
    const named = (Array.isArray(sessions) ? sessions : [])
      .map(s => ({ ...s, label: s.title }));
    const byHost = withTwinMarks(named, s => s.windowHost);
    return withTwinMarks(byHost, s => String(s.id || '').slice(0, 4));
  }

  function nameOf(s) {
    return s.label ?? s.title ?? '';
  }

  /** Missing / zero sort keys sink to the end so incomplete rows don't float up. */
  function missingLast(aVal, bVal, asc) {
    const aMissing = !aVal;
    const bMissing = !bVal;
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    return asc ? aVal - bVal : bVal - aVal;
  }

  /**
   * У карточки на окно (`sessionItem`/`buildSessionList`) имя и id — общие для
   * всех окон одной сессии, так что до этой правки пара совпадала по обоим
   * ключам и compareSessions возвращал 0: порядок карточек дрожал бы вслед за
   * тем, в каком порядке агрегатор в этот раз прислал окна. Машина окна
   * последним ключом снимает дрожь — она у карточек одной сессии как раз и
   * разная.
   */
  function tieBreak(a, b) {
    return nameOf(a).localeCompare(nameOf(b))
      || String(a.id).localeCompare(String(b.id))
      || String(a.windowHost || '').localeCompare(String(b.windowHost || ''));
  }

  /**
   * Ключ сортировки `recent` — минута последней активности, а не секунда.
   *
   * `lastActivity` двигает каждый вызов инструмента, а их десятки в минуту.
   * Подача тикает раз в секунду, и две работающие сессии на секундном ключе
   * менялись первым местом непрерывно — попасть по такой строке нельзя. С
   * округлением обе попадают в одну корзину, дальше их разводит tieBreak по
   * имени, и порядок перестаёт зависеть от того, кто дёрнулся последним.
   *
   * Округление до **абсолютной** минуты, а не до возраста ((now - t) / 60):
   * ключ не зависит от часов, и функция остаётся чистой.
   *
   * Ноль остаётся нулём — missingLast топит такие строки вниз, и делить их с
   * настоящей минутой было бы нечем. А вот `Math.max(1, …)` не для красоты:
   * деление само делает ноль из всякой метки моложе минуты, и без нижней
   * границы сессия, работавшая полминуты назад, притворилась бы строкой без
   * активности вовсе и утонула бы к ним в конец.
   *
   * В строке возраст по-прежнему с секундами: округление живёт только здесь,
   * ageHtml его не знает.
   */
  const MINUTE = 60;

  function recentKey(s) {
    const t = (s || {}).lastActivity ?? 0;
    return t ? Math.max(1, Math.floor(t / MINUTE)) : 0;
  }

  function compareSessions(a, b, mode) {
    const sort = normalizeSort(mode);
    let primary = 0;
    if (sort === 'cost') {
      primary = missingLast(a.agentCostUsd ?? 0, b.agentCostUsd ?? 0, false);
    } else if (sort === 'oldest') {
      primary = missingLast(a.agentStarted ?? 0, b.agentStarted ?? 0, true);
    } else if (sort === 'newest') {
      primary = missingLast(a.agentStarted ?? 0, b.agentStarted ?? 0, false);
    } else if (sort === 'recent') {
      primary = missingLast(recentKey(a), recentKey(b), false);
    } else if (sort === 'name') {
      primary = nameOf(a).localeCompare(nameOf(b));
    }
    return primary || tieBreak(a, b);
  }

  function sortGroupSessions(sessions, mode) {
    return sessions.sort((a, b) => compareSessions(a, b, mode));
  }

  /**
   * Живые сессии — одной группой сверху, остальные — под общим заголовком.
   *
   * На macOS нет ни окон, ни виртуальных столов, ни мониторов (см. Global
   * Constraints плана) — `s.desktop` в объектах, которые отдаёт `ccfzf
   * --state`, не бывает, так что группа мёртвых сессий здесь всегда одна на
   * весь список. Группировка по ключу `desktop` осталась внутри ради
   * структуры (несколько групп, отсортированных по номеру стола) — на этом
   * проекте она просто вырождается в единственную группу с одним и тем же
   * ключом `null`.
   *
   * Живые не делятся на подгруппы намеренно: их несколько, ищут их глазами, и
   * «что из этого работает прямо сейчас» важнее любой дальнейшей разбивки.
   *
   * Внутри группы — выбранный режим сортировки (по умолчанию cost desc).
   */
  function groupSessions(sessions, sort = DEFAULT_SORT) {
    const mode = normalizeSort(sort);
    // Зелийные строки отбираются до всего остального: у них live: true, и
    // живая группа всосала бы их к работающим агентам, где им не место.
    // Своя группа стоит последней — это справочник «что ещё открыто на
    // машине», а не то, к чему возвращаются в первую очередь.
    const zellij = [];
    const rest = [];
    for (const s of sessions) (s.kind === 'zellij' ? zellij : rest).push(s);
    sessions = rest;
    const open = [];
    const groups = new Map();
    for (const s of sessions) {
      // На маке нет окон — «открыта» здесь означает «процесс жив».
      if (s.live) { open.push(s); continue; }
      const desktop = s.desktop ?? null;
      const key = `${desktop}`;
      if (!groups.has(key)) {
        // `past` — пометка «это уже было», а не «так называется». Широкий режим
        // отводит истории свою колонку и умеет её сворачивать, и узнавать её по
        // заголовку значило бы сделать видимую человеку строку форматом: правка
        // формулировки молча выключила бы и колонку, и сворачивание.
        groups.set(key, {
          desktop, past: true, sessions: [],
          // Ключ — стабильный, заголовок — то, что видит человек. Счёт в
          // заголовке не стоит намеренно: он меняется каждые несколько секунд,
          // и входи он в ключ, свёрнутость секции сбрасывалась бы сама собой.
          // Приписывает счёт сборка секции (picker-sections.js).
          key: desktop === null ? 'past' : `past:${desktop}`,
          label: desktop === null ? 'History' : `Desktop ${desktop}`,
        });
      }
      groups.get(key).sessions.push(s);
    }

    const past = [...groups.values()];
    for (const g of past) sortGroupSessions(g.sessions, mode);
    past.sort((a, b) => (a.desktop ?? DESKTOP_UNKNOWN) - (b.desktop ?? DESKTOP_UNKNOWN));

    const tail = zellij.length
      ? [{ desktop: null, key: 'zellij', label: 'Zellij', sessions: sortGroupSessions(zellij, mode) }]
      : [];

    if (!open.length) return [...past, ...tail];
    sortGroupSessions(open, mode);
    return [...activeGroups(open), ...past, ...tail];
  }

  /**
   * Живые сессии — своей группой и по группе на каждую чужую машину.
   *
   * «Своё/чужое» у строки одно: `windowHost`, который ставит buildSessionList,
   * — имя машины окна, и только когда она не наша. Тот же признак решает, что
   * сделает Enter (поднимет окно или откроет терминал), так что деление списка
   * отвечает на тот же вопрос, что и главное действие строки. Сравнение с
   * конфигом сделано там же, выше по течению: здесь достаточно самого поля —
   * непустое оно только у чужих.
   *
   * Трекеров теперь несколько, и «чужое» перестало быть одним местом: сессия на
   * соседнем маке и сессия на сервере отвечают на вопрос «где она» по-разному,
   * а общая группа отвечала бы на него словом «не здесь». Отсюда группа на имя
   * машины; порядок — своя первой всегда, дальше чужие по алфавиту, потому что
   * никакого другого порядка у имён машин нет, а стабильный нужен: список
   * перерисовывается раз в секунду.
   *
   * Имя машины в заголовке — данные, а не литерал: оно приезжает полем строки и
   * в репозитории не лежит (`test/no-private-data.test.js`). Поэтому же чужая
   * группа помечена полем `remote`, а не узнаётся по заголовку: список склеивает
   * чужие группы обратно в один блок, и разбирай он текст — имя машины стало
   * бы форматом, который нельзя менять.
   *
   * Сессия без окна считается своей: чужой её делает названная чужая машина, а
   * не отсутствие сведений. На маке, где трекера может не быть вовсе, иначе
   * весь список уехал бы в «remote».
   *
   * При одном источнике так и остаётся: `windowHost` у строки без окна ставит
   * `buildSessionList`, только когда в ответе больше одного различимого
   * `source` (`ambiguous` в session-list.js) — на обычной установке (один
   * `sshHost`, `localSource` выключен) сравнивать нечего, и сессии без окна
   * остаются местными все до одной. С двумя источниками источник служит
   * ответом, но лишь тогда, когда у названной им машины есть свой оконный
   * трекер (`sourceHostOf` там же): без трекера отсутствие записи окна значит
   * «никто не смотрит», а не «окно там», и блок собирался бы не по машине, а
   * по удаче привязки заголовка.
   *
   * Ни одного чужого окна — группа остаётся одна и называется как раньше:
   * делить нечего, а «Active local sessions» без пары читалось бы вопросом
   * «а где тогда остальные». Пустая половина не заводится по тому же правилу,
   * что и группа «History».
   */
  function activeGroups(open) {
    const remote = open.filter(s => s.windowHost);
    if (!remote.length) {
      return [{ desktop: null, key: 'live', label: 'Active sessions', sessions: open, remote: false, host: '' }];
    }
    const local = open.filter(s => !s.windowHost);
    const groups = [];
    if (local.length) {
      groups.push({ desktop: null, key: 'live', label: 'Active local sessions', sessions: local, remote: false, host: '' });
    }
    const byHost = new Map();
    for (const s of remote) {
      if (!byHost.has(s.windowHost)) byHost.set(s.windowHost, []);
      byHost.get(s.windowHost).push(s);
    }
    // Порядок машин — по свежести самой свежей сессии в группе, свежая первой.
    // Алфавитный порядок ставил ту машину, на которой только что говорили,
    // вниз, если её имя начинается на «w».
    //
    // Ключ тот же, которым меряется свежесть строк внутри группы (`recentKey`,
    // минуты), а не новый: второй разошёлся бы с первым. Минуты здесь нужны и
    // сами по себе — на секундах две почти одинаково свежие машины менялись бы
    // местами от опроса к опросу. На равном ключе они разводятся по имени: у
    // имён машин другого устойчивого порядка нет, а устойчивый нужен — список
    // перерисовывается раз в секунду.
    const freshness = (sessions) => sessions.reduce((max, s) => Math.max(max, recentKey(s)), 0);
    const hosts = [...byHost.keys()].sort((a, b) =>
      (freshness(byHost.get(b)) - freshness(byHost.get(a))) || a.localeCompare(b));
    for (const host of hosts) {
      const sessions = byHost.get(host);
      groups.push({ desktop: null, key: `remote:${host}`, label: `Active on ${host}`, sessions, remote: true, host });
    }
    return groups;
  }

  /**
   * Ответ агрегатора (`ccfzf --state`) — в тот пакет claude-wt-sessions,
   * который читает пикер.
   *
   * Здесь и сходится вся цепочка, и другого места у неё нет: buildSessionList
   * превращает сырые сессии в строки, labelSessions приписывает им имя, под
   * которым их видно и ищут, groupSessions раскладывает по группам и сортирует.
   * Пропусти середину — и строка приедет в разметку без `label`: имя
   * нарисуется как `undefined`, а поиск перестанет находить хоть что-нибудь.
   *
   * `opts.onlyLive` оставляет в списке одни работающие сессии. Отсев идёт
   * здесь, а не до buildSessionList: фоновый агент ищется по всему ответу, и
   * отними у него соседей заранее — живая сессия, чью работу ведёт форк,
   * осталась бы без записи агента и выглядела бы замершей.
   *
   * `opts.onlyWindow` оставляет одни сессии с открытым окном. Само поле
   * `window` приезжает уже в ответе агрегатора и приписывается строке в
   * buildSessionList — здесь остаётся только отсев.
   *
   * `opts.configHost` — имя своей машины из конфига. Нужно строке, чтобы
   * назвать машину чужого окна и промолчать про своё.
   *
   * Pure: берёт уже полученный `res`, сама ничего не читает.
   */
  /**
   * Отсевы, действующие на самом деле: спрошенное перебивает отобранное.
   *
   * Непустой запрос и любой префикс режима отменяют оба отсева — и `onlyLive`,
   * и `onlyWindow`. Причина та же, по которой непустой запрос разворачивает
   * свёрнутые секции: искали сессию, а не отбор. Отсев при поиске не сообщает о
   * себе ничем — найденного просто нет в списке, и почему, не сказано ни
   * словом; молчащий поиск здесь ровно так же плох, как молчащий Enter.
   *
   * Болеют этим оба одинаково, поэтому и правило одно. `onlyWindow` вычищает
   * живые сессии, у которых окна нет; историю он не трогает вовсе (окна у
   * закрытой сессии не бывает по определению — см. `buildSessionsPayload`), но
   * `/h` это не спасало бы: `onlyLive` вычищает всё неживое, то есть историю
   * целиком, и с умолчанием конфига (`onlyLive: true`) `/h` показывал
   * `Nothing in history.` всегда, сколько бы её ни было.
   *
   * Префикс отменяет отсевы и при пустом запросе: `/h` — это просьба про
   * историю, и пустой ответ на неё врал бы про причину. Оговорок по режимам
   * нет намеренно: `/p` и `/s` сессий не касаются вовсе, а `/l` и `/r` живые по
   * построению, так что отмена там ничего не меняет, — а таблица «какой режим
   * что отменяет» была бы вторым списком рядом с `PREFIXES`.
   *
   * Галки при этом остаются нажатыми: отступление временное и кончается вместе
   * с запросом — то же, что со свёрнутостью, которую запрос разворачивает, не
   * забывая.
   */
  function activeFilters(opts = {}) {
    const mode = opts.mode == null ? 'sessions' : String(opts.mode);
    const query = opts.query == null ? '' : String(opts.query).trim();
    const asked = query !== '' || (mode !== '' && mode !== 'sessions');
    return {
      onlyLive: asked ? false : !!opts.onlyLive,
      onlyWindow: asked ? false : !!opts.onlyWindow,
    };
  }

  function buildSessionsPayload(res, sort = DEFAULT_SORT, opts = {}) {
    const mode = normalizeSort(sort);
    if (!res.ok) return { ok: false, reason: res.reason };
    // `state: res` — ради машины окна: на старом агрегаторе она названа только
    // верхними полями ответа, и по одной записи окна её не узнать.
    let rows = listApi.buildSessionList({
      sessions: res.sessions, seen: res.seen, state: res, configHost: opts.configHost,
    });
    if (opts.onlyLive) rows = rows.filter(r => r.live);
    // Историю `onlyWindow` не трогает, и это не поблажка, а определение: окна
    // у закрытой сессии нет и быть не может, так что отсев «покажи то, что
    // сейчас на экране» отвечал ей не «нет», а «нечем ответить». Виден отсев
    // был только вместе с `show all` — и тогда история пропадала до
    // заголовка, без единого слова о причине. Про живые сессии вопрос
    // остаётся прежним: живая без окна уходит.
    //
    // Приложение Claude Desktop считается окном, и это не поблажка: в колонке
    // окна у такой строки стоит `c`, то есть отсев спорил бы с тем, что
    // нарисовано, — пометка есть, а строки нет. Предикат общий с тем, по
    // которому рисуется глиф: своего здесь завести нельзя, разошлись бы молча.
    if (opts.onlyWindow) {
      rows = rows.filter(r => r.window || listApi.inDesktopApp(r) || !r.live);
    }
    // Отсевы выше — про сессии агента, и на зелийные строки они не
    // распространяются: окна у зелийной сессии нет никогда, и onlyWindow
    // вычистил бы весь режим целиком. Поэтому строки подмешиваются после.
    const zellij = zellijApi.buildZellijList({ zellij: res.zellij });
    return { ok: true, groups: groupSessions([...labelSessions(rows), ...zellij], mode), sort: mode };
  }

  return {
    SORT_MODES,
    DEFAULT_SORT,
    normalizeSort,
    cycleSort,
    compareSessions,
    labelSessions,
    groupSessions,
    activeFilters,
    buildSessionsPayload,
  };
});
