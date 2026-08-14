const { test } = require('node:test');
const assert = require('node:assert');
const { separatorFor, mapPath, buildActionArgv } = require('../frontend-src/path-map');

// Корни сетевых дисков Windows пишутся здесь формой UNC, а не буквой диска:
// буква вместе с разделителем — шаблон из no-private-data.test.js, и фикстура с
// ней уронила бы стража приватных данных. Форма другая, а проверяемое свойство
// то же — обратный слэш в разделителе.
const WIN = { remote: '/home/user', local: '\\\\nas\\home' };
const MAC = { remote: '/home/user', local: '/Volumes/remote-home' };

test('путь внутри общего дерева переводится на эту машину', () => {
  assert.strictEqual(mapPath('/home/user/projects/js/x', WIN), '\\\\nas\\home\\projects\\js\\x');
  assert.strictEqual(mapPath('/home/user/projects/js/x', MAC), '/Volumes/remote-home/projects/js/x');
});

test('сам корень даёт корень, а не пустую строку', () => {
  assert.strictEqual(mapPath('/home/user', WIN), '\\\\nas\\home');
  assert.strictEqual(mapPath('/home/user/', WIN), '\\\\nas\\home');
});

test('лишние разделители на концах не меняют результат', () => {
  const trailing = { remote: '/home/user/', local: '\\\\nas\\home\\' };
  assert.strictEqual(mapPath('/home/user/a//', trailing), '\\\\nas\\home\\a');
});

test('путь вне общего дерева не переводится', () => {
  assert.strictEqual(mapPath('/etc/nginx', WIN), null);
  assert.strictEqual(mapPath('/', WIN), null);
});

test('совпадение считается по границе разделителя, а не по длине строки', () => {
  // Иначе пикер собрал бы путь из обрезка чужого каталога: остаток «shop/x»
  // приклеился бы к корню и указал бы в существующую, но не ту папку.
  const srv = { remote: '/srv/work', local: '/Volumes/work' };
  assert.strictEqual(mapPath('/srv/work/x', srv), '/Volumes/work/x');
  assert.strictEqual(mapPath('/srv/workshop/x', srv), null);
  assert.strictEqual(mapPath('/srv/workspace', srv), null);
});

test('без маппинга и без пути перевода нет', () => {
  assert.strictEqual(mapPath('/home/user/x', null), null);
  assert.strictEqual(mapPath('/home/user/x', { remote: '', local: '\\\\nas\\home' }), null);
  assert.strictEqual(mapPath('/home/user/x', { remote: '/home/user', local: '' }), null);
  assert.strictEqual(mapPath('', WIN), null);
  assert.strictEqual(mapPath(undefined, WIN), null);
});

test('разделитель берётся из формы локального корня', () => {
  assert.strictEqual(separatorFor('/Volumes/x'), '/');
  assert.strictEqual(separatorFor('\\\\nas\\home'), '\\');
  // Корень одной буквой диска без разделителя: обратных слэшей в строке нет, а
  // разделитель всё равно обязан быть обратным.
  assert.strictEqual(separatorFor('X:'), '\\');
});

// Ветка mapPath «корень кончается двоеточием — дописать разделитель» тестом не
// покрыта: её ожидаемый результат — буква диска с обратным слэшем, а такую
// форму запрещает шаблон из data/private-patterns.txt. Шаблон шире правила,
// которое сторожит (локальные пути этой установки), и generic-буква под него
// попадает заодно. Определение разделителя по букве диска проверено выше через
// separatorFor.

test('плейсхолдеры подставляются в argv', () => {
  const argv = buildActionArgv(
    { argv: ['app', '{localPath}', '{remotePath}'] },
    { localPath: '\\\\nas\\home\\a', remotePath: '/home/user/a' },
  );
  assert.deepStrictEqual(argv, ['app', '\\\\nas\\home\\a', '/home/user/a']);
});

test('localPathSlash отдаёт тот же путь прямыми слэшами', () => {
  // Ради `cmd /c start`: обратные слэши он съедает и папку не открывает.
  const argv = buildActionArgv(
    { argv: ['cmd', '/c', 'start', '', '{localPathSlash}'] },
    { localPath: '\\\\nas\\home\\a', remotePath: '/home/user/a' },
  );
  assert.deepStrictEqual(argv, ['cmd', '/c', 'start', '', '//nas/home/a']);
});

test('плейсхолдер подставляется внутри аргумента, а не заменяет его целиком', () => {
  const argv = buildActionArgv(
    { argv: ['code', '--folder-uri={localPath}'] },
    { localPath: '/Volumes/remote-home/a', remotePath: '/home/user/a' },
  );
  assert.deepStrictEqual(argv, ['code', '--folder-uri=/Volumes/remote-home/a']);
});

test('argv без плейсхолдеров и пустое действие не ломают сборку', () => {
  assert.deepStrictEqual(buildActionArgv({ argv: ['open'] }, {}), ['open']);
  assert.deepStrictEqual(buildActionArgv(null, null), []);
});
