/** Одно дерево каталогов, видное с двух сторон. Чистые функции, без I/O. */
// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PathMap = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Разделитель, которого требует локальный корень.
   *
   * Определяется по самому корню, а не по системе, на которой крутится пикер:
   * значение пришло из конфига этой машины, и его форма и есть ответ. Признаков
   * два, и второй не лишний — корень могли записать одной буквой диска с
   * двоеточием и без разделителя вовсе, и тогда обратных слэшей в строке нет.
   */
  function separatorFor(local) {
    return local.includes('\\') || /^[A-Za-z]:/.test(local) ? '\\' : '/';
  }

  /**
   * Путь сессии, переведённый на эту машину.
   *
   * `null` означает «показывать нечего»: маппинг не настроен, пути нет или он
   * лежит вне общего дерева. Вызывающий по этому же признаку решает, предлагать
   * ли действия открытия — пункт меню, ведущий в никуда, хуже отсутствующего.
   *
   * Совпадение префикса — с границей по разделителю, а не по длине строки:
   * иначе `/home/username-old` считался бы лежащим внутри `/home/username`, и
   * пикер собрал бы путь из обрезка чужого имени.
   *
   * Удалённая сторона — всегда POSIX: там живёт агрегатор, и других путей он не
   * отдаёт. Разбирать здесь обе формы было бы гаданием.
   */
  function mapPath(cwd, pathMap) {
    const { remote, local } = pathMap || {};
    if (typeof cwd !== 'string' || !cwd) return null;
    if (typeof remote !== 'string' || !remote) return null;
    if (typeof local !== 'string' || !local) return null;

    const from = remote.replace(/\/+$/, '');
    if (!from) return null;
    const normalized = cwd.replace(/\/+$/, '') || '/';
    if (normalized !== from && !normalized.startsWith(`${from}/`)) return null;

    const sep = separatorFor(local);
    const to = local.replace(/[\\/]+$/, '');
    // Корень, оставшийся одним двоеточием, — это буква диска, и без разделителя
    // такой путь означает не корень диска, а «текущий каталог на нём».
    const base = to.endsWith(':') ? `${to}${sep}` : to;
    if (normalized === from) return base;

    const rest = normalized.slice(from.length + 1).split('/').join(sep);
    return base.endsWith(sep) ? `${base}${rest}` : `${base}${sep}${rest}`;
  }

  /**
   * argv действия с подставленными плейсхолдерами.
   *
   * Подстановка идёт внутри каждого элемента, а не заменяет элемент целиком:
   * так работает и форма `--folder-uri={localPath}`, которую иначе пришлось бы
   * разбивать на два аргумента.
   *
   * Кавычить нечего: шелла в цепочке нет. `spawn_detached` зовёт
   * `Command::new(file).args(args)`, и элементы уходят аргументами процесса —
   * этим ветка и отличается от удалённых команд, где `q` из open-strategy
   * обязательна.
   *
   * `{localPathSlash}` существует ради одной подтверждённой мелочи: `cmd /c
   * start` съедает обратные слэши и папку не открывает. Тот же обход стоял в
   * прежнем пикере на Windows.
   */
  function buildActionArgv(action, paths) {
    const { localPath = '', remotePath = '' } = paths || {};
    const values = {
      '{localPath}': localPath,
      '{localPathSlash}': String(localPath).split('\\').join('/'),
      '{remotePath}': remotePath,
    };
    return ((action || {}).argv || []).map(arg => {
      let out = String(arg);
      for (const [token, value] of Object.entries(values)) out = out.split(token).join(value);
      return out;
    });
  }

  return { separatorFor, mapPath, buildActionArgv };
});
