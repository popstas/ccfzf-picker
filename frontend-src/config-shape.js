// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ConfigShape = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULTS = {
    // Умолчания нет намеренно: любое значение здесь — либо чужое имя машины,
    // либо ложь. Пустой хост пикер показывает как ненастроенный конфиг.
    sshHost: '',
    hotkey: 'Cmd+Shift+C',
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
    // Оконный трекер: откуда пикер узнаёт, у какой сессии уже открыт терминал.
    // Умолчания нет по той же причине, что и у sshHost, — любое значение здесь
    // было бы чужим именем машины. Пустой url выключает функцию целиком: ни
    // одного запроса, ни одной пометки, список как раньше.
    windowTracker: { url: '' },
    // Брокер MQTT — второй способ попросить о подъёме окна: тот же топик, что
    // уже слушает демон на Windows-машине. Здесь остался один признак «настроен
    // или нет»: сами настройки читает Rust из того же файла, чтобы пароль не
    // ездил через мост в webview на каждое нажатие.
    mqtt: { configured: false },
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

  function normalizeConfig(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const projects = (Array.isArray(src.projects) ? src.projects : [])
      .filter(p => p && typeof p === 'object' && typeof p.path === 'string' && p.path)
      .map(p => ({ path: p.path, hotkey: typeof p.hotkey === 'string' ? p.hotkey : '' }));

    return {
      sshHost: typeof src.sshHost === 'string' && src.sshHost ? src.sshHost : DEFAULTS.sshHost,
      hotkey: typeof src.hotkey === 'string' && src.hotkey ? src.hotkey : DEFAULTS.hotkey,
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
      windowTracker: {
        url: typeof (src.windowTracker || {}).url === 'string'
          ? src.windowTracker.url.trim()
          : DEFAULTS.windowTracker.url,
      },
      // Те же два условия, что и в Rust (`Broker::is_configured`): без адреса
      // публиковать нечем, без префикса топиков — некуда, а угадывать чужой
      // префикс нельзя. Разойтись им не дадут заметно: фронтенд предложил бы
      // ветку, которую Rust тут же отклонил бы с «mqtt не настроен».
      mqtt: { configured: Boolean(nonEmpty((src.mqtt || {}).host) && nonEmpty((src.mqtt || {}).base)) },
      projects,
    };
  }

  return { DEFAULTS, normalizeConfig };
});
