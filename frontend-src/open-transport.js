// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpenTransport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function normHost(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  /**
   * Кто открывает сессию.
   *
   * На машине оконного трекера — он: маппинг проекта на профиль Windows
   * Terminal (`claudeWt.projects`) знает только windows11-manager, и собранная
   * здесь команда `wt.exe` этот профиль теряет. Просьба уходит публикацией в
   * MQTT (`open_session_mqtt`) — тот же транспорт, что уже работает на этой
   * машине для фокуса окна и пометки непрочитанным.
   *
   * Где трекера нет — открываем сами, как раньше: на macOS менеджера не
   * существует, и просьба уехала бы открывать окно на чужой машине.
   *
   * Без брокера MQTT ветка `manager` вела бы Enter в ошибку там, где раньше
   * он открывал терминал локально — регрессия на машине, которой MQTT никогда
   * не был нужен. Поэтому совпадения имени хоста недостаточно: нужен ещё и
   * настроенный брокер, иначе просьбе некуда уйти и остаётся `local`.
   *
   * `windowPid` здесь, в отличие от `canFocus`, не смотрим: право переднего
   * плана нужно для подъёма окна, а не для запуска терминала.
   */
  function chooseOpenTransport(state, configHost, mqttConfigured) {
    const host = normHost((state || {}).windowHost);
    const mine = normHost(configHost);
    return host && host === mine && mqttConfigured ? 'manager' : 'local';
  }

  /**
   * Виды строк, у которых `id` — это id настоящей сессии.
   *
   * Позитивный список, а не отрицательный: `id` у остальных видов строк —
   * это что-то другое (путь проекта, id снимка), и просьба открыть их на
   * трекере ушла бы искать несуществующую сессию. Перечислены по местам,
   * где строки собираются:
   *  - `session-list.js`: обычная строка сессии — `kind: s.kind || 'interactive'`.
   *    `background` сюда не попадает вовсе: `buildSessionList` отфильтровывает
   *    его раньше, чем строка соберётся, — поля форка достаются строке
   *    родителя через activeAgent, а сам форк своей строки не получает.
   *  - `picker-snapshots.js`: `snapshot-session` — сессия внутри снимка, её
   *    `id` — id той же настоящей сессии, восстановленной или ещё нет;
   *    `snapshot` — заголовок снимка, `id` там — id снимка, не сессии.
   *  - `project-list.js`: `project` — id там путь каталога, сессии ещё нет
   *    вовсе.
   *
   * Deny-list здесь не годится: он остаётся верным только пока кто-то помнит
   * исключить из него каждый новый вид заголовка. Строка неизвестного вида
   * (кто-то добавит новый kind и забудет про этот список) обязана остаться
   * без пункта меню — то же правило, что и у остальных пунктов в
   * `availableActions`: пункт, который не сработает, хуже отсутствующего.
   */
  const SESSION_ID_ROW_KINDS = new Set(['interactive', 'snapshot-session']);

  /**
   * Можно ли предложить строке пункт «Open on <host>».
   *
   * Совмещает три независимых условия: строка несёт настоящий id сессии (иначе
   * приёмник ответит `unknown session` в свой лог, а пикер этого не увидит —
   * PubAck подтверждает публикацию, а не то, что менеджер нашёл сессию),
   * трекер существует, но стоит не на этой машине, и брокер MQTT настроен —
   * без него просьбе некуда уйти, и пункт меню выполнил бы `open_session_mqtt`
   * прямиком в «mqtt не настроен» (main.rs). Пустой `windowHost` проверяется
   * отдельно от `chooseOpenTransport`: та возвращает `'local'` и при пустом
   * хосте (трекера нет вовсе), и пункт в этом случае предлагать тоже нечего —
   * открывать «у себя», когда себя не существует.
   */
  function canOpenRemote(row, state, configHost, mqttConfigured) {
    if (!row || !SESSION_ID_ROW_KINDS.has(row.kind)) return false;
    if (!(state || {}).windowHost) return false;
    if (!mqttConfigured) return false;
    return chooseOpenTransport(state, configHost, mqttConfigured) === 'local';
  }

  return { chooseOpenTransport, canOpenRemote };
});
