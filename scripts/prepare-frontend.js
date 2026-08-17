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
  'frontend-src/session-windows.js',
  'frontend-src/open-transport.js',
  'frontend-src/session-groups.js',
  'frontend-src/ui-state.js',
  'frontend-src/session-glyph.js',
  'frontend-src/session-info.js',
  'frontend-src/path-map.js',
  'frontend-src/action-hotkey.js',
  'frontend-src/key-reference.js',
  'frontend-src/session-actions.js',
  'frontend-src/config-shape.js',
  'frontend-src/stale-items.js',
  'frontend-src/picker-filter.js',
  'frontend-src/picker-snapshots.js',
  'frontend-src/picker-mode.js',
  'frontend-src/project-list.js',
  'frontend-src/zellij-list.js',
  'frontend-src/picker-list-sync.js',
  'frontend-src/open-strategy.js',
  'frontend-src/session-name.js',
  'frontend-src/terminal-presets.js',
  'frontend-src/settings-form.js',
  'frontend-src/action-icons.js',
  'frontend-src/picker-sections.js',
  'frontend-src/project-dim.js',
  'frontend-src/picker-panels.js',
];

fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'sessions.html'), path.join(OUT, 'index.html'));
fs.copyFileSync(path.join(ROOT, 'settings.html'), path.join(OUT, 'settings.html'));
for (const src of FILES) {
  fs.copyFileSync(path.join(ROOT, src), path.join(OUT, path.basename(src)));
}
console.log(`prepared ${FILES.length + 2} files`);
