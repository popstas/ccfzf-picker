// Релиз собирается по тегу, а версия правится руками в трёх файлах —
// `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`. Общего
// кода между ними нет: два JSON и один TOML, каждый читает своя программа.
//
// Отказ здесь самый тихий из возможных. Разойдись версии — сборка всё равно
// пройдёт, релиз выйдет, а установщик назовётся не тем номером; человек,
// поставивший его, увидит в трее прежнюю версию и решит, что обновление не
// встало. Поэтому согласие держат сразу двое: этот сторож — на каждом прогоне
// тестов, и `scripts/check-version.js` — первым шагом обеих сборок в CI, до
// компиляции, чтобы отказ стоил секунд.
//
// Заодно проверяется форма самого workflow. Цена ошибки известна по соседнему
// windows11-manager: там образец тега разошёлся с тем, что ставилось, и три
// релиза вышли без единого `.exe` — не сработавший workflow в релизе ничем
// себя не проявляет.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { versions, versionProblems } = require('../scripts/check-version');

const WORKFLOW = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'release.yml'),
  'utf8',
);

const TAURI_CONF = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'),
);

test('версия одна и та же в package.json, tauri.conf.json и Cargo.toml', () => {
  const found = versions();
  assert.deepStrictEqual(versionProblems(found), [], JSON.stringify(found));
});

test('тег с приставкой v совпадает с версией файлов, а чужой — нет', () => {
  const version = versions()['package.json'];
  assert.deepStrictEqual(versionProblems(versions(), `v${version}`), []);
  const problems = versionProblems(versions(), 'v0.0.1-nope');
  assert.ok(problems.length, 'чужой тег обязан быть отвергнут');
});

test('релиз собирает и установщик Windows, и приложение macOS', () => {
  const targets = TAURI_CONF.bundle.targets;
  assert.ok(targets.includes('nsis'), 'без nsis установщика Windows не собирается вовсе');
  assert.ok(targets.includes('app'), 'без app не из чего делать zip для каски');
  assert.match(
    WORKFLOW,
    /bundle\/nsis\/\*-setup\.exe/,
    'workflow обязан забирать собранный установщик — иначе релиз выйдет пустым',
  );
  assert.match(
    WORKFLOW,
    /ccfzf-picker-macos-arm64-\$\{VERSION\}\.zip/,
    'имя маковского архива подставляет каска в url — оно обязано нести версию',
  );
});

test('workflow висит на теге v* и сверяет тег с версией до компиляции', () => {
  assert.match(WORKFLOW, /tags:\s*\['v\*'\]/, 'теги здесь ставятся без префикса компонента');
  const checks = WORKFLOW.match(/scripts\/check-version\.js/g) || [];
  assert.strictEqual(checks.length, 2, 'сверка обязана стоять в обеих сборках, не в одной');
});

test('релизная сборка перекрывает профиль, а сам профиль остаётся быстрым', () => {
  // Профиль `release` собран под скорость выкатки на три рабочие машины
  // (таблица замеров — в самом Cargo.toml), поэтому рычаги размера живут
  // только в workflow. Верни их в Cargo.toml — и каждая выкатка подорожает
  // втрое, молча: скрипт деплоя времени не считает.
  const cargo = fs.readFileSync(
    path.join(__dirname, '..', 'src-tauri', 'Cargo.toml'),
    'utf8',
  );
  const profile = cargo.slice(cargo.indexOf('[profile.release]'));
  assert.match(profile, /lto\s*=\s*false/, 'lto в профиле выкатки обязан остаться выключенным');
  assert.match(profile, /incremental\s*=\s*true/, 'incremental и есть то, что держит выкатку быстрой');
  for (const lever of [
    'CARGO_PROFILE_RELEASE_LTO',
    'CARGO_PROFILE_RELEASE_CODEGEN_UNITS',
    'CARGO_PROFILE_RELEASE_STRIP',
    'CARGO_PROFILE_RELEASE_OPT_LEVEL',
  ]) {
    assert.ok(WORKFLOW.includes(lever), `рычаг размера ${lever} пропал из workflow`);
  }
});
