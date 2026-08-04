// Tauri собирает статику из frontend/. Копирование, а не сборщик: файлы уже
// готовы к загрузке тегом <script>, и бандлер здесь ничего бы не улучшил.
// Пути считаются от самого скрипта, а не от текущего каталога: его зовут и
// из корня репозитория, и из сборки Tauri (src-tauri/), и из хука — а
// относительные пути молча собрали бы frontend/ не там, где его ищет Tauri.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'frontend');

const FILES = [
  'frontend-src/state-shape.js',
  'frontend-src/session-agent.js',
  'frontend-src/session-list.js',
  'frontend-src/session-groups.js',
  'frontend-src/session-glyph.js',
  'frontend-src/session-info.js',
  'frontend-src/session-actions.js',
  'frontend-src/config-shape.js',
  'frontend-src/picker-filter.js',
  'frontend-src/picker-list-sync.js',
  'frontend-src/open-strategy.js',
];

fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'sessions.html'), path.join(OUT, 'index.html'));
for (const src of FILES) {
  fs.copyFileSync(path.join(ROOT, src), path.join(OUT, path.basename(src)));
}
console.log(`prepared ${FILES.length + 1} files`);
