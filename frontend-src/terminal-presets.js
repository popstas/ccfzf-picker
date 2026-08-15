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
   * команда обязана быть одной строкой. Отсюда `{command}` (см.
   * COMMAND_PLACEHOLDER в open-strategy.js).
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
   */
  const PRESETS = [
    {
      id: 'kitty', label: 'kitty', os: 'macos',
      file: '/opt/homebrew/bin/kitty', args: ['--single-instance', '--hold'],
    },
    {
      id: 'ghostty', label: 'Ghostty', os: 'macos',
      file: '/Applications/Ghostty.app/Contents/MacOS/ghostty', args: ['-e'],
    },
    {
      id: 'iterm2', label: 'iTerm2', os: 'macos',
      file: '/usr/bin/osascript',
      args: ['-e', 'tell application "iTerm" to create window with default profile command "{command}"'],
    },
    {
      id: 'kitty-linux', label: 'kitty', os: 'linux',
      file: '/usr/bin/kitty', args: ['--single-instance', '--hold'],
    },
    {
      id: 'ghostty-linux', label: 'Ghostty', os: 'linux',
      file: '/usr/bin/ghostty', args: ['-e'],
    },
    {
      id: 'wt', label: 'Windows Terminal', os: 'windows',
      file: 'wt.exe', args: [],
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
