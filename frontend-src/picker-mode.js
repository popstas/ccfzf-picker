// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PickerMode = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Режим списка живёт в самой строке поиска, а не отдельным флагом.
   *
   * Так всё, что происходит, написано на экране: видно и что ищем, и где.
   * Скрытый режим потребовал бы места под свой признак и научил бы Esc вести
   * себя по-разному без видимой причины — а стирание префикса возвращает к
   * сессиям само собой, безо всякого выхода из режима.
   *
   * `/al` и `/api` префиксом не считаются: человек, ищущий сессию со словом
   * `/api` в пути, не должен молча оказаться в другом списке.
   *
   * `\s*` впереди — не вольность, а условие того, что обе функции ниже видят
   * одно и то же. Строка поиска приходит в `^A` живьём, с пробелом, который
   * человек успел набрать; без этой поблажки `withProjectPrefix` не узнавала бы
   * уже стоящий префикс и приписывала бы второй, а `parseQuery` на той же
   * строке оставалась бы в сессиях.
   */
  const PROJECT_PREFIX = /^\s*\/(all|a)(\s+|$)/i;
  const PROJECT_PREFIX_TEXT = '/a ';

  /**
   * Снимки — третий режим той же строки поиска.
   *
   * `/session` и `/src` префиксом не считаются по той же причине, по которой
   * им не считается `/api`: хвост `(\s+|$)` требует, чтобы после `/s` строка
   * кончилась или пошёл пробел.
   */
  const SNAPSHOT_PREFIX = /^\s*\/(snapshots|s)(\s+|$)/i;
  const SNAPSHOT_PREFIX_TEXT = '/s ';

  function parseQuery(raw) {
    const text = String(raw == null ? '' : raw);
    const project = text.match(PROJECT_PREFIX);
    if (project) return { mode: 'projects', query: text.slice(project[0].length).trim() };
    const snapshot = text.match(SNAPSHOT_PREFIX);
    if (snapshot) return { mode: 'snapshots', query: text.slice(snapshot[0].length).trim() };
    return { mode: 'sessions', query: text.trim() };
  }

  /** Строка поиска с префиксом впереди — то, что делает `^A`. */
  function withProjectPrefix(raw) {
    const text = String(raw == null ? '' : raw);
    if (PROJECT_PREFIX.test(text)) return text;
    return PROJECT_PREFIX_TEXT + text.replace(/^\s+/, '');
  }

  /** Строка поиска с префиксом снимков впереди. */
  function withSnapshotPrefix(raw) {
    const text = String(raw == null ? '' : raw);
    if (SNAPSHOT_PREFIX.test(text)) return text;
    return SNAPSHOT_PREFIX_TEXT + text.replace(/^\s+/, '');
  }

  return { parseQuery, withProjectPrefix, withSnapshotPrefix, PREFIX_TEXT: PROJECT_PREFIX_TEXT, SNAPSHOT_PREFIX_TEXT };
});
