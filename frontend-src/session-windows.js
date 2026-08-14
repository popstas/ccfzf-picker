// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionWindows = factory();
})(typeof self !== 'undefined' ? self : this, function () {
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
   * Запись окна строки, дополненная сведениями о машине.
   *
   * Трекеров теперь может быть несколько, и «чья это машина» перестало быть
   * свойством всего ответа: агрегатор приписывает `host`, `pid` и `canFocus`
   * каждой записи окна отдельно.
   *
   * Старый агрегатор этих полей не кладёт, и тогда берутся верхние поля
   * ответа — там ровно один трекер, и все окна его. Пикер и агрегатор
   * обновляются порознь, порядок нам не подвластен, а пикер новее агрегатора
   * обязан вести себя как прежде, а не гасить пометки.
   */
  function windowOf(row, state) {
    const w = (row || {}).window;
    if (!w) return null;
    if (normHost(w.host)) return w;
    const s = state || {};
    return { ...w, host: s.windowHost, pid: s.windowPid, canFocus: true };
  }

  /**
   * Поднимать ли окно этой строки вместо открытия терминала.
   *
   * Три условия, и каждое стоит починенной поломки. Машина окна совпала с
   * нашей — иначе подъём на чужом экране ничего не даёт человеку, а Enter
   * теряет привычное открытие терминала. Трекер этой машины умеет поднимать —
   * иначе просьбу разберёт менеджер на другой машине, и окно поднимется не
   * то. Pid ненулевой — это признак живого трекера: свой pid в файл окон
   * кладёт он сам, и ноль значит «файла нет, он чужой или протух».
   */
  function canFocusRow(row, state, configHost) {
    const w = windowOf(row, state);
    if (!w || w.canFocus === false) return false;
    const host = normHost(w.host);
    const mine = normHost(configHost);
    return Boolean(host) && host === mine && focusPid(w) > 0;
  }

  /**
   * Машины, чьи трекеры сейчас живы.
   *
   * Старый агрегатор списка не отдаёт, но одну машину называет верхними
   * полями — из них и собирается список на одного. Пустой список на таком
   * ответе выключил бы режим снимков там, где он работает.
   */
  function trackerHosts(state) {
    const s = state || {};
    if (Array.isArray(s.windowHosts)) return s.windowHosts.filter(Boolean);
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
   * Куда просить о подъёме окна этой строки.
   *
   * Адрес — свойство машины окна, а не всего ответа: трекеров несколько, и у
   * каждого свой топик. Пустая строка значит «спроси свой конфиг» — так пикер
   * вёл себя до появления поля, и так он обязан вести себя со старым
   * агрегатором и со старым трекером.
   */
  function mqttBaseFor(row, state) {
    const w = windowOf(row, state);
    const base = w && typeof w.mqttBase === 'string' ? w.mqttBase.trim() : '';
    return base;
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

  return { windowOf, normHost, canFocusRow, trackerHere, trackerHosts, focusPid, mqttBaseFor, openManager };
});
