// Сверяет тег релиза с версией в конфигах — и валит сборку, если они разошлись.
//
// Цена ошибки известна по соседнему windows11-manager: там workflow висел на
// образце, под который перестали подходить теги, и три релиза вышли без
// единого установщика. Молча — не сработавший workflow в релизе ничем себя не
// проявляет, а человек видит релиз и считает, что файлы просто ещё грузятся.
// Здесь дорога та же: тег ставится руками, версия правится руками в трёх
// файлах, и разойтись им нечего не мешает.
//
// Зовётся из `.github/workflows/release.yml` первым шагом обеих сборок —
// раньше компиляции, чтобы отказ стоил секунд, а не минут. Руками:
//
//   node scripts/check-version.js v0.9.1
//
// Без аргумента только сверяет три файла между собой — то же, что делает
// сторож `test/version-sync.test.js`.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** Версия из package.json, tauri.conf.json и Cargo.toml — три места, где её правят руками. */
function versions() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const conf = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );
  const cargo = fs.readFileSync(path.join(ROOT, 'src-tauri', 'Cargo.toml'), 'utf8');
  // Первая `version` в файле — это версия пакета: она стоит в `[package]`,
  // выше всех зависимостей. Дальше по файлу `version` есть у каждого крейта.
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m);
  return {
    'package.json': pkg.version,
    'src-tauri/tauri.conf.json': conf.version,
    'src-tauri/Cargo.toml': cargoVersion && cargoVersion[1],
  };
}

/**
 * Ошибки согласия: разошедшиеся файлы и тег, не совпавший с ними.
 *
 * Тег необязателен: без него проверяются только файлы между собой — так эту
 * же функцию зовёт тест, которому тега взять неоткуда.
 */
function versionProblems(found, tag) {
  const problems = [];
  const values = Object.values(found);
  if (values.some((v) => !v)) {
    for (const [file, value] of Object.entries(found)) {
      if (!value) problems.push(`версия не найдена в ${file}`);
    }
    return problems;
  }
  if (new Set(values).size > 1) {
    const shown = Object.entries(found)
      .map(([file, value]) => `${file}: ${value}`)
      .join(', ');
    problems.push(`версии разошлись — ${shown}`);
  }
  if (tag) {
    // Тег с приставкой `v`, версия без неё: `v0.9.1` против `0.9.1`.
    const wanted = tag.replace(/^v/, '');
    for (const [file, value] of Object.entries(found)) {
      if (value !== wanted) problems.push(`тег ${tag} не совпал с ${file}: ${value}`);
    }
  }
  return problems;
}

module.exports = { versions, versionProblems };

if (require.main === module) {
  const tag = process.argv[2];
  const found = versions();
  const problems = versionProblems(found, tag);
  if (problems.length) {
    for (const problem of problems) console.error(`ошибка: ${problem}`);
    process.exit(1);
  }
  console.log(`версия ${found['package.json']}${tag ? ` совпала с тегом ${tag}` : ''}`);
}
