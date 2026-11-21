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

  /**
   * Проект, которого однозначно называет слово, — или null.
   *
   * Точное имя (без регистра) или путь каталога целиком побеждают кусок:
   * иначе `ccfzf` не назвал бы проект `ccfzf` при живом `ccfzf-picker`. Кусок
   * ищется только в имени: в путях общие слова (`projects`, `js`) есть у всех,
   * и кусок по ним был бы неоднозначен всегда. Два совпадения — не догадка, а
   * отказ: отдать промпт не тому проекту хуже, чем не отдать никому.
   */
  function resolveProject(word, projects) {
    const w = String(word || '').toLowerCase();
    const list = Array.isArray(projects) ? projects : [];
    if (!w) return null;
    const exact = list.filter(p => String(p.label || '').toLowerCase() === w
      || String(p.cwd || '').toLowerCase() === w);
    if (exact.length) return exact.length === 1 ? exact[0] : null;
    const part = list.filter(p => String(p.label || '').toLowerCase().includes(w));
    return part.length === 1 ? part[0] : null;
  }

  /**
   * `/p <проект> <промпт>`: первое слово хвоста — проект, остальное — промпт.
   *
   * Зовётся с хвостом после префикса (`parseQuery(...).query`). Режим промпта
   * — только когда проект назван однозначно **и** промпт не пуст; во всех
   * остальных случаях это прежний фильтр проектов. Цена такого правила почти
   * нулевая: фильтр ищет весь хвост одной подстрокой (`filterProjects`), то
   * есть многословный запрос и раньше не находил почти ничего.
   *
   * Отдельного признака, который ставил бы только Tab, нет намеренно: строка
   * остаётся самоописывающей (см. шапку файла), а набранное руками
   * `/p pick fix it` значит то же, что и после Tab.
   */
  function projectPrompt(query, projects) {
    const text = String(query == null ? '' : query).replace(/^\s+/, '');
    const hit = text.match(/^(\S+)\s+([\s\S]*\S)\s*$/);
    if (!hit) return null;
    const project = resolveProject(hit[1], projects);
    return project ? { project, prompt: hit[2] } : null;
  }

  /**
   * Слово, которым Tab называет проект: такое, что `resolveProject` вернёт
   * этот же проект. Имя — если в нём нет пробела и тёзки нет; иначе путь
   * каталога; иначе однозначный кусок имени без пробела, самый длинный из
   * таких. Пустая строка —
   * назвать нечем, и Tab ничего не делает.
   */
  function projectToken(project, projects) {
    if (!project) return '';
    // Куски — от длинного к короткому: длинный и читается, и реже совпадает
    // с чужим именем.
    const pieces = String(project.label || '').split(/\s+/).sort((a, b) => b.length - a.length);
    const candidates = [project.label, project.cwd, ...pieces];
    for (const c of candidates) {
      const word = String(c || '');
      if (word && !/\s/.test(word) && resolveProject(word, projects) === project) return word;
    }
    return '';
  }

  return { parseQuery, withPrefix, stripPrefix, projectPrompt, projectToken, PREFIXES };
});
