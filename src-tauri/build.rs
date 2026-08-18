use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    // Штамп времени сборки виден в пункте меню трея. Нужен он затем, что
    // `deploy-*.sh` обновляет пикер на месте: после выкатки нечем проверить,
    // что перезапустилось именно новое, — версия у всех сборок между релизами
    // одна.
    //
    // Признак «это релиз» объявляет сборщик переменной окружения, а не
    // cargo-профиль: `deploy-*.sh` собирает `--release`, и на
    // `debug_assertions` штамп пропал бы ровно там, где он и нужен. Сейчас
    // переменную не выставляет никто — релиза у проекта пока нет вовсе, — так
    // что штамп есть везде, а место под будущий CI готово.
    println!("cargo:rerun-if-env-changed=CCFZF_RELEASE");
    // Без явного rerun-if-changed штамп застыл бы на первой сборке: любой
    // `cargo:rerun-if-*` отменяет умолчание «пересобирать скрипт на любую
    // правку в пакете», а его отменяет уже `tauri_build::build()` своими
    // директивами.
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");
    // Фронтенд — тоже вход сборки, но каталог его лежит вне пакета
    // (`frontendDist` — `../frontend`), и сам себя он здесь не объявляет:
    // `tauri_build::build()` печатает директиву только на `tauri.conf.json` и
    // `capabilities`, а статику вшивает `generate_context!` уже на
    // компиляции. Без этой строки выкатка с одними правками страницы
    // оставляла скрипт свежим, и штамп в трее показывал прошлую сборку —
    // ровно то, за чем в него и смотрят после деплоя.
    //
    // На саму статику это не влияет и не влияло: пути фронтенда попадают в
    // dep-info крейта (`target/debug/ccfzf-picker.d`, все 29 файлов), то есть
    // правку страницы cargo замечает и крейт пересобирает. Проверено
    // измерением: правка одного файла во `frontend/` из чистого состояния
    // даёт «Compiling ccfzf-picker». Врал только штамп.
    println!("cargo:rerun-if-changed=../frontend");
    // Копия агрегатора вшивается на компиляции (`include_str!`), и обновление
    // подмодуля обязано пересобирать крейт. Про сам `include_str!` cargo знает,
    // а про build.rs — нет: он решает про него до того, как хоть что-то наше
    // начнёт выполняться.
    println!("cargo:rerun-if-changed=../vendor/ccfzf/ccfzf");
    let stamp = if std::env::var_os("CCFZF_RELEASE").is_some() {
        0
    } else {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    };
    println!("cargo:rustc-env=CCFZF_BUILD_UNIX={stamp}");
    tauri_build::build()
}
