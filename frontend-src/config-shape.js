// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ConfigShape = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся.
  const hotkeyApi = typeof module === 'object' && module.exports
    ? require('./action-hotkey')
    : globalThis.ActionHotkey;

  const DEFAULTS = {
    // Умолчания нет намеренно: любое значение здесь — либо чужое имя машины,
    // либо ложь. Пустой хост пикер показывает как ненастроенный конфиг.
    sshHost: '',
    hotkey: 'Cmd+Shift+C',
    // Пусто, а не комбинация: у второго хоткея умолчание своё на каждой
    // системе (`Win+Shift+F10` против `Option+Cmd+Shift+C`), и одной строкой,
    // как `Super` у первого, они не сходятся. Умолчание живёт в Rust, где
    // видно систему; пустое поле здесь значит «взять встроенное». Запиши сюда
    // одну из двух комбинаций — и окно настроек, сохранившись на другой
    // системе, увезло бы в конфиг чужую клавишу.
    projectsHotkey: '',
    // Прямой запуск бинаря, а не `open -na kitty --args`. Обе формы доводят
    // команду до kitty (проверено), но `open -n` каждый раз поднимает новый
    // экземпляр приложения, а --single-instance отдаёт окно уже запущенному
    // процессу и сразу выходит. Так же kitty зовёт hammerspoon на этой машине.
    terminal: { file: '/opt/homebrew/bin/kitty', args: ['--single-instance'] },
    // Оба false: умолчания отвечают на вопрос «что делать, когда про ту
    // сторону ничего не известно». Без конфига хост может быть любым, `reptyr`
    // там может быть не установлен, а перехват — это чужой процесс под
    // сигналом, и делать такое по умолчанию нельзя. Незнание ведёт к resume:
    // он в худшем случае откроет сессию рядом со своей же копией.
    caps: { reptyr: false, takeover: false },
    // Список из одних работающих сессий. «Работает прямо сейчас» — то, что
    // агрегатор знает наверняка: он видит живые процессы, а не окна
    // терминалов.
    onlyLive: true,
    // Клик мимо окна закрывает пикер. Читает это поле Rust — окно прячет он;
    // здесь оно описано затем же, зачем и остальные: чтобы форма конфига была
    // в одном месте и проверялась одним тестом.
    hideOnBlur: true,
    // Опрос продолжается при закрытом окне. Он не только держит список тёплым
    // к следующему открытию: `ccfzf --state` переписывает свой дамп, а с того
    // дампа живёт экспорт в Home Assistant и панель openHASP. Закрытый пикер,
    // который перестал спрашивать, останавливает и панель.
    //
    // Выключать это стоит там, где панели нет: на маке фон — ssh раз в минуту
    // без выгоды.
    backgroundRefresh: true,
    // Имя машины, на которой работает этот пикер. Сверяется с `windowHost` из
    // ответа агрегатора и отвечает ровно на один вопрос: окна, о которых он
    // рассказал, — на этом экране или на чужом. Совпало — Enter поднимает окно;
    // не совпало — Enter открывает терминал, как раньше, а пометка об окне всё
    // равно видна.
    //
    // Умолчания нет по той же причине, что и у sshHost: любое значение здесь
    // было бы чужим именем машины. Пусто — фокуса не бывает.
    windowHost: '',
    // Брокер MQTT — второй способ попросить о подъёме окна: тот же топик, что
    // уже слушает демон на Windows-машине. Здесь остался один признак «настроен
    // или нет»: сами настройки читает Rust из того же файла, чтобы пароль не
    // ездил через мост в webview на каждое нажатие.
    mqtt: { configured: false },
    // Одно дерево каталогов, видное с двух сторон: слева путь на удалённом
    // хосте, справа — как та же папка примонтирована здесь. Умолчания нет и
    // быть не может: примонтировано у всех по-своему, а угаданный корень увёл
    // бы действия открытия не туда молча. Пусто — действий открытия нет вовсе.
    pathMap: { remote: '', local: '' },
    // Чем открывать папку сессии. Пикер не знает ни одного приложения по
    // имени: он подставляет путь в argv и запускает. Знание «чем открыть
    // папку» принадлежит машине, а не программе — пикер работает и на маке, и
    // на Windows, а конфиг всё равно свой на каждой из них.
    actions: [],
    // Размер окна долями экрана, по стороне на каждую раскладку. Ноль — «взять
    // встроенный размер», и он же умолчание: у большинства ключа нет вовсе.
    //
    // Проценты, а не пиксели: вопрос у человека не «сколько точек», а «сколько
    // сессий влезет», и число, верное на одном экране, на втором значит другое.
    // Ноль, а не отсутствие ключа: удалять ключи `merge_patch` не умеет, он
    // только вставляет, — то есть выбор «Default» после выбора «80%» нечем
    // было бы записать. Считает размер Rust (`wanted_size` в main.rs); здесь
    // ключ описан затем же, зачем и `hideOnBlur`, — чтобы форма конфига была в
    // одном месте и проверялась одним тестом.
    pickerSize: { narrow: { width: 0, height: 0 }, wide: { width: 0, height: 0 } },
  };

  /**
   * Конфиг с проставленными умолчаниями.
   *
   * Правило одно: испорченная запись выбрасывается, а не роняет весь файл.
   * Пикер без одного проектного хоткея работает; пикер, который не открылся
   * из-за опечатки в yaml, — нет.
   */
  function nonEmpty(value) {
    return typeof value === 'string' && value.trim() !== '';
  }

  /** Маппинг годен только целиком: половина пары ведёт в никуда. */
  function normalizePathMap(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    if (!nonEmpty(src.remote) || !nonEmpty(src.local)) return { ...DEFAULTS.pathMap };
    return { remote: src.remote.trim(), local: src.local.trim() };
  }

  /**
   * Действия открытия из конфига.
   *
   * Правило то же, что и у проектных хоткеев: испорченная запись выбрасывается,
   * а не роняет весь файл. Действие без `id` не отличить от соседнего, без
   * `argv` — нечего запускать; такую запись пропускаем целиком.
   *
   * Клавиша — дело отдельное: неразобранная комбинация обнуляется, но само
   * действие остаётся в меню. Опечатка в хоткее не повод прятать пункт, до
   * которого человек и так дойдёт через ^K.
   *
   * Столкновения решаются в одну сторону и всегда одинаково: встроенная
   * клавиша окна выигрывает у настроенной, а из двух настроенных — первая по
   * порядку. Иначе комбинация досталась бы тому, кто ниже в файле, и подпись в
   * меню обещала бы клавишу, которая ведёт в другое место.
   */
  function normalizeActions(raw) {
    const seenIds = new Set();
    const seenHotkeys = new Set();
    const out = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      if (!item || typeof item !== 'object') continue;
      if (!nonEmpty(item.id) || seenIds.has(item.id.trim())) continue;
      const argv = Array.isArray(item.argv) ? item.argv.filter(a => typeof a === 'string') : [];
      if (!argv.length || argv.length !== (item.argv || []).length) continue;

      const id = item.id.trim();
      seenIds.add(id);
      const parsed = hotkeyApi.parseHotkey(item.hotkey);
      // Сверяются разобранные комбинации, а не строки из файла: `Ctrl+Shift+E`
      // и `Shift+Ctrl+E` — одна и та же клавиша, записанная двумя способами.
      const combo = parsed && `${parsed.code}/${parsed.ctrl}${parsed.meta}${parsed.alt}${parsed.shift}`;
      const taken = !parsed || hotkeyApi.isReserved(parsed) || seenHotkeys.has(combo);
      if (!taken) seenHotkeys.add(combo);
      out.push({
        id,
        label: nonEmpty(item.label) ? item.label.trim() : id,
        hotkey: taken ? '' : item.hotkey.trim(),
        parsedHotkey: taken ? null : parsed,
        // Откуда брать иконку пункта. Пусто — берётся argv[0]; ключ нужен
        // там, где argv[0] не приложение: `cmd /c start` у проводника.
        icon: nonEmpty(item.icon) ? item.icon.trim() : '',
        argv,
      });
    }
    return out;
  }

  /**
   * Размер окна долями экрана.
   *
   * Правило то же, что и у соседей: испорченное выбрасывается, а не роняет
   * файл. Годятся числа `1..100`; ноль, мусор и число вне диапазона читаются
   * как «взять встроенный размер» — те же границы, по которым судит
   * `scale_axis` в Rust. Две проверки тут неизбежны (размер ставит Rust,
   * показывает выбор страница), поэтому они и записаны одинаково; сторож
   * сверяет их на общих значениях.
   */
  function normalizePickerSize(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const axis = (half, side) => {
      const value = Number(((src[half] || {}) || {})[side]);
      return Number.isFinite(value) && value >= 1 && value <= 100 ? value : 0;
    };
    return {
      narrow: { width: axis('narrow', 'width'), height: axis('narrow', 'height') },
      wide: { width: axis('wide', 'width'), height: axis('wide', 'height') },
    };
  }

  function normalizeConfig(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};

    return {
      sshHost: typeof src.sshHost === 'string' && src.sshHost ? src.sshHost : DEFAULTS.sshHost,
      hotkey: typeof src.hotkey === 'string' && src.hotkey ? src.hotkey : DEFAULTS.hotkey,
      projectsHotkey: typeof src.projectsHotkey === 'string'
        ? src.projectsHotkey : DEFAULTS.projectsHotkey,
      terminal: src.terminal && typeof src.terminal === 'object' && src.terminal.file
        ? { file: src.terminal.file, args: Array.isArray(src.terminal.args) ? src.terminal.args : [] }
        : DEFAULTS.terminal,
      caps: {
        reptyr: Boolean((src.caps || {}).reptyr),
        takeover: Boolean((src.caps || {}).takeover),
      },
      // Единственное поле, где умолчание true: отсутствие ключа значит «как
      // договорились», а не «показывай две сотни транскриптов».
      onlyLive: typeof src.onlyLive === 'boolean' ? src.onlyLive : DEFAULTS.onlyLive,
      hideOnBlur: typeof src.hideOnBlur === 'boolean' ? src.hideOnBlur : DEFAULTS.hideOnBlur,
      backgroundRefresh: typeof src.backgroundRefresh === 'boolean'
        ? src.backgroundRefresh
        : DEFAULTS.backgroundRefresh,
      windowHost: typeof src.windowHost === 'string'
        ? src.windowHost.trim()
        : DEFAULTS.windowHost,
      // Те же два условия, что и в Rust (`Broker::is_configured`): без адреса
      // публиковать нечем, без префикса топиков — некуда, а угадывать чужой
      // префикс нельзя. Разойтись им не дадут заметно: фронтенд предложил бы
      // ветку, которую Rust тут же отклонил бы с «mqtt не настроен».
      mqtt: { configured: Boolean(nonEmpty((src.mqtt || {}).host) && nonEmpty((src.mqtt || {}).base)) },
      pathMap: normalizePathMap(src.pathMap),
      actions: normalizeActions(src.actions),
      pickerSize: normalizePickerSize(src.pickerSize),
    };
  }

  return { DEFAULTS, normalizeConfig };
});
