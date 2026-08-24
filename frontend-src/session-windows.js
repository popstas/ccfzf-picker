// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionWindows = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся. Та же дорога, что у session-list.js.
  const staleApi = typeof module === 'object' && module.exports
    ? require('./stale-items')
    : globalThis.StaleItems;

  /**
   * Имя машины из ответа агрегатора — в сравнимый вид.
   *
   * Одна сторона — `os.hostname()` соседней машины, другая — строка, набранная
   * человеком в конфиге. Регистр в именах машин Windows не значит ничего, а
   * пробел по краям набирается легко и не виден вовсе.
   */
  function normHost(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  /** pid трекера; ноль значит «трекера не слышно». */
  function focusPid(src) {
    const o = src || {};
    const pid = typeof o.pid === 'number' ? o.pid : o.windowPid;
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  }

  /**
   * Окна строки, дополненные сведениями о машине.
   *
   * Окон у сессии бывает больше одного: её открывают на двух машинах сразу —
   * работали на одной, продолжили на другой. Агрегатор отдаёт их списком, в
   * порядке «свежайший взгляд первым».
   *
   * Две ветви совместимости, и обе обязательны: пикер и агрегатор
   * выкатываются порознь, а пикер новее агрегатора обязан вести себя как
   * прежде, а не гасить пометки. Старый ответ несёт одно `window` — из него
   * выходит список на одного; совсем старый не кладёт машину и в него, и
   * тогда её называют верхние поля ответа: там ровно один трекер, и все окна
   * его.
   */
  function windowsOf(row, state) {
    const r = row || {};
    if (Array.isArray(r.windows) && r.windows.length) return r.windows;
    const w = r.window;
    if (!w) return [];
    if (normHost(w.host)) return [w];
    const s = state || {};
    return [{ ...w, host: s.windowHost, pid: s.windowPid, canFocus: true }];
  }

  /** Первое окно строки — то, которое агрегатор назвал главным. */
  function windowOf(row, state) {
    return windowsOf(row, state)[0] || null;
  }

  /**
   * Своё окно этой строки — то, которое Enter поднимет.
   *
   * Ищется среди **всех** окон, а не берётся главное: главным агрегатор
   * называет окно со свежайшим взглядом, и на машине, где сессию открывали
   * раньше, это будет окно соседней машины. Подъём на чужом экране человеку
   * ничего не даёт, а Enter при этом теряет привычное открытие терминала.
   *
   * Три условия у окна те же, что были: машина совпала с нашей, трекер этой
   * машины умеет поднимать, pid ненулевой — признак живого трекера.
   */
  function focusWindowOf(row, state, configHost) {
    const mine = normHost(configHost);
    if (!mine) return null;
    return windowsOf(row, state).find(w => w && w.canFocus !== false
      && normHost(w.host) === mine && focusPid(w) > 0) || null;
  }

  /**
   * Поднимать ли окно этой строки вместо открытия терминала.
   */
  function canFocusRow(row, state, configHost) {
    return Boolean(focusWindowOf(row, state, configHost));
  }

  /**
   * Машины, чьи трекеры сейчас живы.
   *
   * Старый агрегатор списка не отдаёт, но одну машину называет верхними
   * полями — из них и собирается список на одного. Пустой список на таком
   * ответе выключил бы режим снимков там, где он работает.
   *
   * Запись без имени машины выбрасывается, а не пропускается дальше: файл
   * пишет чужая машина, и доверия его содержимому нет. Одного `Boolean` тут
   * мало — пустой объект проходил его насквозь и доезжал до `openManager`,
   * где запасное `|| able[0]` могло назначить менеджером именно его. Просьба
   * ушла бы с пустым `mqttBase`, то есть в никуда, и молча: ответа у
   * публикации нет.
   */
  function trackerHosts(state) {
    const s = state || {};
    if (Array.isArray(s.windowHosts)) return s.windowHosts.filter(e => e && normHost(e.host));
    return s.windowHost ? [{ host: s.windowHost, pid: s.windowPid, canFocus: true }] : [];
  }

  /**
   * Наш ли трекер жив и умеет ли он поднимать окна.
   *
   * Отвечает на вопросы про машину целиком, а не про строку: доступен ли режим
   * снимков, показывать ли подсказку о нём. По списку окон этого не понять — у
   * здорового трекера без открытых терминалов он пуст.
   */
  function trackerHere(state, configHost) {
    const mine = normHost(configHost);
    if (!mine) return null;
    return trackerHosts(state).find(e => normHost((e || {}).host) === mine
      && e.canFocus !== false && focusPid(e) > 0) || null;
  }

  /**
   * Свёрнуто ли окно этой строки на **этой** машине.
   *
   * Вопрос про свою машину, а не про строку вообще: окно соседней машины эта
   * не раскладывает и человеку здесь не показывает, и свёрнутость его к делу
   * не относится вовсе.
   *
   * Своих окон бывает больше одного — сессию открывали здесь дважды, — и
   * свёрнутой строка считается, когда свёрнуты все: одно развёрнутое окно
   * стоит на экране, и гасить строку не за что.
   *
   * Нет своих окон — `false`, а не «свёрнуто»: раскладывать нечего, но и
   * прятать нечего тоже.
   *
   * Признак приезжает от трекера полем `minimized` записи окна; агрегатор
   * прежней версии его не пропускает вовсе, и строка тогда ведёт себя как
   * раньше — то же правило совместимости, что у `mqttBase` и `app`.
   */
  function minimizedHere(row, state, configHost) {
    const mine = normHost(configHost);
    if (!mine) return false;
    const own = windowsOf(row, state).filter(w => w && normHost(w.host) === mine);
    return own.length > 0 && own.every(w => w.minimized === true);
  }

  /**
   * Порядок сессий для просьбы о раскладке.
   *
   * Список строк — тот, что человек видит сейчас: отфильтровал `/l foo` —
   * разложил найденное. Порядок и есть смысл поля `ids`: знает его только тот,
   * кто список показывает, а на стороне трекера его не восстановить.
   *
   * Берутся строки, чьё окно стоит на своей машине, — тем же `focusWindowOf`,
   * которым Enter решает «поднимать ли окно»: второе правило про то же самое
   * разошлось бы с первым молча. Окно соседней машины трекер этой всё равно
   * не ведёт, а порядок сдвинуло бы.
   *
   * Повторы выброшены: карточка — на окно, и у сессии, открытой дважды на
   * одной машине, их две, а id один. Приёмник посчитал бы такой id за два окна.
   *
   * Строки, которые пикер погасил как stale, в раскладку не идут: клетка
   * сетки, отданная свёрнутому или давно молчащему окну, ужимает те, на
   * которые человек смотрит. Правило то же, каким строка гасится в списке
   * (`StaleItems.isStale`), и это не совпадение: «тусклое не раскладываем»
   * иначе объяснить человеку нечем, а два разных правила разошлись бы молча.
   *
   * `opts` не сказан — отсева нет вовсе: так placeIds вёл себя до появления
   * галки, и зовущий, который про неё не знает, обязан получать прежний
   * порядок.
   */
  function placeIds(rows, state, configHost, opts) {
    const o = opts || {};
    const stale = o.stale;
    const out = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = (row || {}).id;
      if (!id || !focusWindowOf(row, state, configHost)) continue;
      // Вид строки — тот же, каким её рисует страница: зелийная псевдосессия
      // возраста не имеет, и `isStale` ответит на неё `false` сам.
      const kind = (row || {}).kind === 'zellij' ? 'zellij' : 'session';
      if (stale && staleApi
        && staleApi.isStale(row, o.nowSec, stale, kind, minimizedHere(row, state, configHost))) {
        continue;
      }
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  /**
   * Куда просить о подъёме окна этой строки.
   *
   * Адрес — свойство машины окна, которое поднимаем, а не всего ответа:
   * трекеров несколько, и у каждого свой топик. Своего окна нет — берётся
   * главное: просьба всё равно уйдёт мимо, но топик остаётся хоть каким-то.
   * Пустая строка значит «спроси свой конфиг» — так пикер вёл себя до
   * появления поля, и так он обязан вести себя со старым агрегатором и со
   * старым трекером.
   */
  function mqttBaseFor(row, state, configHost) {
    const w = focusWindowOf(row, state, configHost) || windowOf(row, state);
    const base = w && typeof w.mqttBase === 'string' ? w.mqttBase.trim() : '';
    return base;
  }

  /**
   * Адрес прямой просьбы к менеджеру машины — `"host:port"` или пусто.
   *
   * Дорога двухшаговая, и это не лишний шаг: в записи окна адреса нет вовсе.
   * Агрегатор кладёт его только в запись машины (`windowHosts`), потому что
   * адрес — свойство машины, а запись окна ехала бы им в каждом ответе
   * `--state`, раз в секунду. `mqttBase` дублируется в обеих по историческим
   * причинам, и повторять это незачем.
   *
   * Пустая строка значит «иди через MQTT»: трекер или агрегатор прежней версии
   * поля не пишет. Отката тут не изобретается — MQTT и был единственной
   * дорогой.
   */
  function httpEndpointOf(entry) {
    const host = String((entry || {}).host || '').trim();
    const port = ((entry || {}).http || {}).port;
    if (!host) return '';
    return Number.isInteger(port) && port > 0 ? `${host}:${port}` : '';
  }

  function httpForHost(state, host) {
    const mine = normHost(host);
    if (!mine) return '';
    const entry = trackerHosts(state).find(e => normHost(e.host) === mine);
    return entry ? httpEndpointOf(entry) : '';
  }

  /** Адрес прямой просьбы для строки — по машине её окна. */
  function httpFor(row, state, configHost) {
    const w = focusWindowOf(row, state, configHost) || windowOf(row, state);
    return httpForHost(state, (w || {}).host);
  }

  /** Адрес прямой просьбы к машине, чей менеджер открывает сессии. */
  function managerHttp(state, configHost) {
    const manager = openManager(state, configHost);
    return manager ? httpEndpointOf(manager) : '';
  }

  /**
   * Трекер, чей менеджер берётся открывать сессии и терминалы.
   *
   * Вопрос про машину, а не про строку, и построчным он стать не может: у
   * строки проекта окна нет вовсе, а спросить «кто откроет терминал» надо и
   * про неё. Раньше на него отвечало верхнее поле `windowHost`, но с
   * несколькими трекерами оно значит «машина, чьи проектные хоткеи мы взяли»
   * (`lead` в `read_window_sources`), а вовсе не «машина, где стоит менеджер»:
   * упади Windows-трекер, верхним хостом стал бы мак.
   *
   * Свой раньше чужого: на машине с менеджером просьба уходит ему, на машине
   * без менеджера — остаётся имя чужой машины для пункта «Open on <host>».
   *
   * Отсутствующий `openSession` читается как «берётся» — то же правило, что у
   * `canFocus`: windows11-manager этого поля не пишет и не должен.
   */
  function openManager(state, configHost) {
    const able = trackerHosts(state).filter(e => e && e.openSession !== false);
    const mine = normHost(configHost);
    return able.find(e => normHost(e.host) === mine) || able[0] || null;
  }

  /**
   * Куда отматывать отметку «просмотрено».
   *
   * Отметка строки — максимум по своей отметке и focusedAt окна карточки
   * (см. focusedAt в session-list.js), а карточка теперь несёт одно окно —
   * своё. Отматывать при этом надо у **всех** трекеров сессии, а не только у
   * трекера этого окна: отмотай у одного, и сосед вернёт «просмотрено» на
   * следующем же опросе, а кнопка будет выглядеть сломанной — молча, у
   * публикации в MQTT нет ответа. Поэтому список окон здесь — не `row.windows`
   * (своё окно карточки), а `row.sessionWindows`, если оно есть: это
   * единственное поле, ради которого карточка вообще помнит про сессию
   * целиком, а не только про своё окно.
   *
   * `row.sessionWindows` есть только у строк, собранных buildSessionList.
   * Строки из других источников — старые вызовы в тестах, чужие сборщики
   * списка — этого поля не несут, и тогда откат на `windowsOf(row, state)`
   * ведёт себя как раньше: читает `row.windows`/`row.window`.
   *
   * Безадресное окно — не повод его выбросить, а windows11-manager поле
   * `mqttBase` не пишет вовсе, то есть агрегатор кладёт ему пустую строку
   * всегда. Выброси её здесь — и просьба до трекера этой машины не доедет
   * никогда, молча: у публикации в MQTT нет ответа, а следующий опрос снова
   * вернёт «просмотрено». Пустая строка едет наружу как есть: Rust читает её
   * как «спроси свой конфиг» (`resolve_base`) — так пикер вёл себя и до
   * появления нескольких трекеров, — а дедупликация ниже схлопывает повторы
   * сама, даже если пустых окон несколько.
   *
   * Транспорт считается на каждую машину отдельно и едет в паре с базой: у
   * одного трекера может быть http, у соседнего нет. Двумя параллельными
   * массивами это разъехалось бы по индексам на первой же правке.
   */
  function unreadTargets(row, state) {
    const r = row || {};
    const wins = Array.isArray(r.sessionWindows) ? r.sessionWindows : windowsOf(row, state);
    const out = [];
    for (const w of wins) {
      const base = w && typeof w.mqttBase === 'string' ? w.mqttBase.trim() : '';
      const http = httpForHost(state, (w || {}).host);
      if (!out.some(t => t.base === base && t.http === http)) out.push({ base, http });
    }
    return out;
  }

  return {
    windowOf, windowsOf, normHost, canFocusRow, focusWindowOf, trackerHere, trackerHosts, focusPid,
    mqttBaseFor, httpFor, managerHttp, openManager, unreadTargets, placeIds, minimizedHere,
  };
});
