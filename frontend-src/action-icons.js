// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ActionIcons = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Значки пунктов, у которых приложения нет.
   *
   * Три знака взяты из строки списка не для красоты: `↗` там помечает PR,
   * `●` оранжевым горит непросмотренная сессия, `▣` — открытое окно. Один и
   * тот же знак в списке и в меню читается как одно и то же дело; разные
   * заставили бы догадываться, что это про одно и то же.
   */
  const GLYPHS = {
    new: { text: '+' },
    info: { text: 'ⓘ' },
    pr: { text: '↗' },
    unread: { text: '●', cls: 'unread' },
    attach: { text: '⧉' },
    'open-remote': { text: '▣' },
  };

  /** Настроенное действие, чей exe не нашёлся: нейтральное «запустить». */
  const FALLBACK = { text: '▸' };

  /**
   * Что спросить у Rust.
   *
   * Список собирает страница, а не Rust: тот умеет ровно «дай иконку этого
   * файла» и про меню не знает ничего. `icon` перевешивает `argv[0]` — он и
   * заведён ради случая, когда argv[0] не приложение (`cmd /c start` у
   * проводника). Пункт `new` в конфиге не описан, но иконку у него взять
   * есть откуда — у агента; нет агента на машине — встанет глиф.
   */
  function iconSpecs(config) {
    const specs = [{ id: 'new', path: 'claude.exe' }];
    for (const action of (config && config.actions) || []) {
      const path = action.icon || (action.argv || [])[0] || '';
      if (path) specs.push({ id: action.id, path });
    }
    return specs;
  }

  /**
   * Значок строки меню: картинка, если она приехала, иначе глиф.
   *
   * Возвращается описание, а не готовый HTML: экранирование живёт на
   * странице, вместе с остальной сборкой строки, — второй escapeHtml здесь
   * разошёлся бы с ним молча.
   */
  function actionIcon(action, icons) {
    const id = (action || {}).id;
    const src = (icons || {})[id];
    if (src) return { kind: 'img', src };
    const glyph = GLYPHS[id] || FALLBACK;
    return { kind: 'glyph', text: glyph.text, cls: glyph.cls || '' };
  }

  return { GLYPHS, iconSpecs, actionIcon };
});
