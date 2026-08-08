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
  const PREFIX = /^\s*\/(all|a)(\s+|$)/i;
  const PREFIX_TEXT = '/a ';

  function parseQuery(raw) {
    const text = String(raw == null ? '' : raw);
    const m = text.match(PREFIX);
    if (!m) return { mode: 'sessions', query: text.trim() };
    return { mode: 'projects', query: text.slice(m[0].length).trim() };
  }

  /** Строка поиска с префиксом впереди — то, что делает `^A`. */
  function withProjectPrefix(raw) {
    const text = String(raw == null ? '' : raw);
    if (PREFIX.test(text)) return text;
    return PREFIX_TEXT + text.replace(/^\s+/, '');
  }

  return { parseQuery, withProjectPrefix, PREFIX_TEXT };
});
