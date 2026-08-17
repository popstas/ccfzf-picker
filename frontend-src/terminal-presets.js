/** Готовые терминалы для окна настроек: путь и аргументы одним выбором. */
// Loaded twice: as a <script> in settings.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TerminalPresets = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Пункт «своё»: путь и аргументы человек пишет руками.
   *
   * Пресеты полей не заменяют, а заполняют: путь у всех разный, и один
   * homebrew на arm и на intel даёт два разных префикса. Поэтому «Custom» —
   * не режим, а признак того, что набранное не совпало ни с одним пресетом.
   */
  const CUSTOM = 'custom';

  /**
   * Терминалы, для которых известны и путь, и аргументы.
   *
   * Аргументы у каждого свои, и разница не косметическая: команда собирается
   * одна и та же (`buildOpenCommand`), а берут её терминалы по-разному.
   * kitty исполняет хвост argv как есть — потому давнее умолчание и работало.
   * Ghostty хочет команду после `-e`. Windows Terminal тоже берёт хвост argv.
   * А iTerm2 в argv команду не принимает вовсе: `open -a iTerm` аргументы до
   * программы не доносит, и единственная дорога к нему — AppleScript, где
   * команда обязана быть одной строкой.
   *
   * Кавычек в этой строке iTerm2 не достаётся ни одной, и это главное. Его
   * токенизатор обрабатывает `\` и внутри одинарных кавычек — там, где
   * POSIX-шелл считает его обычным знаком, — и идиома `'\''`, которой `q`
   * закрывает кавычку, у него рассыпается. До ssh доезжала битая команда,
   * падала мгновенно, а профиль по умолчанию закрывает кончившуюся сессию:
   * окно открывалось и тут же исчезало, без единого слова о причине (ответа
   * `osascript` мы не читаем). Измерено на живом маке 2026-08-15.
   *
   * Промежуточный ход — `write text`, печатавший команду в уже поднятую
   * сессию, — работал: разбирал строку шелл сессии, и argv совпадал с sh знак
   * в знак. Но напечатанное **видно**, и первой строкой сессии человек читал
   * простыню экранирования. Отсюда нынешняя форма: iTerm2 получает два токена
   * — путь помощника и base64 команды (`{helper}`, `{commandBase64}` в
   * open-strategy.js), — а разворачивает и кавычит уже шелл. В алфавите
   * base64 нет ни кавычки, ни пробела, ни обратного слэша, так что ломать
   * токенизатору нечего, а печатать в сессию ничего не надо.
   *
   * Окно после сессии держит открытым сам помощник (`exec $SHELL -i` в
   * хвосте): иначе профиль закрыл бы его вместе с агентом, и ошибку снова
   * стало бы не прочитать. Забота та же, что у kitty с `--hold`, только
   * платит за неё здесь помощник, а не флаг терминала.
   *
   * `--single-instance` у kitty — не украшение: `open -n` каждый раз поднимал
   * бы новый экземпляр приложения, а этот флаг отдаёт окно уже запущенному
   * процессу и сразу выходит.
   *
   * `--hold` — «remain open, at a shell prompt, after child process exits»: без
   * него окно закрывается вместе с сессией агента, и прочитать, чем та
   * кончилась, нельзя. Флага `--hide` у kitty нет вовсе, а `--start-as=hidden`
   * прячет окно — то есть делает ровно противоположное; путать их легко, и
   * ошибка эта уже была записана в задачу.
   *
   * Оговорка kitty к `--hold` — «only affects the first window» — с
   * `--single-instance` в одном ряду читается тревожно: второе окно отдаёт уже
   * запущенный экземпляр, и до него флаг может не доехать. Проверять это
   * можно только живьём, здесь ни одного из этих терминалов нет.
   *
   * WezTerm берёт команду хвостом argv, как kitty, — но после `start --`: без
   * `--` его разбор аргументов принял бы `ssh` за свою подкоманду. Пресета два,
   * и разница между ними только в пути: на маке зовётся `wezterm` из бандла
   * приложения, на Windows — `wezterm-gui.exe`, а не `wezterm.exe`, иначе к
   * окну терминала прибавилось бы консольное окно самого запускающего.
   *
   * Имя без каталога — та же форма, что у `wt.exe`, и по той же причине:
   * установщик кладёт WezTerm в PATH, а абсолютный путь тут был бы вымыслом
   * (у msi, portable-распаковки и scoop он разный). Не нашёлся — человек
   * допишет путь в поле руками, пресет для того поля и заполняет.
   *
   * Окно после конца сессии WezTerm закрывает — держать его нечем: флага вроде
   * kitty-шного `--hold` у `wezterm start` нет вовсе, это `exit_behavior` в его
   * собственном конфиге (`~/.wezterm.lua`), то есть настройка человека, а не
   * пресета. Решено оставить как есть: цена — непрочитанная ошибка ssh, та же,
   * что была у kitty до `--hold`.
   *
   * `terminal` — **семейное имя**, и оно не то же самое, что `id`. `id`
   * называет запись этой таблицы (`wezterm` и `wezterm-windows` — две разные,
   * потому что путь разный), а семейное имя называет сам терминал: WezTerm на
   * маке и на Windows зовётся одинаково, а что за именем стоит, знает только
   * принимающая сторона. Уезжает оно в теле просьбы к менеджеру окон
   * (`claude-session-open`), чтобы выбранное в пикере главенствовало и там, где
   * терминал открывает не пикер. Словарь общий с реестром менеджера:
   * `wt`, `wezterm`, `kitty`, `ghostty`, `iterm2`.
   *
   * У «Custom» имени нет и быть не может: набранное руками нам неизвестно, и
   * назови мы его чужим именем — менеджер открыл бы не то, что стоит в поле.
   * Тогда поле в просьбе не едет вовсе, и менеджер берёт свой дефолт.
   *
   * Имя это читает не страница, а Rust (`terminal_name` в `mqtt.rs`): ту же
   * просьбу шлёт проектный хоткей, а у него webview спит. Здесь имя — источник
   * правды, там его копия; сверяет их `test/terminal-name.test.js`.
   */
  const PRESETS = [
    {
      id: 'kitty', label: 'kitty', os: 'macos', terminal: 'kitty',
      file: '/opt/homebrew/bin/kitty', args: ['--single-instance', '--hold'],
    },
    {
      id: 'ghostty', label: 'Ghostty', os: 'macos', terminal: 'ghostty',
      file: '/Applications/Ghostty.app/Contents/MacOS/ghostty', args: ['-e'],
    },
    {
      id: 'iterm2', label: 'iTerm2', os: 'macos', terminal: 'iterm2',
      file: '/usr/bin/osascript',
      args: ['-e', 'tell application "iTerm" to create window with default profile command "{helper} {commandBase64}"'],
    },
    {
      id: 'wezterm', label: 'WezTerm', os: 'macos', terminal: 'wezterm',
      file: '/Applications/WezTerm.app/Contents/MacOS/wezterm', args: ['start', '--'],
    },
    {
      id: 'kitty-linux', label: 'kitty', os: 'linux', terminal: 'kitty',
      file: '/usr/bin/kitty', args: ['--single-instance', '--hold'],
    },
    {
      id: 'ghostty-linux', label: 'Ghostty', os: 'linux', terminal: 'ghostty',
      file: '/usr/bin/ghostty', args: ['-e'],
    },
    {
      id: 'wt', label: 'Windows Terminal', os: 'windows', terminal: 'wt',
      file: 'wt.exe', args: [],
    },
    {
      id: 'wezterm-windows', label: 'WezTerm', os: 'windows', terminal: 'wezterm',
      file: 'wezterm-gui.exe', args: ['start', '--'],
    },
  ];

  /**
   * Имя системы по тому, что видно странице.
   *
   * Спрашивается у navigator, а не у Rust: окно настроек и так рисуется до
   * первой команды, а ошибка здесь стоит неверного списка в выпадашке, а не
   * поломки — поля остаются на месте, и человек допишет путь руками.
   */
  function osOf(platform) {
    const name = String(platform || '').toLowerCase();
    if (name.includes('mac') || name.includes('darwin')) return 'macos';
    if (name.includes('win')) return 'windows';
    return 'linux';
  }

  /** Терминалы своей системы плюс «Custom» последним. */
  function presetsFor(platform) {
    const os = osOf(platform);
    return [
      ...PRESETS.filter(p => p.os === os).map(p => ({ id: p.id, label: p.label })),
      { id: CUSTOM, label: 'Custom' },
    ];
  }

  /** Пресет по id — то, чем заполнить поля. */
  function presetById(id) {
    const found = PRESETS.find(p => p.id === id);
    return found ? { file: found.file, args: [...found.args] } : null;
  }

  /**
   * Какой пресет сейчас выбран.
   *
   * Считается по содержимому полей, а не хранится отдельным ключом конфига:
   * второй источник правды разошёлся бы с полями, которые человек правит
   * руками, и выпадашка обещала бы iTerm2 там, где в поле стоит kitty.
   * Сверяются только свои по системе — чужой путь на этой машине всё равно
   * не работает, и называть его выбранным значило бы врать.
   */
  function matchPreset(terminal, platform) {
    const os = osOf(platform);
    const file = String((terminal || {}).file || '').trim();
    const args = ((terminal || {}).args || []).map(a => String(a));
    const found = PRESETS.find(p => p.os === os && p.file === file
      && p.args.length === args.length && p.args.every((a, i) => a === args[i]));
    return found ? found.id : CUSTOM;
  }

  return { PRESETS, CUSTOM, osOf, presetsFor, presetById, matchPreset };
});
