const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  separatorFor, mapPath, mapRowPath, mapRowDoc, buildActionArgv,
  sshRemoteUrl, editorFolderTarget, editorDocTarget,
} = require('../frontend-src/path-map');

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


// ── Строка списка и её каталог ─────────────────────────────────────────────
//
// Корень тот же UNC, что и выше: буква диска с разделителем — шаблон стража
// приватных данных, а проверяемое свойство от формы корня не зависит.
const LOCAL_ROW = { cwd: '<drive>:\\projects\\some-project', source: 'local' };
const REMOTE_ROW = { cwd: '/home/user/projects/x', source: 'build-host' };

test('строка местного источника переводу не подлежит', () => {
  // Её путь уже местный. Перевод отдавал бы null, и вместе с ним из меню
  // пропадали бы все действия с папкой, Open plan и Open spec.
  assert.strictEqual(mapRowPath(LOCAL_ROW, WIN), '<drive>:\\projects\\some-project');
});

test('строка с чужой машины переводится как прежде', () => {
  assert.strictEqual(mapRowPath(REMOTE_ROW, WIN), '\\\\nas\\home\\projects\\x');
});

test('строка без источника переводится как прежде', () => {
  // Старый ответ агрегатора источника не проставляет вовсе.
  assert.strictEqual(mapRowPath({ cwd: '/home/user/projects/x' }, WIN), '\\\\nas\\home\\projects\\x');
});

test('местная строка без каталога — по-прежнему null', () => {
  assert.strictEqual(mapRowPath({ source: 'local' }, WIN), null);
});

