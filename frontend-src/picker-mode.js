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
   * Одна таблица на все пять, а не пять пар регулярок: разбор, снятие и
   * вставка обязаны видеть один и тот же набор, иначе `^L` на строке с чужим
   * префиксом приписал бы свой поверх.
   *
   * Хвост `(\s+|$)` у каждой записи обязателен: без него `/lib` уводил бы в
   * режим `local`, а `/home` — в `history`. По этой же причине префиксом не
   * считаются `/api`, `/src` и `/pr`.
   *
   * `\s*` впереди — не вольность: строка поиска приходит в хоткей живьём,
   * вместе с пробелом, который человек успел набрать. Без этой поблажки
   * `withPrefix` не узнавала бы уже стоящий префикс и приписывала бы второй.
   */
  const PREFIXES = [
    { mode: 'local', text: '/l ', re: /^\s*\/(local|l)(\s+|$)/i },
    { mode: 'remote', text: '/r ', re: /^\s*\/(remote|r)(\s+|$)/i },
    { mode: 'history', text: '/h ', re: /^\s*\/(history|h)(\s+|$)/i },
    { mode: 'projects', text: '/p ', re: /^\s*\/(projects|p)(\s+|$)/i },
    { mode: 'snapshots', text: '/s ', re: /^\s*\/(snapshots|s)(\s+|$)/i },
  ];

  /** Запись таблицы, которой отвечает начало строки, и длина совпадения. */
  function matchPrefix(text) {
    for (const prefix of PREFIXES) {
      const hit = text.match(prefix.re);
      if (hit) return { prefix, length: hit[0].length };
    }
    return null;
  }

  function parseQuery(raw) {
    const text = String(raw == null ? '' : raw);
    const hit = matchPrefix(text);
    if (hit) return { mode: hit.prefix.mode, query: text.slice(hit.length).trim() };
    return { mode: 'sessions', query: text.trim() };
  }

  /** Снять префикс любого из режимов, оставив сам запрос. */
  function stripPrefix(text) {
    const hit = matchPrefix(text);
    return hit ? text.slice(hit.length) : text;
  }

  /** Строка поиска с префиксом названного режима впереди — то, что делают хоткеи. */
  function withPrefix(raw, mode) {
    const text = String(raw == null ? '' : raw);
    const target = PREFIXES.find(p => p.mode === mode);
    if (!target) return text;
    if (target.re.test(text)) return text;
    return target.text + stripPrefix(text).replace(/^\s+/, '');
  }

  return { parseQuery, withPrefix, stripPrefix, PREFIXES };
});
