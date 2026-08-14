// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZellijList = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Строки зелийных сессий из ответа агрегатора.
   *
   * Строка заводится каждой живой зелийной сессии, а не только тем, внутри
   * которых нет агента. Причина не в полноте ради полноты: список сессий в
   * ответе обрезан (`--limit`, по умолчанию 100), и агент внутри зелийной
   * сессии может в срез не попасть — тогда не стало бы ни его строки, ни
   * строки его зелийной сессии, то есть ровно той невидимости, ради которой
   * режим и заведён. Сколько агентов внутри, говорит `agents`.
   *
   * `label` и `lastActivity` названы так же, как у сессии и у проекта: имя
   * рисует и ищет общий код, колонку возраста — общая ageHtml, и второе имя
   * для того же смысла им пришлось бы объяснять.
   *
   * `zellij` — своё же имя. Через это поле строка попадает в ветку `attach`
   * (open-strategy.js) без единого условия про `kind`.
   *
   * `live: true` — сессия существует, пока жив её сервер; строка мёртвой
   * зелийной сессии сюда не приезжает вовсе (агрегатор их не видит).
   */
  function buildZellijList({ zellij } = {}) {
    const list = Array.isArray(zellij) ? zellij : [];
    return list
      .filter(z => z && typeof z.name === 'string' && z.name)
      .map(z => ({
        kind: 'zellij',
        // Префикс обязателен: ключ строки в DOM общий на весь список, а
        // зелийную сессию законно назвать как угодно — хоть uuid сессии.
        id: `zellij:${z.name}`,
        label: z.name,
        name: z.name,
        zellij: z.name,
        agents: Number(z.agents) || 0,
        lastActivity: Number(z.created) || 0,
        live: true,
        // Каталога у зелийной сессии нет: панели в ней могут стоять в разных.
        // Пустая строка, а не undefined, — действия папки спрашивают именно
        // её и на пустой молчат.
        cwd: '',
      }));
  }

  return { buildZellijList };
});