test('каталог строки никто не переводит мимо mapRowPath', () => {
  // Правило «местная строка уже местная» живёт в одном месте, и вызов
  // напрямую его обходит молча: действия просто исчезают из меню.
  const files = ['sessions.html', 'frontend-src/session-actions.js'];
  const offenders = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/mapPath\(\s*(row|\(row \|\| \{\}\))\./.test(line)) {
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepStrictEqual(offenders, []);
});

// --- Бумаги строки: спека и план ------------------------------------------

test('относительная бумага клеится к каталогу строки разделителем корня', () => {
  const row = { cwd: '/home/user/projects/x' };
  assert.strictEqual(mapRowDoc(row, 'docs/specs/a.md', WIN),
    '\\\\nas\\home\\projects\\x\\docs\\specs\\a.md');
  assert.strictEqual(mapRowDoc(row, 'docs/specs/a.md', MAC),
    '/Volumes/remote-home/projects/x/docs/specs/a.md');
});

test('абсолютная бумага переводится сама, а не клеится к каталогу', () => {
  // Сессия написала спеку в соседний репозиторий (2026-10-10, claude-otel →
  // grafana): агрегатор отдаёт абсолютный путь, и приклеенный к cwd он вёл бы
  // в несуществующий файл.
  const row = { cwd: '/home/user/projects/otel' };
  const abs = '/home/user/projects/grafana/docs/superpowers/specs/a-design.md';
  assert.strictEqual(mapRowDoc(row, abs, MAC),
    '/Volumes/remote-home/projects/grafana/docs/superpowers/specs/a-design.md');
  assert.strictEqual(mapRowDoc(row, abs, WIN),
    '\\\\nas\\home\\projects\\grafana\\docs\\superpowers\\specs\\a-design.md');
});

test('абсолютная бумага вне общего дерева — null', () => {
  const row = { cwd: '/home/user/projects/otel' };
  assert.strictEqual(mapRowDoc(row, '/srv/other/docs/specs/a.md', MAC), null);
});

test('у местной строки абсолютная бумага уже местная', () => {
  const row = { cwd: '/home/user/p', source: 'local' };
  assert.strictEqual(mapRowDoc(row, '/home/user/q/docs/specs/a.md', {}), '/home/user/q/docs/specs/a.md');
  assert.strictEqual(mapRowDoc(row, 'docs/specs/a.md', {}), '/home/user/p/docs/specs/a.md');
});

test('пустая бумага — null', () => {
  assert.strictEqual(mapRowDoc({ cwd: '/home/user/p' }, '', MAC), null);
  assert.strictEqual(mapRowDoc({ cwd: '/home/user/p' }, undefined, MAC), null);
});

// --- SSH Remote: Zed открывает удалённую папку сам, мимо сетевого диска ------
//
// Сетевой диск не сообщает Zed о правках, сделанных на той машине, и при
// сохранении Zed с диском не сверяется: файл, поправленный агентом, он молча
// затирает своей копией. По ssh файлы читает и пишет удалённая машина, и Zed
// видит чужие правки. Хост в фикстурах условный — имена машин в репозиторий не
// возвращаются (test/no-private-data.test.js).

const SSH = { sshHost: 'build-host.example', editorSshRemote: true, pathMap: WIN };

test('sshRemoteUrl: хост и абсолютный путь склеиваются в ssh://', () => {
  assert.strictEqual(sshRemoteUrl('build-host.example', '/home/user/projects/x'),
    'ssh://build-host.example/home/user/projects/x');
  // Пользователь в хосте — законная форма sshHost, и в адрес она ложится как есть.
  assert.strictEqual(sshRemoteUrl('user@build-host.example', '/srv/x'),
    'ssh://user@build-host.example/srv/x');
});

test('sshRemoteUrl: сегменты пути кодируются, слэши — нет', () => {
  // Zed раскодирует путь ровно один раз (parse_file_path), а `#`, `?` и `%`
  // без кодирования адрес обрезали бы или раскодировались бы не в то.
  assert.strictEqual(sshRemoteUrl('h', '/home/user/my notes/a#b?c%d'),
    'ssh://h/home/user/my%20notes/a%23b%3Fc%25d');
  assert.strictEqual(sshRemoteUrl('h', '/home/user/проект'),
    'ssh://h/home/user/%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82');
});

test('sshRemoteUrl: без хоста или с относительным путём — null', () => {
  assert.strictEqual(sshRemoteUrl('', '/home/user/x'), null);
  assert.strictEqual(sshRemoteUrl('  ', '/home/user/x'), null);
  assert.strictEqual(sshRemoteUrl('h', 'home/user/x'), null);
  assert.strictEqual(sshRemoteUrl('h', ''), null);
  assert.strictEqual(sshRemoteUrl(undefined, '/x'), null);
});

test('editorFolderTarget: при Zed и включённой настройке удалённая папка уходит по ssh', () => {
  const row = { cwd: '/home/user/projects/x', source: 'build-host.example' };
  assert.strictEqual(editorFolderTarget(row, SSH, 'zed'),
    'ssh://build-host.example/home/user/projects/x');
});

test('editorFolderTarget: ssh не нужна карта путей', () => {
  // Вся затея в том, чтобы обойтись без сетевого диска: каталог вне pathMap
  // (или pathMap пуст) по ssh открывается всё равно.
  const row = { cwd: '/srv/elsewhere' };
  assert.strictEqual(editorFolderTarget(row, { ...SSH, pathMap: {} }, 'zed'),
    'ssh://build-host.example/srv/elsewhere');
});

test('editorFolderTarget: без настройки, с другим редактором или без хоста — прежний перевод', () => {
  const row = { cwd: '/home/user/projects/x' };
  const local = '\\\\nas\\home\\projects\\x';
  assert.strictEqual(editorFolderTarget(row, { ...SSH, editorSshRemote: false }, 'zed'), local);
  assert.strictEqual(editorFolderTarget(row, SSH, 'vscode'), local);
  assert.strictEqual(editorFolderTarget(row, SSH, undefined), local);
  assert.strictEqual(editorFolderTarget(row, { ...SSH, sshHost: '' }, 'zed'), local);
  // Не булево `true` — не включено: конфиг пишет человек руками.
  assert.strictEqual(editorFolderTarget(row, { ...SSH, editorSshRemote: 'yes' }, 'zed'), local);
});

test('editorFolderTarget: местная строка открывается своим путём и при включённой настройке', () => {
  // У своей машины ходить по ssh не к кому: sshHost — это та, другая.
  const row = { cwd: '/home/user/p', source: 'local' };
  assert.strictEqual(editorFolderTarget(row, SSH, 'zed'), '/home/user/p');
});

test('editorFolderTarget: без каталога — null', () => {
  assert.strictEqual(editorFolderTarget({}, SSH, 'zed'), null);
  assert.strictEqual(editorFolderTarget({ cwd: '' }, SSH, 'zed'), null);
});

test('editorDocTarget: бумага по ssh — относительная от каталога, абсолютная сама', () => {
  const row = { cwd: '/home/user/projects/otel' };
  assert.strictEqual(editorDocTarget(row, 'docs/specs/a.md', SSH, 'zed'),
    'ssh://build-host.example/home/user/projects/otel/docs/specs/a.md');
  assert.strictEqual(editorDocTarget(row, '/home/user/projects/grafana/b.md', SSH, 'zed'),
    'ssh://build-host.example/home/user/projects/grafana/b.md');
  assert.strictEqual(editorDocTarget(row, '', SSH, 'zed'), null);
});

test('editorDocTarget: в остальных случаях — тот же mapRowDoc', () => {
  const row = { cwd: '/home/user/projects/x' };
  assert.strictEqual(editorDocTarget(row, 'docs/a.md', SSH, 'cursor'),
    mapRowDoc(row, 'docs/a.md', WIN));
  const local = { cwd: '/home/user/p', source: 'local' };
  assert.strictEqual(editorDocTarget(local, 'docs/a.md', SSH, 'zed'), '/home/user/p/docs/a.md');
});

test('editorFolderTarget: хост берётся из source строки, sshHost — откат', () => {
  // Метка ssh-источника — sshHost дословно; у строки без source (тесты, старые
  // ответы) остаётся сам sshHost.
  const row = { cwd: '/srv/x', source: 'user@other.example' };
  assert.strictEqual(editorFolderTarget(row, SSH, 'zed'), 'ssh://user@other.example/srv/x');
  assert.strictEqual(editorFolderTarget({ cwd: '/srv/x' }, SSH, 'zed'), 'ssh://build-host.example/srv/x');
});
