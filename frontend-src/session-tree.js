// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionTree = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Отступ одного уровня дерева, в пикселях. Одно число на обе раскладки:
   * в карточке широкого режима он виден так же, как в узком списке, а двух
   * значений об одном и том же никто бы не держал в согласии.
   */
  const INDENT_PX = 20;

  /**
   * Строки секции в порядке дерева head-сессий: дети стоят непосредственно
   * **после** родительской строки, внуки — после своего ребёнка.
   *
   * После, а не перед, — и это переделка. Сначала дети стояли перед
   * родителем, как просил владелец, но блок с отступом глаз приписывает
   * строке **над** ним: на nb «родителем» выглядел сосед сверху, и менялся он
   * вместе с сортировкой по активности. Владелец выбрал обычное дерево
   * (2026-11-11).
   *
   * Родитель ищется только среди строк той же секции и того же участка между
   * подзаголовками машин (`block-subhead`). Секция отвечает на свой вопрос —
   * живая, чужая машина, история, — и закрытый ребёнок, втянутый в «Active»
   * к живому родителю, сказал бы про себя неправду. Ребёнок без родителя на
   * участке — родитель закрыт, отфильтрован запросом или в другой секции —
   * стоит где стоял, с глубиной 0, и подпись `head:` у него остаётся: связь
   * всё ещё надо как-то показать.
   *
   * Сперва по `headId` — он переживает переименование родителя; затем по
   * `head` против имени строки (`title`, затем `windowTitle`). При тёзках
   * берётся первый в видимом порядке.
   *
   * Карточки одной сессии (по одной на окно) ходят вместе: дети встают после
   * последней из них. Группируются карточки по id сессии, а не по окну: у
   * вкладок Windows Terminal процесс, а значит и `window.pid`, общий. Строки без id (zellij-псевдосессии) — сами себе узлы.
   * Цикл в данных (A ребёнок B, B ребёнок A) разрывается: узел, чей предок
   * оказался им самим, остаётся корнем.
   *
   * Строки не мутируются: на выход идут копии с `treeDepth` — 0 у корня.
   * Строки, которые никуда не переехали, тоже копируются ради поля: читатель
   * спрашивает его у всякой строки и не должен гадать про `undefined`.
   */
  function nestByHead(rows) {
    const src = Array.isArray(rows) ? rows : [];
    const out = [];
    let segment = [];
    const flush = () => {
      for (const row of nestSegment(segment)) out.push(row);
      segment = [];
    };
    for (const row of src) {
      if (row && row.kind === 'block-subhead') {
        flush();
        out.push(row);
      } else {
        segment.push(row);
      }
    }
    flush();
    return out;
  }

  function nestSegment(rows) {
    // Узел — сессия целиком: id → карточки по порядку. Строка без id
    // становится узлом сама по себе, под своим номером.
    const nodes = [];
    const byId = new Map();
    for (const [i, row] of rows.entries()) {
      const id = row && typeof row.id === 'string' && row.id ? row.id : '';
      if (id && byId.has(id)) {
        byId.get(id).cards.push(row);
        continue;
      }
      const node = { key: id || `#${i}`, row, cards: [row], parent: null, children: [] };
      nodes.push(node);
      if (id) byId.set(id, node);
    }
    const byName = new Map();
    for (const node of nodes) {
      for (const name of [node.row && node.row.title, node.row && node.row.windowTitle]) {
        const n = typeof name === 'string' ? name.trim() : '';
        if (n && !byName.has(n)) byName.set(n, node);
      }
    }
    for (const node of nodes) {
      const r = node.row || {};
      const headId = typeof r.headId === 'string' ? r.headId.trim() : '';
      const head = typeof r.head === 'string' ? r.head.trim() : '';
      let parent = headId ? byId.get(headId) : undefined;
      if (!parent && head) parent = byName.get(head);
      if (parent && parent !== node) node.parent = parent;
    }
    // Разрыв циклов: поднимаемся по предкам, и встреча с собой значит, что
    // данные противоречат друг другу, — такой узел остаётся корнем.
    for (const node of nodes) {
      const seen = new Set([node]);
      for (let up = node.parent; up; up = up.parent) {
        if (seen.has(up)) { node.parent = null; break; }
        seen.add(up);
      }
    }
    for (const node of nodes) if (node.parent) node.parent.children.push(node);

    const out = [];
    const emit = (node, depth) => {
      for (const card of node.cards) out.push({ ...card, treeDepth: depth });
      for (const child of node.children) emit(child, depth + 1);
    };
    for (const node of nodes) if (!node.parent) emit(node, 0);
    return out;
  }

  return { nestByHead, INDENT_PX };
});
