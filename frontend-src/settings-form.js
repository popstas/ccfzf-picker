// Loaded twice: as a <script> in settings.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SettingsForm = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся.
  const hotkeyApi = typeof module === 'object' && module.exports
    ? require('./action-hotkey')
    : globalThis.ActionHotkey;

  /**
   * Страницы настроек и поля на них.
   *
   * Одна таблица на всё: по ней страница рисуется, по ней же собирается патч.
   * Поле, попавшее на две страницы, означало бы два источника правды для
   * одного ключа — сохранив одну страницу, человек молча откатил бы вторую;
   * это сторожит тест.
   *
   * `id` поля — это путь в конфиге через точку. Разбор пути тут же, ниже:
   * заводить ради двух уровней вложенности схему было бы дороже.
   *
   * Страница `ui` полей не имеет: она правит ui.json, а не config.yaml, и
   * рисуется своим кодом в settings.html — таблицей галок по двум осям.
   */
  const PAGES = [
    {
      id: 'general',
      title: 'General',
      fields: [
        { id: 'sshHost', label: 'Host with sessions', type: 'text',
          hint: 'Any form ssh understands. Without it there is nowhere to get the list from.' },
        { id: 'terminal.file', label: 'Terminal', type: 'text' },
        { id: 'terminal.args', label: 'Terminal arguments', type: 'lines',
          hint: 'One per line — a comma occurs inside the arguments themselves.' },
        { id: 'onlyLive', label: 'Only running sessions', type: 'bool', default: true },
        { id: 'hideOnBlur', label: 'Hide the window when it loses focus', type: 'bool', default: true },
        { id: 'backgroundRefresh', label: 'Keep polling while the window is closed', type: 'bool',
          default: true,
          hint: 'Keeps the aggregator dump fresh: the openHASP panel lives off it.' },
        { id: 'caps.reptyr', label: 'Allow moving the process (reptyr)', type: 'bool' },
        { id: 'caps.takeover', label: 'Allow taking a session over', type: 'bool' },
      ],
    },
    { id: 'ui', title: 'UI', fields: [] },
    {
      id: 'hotkeys',
      title: 'Hotkeys',
      fields: [
        { id: 'hotkey', label: 'Show the picker', type: 'text',
          hint: 'SUPER is Cmd on a Mac and Win on Windows.' },
      ],
    },
    {
      id: 'integrations',
      title: 'Integrations',
      fields: [
        { id: 'windowHost', label: 'Name of this machine', type: 'text',
          hint: 'Matches windowHost from the reply — Enter raises the window.' },
        { id: 'mqtt.host', label: 'MQTT broker', type: 'text' },
        { id: 'mqtt.port', label: 'Broker port', type: 'number' },
        { id: 'mqtt.user', label: 'User', type: 'text' },
        { id: 'mqtt.password', label: 'Password', type: 'password',
          hint: 'Empty means keep the current one.' },
        { id: 'mqtt.base', label: 'Topic prefix', type: 'text' },
        { id: 'pathMap.remote', label: 'Directory on the remote host', type: 'text' },
        { id: 'pathMap.local', label: 'The same one here', type: 'text' },
      ],
    },
  ];

  const FIELDS = PAGES.flatMap(page => page.fields);

  function at(source, path) {
    return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), source);
  }

  function put(target, path, value) {
    const keys = path.split('.');
    let node = target;
    for (const key of keys.slice(0, -1)) {
      if (!node[key] || typeof node[key] !== 'object') node[key] = {};
      node = node[key];
    }
    node[keys[keys.length - 1]] = value;
  }

  /**
   * Чем поле заполняется, когда ключа в конфиге нет.
   *
   * У `bool` это `field.default`, а не `false`: `onlyLive`, `hideOnBlur` и
   * `backgroundRefresh` при отсутствии ключа считаются включёнными — так их
   * читают и `DEFAULTS` в config-shape.js, и Rust через `unwrap_or(true)`.
   * Пустая галка показывала бы выключенным то, что работает включённым, и
   * проверить это можно было бы только по поведению пикера.
   *
   * Умолчание объявлено здесь, а не взято из `normalizeConfig`: та подставила
   * бы заодно и остальные — писанные под macOS (`terminal.file` — kitty), — и
   * первое же сохранение вписало бы их человеку в config.yaml.
   */
  function emptyFor(field) {
    if (field.type === 'bool') return Boolean(field.default);
    if (field.type === 'number') return '';
    return '';
  }

  /** Значение конфига в том виде, в каком его держит поле формы. */
  function toField(field, value) {
    // Пароль в форму не кладётся вовсе: он ездил бы через мост в webview на
    // каждое открытие настроек, а показывать его незачем. Пустое поле значит
    // «оставить прежний» — так и написано в подсказке.
    if (field.type === 'password') return '';
    if (value === undefined || value === null) return emptyFor(field);
    if (field.type === 'bool') return Boolean(value);
    if (field.type === 'lines') return (Array.isArray(value) ? value : []).join('\n');
    return value;
  }

  /** Значение поля формы в том виде, в каком оно ложится в конфиг. */
  function fromField(field, value) {
    if (field.type === 'lines') {
      return String(value == null ? '' : value)
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);
    }
    if (field.type === 'number') {
      // Пустая (или из пробелов) строка — это «не трогали», а не число 0:
      // `Number('')` даёт 0, и без этой проверки стёртое поле порта тихо
      // сохранилось бы как mqtt.port: 0 — недопустимый порт брокера.
      const trimmed = String(value == null ? '' : value).trim();
      if (!trimmed) return undefined;
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : undefined;
    }
    if (field.type === 'bool') return Boolean(value);
    return String(value == null ? '' : value);
  }

  function configToFields(config) {
    const src = config && typeof config === 'object' ? config : {};
    const fields = {};
    for (const field of FIELDS) fields[field.id] = toField(field, at(src, field.id));
    return fields;
  }

  /**
   * Патч: только то, что человек и правда поменял.
   *
   * Не весь конфиг, потому что окно знает не про все ключи, и не «всё, что
   * есть в форме», потому что пустой пароль значит «оставить прежний», а не
   * «стереть». Стёртый пароль брокера заметить можно только по молчащему
   * Enter на чужой машине.
   *
   * Договор по типам: `fields` может нести значения в любом виде, какой
   * отдаёт вызывающая сторона, — «родном» (число, bool, массив, как из
   * `configToFields`) или строковом (как `value` у любого элемента формы в
   * DOM, включая `<input type="number">` — там оно строка всегда). Функции
   * это безразлично, потому что и текущее значение, и то, с чем оно
   * сравнивается, пропускаются через один и тот же `fromField` — сравнение
   * идёт по итогу приведения, а не по сырым типам. Без этого `"1883"` от
   * DOM и сохранённое число `1883` считались бы разным значением, и
   * нетронутое поле каждый раз попадало бы в патч.
   */
  function fieldsToPatch(fields, original) {
    const before = configToFields(original);
    const patch = {};
    for (const field of FIELDS) {
      const value = fields[field.id];
      if (field.type === 'password') {
        if (String(value || '')) put(patch, field.id, String(value));
        continue;
      }
      const converted = fromField(field, value);
      if (converted === undefined) continue;
      const convertedBefore = fromField(field, before[field.id]);
      if (JSON.stringify(converted) === JSON.stringify(convertedBefore)) continue;
      put(patch, field.id, converted);
    }
    return patch;
  }

  /**
   * Что не даст сохранить.
   *
   * Проверки те же, что уже стоят на пути конфига, и переписывать их здесь
   * нельзя: разойдясь, форма разрешила бы то, что пикер потом молча выбросит.
   * Отсюда и список — два случая, каждый из которых иначе виден только
   * пальцами: неработающий список, неотзывающаяся клавиша.
   */
  function validate(fields) {
    const problems = [];
    if (!String(fields.sshHost || '').trim()) {
      problems.push('sshHost is not set: there is nowhere to get the list from');
    }
    const hotkey = String(fields.hotkey || '').trim();
    // isReserved, а не свой разбор строки: комбинации, которые окно пикера
    // забирает себе, перечислены там, и второй список разошёлся бы с первым.
    if (hotkey && hotkeyApi.isReserved(hotkeyApi.parseHotkey(hotkey))) {
      problems.push(`${hotkey} is taken by the picker window itself — inside it, it will not respond`);
    }
    return problems;
  }

  return { PAGES, configToFields, fieldsToPatch, validate };
});
