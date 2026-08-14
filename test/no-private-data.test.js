// Публичный репозиторий: имена машин и домашние пути сюда не возвращаются.
// Имена публичных проектов — возвращаются: объяснение, отсылающее к «соседнему
// репозиторию» без названия, читателю бесполезно. Проверка идёт по
// `git ls-files`, то есть по тому, что реально уедет в публикацию, а не по
// рабочему дереву.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');

// Осознанные исключения.
const ALLOWED = new Set([
  // Bundle id менять нельзя: смена уводит настройки уже установленных копий.
  'src-tauri/tauri.conf.json',
  // Сам этот файл — в нём шаблоны и примеры.
  'test/no-private-data.test.js',
]);

// Имена, которыми в проекте называют «кого угодно». Их наличие — не утечка.
const SAMPLE_USERS = new Set(['user', 'example', 'someone', '<user>']);

// Формы, которым не место в публичном репозитории независимо от того, чья это
// машина. Работают у любого, кто склонирует репозиторий, — знания конкретных
// имён не требуют. Завершающий слэш не требуется: символьный класс группы
// (буквы, цифры, `.`, `-`) сам не включает кавычку, запятую, точку конца
// предложения и конец строки, так что путь ловится и в конце JSON-значения
// («"cwd": "/home/ivan"»), и в конце строки лога, и в конце предложения.
// Негативный lookbehind перед `/home`/`/Users` требует, чтобы это был
// начальный сегмент пути, а не чужой вложенный каталог с тем же именем —
// без него страж падал бы на `test/session-glyph.test.js` фикстуре
// `/opt/home/x`, которая как раз и проверяет, что вложенный `home` домашним
// каталогом не считается.
//
// Цена: регуляркой `/opt/home/x` и `/mnt/disk9/home/ivan` структурно
// неразличимы (в обоих `home` — не первый сегмент), поэтому lookbehind
// заодно гасит и настоящие домашние пути без разделителя перед `/home`
// (`backup2024/home/ivan`, `rsync://server/backup1/home/ivan/`). Это
// осознанный выбор, не проглядели: для стража в `npm test` ложное
// срабатывание дороже пропуска — тест, который краснеет на легитимной
// фикстуре, чинят удалением теста, а не разбором находки. Дыру частично
// закрывает вторая половина стража: `data/private-patterns.txt` хранит
// домашний путь этой установки (конкретное имя пользователя) без якорения
// и ловит его в любом положении внутри строки — там, где универсальная
// регулярка молчит из-за буквенно-цифрового символа перед `/home`. Но
// работает это только там, где файл со словами есть; у всех остальных,
// кто склонирует репозиторий, эта форма останется непойманной.
const UNIVERSAL = [
  { re: /(?<![A-Za-z0-9_])\/home\/([A-Za-z][\w.-]*)/g, what: 'домашний каталог Linux с именем пользователя' },
  { re: /(?<![A-Za-z0-9_])\/Users\/([A-Za-z][\w.-]*)/g, what: 'домашний каталог macOS с именем пользователя' },
  { re: /(?<![A-Za-z0-9_])\\Users\\([A-Za-z][\w.-]*)/g, what: 'домашний каталог Windows с именем пользователя' },
];

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter(f => !ALLOWED.has(f));
}

// Единственные отслеживаемые файлы, которые страж читать не может и не должен:
// иконки приложения. Семь из восьми — вывод `python3 scripts/make-icons.py`,
// восьмой (`favicon.png`) правится руками; имени машины в пикселях не бывает.
// Список задан именами, а не маской вроде «всё двоичное»: маска молча
// проглатывала бы любой новый нечитаемый файл, а с ним и всё, что в нём
// написано. Ровно так уже вышло — план с именами машин содержал управляющий
// символ в примере кода, `textLines()` возвращал `null`, и обе проверки
// пропускали файл целиком, оставаясь при этом зелёными.
const BINARY_OK = new Set([
  'src-tauri/icons/128x128.png',
  'src-tauri/icons/128x128@2x.png',
  'src-tauri/icons/32x32.png',
  'src-tauri/icons/favicon.png',
  'src-tauri/icons/icon.icns',
  'src-tauri/icons/icon.ico',
  'src-tauri/icons/icon.png',
]);

/** Текстовые файлы читаем построчно, известные двоичные пропускаем. */
function textLines(file) {
  const buf = fs.readFileSync(path.join(REPO, file));
  if (buf.includes(0)) return null;
  return buf.toString('utf8').split('\n');
}

// Проверка идёт до содержательных: пока страж не умеет прочитать файл, он про
// него ничего и не утверждает, а молчание тут неотличимо от чистоты.
test('все отслеживаемые файлы, кроме иконок, читаются текстом', () => {
  const unreadable = trackedFiles()
    .filter(f => !BINARY_OK.has(f))
    .filter(f => textLines(f) === null);
  assert.deepStrictEqual(unreadable, [], [
    '',
    'Эти файлы не читаются текстом, поэтому проверки на имена машин их не видят:',
    ...unreadable.map(f => `  ${f}`),
    'Либо уберите из них управляющие символы (в примерах кода — записью вида \\x00),',
    'либо, если файл действительно двоичный, впишите его в BINARY_OK с объяснением.',
    '',
  ].join('\n'));
});

function report(file, i, line) {
  return `${file}:${i + 1}: ${line.trim().slice(0, 100)}`;
}

test('в отслеживаемых файлах нет домашних каталогов с именем пользователя', () => {
  const hits = [];
  for (const file of trackedFiles()) {
    const lines = textLines(file);
    if (!lines) continue;
    lines.forEach((line, i) => {
      for (const { re, what } of UNIVERSAL) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          if (SAMPLE_USERS.has(m[1].toLowerCase())) continue;
          hits.push(`${report(file, i, line)}  <- ${what}: ${m[1]}`);
        }
      }
    });
  }
  assert.deepStrictEqual(hits, [], `\n${hits.join('\n')}\n`);
});

// Список конкретных слов лежит вне репозитория намеренно: файл с искомым
// словом в публичном репозитории ничем не лучше кода с этим словом — имя
// реальной машины, попавшее в объяснение того, почему его нельзя писать,
// само стало бы утечкой. Нет файла — эта часть проверки пропускается.
test('в отслеживаемых файлах нет слов из локального списка', (t) => {
  const listPath = path.join(REPO, 'data', 'private-patterns.txt');
  if (!fs.existsSync(listPath)) {
    t.skip('нет data/private-patterns.txt — локальная часть проверки пропущена');
    return;
  }
  const patterns = fs.readFileSync(listPath, 'utf8')
    .split('\n')
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#'))
    .map(s => new RegExp(s, 'i'));

  const hits = [];
  for (const file of trackedFiles()) {
    const lines = textLines(file);
    if (!lines) continue;
    lines.forEach((line, i) => {
      if (patterns.some(re => re.test(line))) hits.push(report(file, i, line));
    });
  }
  assert.deepStrictEqual(hits, [], `\n${hits.join('\n')}\n`);
});
