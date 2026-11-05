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
   * иначе каталог, чьё имя лишь начинается так же, как корень (`/srv/workshop`
   * при корне `/srv/work`), считался бы лежащим внутри, и пикер собрал бы путь
   * из обрезка чужого имени.
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
   * Путь строки на этой машине.
   *
   * У строки местного источника он уже местный: переводить нечего, а перевод
   * отдал бы `null` — путь не начинается с удалённого префикса, — и вместе с
   * ним из меню пропали бы все действия с папкой, `Open plan` и `Open spec`.
   * Видно это стало на Windows, где местная строка несёт путь с буквой диска,
   * но правило общее: на Linux местная строка сегодня переводится через тот же
   * префикс, и это так же неверно.
   *
   * Метка источника — та же строка `local`, что стоит в `LOCAL_LABEL`
   * (state_source.rs) и в `LOCAL_SOURCE` (open-strategy.js). Импортировать её
   * сюда неоткуда: у этого модуля зависимостей нет вовсе.
   */
  function mapRowPath(row, pathMap) {
    const cwd = (row || {}).cwd;
    if (typeof cwd !== 'string' || !cwd) return null;
    if (String((row || {}).source || '') === 'local') return cwd;
    return mapPath(cwd, pathMap);
  }

  /**
   * Спека или план строки на этой машине; `null` — открыть нечем.
   *
   * Форм у бумаги две. Обычная — путь внутри `cwd`, и он клеится к переведённому
   * каталогу тем разделителем, который выбрал сам pathMap: локальный корень
   * бывает и windows-путём. Абсолютная — бумага, которую сессия писала в чужой
   * каталог (`written_doc` в ccfzf, живой случай 2026-10-10: claude-otel →
   * grafana): к `cwd` её не приклеить, и переводится она сама, по тому же
   * правилу, что и каталог строки. Удалённая сторона — POSIX, поэтому ведущий
   * `/` и есть признак.
   *
   * Форму пути уже проверил агрегатор — пробела и кавычки в нём не бывает.
   */
  function mapRowDoc(row, doc, pathMap) {
    if (typeof doc !== 'string' || !doc) return null;
    if (doc.startsWith('/')) {
      if (String((row || {}).source || '') === 'local') return doc;
      return mapPath(doc, pathMap);
    }
    const base = mapRowPath(row, pathMap);
    if (base === null) return null;
    const sep = separatorFor(base);
    return `${base}${base.endsWith(sep) ? '' : sep}${doc.split('/').join(sep)}`;
  }

  /**
   * Адрес `ssh://<хост>/<путь>`, которым Zed открывает папку или файл на
   * удалённой машине; `null` — хоста нет или путь не абсолютный.
   *
   * Сегменты кодируются, слэши между ними — нет: Zed раскодирует путь ровно
   * один раз (`parse_file_path` в open_listener.rs), и `#`, `?` или `%` без
   * кодирования обрезали бы адрес или раскодировались бы не в то. Хост
   * вставляется как есть — форма `user@host` в sshHost законна и в адрес
   * ложится сама.
   */
  function sshRemoteUrl(host, path) {
    const h = typeof host === 'string' ? host.trim() : '';
    if (!h || typeof path !== 'string' || !path.startsWith('/')) return null;
    return `ssh://${h}${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  /**
   * Открывать ли эту строку по ssh, а не через сетевой диск.
   *
   * Затем и заведено: сетевой диск не сообщает Zed о правках, сделанных на
   * той машине, а при сохранении Zed с диском не сверяется — файл, который
   * поправил агент, он молча затирал своей копией (2026-11-05, пропал
   * TODO.md). По ssh файлы читает и пишет удалённая машина сама.
   *
   * Только Zed: адрес `ssh://` понимает он один из трёх, VS Code и Cursor
   * открыли бы файл с таким именем. Только чужая строка: у своей машины ходить
   * по ssh не к кому. Включено — только булево `true`: конфиг пишут руками.
   */
  function usesSshRemote(row, cfg, editorId) {
    const c = cfg || {};
    return c.editorSshRemote === true
      && editorId === 'zed'
      && String((row || {}).source || '') !== 'local'
      && sshHostOf(row, c) !== '';
  }

  /**
   * На какую машину идти: `source` строки, а без него — sshHost. Тот же откат,
   * что у остальных удалённых действий страницы (`row.source || CONFIG.sshHost`):
   * метка ssh-источника — это sshHost дословно, включая `user@host`
   * (`Source::label` в state_source.rs).
   */
  function sshHostOf(row, cfg) {
    const source = String((row || {}).source || '').trim();
    if (source && source !== 'local') return source;
    return typeof (cfg || {}).sshHost === 'string' ? cfg.sshHost.trim() : '';
  }

  /**
   * Что отдать редактору, открывая папку строки: адрес `ssh://` или путь на
   * этой машине; `null` — открыть нечем.
   *
   * Карта путей для ssh не нужна вовсе — обойтись без сетевого диска и есть
   * цель, — поэтому пункт редактора спрашивает эту функцию, а не `mapRowPath`.
   * Настроенные действия (`{localPath}`) по-прежнему держатся за карту.
   */
  function editorFolderTarget(row, cfg, editorId) {
    if (usesSshRemote(row, cfg, editorId)) return sshRemoteUrl(sshHostOf(row, cfg), (row || {}).cwd);
    return mapRowPath(row, (cfg || {}).pathMap);
  }

  /**
   * То же для спеки или плана. Удалённая сторона — POSIX, поэтому
   * относительная бумага клеится к `cwd` через `/`, а абсолютная (`written_doc`
   * в чужом каталоге) уходит сама — то же правило, что у `mapRowDoc`.
   */
  function editorDocTarget(row, doc, cfg, editorId) {
    if (typeof doc !== 'string' || !doc) return null;
    if (!usesSshRemote(row, cfg, editorId)) return mapRowDoc(row, doc, (cfg || {}).pathMap);
    if (doc.startsWith('/')) return sshRemoteUrl(sshHostOf(row, cfg), doc);
    const cwd = String((row || {}).cwd || '').replace(/\/+$/, '');
    if (!cwd) return null;
    return sshRemoteUrl(sshHostOf(row, cfg), `${cwd}/${doc}`);
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
   * windows-mqtt (`src/picker/session-open-helpers.js`).
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

  return {
    separatorFor, mapPath, mapRowPath, mapRowDoc, buildActionArgv,
    sshRemoteUrl, editorFolderTarget, editorDocTarget,
  };
});
