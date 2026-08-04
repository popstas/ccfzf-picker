// Tauri собирает статику из frontend/. Копирование, а не сборщик: файлы уже
// готовы к загрузке тегом <script>, и бандлер здесь ничего бы не улучшил.
const fs = require('fs');

const FILES = [
  'frontend-src/state-shape.js',
  'frontend-src/session-agent.js',
  'frontend-src/session-list.js',
  'frontend-src/session-groups.js',
  'frontend-src/session-glyph.js',
  'frontend-src/session-info.js',
  'frontend-src/picker-filter.js',
  'frontend-src/picker-list-sync.js',
  'frontend-src/open-strategy.js',
];

fs.mkdirSync('frontend', { recursive: true });
fs.copyFileSync('sessions.html', 'frontend/index.html');
for (const src of FILES) {
  fs.copyFileSync(src, 'frontend/' + src.split('/').pop());
}
console.log(`prepared ${FILES.length + 1} files`);
