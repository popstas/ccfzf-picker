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
   * Страница `columns` полей не имеет: она правит ui.json, а не config.yaml, и
   * рисуется своим кодом в settings.html — таблицей галок по двум осям.
   */
  /**
   * Размеры окна на выбор, одним списком на все четыре стороны.
   *
   * Ноль — «встроенный размер», то есть 900×640 из `tauri.conf.json` в узкой
   * раскладке и зажатые по экрану 1400×900 в широкой. Он первым и он же
   * умолчание: ключа в `config.yaml` у большинства нет вовсе, и список,
   * начинающийся с доли экрана, обещал бы, что размер уже настроен.
   *
   * Доли считаются от экрана, а не от встроенного размера: вопрос у человека
   * не «во сколько раз больше», а «сколько сессий влезет», и на разных
   * машинах ответ разный. Считает их Rust (`wanted_size` в main.rs) — у окна
   * нет декораций, и `window.resizeTo` на нём не работает вовсе.
   *
   * Пять долей, а не десять: список, по которому надо водить глазами, хуже
   * короткого, а разницу между 80% и 85% на глаз не увидеть. 100 — тоже доля
   * экрана (`scale_axis` в Rust), а не `set_fullscreen`: панель задач и вырез
   * у Mac никуда не деваются, окно просто занимает весь оставшийся прямоугольник.
   *
   * Значение вне этого списка — пиксели, ≥101 (см. `normalizePickerSize` в
   * config-shape.js) — задаются не радиокнопкой, а соседним числовым полем;
   * это уже не выбор из перечисленных долей, и лишнего пункта список ради
   * него не заводит.
   */
  const SIZE_CHOICES = [
    { value: 0, label: 'Default' },
    { value: 50, label: '50%' },
    { value: 65, label: '65%' },
    { value: 80, label: '80%' },
    { value: 95, label: '95%' },
    { value: 100, label: '100%' },
  ];

  const PAGES = [
    {
      id: 'general',
      title: 'General',
      fields: [
        { id: 'sshHost', label: 'Host with sessions', type: 'text',
          hint: 'Any form ssh understands. Without it there is nowhere to get the list from.' },
        { id: 'localSource', label: 'Also show sessions from this machine', type: 'bool',
          default: false,
          hint: 'Runs ccfzf here, without ssh. Linux and macOS only.' },
        // Не поле конфига, а помощник к двум следующим: подставляет в них
        // путь и аргументы разом. Своего ключа у него нет намеренно — второй
        // источник правды разошёлся бы с полями, которые правят руками, и
        // выпадашка обещала бы iTerm2 там, где в поле стоит kitty. Что выбрано,
        // считается обратно по содержимому полей (`matchPreset`).
        { id: 'terminalPreset', label: 'Terminal preset', type: 'preset',
          hint: 'Fills in the path and the arguments below. '
            + 'The arguments differ per terminal, so pick one before editing by hand.' },
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
        { id: 'windowHost', label: 'Name of this machine', type: 'text',
          hint: 'Matches the host on a session window — Enter raises it.' },
      ],
    },
    {
      id: 'stale',
      title: 'Dim stale sessions',
      fields: [
        { id: 'stale.enabled', label: 'Dim stale sessions and projects',
          type: 'bool', default: false },
        { id: 'stale.sessionHours', label: 'Sessions become stale after, hours',
          type: 'number', default: 2 },
        { id: 'stale.projectHours', label: 'Projects become stale after, hours',
          type: 'number', default: 24 },
        { id: 'stale.opacity', label: 'Stale opacity', type: 'range', default: 0.5,
          min: 0.1, max: 1, step: 0.1,
          hint: 'From 0.1 (very dim) to 1.0 (fully opaque).' },
      ],
    },
    {
      id: 'window',
      title: 'Window popup',
      fields: [
        { id: 'pickerSize.narrow.width', label: 'List width', type: 'size',
          options: SIZE_CHOICES },
        { id: 'pickerSize.narrow.height', label: 'List height', type: 'size',
          options: SIZE_CHOICES,
          hint: 'A share of the screen fits more sessions on a big display. '
            + 'Default is the built-in size, the same on every screen.' },
        { id: 'pickerSize.wide.width', label: 'Wide mode width', type: 'size',
          options: SIZE_CHOICES },
        { id: 'pickerSize.wide.height', label: 'Wide mode height', type: 'size',
          options: SIZE_CHOICES,
          hint: 'Wide mode is the one Ctrl+F switches to.' },
        // После полей размера, не на отдельной странице: подложка отвечает
        // на тот же вопрос «каким видеть окно», что и сам размер. Ставит её
        // нативное окно (`scrim.rs`), а не страница — эти два поля решают
        // только, звать ли его, порознь для каждой раскладки.
        { id: 'scrim.narrow', label: 'Dim the desktop behind the list', type: 'bool' },
        { id: 'scrim.wide', label: 'Dim the desktop behind the wide view', type: 'bool' },
      ],
    },
    { id: 'columns', title: 'Columns', fields: [] },
    // Полей у неё нет по той же причине, что и у `columns`: правит она
    // ui.json, а не config.yaml, и рисуется своим кодом в settings.html —
    // таблицей панелей широкого режима.
    { id: 'panels', title: 'Layout panels', fields: [] },
    {
      id: 'hotkeys',
      title: 'Hotkeys',
      fields: [
        { id: 'hotkey', label: 'Show the picker', type: 'hotkey',
          hint: 'Click the field and press the combination.' },
        { id: 'projectsHotkey', label: 'Show the picker on projects', type: 'hotkey',
          hint: 'Leave empty for the built-in one: Win+Shift+F10 on Windows, '
            + 'Option+Cmd+Shift+C on a Mac.' },
        { id: 'tileHotkey', label: 'Tile the windows on this machine', type: 'hotkey',
          hint: 'Asks the window tracker for the tile layout, in the order of this list. '
            + 'Leave empty for the built-in one: Ctrl+Win+F10 on Windows, '
            + 'Ctrl+Option+Cmd+C on a Mac.' },
      ],
    },
    {
      id: 'mqtt',
      title: 'MQTT',
      fields: [
        { id: 'mqtt.host', label: 'MQTT broker', type: 'text' },
        { id: 'mqtt.port', label: 'Broker port', type: 'number' },
        { id: 'mqtt.user', label: 'User', type: 'text' },
        { id: 'mqtt.password', label: 'Password', type: 'password',
          hint: 'Empty means keep the current one.' },
        { id: 'mqtt.base', label: 'Topic prefix', type: 'text' },
      ],
    },
    {
      id: 'paths',
      title: 'Paths',
      fields: [
        { id: 'pathMap.remote', label: 'Directory on the remote host', type: 'text' },
        { id: 'pathMap.local', label: 'The same one here', type: 'text' },
        // Стоит на этой вкладке, а не на своей: пункты «Open plan» и «Open
        // spec» работают только вместе с картой путей — файл лежит на
        // удалённой машине, и без перевода открывать нечего. Рядом человек и
        // увидит, почему поле есть, а пункты не появляются.
        { id: 'editor', label: 'Editor for specs and plans', type: 'text',
          hint: 'Empty means cursor. On macOS a bare name opens the matching '
            + 'application; write a full path to run a program directly.' },
      ],
    },
    // Полей у неё нет по той же причине, что у `columns` и `panels`: она
    // ничего не правит в config.yaml, а показывает буфер строк лога, и
    // рисуется своим кодом в settings.html.
    //
    // Заведена затем, что запущенный из ярлыка (или из `.app`) пикер stderr
    // отдаёт некуда, и на вопрос «почему пикер притих» смотреть было не во
    // что: ни файла лога, ни буфера в памяти.
    { id: 'log', title: 'Log', fields: [] },
  ];

  // Помощники (`preset`) в список полей не входят: своего ключа в конфиге у них
