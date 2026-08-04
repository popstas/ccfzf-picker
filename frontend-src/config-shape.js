// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ConfigShape = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULTS = {
    sshHost: 'example-host',
    hotkey: 'Cmd+Shift+T',
    terminal: { file: 'open', args: ['-na', 'kitty', '--args'] },
    // false, хотя опыт признал reptyr пригодным: умолчание отвечает на вопрос
    // «что делать, когда про ту сторону ничего не известно», а не «работает ли
    // reptyr на example-host». Без конфига хост может быть любым, и `reptyr -T`
    // упал бы там, где его не установили. Вердикт опыта живёт в config.yaml.
    caps: { reptyr: false },
  };

  /**
   * Конфиг с проставленными умолчаниями.
   *
   * Правило одно: испорченная запись выбрасывается, а не роняет весь файл.
   * Пикер без одного проектного хоткея работает; пикер, который не открылся
   * из-за опечатки в yaml, — нет.
   */
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
      caps: { reptyr: Boolean((src.caps || {}).reptyr) },
      projects,
    };
  }

  return { DEFAULTS, normalizeConfig };
});
