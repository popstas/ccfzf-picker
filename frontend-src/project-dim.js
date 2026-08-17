// Loaded twice: as a <script> in sessions.html and as a module in the tests.
//
// Гашение строк чужого проекта: две чистые функции — какой каталог считать
// выбранным и какие строки под него гасить. Обе жили в самой странице и
// проверялись текстовым извлечением исходника; вынесены сюда потому, что
// решают они не про DOM, а про данные, и проверяются прямым вызовом.
// Раскладывает решение по узлам по-прежнему страница: `paintProjectDim`.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProjectDim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Виды строк, которые не гаснут никогда. Заголовки секций и дней —
  // погашенный заголовок читался бы как свёрнутая панель. Заголовок снимка
  // сюда добавлен отдельно, и это не то же самое, что `HEADER_KINDS`
  // страницы: тот список решает, куда встаёт выбор при сбросе, а заголовок
  // снимка выбираемый — на нём Enter поднимает всю раскладку. Своего `cwd` у
  // него при этом нет, то есть под любой проект он не подходит и гас бы
  // всегда, сколько бы снимков ни лежало рядом.
  const NEVER_DIM = new Set(['snapshot']);

  function stays(row, headerKinds) {
    if (NEVER_DIM.has(row.kind)) return true;
    return Boolean(headerKinds && headerKinds.has(row.kind));
  }

  /**
   * По какому каталогу гасим: наведение главнее фокуса — мышь жест более
   * свежий и намеренный, а выбор стоит на строке всегда, в том числе сам
   * собой после открытия окна.
   *
   * Фокус гасит только со строки проекта и только в смешанном списке. Второе
   * условие записано свойством самого списка («есть строка не-проект и не
   * заголовок»), а не именем режима: в `/p` строк других видов нет, значит
   * гашение само не включится, — и точно так же не включится под запросом,
   * отобравшим одни проекты. Читай мы `mode`, это был бы второй источник
   * правды рядом с содержимым списка, и разошлись бы они на первой правке
   * префиксов. Отделять там всё равно нечего: выбор подсвечен и без гашения.
   *
   * `enabled` — галка `dim project`. Гасится всё здесь, в самой нижней
   * точке: обработчики мыши и отрисовка о галке не знают вовсе, а две точки
   * отключения дали бы галку, работающую через раз.
   */
  function dimCwd(rows, active, hoverCwd, enabled, headerKinds) {
    if (!enabled) return '';
    if (hoverCwd) return hoverCwd;
    const list = Array.isArray(rows) ? rows : [];
    const row = list[active];
    if (!row || row.kind !== 'project' || !row.cwd) return '';
    const mixed = list.some(r => !stays(r, headerKinds) && r.kind !== 'project');
    return mixed ? row.cwd : '';
  }

  /** Какие строки гасить под выбранный каталог. */
  function dimsForHover(rows, cwd, headerKinds) {
    const list = Array.isArray(rows) ? rows : [];
    // Ни одна строка не несёт этот каталог — значит наведение устарело
    // (список успел пересобраться под ним) или само стало осадком прошлого
    // показа. Гасить всё подряд в этом случае значило бы притушить весь
    // список без единой яркой строки под курсором.
    if (!cwd || !list.some(row => row.cwd === cwd)) return list.map(() => false);
    return list.map(row => !stays(row, headerKinds) && row.cwd !== cwd);
  }

  return { dimCwd, dimsForHover, NEVER_DIM };
});