// нет, и `configToFields`/`fieldsToPatch` полезли бы за значением, которого не
// существует, а патч унёс бы в config.yaml выдуманный ключ.
const FIELDS = PAGES.flatMap(page => page.fields).filter(field => field.type !== 'preset');

  // Глобальные хоткеи — те три, что вешает Rust. Список считается из самой
  // страницы, а не пишется вторым рядом: разойдись он с полями, проверка на
  // занятую комбинацию молча пропустила бы одну из клавиш, а молчащий хоткей
  // читается как сломанный конфиг — здесь за это уже заплачено полднём
  // расследования (`Ctrl+F11` в `project_hotkeys.rs`).
  //
  // Отбор по типу, а не «все поля вкладки»: рядом с клавишами на ней стоят
  // выпадашки действий мыши, и попади они сюда, форма проверяла бы `tile` на
  // занятую комбинацию и на совпадение с хоткеем.
  const GLOBAL_HOTKEYS = (PAGES.find(page => page.id === 'hotkeys') || { fields: [] })
    .fields.filter(field => field.type === 'hotkey').map(field => field.id);

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
    if (field.type === 'number' || field.type === 'range') {
      return field.default === undefined ? '' : field.default;
    }
    // Ноль, а не пустая строка: у выбора нет состояния «не заполнено» — первый
    // пункт списка и есть умолчание, и отсутствующий ключ обязан показать
    // именно его. Отступление для высоты (65 вместо 0) не отсюда — оно
    // приписывается только в экспортируемой `configToFields`, см. её
    // комментарий: эта же функция служит базой для `fieldsToPatch`.
    if (field.type === 'size') return 0;
    return '';
  }

  /** Значение конфига в том виде, в каком его держит поле формы. */
  function toField(field, value) {
    // Пароль в форму не кладётся вовсе: он ездил бы через мост в webview на
    // каждое открытие настроек, а показывать его незачем. Пустое поле значит
    // «оставить прежний» — так и написано в подсказке.
    if (field.type === 'password') return '';
    if (value === undefined || value === null) return emptyFor(field);
    if (field.type === 'bool') {
      if (field.id === 'stale.enabled') {
        return typeof value === 'boolean' ? value : emptyFor(field);
      }
      return Boolean(value);
    }
    if (field.type === 'lines') return (Array.isArray(value) ? value : []).join('\n');
    // Число, а не строка: значение из конфига сравнивается с тем, что отдаёт
    // радиокнопка или числовое поле пикселей (оба всегда строка), и оба конца
    // приводит `fromField` — но показанный выбор ищется по этому значению, и
    // `'80' !== 80` не отметил бы совпавшую радиокнопку.
    if (field.type === 'size') {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
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
    if (field.type === 'number' || field.type === 'range') {
      // Пустая (или из пробелов) строка — это «не трогали», а не число 0:
      // `Number('')` даёт 0, и без этой проверки стёртое поле порта тихо
      // сохранилось бы как mqtt.port: 0 — недопустимый порт брокера.
      const trimmed = String(value == null ? '' : value).trim();
      if (!trimmed) return undefined;
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : undefined;
    }
    if (field.type === 'bool') return Boolean(value);
    // Размер ложится в конфиг числом — долей экрана или пикселями, граница
    // между ними (0, 1–100, ≥101) не здесь, её сторожит `validate`. Нечисло —
    // «не трогали»: значило бы вписать человеку в config.yaml то, чего он не
    // набирал. Значения 1–100, набранные в поле пикселей, форма сюда не
    // доводит вовсе — их отсекает сама разметка страницы (fieldHtml), не
    // давая записать `fields[id]`; сравнивать их здесь было бы нечем — та же
    // строка "50" приходит что от радиокнопки, что от поля пикселей.
    if (field.type === 'size') {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    return String(value == null ? '' : value);
  }

  /**
   * База конфига в полях формы, без единого отступления: отсутствующий ключ
   * всегда читается через `toField`/`emptyFor`, то есть нулём у размера.
   *
   * Не экспортируется и не зовётся страницей напрямую — это только опора для
   * сравнения в `fieldsToPatch` (см. её комментарий) и для подмены высоты в
   * `configToFields` ниже. Показанная человеку форма подмену уже несёт, а
   * база не должна: сверься `fieldsToPatch` с уже подменённым значением, обе
   * стороны сравнения читали бы одно и то же 65, патч выходил бы пустым, и
   * высота никогда не попала бы в config.yaml, — то есть подмена, задуманная
   * ради видимости, тихо выключила бы саму себя.
   */
  function baselineFields(config) {
    const src = config && typeof config === 'object' ? config : {};
    const fields = {};
    for (const field of FIELDS) fields[field.id] = toField(field, at(src, field.id));
    return fields;
  }

  /**
   * Поля формы из конфига — с одним отступлением: отсутствующая высота
   * узкого и широкого режима показывается как 65% (`SIZE_CHOICES`), а не как
   * Default.
   *
   * Это подсказанное значение, а не то, чем пикер живёт прямо сейчас: при
   * отсутствующем ключе `wanted_size` в main.rs берёт встроенный размер
   * (900×640 узкого, 1400×900 широкого, зажатый по экрану) — не 65% экрана.
   * Показывай форма тут «Default», это выглядело бы честно и было бы
   * неудобно: единственный пункт списка без единого выделенного значения.
   * 65 — рекомендация, которая при этом ведёт себя как настоящее значение
   * поля и потому доезжает до config.yaml вместе с первым же настоящим
   * autosave или Save (см. хвост загрузки в settings.html) — не раньше и не
   * сама по себе. Явный `height: 0` в файле — это Default, записанный
   * намеренно (в том числе самой формой при возврате человеком к встроенному
   * размеру), и превращать его обратно в 65 нельзя. Ширины отступление не
   * касается: «сколько сессий влезет» и «насколько окно широкое» — разные
   * вопросы.
   *
   * Подмена — только тут, а не в `toField`/`baselineFields`: та же логика
   * служит базой для патча, и подставь она 65 туда тоже, сравнение перестало
   * бы что-либо замечать (см. `baselineFields`).
   */
  function configToFields(config) {
    const src = config && typeof config === 'object' ? config : {};
    const fields = baselineFields(config);
    if (at(src, 'pickerSize.narrow.height') === undefined) fields['pickerSize.narrow.height'] = 65;
    if (at(src, 'pickerSize.wide.height') === undefined) fields['pickerSize.wide.height'] = 65;
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
   *
   * База сравнения — `baselineFields`, а не экспортируемая `configToFields`:
   * последняя показывает отсутствующую высоту как 65, и сверься патч с ней
   * же, отсутствующий ключ и показанные 65 читались бы одинаково — патч на
   * реальную запись 65 в файл никогда бы не собрался.
   */
  function fieldsToPatch(fields, original) {
    const before = baselineFields(original);
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
    if (!String(fields.sshHost || '').trim() && !fields.localSource) {
      // Текст дословно тот же, что и в poller.rs и sessions.html, —
      // намеренно: разная формулировка одной и той же беды читалась бы как
      // две разных.
      problems.push('no source: set the host with sessions, or turn on sessions from this machine');
    }
    // Три глобальных хоткея проверяются одним проходом, а не тремя копиями
    // подряд: копий было две, и с третьей клавишей забыть одну из них стало
    // делом времени — а забытая молчит.
    const globals = GLOBAL_HOTKEYS.map(id => String(fields[id] || '').trim());
    for (const combo of globals) {
      // isReserved, а не свой разбор строки: комбинации, которые окно пикера
      // забирает себе, перечислены там, и второй список разошёлся бы с первым.
      if (combo && hotkeyApi.isReserved(hotkeyApi.parseHotkey(combo))) {
        problems.push(`${combo} is taken by the picker window itself — inside it, it will not respond`);
      }
    }
    // Две одинаковые комбинации — это молчащая вторая: система отдаёт
    // сочетание одному слушателю, и второй регистрируется отказом. Отказ
    // виден в трее, но сказать о нём здесь дешевле, чем отправлять человека
    // туда искать.
    for (let i = 0; i < globals.length; i += 1) {
      for (let j = i + 1; j < globals.length; j += 1) {
        if (!globals[i] || !globals[j]) continue;
        if (globals[i].toLowerCase() !== globals[j].toLowerCase()) continue;
        problems.push(`${globals[i]} is set for two hotkeys — only one of them will work`);
      }
    }
    const validNumber = (id, min, max, message) => {
      // Частичные вызовы validate в тестах старых полей не обязаны знать про
      // новое поле; настоящая форма всегда передаёт все четыре stale-ключа.
      if (fields[id] === undefined) return;
      const raw = fields[id];
      const numeric = typeof raw === 'number'
        || (typeof raw === 'string' && raw.trim());
      const value = numeric ? Number(raw) : NaN;
      if (!Number.isFinite(value) || value < min || value > max) {
        problems.push(`${id} ${message}`);
      }
    };
    validNumber('stale.sessionHours', Number.MIN_VALUE, Infinity, 'must be greater than 0');
    validNumber('stale.projectHours', Number.MIN_VALUE, Infinity, 'must be greater than 0');
    validNumber('stale.opacity', 0.1, 1, 'must be between 0.1 and 1.0');
    // Размер: 0 (Default), 1–100 (доля экрана) или ≥101 (пиксели) — тот же
    // диапазон, что и у `normalizePickerSize` в config-shape.js, и он же
    // обязан совпасть с тем, что принимает `scale_axis` в Rust (иначе форма
    // пропустила бы значение, которое Rust молча отклонит, — окно вышло бы
    // не того размера без единого объяснения на экране). Своя, не
    // `validNumber`: у той один сплошной [min, max], а здесь две дыры —
    // дробная доля меньше единицы (не значит ничего ни как процент, ни как
    // пиксели) и зазор `(100..101)` между долей и пикселями (не дотягивает
    // ни до сотни процентов, ни до сотни первого пикселя).
    for (const field of FIELDS) {
      if (field.type !== 'size') continue;
      if (fields[field.id] === undefined) continue;
      const raw = fields[field.id];
      const numeric = typeof raw === 'number' || (typeof raw === 'string' && raw.trim());
      const value = numeric ? Number(raw) : NaN;
      const inGap = value > 100 && value < 101;
      if (!Number.isFinite(value) || (value !== 0 && value < 1) || inGap) {
        problems.push(`${field.id} must be 0 (Default), 1-100 (percent of screen), or 101 or more (pixels)`);
      }
    }
    return problems;
  }

  return { PAGES, configToFields, fieldsToPatch, validate };
});
