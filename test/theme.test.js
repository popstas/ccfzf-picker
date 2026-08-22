const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');

const THEME_CSS = read('frontend-src/theme.css');
const SESSIONS_HTML = read('sessions.html');
const SETTINGS_HTML = read('settings.html');
const MAIN_RS = read('src-tauri/src/main.rs');

const { THEMES } = require('../frontend-src/config-shape');

/** Тело правила, начинающегося названным селектором. */
function block(css, selector) {
  const at = css.indexOf(selector);
  assert.notStrictEqual(at, -1, `${selector} пропал из theme.css — тест сторожит не то`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

/** Имена и значения переменных, объявленных в теле правила. */
function tokens(body) {
  const out = new Map();
  for (const [, name, value] of body.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) {
    out.set(name, value.trim());
  }
  return out;
}

const DARK = tokens(block(THEME_CSS, ':root {'));
const SYSTEM_LIGHT = tokens(block(THEME_CSS, ':root:not([data-theme="dark"]) {'));
const FORCED_LIGHT = tokens(block(THEME_CSS, ':root[data-theme="light"] {'));

// Токен без светлой пары унаследовал бы тёмное значение и стал бы нечитаем —
// тёмно-серая подпись на белом. Поведением такое не поймать вовсе: страница
// рисуется, ошибок нет, просто одна колонка пропала с глаз.
test('у каждого тёмного токена есть светлая пара', () => {
  assert.ok(DARK.size > 15, 'тёмная палитра подозрительно мала — тест сторожит не то');
  for (const name of DARK.keys()) {
    assert.ok(FORCED_LIGHT.has(name), `${name} объявлен только в тёмной палитре`);
  }
});

// Светлая половина написана дважды — под медиазапросом («as system») и под
// атрибутом («light»), — и разъехаться им нельзя: тогда одна и та же светлая
// тема выглядела бы по-разному в зависимости от того, выбрана она человеком
// или взята у системы.
test('обе светлые половины совпадают', () => {
  assert.deepStrictEqual(
    Object.fromEntries(SYSTEM_LIGHT),
    Object.fromEntries(FORCED_LIGHT),
    'светлая палитра под медиазапросом разошлась со светлой под атрибутом',
  );
});

// `color-scheme` ведёт скроллбары и системные контролы. Забудь его в светлой
// половине — и на белой странице останется тёмная полоса прокрутки.
test('color-scheme объявлен во всех трёх блоках', () => {
  assert.strictEqual(DARK.get('color-scheme'), undefined, 'color-scheme не переменная');
  for (const selector of [':root {', ':root:not([data-theme="dark"]) {', ':root[data-theme="light"] {']) {
    assert.match(block(THEME_CSS, selector), /color-scheme:/, `${selector} без color-scheme`);
  }
});

// Цвет, дописанный литералом мимо палитры, светлую тему сломает молча: в
// тёмной он будет верен, а увидеть его на светлой можно только глазами и
// только на той машине, где пикер стоит.
test('в стилях страниц нет сырых цветов', () => {
  for (const [name, html] of [['sessions.html', SESSIONS_HTML], ['settings.html', SETTINGS_HTML]]) {
    const style = html.split('<style>')[1].split('</style>')[0];
    const raw = [...style.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map(m => m[0]);
    assert.deepStrictEqual(raw, [], `${name}: цвет мимо палитры — светлая тема его не увидит`);
  }
});

// Палитра — отдельный файл, и обе страницы обязаны его подключать. Забытый
// `<link>` даёт окно, у которого не разрешается ни одна переменная: фон,
// текст и рамки становятся прозрачными разом.
test('обе страницы подключают палитру', () => {
  for (const [name, html] of [['sessions.html', SESSIONS_HTML], ['settings.html', SETTINGS_HTML]]) {
    assert.match(html, /<link rel="stylesheet" href="theme\.css">/, `${name} без палитры`);
  }
  assert.match(
    read('scripts/prepare-frontend.js'),
    /'frontend-src\/theme\.css'/,
    'theme.css не копируется в frontend/ — в бинарь уедет страница без цветов',
  );
});

// `system` — это **снятый** атрибут, а не третье его значение: светлую
// половину при нём включает медиазапрос. Поставь страница `data-theme="system"`
// — и ни одно правило палитры не совпало бы, окно осталось бы тёмным на
// светлой системе.
test('system снимает атрибут, а не ставит третье значение', () => {
  assert.ok(!THEME_CSS.includes('data-theme="system"'), 'в палитре не должно быть правила для system');
  for (const [name, html] of [['sessions.html', SESSIONS_HTML], ['settings.html', SETTINGS_HTML]]) {
    assert.match(
      html,
      /if \(theme === 'system'\) delete root\.dataset\.theme;/,
      `${name}: applyTheme обязан снимать атрибут на system`,
    );
  }
});

// Три списка одних и тех же слов: разбор конфига, выпадашка окна настроек и
// таблица в Rust, ставящая тему до загрузки страницы. Разойдись они — окно
// ответило бы «saved», а тема не сменилась бы; ответа у этой дороги нет.
test('списки тем совпадают во всех трёх местах', () => {
  const form = [...read('frontend-src/settings-form.js')
    .split('const THEMES = [')[1].split('];')[0]
    .matchAll(/\{ value: '([a-z]+)', label: '([^']+)' \}/g)];
  const rust = [...MAIN_RS
    .split('const THEMES: [(&str, &str); 3] = [')[1].split('];')[0]
    .matchAll(/\("([a-z]+)", "([^"]+)"\)/g)];

  assert.deepStrictEqual(form.map(m => m[1]), THEMES, 'выпадашка разошлась с разбором конфига');
  assert.deepStrictEqual(rust.map(m => m[1]), THEMES, 'таблица в Rust разошлась с разбором конфига');
  assert.deepStrictEqual(
    rust.map(m => m[2]),
    form.map(m => m[2]),
    'подписи в Rust и в окне настроек разошлись',
  );
});

// Значение уезжает в исходный текст страницы `initialization_script`-ом:
// просеивание тут и есть вся защита, а чужое слово в нём было бы дырой.
test('theme_script отдаёт только просеянные слова', () => {
  const fn = MAIN_RS.split('fn theme_script(')[1].split('\n}\n')[0];
  const emitted = [...fn.matchAll(/window\.__THEME__ = '([a-z]+)';/g)].map(m => m[1]);
  assert.deepStrictEqual(emitted, ['dark', 'light'], 'скрипт темы обязан знать ровно два слова');
  assert.match(fn, /config_choice\(config, "theme", "system", &THEMES\)/, 'значение обязано просеиваться');
});

// Умолчание — `system`, и назвать его обязаны все трое: иначе пикер, окно
// настроек и Rust разошлись бы в том, что делать с отсутствующим ключом.
test('умолчание темы — system', () => {
  const { DEFAULTS } = require('../frontend-src/config-shape');
  assert.strictEqual(DEFAULTS.theme, 'system');
  assert.match(
    read('frontend-src/settings-form.js'),
    /\{ id: 'theme', label: 'Theme', type: 'choice', default: 'system',/,
    'поле формы обязано знать то же умолчание',
  );
  assert.match(MAIN_RS, /config_choice\(config, "theme", "system"/, 'Rust обязан знать то же умолчание');
});
