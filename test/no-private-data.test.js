// Публичный репозиторий: имена машин, домашние пути и имена соседних проектов
// сюда не возвращаются. Проверка идёт по `git ls-files`, то есть по тому, что
// реально уедет в публикацию, а не по рабочему дереву.
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
// Негативный lookbehind перед `/home` — чтобы не путать домашний каталог
// пользователя с каталогом, который просто называется `home` и вложен во
// что-то другое (`/opt/home/x`): такой путь не начинает собой ничью
// домашнюю директорию, а лишь содержит слово «home» как обычный сегмент.
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

/** Текстовые файлы читаем построчно, двоичные пропускаем. */
function textLines(file) {
  const buf = fs.readFileSync(path.join(REPO, file));
  if (buf.includes(0)) return null;
  return buf.toString('utf8').split('\n');
}

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

// Список конкретных слов лежит вне репозитория намеренно: файл со словом
// «example-host» в публичном репозитории ничем не лучше кода со словом «example-host».
// Нет файла — эта часть проверки пропускается.
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
