// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionWindows = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Ответ оконного трекера — в справочник «id сессии → её окно».
   *
   * Трекер живёт в соседнем репозитории, на другой машине, и приезжает по сети.
   * Ничему в этом ответе не доверяется: слот без строкового `id` выбрасывается
   * целиком, нечисловой стол становится `null`. Порченый ответ должен стоить
   * пометки, а не списка.
   *
   * Пустой справочник — законный результат: трекер погашен, ответил мусором
   * или окон просто нет. Разницы для отрисовки никакой, и заводить её незачем.
   */
  function normalizeWindows(raw) {
    const slots = raw && Array.isArray(raw.slots) ? raw.slots : [];
    const out = {};
    for (const slot of slots) {
      if (!slot || typeof slot.id !== 'string' || !slot.id) continue;
      out[slot.id] = {
        title: typeof slot.title === 'string' ? slot.title : '',
        desktop: Number.isFinite(slot.desktop) ? slot.desktop : null,
        lastSeen: Number.isFinite(slot.lastSeen) ? slot.lastSeen : 0,
      };
    }
    return out;
  }

  /**
   * Приписать строкам их окно.
   *
   * Поле одно (`row.window`), и оно либо объект, либо `null`: «окна нет» и «про
   * окна ничего не известно» здесь сознательно не различаются. Различие видно
   * только в конфиге — не задан `windowTracker.url`, значит трекера нет вовсе,
   * — а по строке списка его не показать, и попытка показать дала бы третье
   * состояние глифа, которое некому читать.
   */
  function withWindows(rows, windows) {
    const byId = windows || {};
    return (rows || []).map(row => ({ ...row, window: byId[row.id] || null }));
  }

  /**
   * Отзывается ли этот url на той же машине, где работает пикер.
   *
   * От этого зависит, поднимать ли окно по Enter. Трекер на петлевом адресе —
   * значит окна на том же экране, перед которым человек. Трекер на чужом имени
   * — значит окна на другой машине: пометка о них полезна, а фокус поднял бы
   * окно там, где на него никто не смотрит, и вдобавок отнял бы у Enter
   * привычное открытие терминала.
   *
   * Разбор без `new URL`: тот кидает на строке без схемы, а конфиг пишет
   * человек. Строка, которую не удалось разобрать, — не петлевой адрес.
   */
  function hostOf(url) {
    const rest = String(url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
    // IPv6 записывается в скобках именно затем, чтобы его двоеточия не спутали
    // с портом: `[::1]:9722`. Внутри скобок — весь адрес, снаружи — только порт.
    const bracketed = rest.match(/^\[(.+?)\]/);
    if (bracketed) return bracketed[1];
    // Одно двоеточие — это `host:port`. Больше одного — голый IPv6, у которого
    // порта нет: отрезать у него хвост значило бы менять сам адрес.
    const parts = rest.split(':');
    return parts.length === 2 ? parts[0] : rest;
  }

  function isLoopback(url) {
    if (typeof url !== 'string' || !url) return false;
    const host = hostOf(url);
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }

  return { normalizeWindows, withWindows, isLoopback };
});
