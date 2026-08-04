(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpenStrategy = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /** Одинарные кавычки в POSIX-строке: закрыть, экранировать, открыть заново. */
  function q(s) {
    return `'${String(s == null ? '' : s).replace(/'/g, `'\\''`)}'`;
  }

  /**
   * Чем открывать сессию.
   *
   * Порядок ветвей — по убыванию сохранности: tmux ничего не трогает, reptyr
   * переносит живой процесс, перехват его убивает, resume нужен только когда
   * трогать уже нечего. tmux проверяется первым и у мёртвой сессии тоже: если
   * панель существует, зайти в неё лучше, чем поднимать процесс заново.
   */
  function chooseOpenStrategy(row, caps) {
    if (!row) return 'resume';
    if (row.tmux) return 'attach';
    // Перехватывать нечего без pid: живой сессию мог назвать и эвристический
    // разбор /proc, который процесс так и не нашёл.
    if (row.live && row.pid) return (caps || {}).reptyr ? 'reptyr' : 'takeover';
    return 'resume';
  }

  /**
   * argv для запуска терминала. Ввод-вывод делает вызывающий.
   *
   * `destructive` поднимается только у перехвата: это единственная ветка, где
   * чужой процесс умирает, и подтверждение спрашивается по этому признаку, а
   * не по имени стратегии.
   */
  function buildOpenCommand(row, strategy, opts) {
    const { sshHost, terminal } = opts || {};
    let remote = null;
    let destructive = false;

    if (strategy === 'attach') {
      remote = `tmux attach -t ${q(row.tmux)}`;
    } else if (strategy === 'reptyr') {
      remote = `reptyr -T ${Number(row.pid)}`;
    } else if (strategy === 'resume') {
      remote = `cd ${q(row.cwd)} && claude --resume ${q(row.id)}`;
    } else if (strategy === 'takeover') {
      destructive = true;
      // SIGHUP, а не -9: агент успевает закрыть транскрипт. Ожидание — до 10
      // секунд с проверкой раз в полсекунды; если процесс всё же жив, resume
      // не запускается, иначе получилось бы два процесса на одном файле.
      const pid = Number(row.pid);
      remote = [
        `kill -HUP ${pid}`,
        `for i in $(seq 20); do kill -0 ${pid} 2>/dev/null || break; sleep 0.5; done`,
        `kill -0 ${pid} 2>/dev/null && { echo "ccfzf-picker: process ${pid} is still alive" >&2; exit 1; }`,
        `cd ${q(row.cwd)} && claude --resume ${q(row.id)}`,
      ].join('; ');
    }

    if (remote === null) return null;
    const term = terminal || { file: 'open', args: [] };
    return {
      argv: [term.file, ...(term.args || []), 'ssh', '-t', String(sshHost || ''), remote],
      destructive,
    };
  }

  // q отдаётся наружу не для красоты: это единственный барьер между путём,
  // который придумал человек, и шеллом на той стороне ssh. Всякий, кому нужно
  // собрать удалённую команду (проектные хоткеи в sessions.html), обязан звать
  // именно её, а не писать replace по месту — второй экземпляр этого правила
  // рано или поздно разойдётся с первым.
  return { q, chooseOpenStrategy, buildOpenCommand };
});
