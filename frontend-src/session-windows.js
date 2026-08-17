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
   * Отметка строки — максимум по всем окнам, поэтому отмотать надо у каждого
   * трекера: отмотай у одного, и второй вернёт «просмотрено» на следующем же
   * опросе, а кнопка будет выглядеть сломанной.
   *
   * Пустой список — не отказ: просьба уйдёт по базе из своего конфига, как
   * было до появления нескольких трекеров. Слот в менеджере переживает
   * закрытие окна, и такую сессию он всё ещё может знать по id.
   */
  function unreadBases(row, state) {
    const out = [];
    for (const w of windowsOf(row, state)) {
      const base = w && typeof w.mqttBase === 'string' ? w.mqttBase.trim() : '';
      if (base && !out.includes(base)) out.push(base);
    }
    return out;
  }

  return { windowOf, windowsOf, normHost, canFocusRow, focusWindowOf, trackerHere, trackerHosts, focusPid, mqttBaseFor, openManager, unreadBases };
});
