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
   * переносит живой процесс, перехват его убивает. tmux проверяется первым и у
   * мёртвой сессии тоже: если панель существует, зайти в неё лучше, чем
   * поднимать процесс заново.
   *
   * `resume` стоит последним и ловит в том числе живую сессию — то есть
   * поднимает второй процесс на том же транскрипте. Раньше на этом месте был
   * перехват, и он оправдывал себя, пока перенос считался рабочим. После
   * проверки 2026-08-05 (см. docs/reptyr-experiment.md) переносить нечем:
   * держатель pty — sshd, ptrace по нему запрещён. Выбор остался между
   * «убить чужую работу» и «открыть рядом», и владелец проекта выбрал второе.
   * Перехват никуда не делся, но теперь его надо просить явно — `caps.takeover`.
   */
  function chooseOpenStrategy(row, caps) {
    if (!row) return 'resume';
    if (row.tmux) return 'attach';
    // Ни переносить, ни перехватывать нечего без pid: живой сессию мог назвать
    // и эвристический разбор /proc, который процесс так и не нашёл.
    if (row.live && row.pid) {
      if ((caps || {}).reptyr) return 'reptyr';
      if ((caps || {}).takeover) return 'takeover';
    }
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
      // `exec` не для красоты: он делает reptyr единственным процессом своей
      // группы. Без него шелл, запущенный ssh, остаётся рядом в той же группе,
      // и следующий перенос этой сессии откажется работать — плоский reptyr
      // отказывается брать цель, у которой есть соседи по группе процессов.
      // Почему следующий перенос целится в reptyr, а не в сессию, — см.
      // buildAttachCommand и docs/reptyr-experiment.md.
      remote = `exec reptyr -T ${Number(row.pid)}`;
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

  /**
   * Команда, которой человек сам переклеит сессию в свой терминал.
   *
   * Без `sudo`: он бы всё сломал. sudo 1.9.14+ обязательно заводит себе
   * отдельный pty, и сессия уехала бы в него, а не в терминал человека.
   * Работать `reptyr` без root позволяют file capabilities на бинаре, их надо
   * выдать один раз (см. docs/reptyr-experiment.md):
   *
   *     sudo setcap 'cap_sys_ptrace,cap_dac_read_search+ep' /usr/bin/reptyr
   *
   * Обе нужны: первая снимает запрет ptrace на sshd, вторая даёт прочитать
   * его /proc/<pid>/fd, где лежит дескриптор мастера pty.
   *
   * Вставлять надо в терминал **на той машине** и именно в тот, куда сессия
   * должна переехать: reptyr тянет процесс к своему tty.
   *
   * Половина после `||` — про второй и последующие переносы той же сессии.
   * `-T` умеет искать мастер pty ровно в одном месте: у процесса, которого он
   * считает эмулятором терминала (родитель лидера сессии, обычно sshd). Первая
   * же кража **выносит** этот дескриптор оттуда к себе, поэтому второй `-T`
   * приходит на то же место и не находит ничего:
   *
   *     [-] Unable to find the fd for the pty!
   *     Unable to attach to pid 42: No such process
   *
   * («No such process» здесь врёт: сессия жива, это остаточный errno.)
   * Мастер при этом никуда не делся — он у первого reptyr, а тот сессии не
   * родственник, и по родословной его не найти. Зато его можно перенести
   * самого: плоский `reptyr <pid первого reptyr>` уводит проксирующий процесс
   * в новый терминал, а сессия едет следом. Разбор — docs/reptyr-experiment.md.
   *
   * `pgrep -x -f` сверяет **всю** командную строку целиком, поэтому шаблон
   * находит именно первый reptyr: у сменившего его плоского аргументы другие.
   * Это же делает команду годной для любого по счёту переноса — она сама
   * выбирает, первый он или нет.
   *
   * Пустая строка вместо команды у сессии без pid: тянуть нечего, а команда с
   * `NaN` внутри выглядела бы рабочей.
   */
  function buildAttachCommand(row) {
    const pid = Number((row || {}).pid);
    if (!Number.isInteger(pid) || pid <= 0) return '';
    const first = `reptyr -T ${pid}`;
    return `${first} || reptyr "$(pgrep -x -f ${q(first)} | head -1)"`;
  }

  // q отдаётся наружу не для красоты: это единственный барьер между путём,
  // который придумал человек, и шеллом на той стороне ssh. Всякий, кому нужно
  // собрать удалённую команду (проектные хоткеи в sessions.html), обязан звать
  // именно её, а не писать replace по месту — второй экземпляр этого правила
  // рано или поздно разойдётся с первым.
  return { q, chooseOpenStrategy, buildOpenCommand, buildAttachCommand };
});
