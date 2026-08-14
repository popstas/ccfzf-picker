# Этап 3 macos-windows-manager: «снимки и расстановка» — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Окно сессии на маке возвращается туда, где стояло, а вчерашняя раскладка поднимается из пикера одним действием.

**Architecture:** У трекера появляется состояние на диске, которого сейчас нет вовсе: слоты сессий с координатами и файл снимков. Каждый такт он читает геометрию видимых окон; увидев, что окно сессии появилось, ставит его в запомненное место. Состав открытых сессий он же снимает с дебаунсом. Снимки едут читателю тем же файлом окон, каким едут окна, и агрегатор впервые проставляет им машину-владельца.

**Tech Stack:** Rust (Tauri 2, `accessibility`/`accessibility-sys`, `objc2-app-kit`, `serde_json`), Python 3 (агрегатор `ccfzf`), ванильный JS без сборщика (фронтенд пикера).

**Spec:** `docs/superpowers/specs/2026-08-14-macos-windows-manager-etap-3-design.md` (в репозитории `ccfzf-picker`)

## Global Constraints

- **Три репозитория, коммиты в каждый свои.** Трекер `~/projects/js/macos-windows-manager` (ветка `master`), агрегатор `~/projects/shell/ccfzf` (ветка `main`), пикер `~/projects/js/ccfzf-picker` (ветка `windows-mqtt-migrate`). Ни одна задача не трогает больше одного репозитория, кроме последней.
- **Язык.** Всё, что видит человек, — по-английски. Комментарии, doc-комментарии, названия тестов и сообщения в `assert` — по-русски.
- **Имён машин и домашних каталогов с именем пользователя в репозиториях нет.** В примерах и тестах — только `remote-host`, `mac-host`, `windows-box`, пути от `~`, топики вида `home/room/mac/windows`. Сторож: `test/no-private-data.test.js` в пикере, он входит в `npm test`.
- **Тесты запускаются так и только так:** трекер — `cargo test -p mwm-core` и `cargo test -p macos-windows-manager`; агрегатор — `python3 tests/test_<имя>.py` по одному файлу; пикер — `npm test` (`node --test` на этих версиях Node не работает) и `cd src-tauri && cargo test`.
- **Предсуществующих падений нет.** На момент написания плана: `mwm-core` 54, `macos-windows-manager` 7, пикер 419 + 90, агрегатор `test_windows_file.py` 26/26 и `test_windows_merge.py` целиком. Любое падение — своё.
- **Код под `#[cfg(target_os = "macos")]` на машине разработки не компилируется вовсе.** `cargo test -p macos-windows-manager` собирает не-macOS ветку. Ошибки в именах методов `accessibility` и `objc2-app-kit` всплывут только на выкатке (задача 12) — так уже было дважды: с `CFType::from` на первом этапе и с `NSRunningApplication::activate` на втором. Поэтому в macOS-ветку не кладётся ничего, кроме вызовов платформы: никакой логики, минимум кода.
- **`mod imp` в `ax.rs` расщеплён по платформе.** В macOS-ветке `Registry` — структура с полями, в не-macOS — юнит-структура `pub struct Registry;`. Правки полей реестра относятся только к macOS-ветке; не-macOS получает заглушки с той же сигнатурой.
- **Отсутствующее поле — умолчание, а не третья ветка поведения.** Мусор в файле стоит поля, а не файла.
- **`;` в удалённой команде не ставить** — правило связки, одно на все репозитории.
- **Коммиты — conventional commits по-русски**, с подписью `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## Структура файлов

**Трекер `macos-windows-manager`:**
- Create: `crates/mwm-core/src/geometry.rs` — `Bounds`, `Display`, клампинг к экранам
- Create: `crates/mwm-core/src/state.rs` — слоты на диске, атомарная запись
- Create: `crates/mwm-core/src/snapshots.rs` — решение о снимке, дебаунс, обрезка
- Modify: `crates/mwm-core/src/index.rs` — индекс отдаёт и каталог
- Modify: `crates/mwm-core/src/tracker.rs` — геометрия в слоте, устойчивость, расстановка
- Modify: `crates/mwm-core/src/publish.rs` — снимки в файле окон
- Modify: `crates/mwm-core/src/lib.rs` — объявления новых модулей
- Modify: `crates/mwm-core/src/config.rs` — пути состояния и настройки снимков
- Modify: `src-tauri/src/ax.rs` — чтение и установка геометрии, список экранов
- Modify: `src-tauri/src/main.rs` — сшивка такта

**Агрегатор `ccfzf`:**
- Modify: `ccfzf` — `read_window_sources`
- Test: `tests/test_windows_merge.py`

**Пикер `ccfzf-picker`:**
- Modify: `frontend-src/picker-snapshots.js` — отбор снимков своей машины
- Modify: `sessions.html` — восстановление ветвится по машине снимка
- Test: `test/picker-snapshots.test.js`

---

### Task 1: Геометрия и клампинг к экранам

**Repo:** `~/projects/js/macos-windows-manager`, ветка `master`

**Files:**
- Create: `crates/mwm-core/src/geometry.rs`
- Modify: `crates/mwm-core/src/lib.rs`

**Interfaces:**
- Produces:
  - `pub struct Bounds { pub x: i32, pub y: i32, pub width: i32, pub height: i32 }` с `#[derive(Debug, Clone, Copy, PartialEq, Eq)]`
  - `pub struct Display { pub bounds: Bounds }` с `#[derive(Debug, Clone, Copy, PartialEq, Eq)]`
  - `pub fn clamp_to_displays(b: Bounds, displays: &[Display]) -> Bounds`

**Контекст:** раскладка мониторов меняется — ноутбук отключили от дока, внешний экран сменился местами. Окно, поставленное по вчерашним координатам, уезжает за границу видимого и теряется насовсем: вернуть его мышкой нельзя.

- [x] **Step 1: Написать падающие тесты**

Создать `crates/mwm-core/src/geometry.rs` с шапкой, типами, `todo!()` в теле функции и тестами:

```rust
//! Прямоугольники окон и экранов.
//!
//! Система координат — глобальная, с началом в левом верхнем углу главного
//! экрана: такую отдаёт Accessibility. `NSScreen` считает от левого нижнего, и
//! смешивать их нельзя — список экранов поэтому берётся тем же способом, каким
//! читаются окна, а не через AppKit.

/// Прямоугольник в глобальных координатах.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Экран — тот же прямоугольник, отдельным типом ради читаемости сигнатур.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Display {
    pub bounds: Bounds,
}

/// Какую долю площади окна должны накрывать экраны, чтобы положение считалось
/// годным. Половина, а не «видно хоть сколько-нибудь»: окно, торчащее с экрана
/// на три четверти, человеку так же бесполезно, как уехавшее целиком.
const VISIBLE_NUM: i64 = 1;
const VISIBLE_DEN: i64 = 2;

/// Подогнать положение окна под текущие экраны.
pub fn clamp_to_displays(b: Bounds, displays: &[Display]) -> Bounds {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(x: i32, y: i32, width: i32, height: i32) -> Bounds {
        Bounds { x, y, width, height }
    }

    fn screens(list: &[Bounds]) -> Vec<Display> {
        list.iter().map(|&bounds| Display { bounds }).collect()
    }

    #[test]
    fn a_window_on_screen_is_left_alone() {
        let d = screens(&[b(0, 0, 1920, 1080)]);
        let w = b(100, 100, 800, 600);
        assert_eq!(clamp_to_displays(w, &d), w);
    }

    #[test]
    fn a_window_mostly_on_screen_is_left_alone() {
        // Окно, свисающее с края на четверть, человек видит и может подвинуть
        // сам. Дёргать его — значит спорить с тем, как он его поставил.
        let d = screens(&[b(0, 0, 1000, 1000)]);
        let w = b(750, 0, 400, 400);
        assert_eq!(clamp_to_displays(w, &d), w, "накрыто 250 из 400 по ширине — больше половины площади");
    }

    #[test]
    fn a_window_off_screen_comes_back() {
        // Внешнего экрана не стало, окно осталось на его координатах. Мышкой
        // такое не вернуть — его вообще не видно.
        let d = screens(&[b(0, 0, 1000, 1000)]);
        let w = b(3000, 200, 400, 300);
        let got = clamp_to_displays(w, &d);
        assert_eq!(got, b(600, 200, 400, 300), "прижато к правому краю, размер сохранён");
    }

    #[test]
    fn a_window_larger_than_the_screen_shrinks_to_fit() {
        let d = screens(&[b(0, 0, 800, 600)]);
        let w = b(5000, 5000, 1600, 1200);
        assert_eq!(clamp_to_displays(w, &d), b(0, 0, 800, 600));
    }

    #[test]
    fn the_screen_with_the_most_overlap_wins() {
        // Два экрана с зазором между ними, окно уехало в зазор и цепляет оба
        // краями. Накрыто меньше половины площади — значит возвращать; вернуть
        // надо на тот экран, где окна больше, иначе оно прыгает через весь стол.
        //
        // Зазор между экранами обязателен: на смежных экранах окно, уехавшее на
        // стык, накрыто целиком, ветка выбора экрана не исполняется вовсе, и
        // тест зеленел бы, ничего не проверив.
        //
        // Случая два, и они зеркальны намеренно: с одним тест не отличил бы
        // правило «побеждает наибольшее перекрытие» от правила «побеждает
        // первый экран в списке».
        let d = screens(&[b(0, 0, 1000, 1000), b(1500, 0, 1000, 1000)]);

        // Слева 300 столбцов из 900, справа 100 — накрыто 160 000 из 360 000.
        assert_eq!(
            clamp_to_displays(b(700, 100, 900, 400), &d),
            b(100, 100, 900, 400),
            "перекрытие больше слева — окно вернулось на левый экран",
        );

        // Зеркально: слева 100 столбцов, справа 300.
        assert_eq!(
            clamp_to_displays(b(900, 100, 900, 400), &d),
            b(1500, 100, 900, 400),
            "перекрытие больше справа — правило «первый в списке» выбрало бы левый",
        );
    }

    #[test]
    fn no_screens_means_no_opinion() {
        // Экранов не видно вовсе — клампить не к чему. Отказ от расстановки был
        // бы хуже: окно осталось бы там, куда его положила система.
        let w = b(100, 100, 800, 600);
        assert_eq!(clamp_to_displays(w, &[]), w);
    }

    #[test]
    fn a_zero_sized_window_is_left_alone() {
        // Размер приезжает от Accessibility и может оказаться нулевым, если
        // окно как раз закрывается. Делить на ноль в подсчёте доли нельзя, а
        // трогать такое окно незачем.
        let d = screens(&[b(0, 0, 1000, 1000)]);
        let w = b(5000, 5000, 0, 0);
        assert_eq!(clamp_to_displays(w, &d), w);
    }
}
```

В `crates/mwm-core/src/lib.rs` дописать `pub mod geometry;`.

- [x] **Step 2: Прогнать и убедиться, что падает**

Run: `cd ~/projects/js/macos-windows-manager && cargo test -p mwm-core`
Expected: FAIL — паника `not yet implemented` в тестах геометрии.

- [x] **Step 3: Реализовать**

Заменить `todo!()` на:

```rust
pub fn clamp_to_displays(b: Bounds, displays: &[Display]) -> Bounds {
    if displays.is_empty() {
        return b;
    }
    let area = i64::from(b.width.max(0)) * i64::from(b.height.max(0));
    if area == 0 {
        return b;
    }
    let covered: i64 = displays.iter().map(|d| overlap(&b, &d.bounds)).sum();
    if covered * VISIBLE_DEN >= area * VISIBLE_NUM {
        return b;
    }
    // Возвращаем на экран с наибольшим перекрытием, а не на первый попавшийся:
    // иначе окно, съехавшее на стык двух экранов, прыгало бы через весь стол.
    let best = displays
        .iter()
        .max_by_key(|d| overlap(&b, &d.bounds))
        .map(|d| d.bounds)
        .unwrap_or(b);
    let width = b.width.min(best.width);
    let height = b.height.min(best.height);
    Bounds {
        x: b.x.max(best.x).min(best.x + best.width - width),
        y: b.y.max(best.y).min(best.y + best.height - height),
        width,
        height,
    }
}

/// Площадь пересечения. В `i64`, потому что произведение двух `i32` из него
/// выходит: экран 8K на паре мониторов даёт число за пределами `i32`.
fn overlap(a: &Bounds, b: &Bounds) -> i64 {
    let x = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let y = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    if x <= 0 || y <= 0 {
        return 0;
    }
    i64::from(x) * i64::from(y)
}
```

- [x] **Step 4: Прогнать**

Run: `cargo test -p mwm-core`
Expected: PASS

- [x] **Step 5: Коммит**

```bash
git add crates/mwm-core/src/geometry.rs crates/mwm-core/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(geometry): прямоугольники окон и возврат на текущие экраны

Раскладка мониторов меняется, и окно, поставленное по вчерашним координатам,
уезжает за границу видимого. Мышкой такое не вернуть — его не видно вовсе.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Состояние на диске

**Repo:** `~/projects/js/macos-windows-manager`

**Files:**
- Create: `crates/mwm-core/src/state.rs`
- Modify: `crates/mwm-core/src/lib.rs`

**Interfaces:**
- Consumes: `crate::geometry::Bounds` (задача 1).
- Produces:
  - `pub struct SlotState { pub bounds: Option<Bounds>, pub title: String, pub cwd: String, pub last_seen_ms: u64, pub focused_at_ms: u64 }` с `#[derive(Debug, Clone, Default, PartialEq)]`
  - `pub fn parse_state(json: &str) -> BTreeMap<String, SlotState>`
  - `pub fn state_json(slots: &BTreeMap<String, SlotState>) -> serde_json::Value`
  - `pub fn read_state(path: &std::path::Path) -> BTreeMap<String, SlotState>`
  - `pub fn write_atomic(path: &std::path::Path, value: &serde_json::Value) -> Result<(), String>`

**Контекст:** у трекера сейчас нет ни одного файла, кроме конфига. Атомарная запись с `fsync` — правило, оплаченное на Windows: переименование журналируется, а данные — нет, и без `fsync` потеря питания оставляет рваный файл.

- [x] **Step 1: Написать падающие тесты**

Создать `crates/mwm-core/src/state.rs` с шапкой, типами, `todo!()` в телах и тестами:

```rust
//! Слоты сессий на диске: где стояло окно, как называлось, из какого каталога.
//!
//! Файл машинный, конфиг человеческий — лежат они поэтому в разных местах.
//! Соседство приглашало бы спутать резервную копию одного с рабочим файлом
//! другого.

use crate::geometry::Bounds;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::Path;

/// Что помнится про сессию между запусками.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SlotState {
    /// Устойчивое положение окна. `None` — сессию видели, а координат не знаем.
    pub bounds: Option<Bounds>,
    pub title: String,
    /// Каталог проекта. Нужен снимку: сессия из снимка может быть уже
    /// неизвестна агрегатору, и пикеру взять каталог будет неоткуда.
    pub cwd: String,
    pub last_seen_ms: u64,
    /// Отметка взгляда. Переживает перезапуск намеренно: без этого перезапуск
    /// трекера показал бы человеку все сессии непрочитанными разом, а отметку
    /// эту ставил взгляд, а не случай.
    pub focused_at_ms: u64,
}

pub fn parse_state(json: &str) -> BTreeMap<String, SlotState> {
    todo!()
}

pub fn state_json(slots: &BTreeMap<String, SlotState>) -> serde_json::Value {
    todo!()
}

pub fn read_state(path: &Path) -> BTreeMap<String, SlotState> {
    todo!()
}

pub fn write_atomic(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "aaaaaaaa-1111-2222-3333-444444444444";

    fn slot() -> SlotState {
        SlotState {
            bounds: Some(Bounds { x: 10, y: 20, width: 800, height: 600 }),
            title: "ccfzf".to_string(),
            cwd: "~/projects/js/ccfzf-picker".to_string(),
            last_seen_ms: 5_000,
            focused_at_ms: 4_000,
        }
    }

    #[test]
    fn a_slot_survives_a_round_trip() {
        let mut slots = BTreeMap::new();
        slots.insert(SID.to_string(), slot());
        let back = parse_state(&state_json(&slots).to_string());
        assert_eq!(back, slots);
    }

    #[test]
    fn a_slot_without_bounds_survives_too() {
        // Сессию видели, а координат не узнали: окно закрылось раньше, чем
        // положение устоялось. Терять запись из-за этого нельзя — в ней ещё
        // каталог и отметка взгляда.
        let mut slots = BTreeMap::new();
        slots.insert(SID.to_string(), SlotState { bounds: None, ..slot() });
        let back = parse_state(&state_json(&slots).to_string());
        assert_eq!(back[SID].bounds, None);
        assert_eq!(back[SID].cwd, "~/projects/js/ccfzf-picker");
    }

    #[test]
    fn garbage_costs_itself_and_nothing_more() {
        // Недоверие к файлу то же, что у файла окон: порченая запись стоит
        // себя, а не всего состояния.
        assert!(parse_state("not json").is_empty());
        assert!(parse_state(r#"{"slots":"nope"}"#).is_empty());
        let back = parse_state(&format!(
            r#"{{"slots":{{"{SID}":{{"title":"ok","bounds":{{"x":1,"y":2,"width":"нет","height":4}}}},
                          "":{{"title":"безымянный"}}}}}}"#
        ));
        assert_eq!(back.len(), 1, "запись с пустым ключом не в счёт");
        assert_eq!(back[SID].bounds, None, "порченые координаты стоят координат, а не записи");
        assert_eq!(back[SID].title, "ok");
    }

    #[test]
    fn writing_is_atomic_and_leaves_no_temp_behind() {
        // Временный файл рядом, потом переименование. Останься он лежать —
        // каталог состояния копил бы мусор, а разбираться в нём было бы некому.
        let dir = std::env::temp_dir().join(format!("mwm-state-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("state.json");
        let mut slots = BTreeMap::new();
        slots.insert(SID.to_string(), slot());
        write_atomic(&path, &state_json(&slots)).expect("запись обязана удаться");
        assert_eq!(read_state(&path), slots);
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left.len(), 1, "рядом с файлом ничего не осталось: {left:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_file_is_moved_aside_and_the_tracker_starts() {
        // Рваный файл не должен мешать старту: раскладка забыта, работа
        // продолжается. Но байты отодвигаются, а не удаляются — они могут ещё
        // пригодиться тому, кто будет разбираться.
        let dir = std::env::temp_dir().join(format!("mwm-state-broken-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        std::fs::write(&path, "{ порвано").unwrap();
        assert!(read_state(&path).is_empty());
        assert!(dir.join("state.json.bak").exists(), "байты отодвинуты, а не выброшены");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_is_an_empty_state_not_an_error() {
        let path = std::env::temp_dir().join("mwm-state-does-not-exist-at-all.json");
        let _ = std::fs::remove_file(&path);
        assert!(read_state(&path).is_empty());
    }
}
```

В `crates/mwm-core/src/lib.rs` дописать `pub mod state;`.

- [x] **Step 2: Прогнать и убедиться, что падает**

Run: `cargo test -p mwm-core`
Expected: FAIL — паника `not yet implemented`.

- [x] **Step 3: Реализовать**

```rust
/// Версия формата. Пишется, но не проверяется: читатель здесь один и тот же
/// процесс, а поле пригодится тому, кто будет разбирать файл руками.
const VERSION: u64 = 1;

fn bounds_from(v: &serde_json::Value) -> Option<Bounds> {
    let o = v.as_object()?;
    let n = |k: &str| o.get(k).and_then(|x| x.as_i64()).and_then(|x| i32::try_from(x).ok());
    Some(Bounds { x: n("x")?, y: n("y")?, width: n("width")?, height: n("height")? })
}

pub fn parse_state(json: &str) -> BTreeMap<String, SlotState> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return BTreeMap::new();
    };
    let Some(slots) = v.get("slots").and_then(|s| s.as_object()) else {
        return BTreeMap::new();
    };
    let mut out = BTreeMap::new();
    for (sid, rec) in slots {
        if sid.is_empty() {
            continue;
        }
        let text = |k: &str| {
            rec.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string()
        };
        let num = |k: &str| rec.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        out.insert(
            sid.clone(),
            SlotState {
                bounds: rec.get("bounds").and_then(bounds_from),
                title: text("title"),
                cwd: text("cwd"),
                last_seen_ms: num("lastSeen"),
                focused_at_ms: num("focusedAt"),
            },
        );
    }
    out
}

pub fn state_json(slots: &BTreeMap<String, SlotState>) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    for (sid, s) in slots {
        out.insert(
            sid.clone(),
            json!({
                "bounds": s.bounds.map(|b| json!({
                    "x": b.x, "y": b.y, "width": b.width, "height": b.height
                })),
                "title": s.title,
                "cwd": s.cwd,
                "lastSeen": s.last_seen_ms,
                "focusedAt": s.focused_at_ms,
            }),
        );
    }
    json!({ "version": VERSION, "slots": out })
}

pub fn read_state(path: &Path) -> BTreeMap<String, SlotState> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    if serde_json::from_str::<serde_json::Value>(&text).is_err() {
        // Отодвигаем, а не удаляем: трекер обязан подняться, но байты могут
        // ещё пригодиться тому, кто будет разбираться.
        let bak = path.with_extension("json.bak");
        if let Err(e) = std::fs::rename(path, &bak) {
            eprintln!("mwm: broken state file, and moving it aside failed: {e}");
        } else {
            eprintln!("mwm: broken state file, moved to {}", bak.display());
        }
        return BTreeMap::new();
    }
    parse_state(&text)
}

/// Атомарная запись: временный файл рядом, `fsync`, потом переименование.
///
/// `fsync` — это и есть смысл упражнения. Переименование журналируется, а
/// данные нет, и без него потеря питания оставляет рваный файл; рваный файл
/// стоит запомненной раскладки, ради которой всё и затевалось.
pub fn write_atomic(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    use std::io::Write;
    let dir = path.parent().ok_or("state path has no parent directory")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create state dir: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("create temp state: {e}"))?;
        f.write_all(value.to_string().as_bytes())
            .map_err(|e| format!("write temp state: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync temp state: {e}"))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("rename temp state: {e}"))
}
```

- [x] **Step 4: Прогнать**

Run: `cargo test -p mwm-core`
Expected: PASS

- [x] **Step 5: Коммит**

```bash
git add crates/mwm-core/src/state.rs crates/mwm-core/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(state): слоты сессий переживают перезапуск

Запись атомарная с fsync: переименование журналируется, а данные нет, и без
него потеря питания оставляет рваный файл — то есть забытую раскладку.
Отметка взгляда переезжает на диск заодно: иначе перезапуск трекера показывал
бы человеку все сессии непрочитанными разом.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Индекс отдаёт и каталог

**Repo:** `~/projects/js/macos-windows-manager`

**Files:**
- Modify: `crates/mwm-core/src/index.rs`
- Modify: `crates/mwm-core/src/tracker.rs` — ровно настолько, чтобы собралось (шаг 4)

**Interfaces:**
- Produces: `pub struct SessionRef { pub id: String, pub cwd: String }` с `#[derive(Debug, Clone, PartialEq, Eq)]`; `parse_index` меняет тип на `BTreeMap<String, SessionRef>`.

**Контекст:** каталог нужен снимку. Сессия из снимка может быть уже неизвестна агрегатору — снимки затем и существуют, — и пикеру взять каталог будет неоткуда. В дампе агрегатора (`~/.ccfzf.sessions.json`) поле `cwd` у каждой сессии уже есть.

**Внимание:** смена типа ломает вызов в `tracker.rs` и все существующие тесты этого файла. Тесты правятся в этой же задаче: они распаковывают `Some(&A.to_string())`, а станут распаковывать `SessionRef`. `tracker.rs` в этой задаче правится ровно настолько, чтобы собраться — там `index.get(&key)` даёт теперь `SessionRef`, и берётся у него `.id`; всё остальное про трекер — задача 4.

- [x] **Step 1: Переписать тесты под новый тип**

В `mod tests` файла `index.rs` заменить обращения вида `idx.get("ccfzf")` на сравнение с `SessionRef`. Помощник рядом с тестами:

```rust
    fn r(id: &str, cwd: &str) -> SessionRef {
        SessionRef { id: id.to_string(), cwd: cwd.to_string() }
    }
```

Правки в существующих тестах — механические:

```rust
    #[test]
    fn titles_map_to_sessions() {
        let idx = parse_index(&format!(
            r#"{{"sessions":[{{"id":"{A}","title":"ccfzf"}},{{"id":"{B}","title":"other"}}]}}"#
        ));
        assert_eq!(idx.get("ccfzf"), Some(&r(A, "")));
        assert_eq!(idx.get("other"), Some(&r(B, "")));
    }

    #[test]
    fn title_is_stored_stripped() {
        let idx = parse_index(&format!(r#"{{"sessions":[{{"id":"{A}","title":"✳ ccfzf"}}]}}"#));
        assert_eq!(idx.get("ccfzf"), Some(&r(A, "")));
    }
```

В `twins_go_to_the_livelier_one` заменить `Some(&B.to_string())` на `Some(&r(B, ""))` и `Some(&D.to_string())` на `Some(&r(D, ""))`, сохранив оба пояснения в `assert` дословно. В `blank_title_or_id_is_skipped_but_document_still_parses` заменить `Some(&B.to_string())` на `Some(&r(B, ""))`. Тесты `garbage_costs_itself_and_nothing_more` правки не требуют — он смотрит только на длину.

Дописать новый тест:

```rust
    #[test]
    fn the_working_directory_travels_with_the_session() {
        // Каталог нужен снимку: сессия из снимка может быть уже неизвестна
        // агрегатору — снимки затем и есть, — и пикеру взять каталог будет
        // неоткуда.
        let idx = parse_index(&format!(
            r#"{{"sessions":[{{"id":"{A}","title":"ccfzf","cwd":"~/projects/js/ccfzf-picker"}}]}}"#
        ));
        assert_eq!(idx.get("ccfzf"), Some(&r(A, "~/projects/js/ccfzf-picker")));
    }

    #[test]
    fn a_session_without_a_directory_is_still_a_session() {
        // Каталога может не быть вовсе — это не повод терять привязку окна.
        let idx = parse_index(&format!(r#"{{"sessions":[{{"id":"{A}","title":"ccfzf","cwd":17}}]}}"#));
        assert_eq!(idx.get("ccfzf"), Some(&r(A, "")));
    }
```

- [x] **Step 2: Прогнать и убедиться, что падает**

Run: `cargo test -p mwm-core`
Expected: FAIL — `SessionRef` не объявлен.

- [x] **Step 3: Реализовать**

Над `parse_index` добавить тип и поправить тело:

```rust
/// Сессия, какой её знает дамп агрегатора.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRef {
    pub id: String,
    /// Каталог проекта. Пустая строка — дамп его не назвал.
    pub cwd: String,
}
```

```rust
pub fn parse_index(json: &str) -> BTreeMap<String, SessionRef> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return BTreeMap::new();
    };
    let mut out: BTreeMap<String, (SessionRef, f64)> = BTreeMap::new();
    for s in v.get("sessions").and_then(|s| s.as_array()).into_iter().flatten() {
        let (Some(id), Some(title)) = (
            s.get("id").and_then(|x| x.as_str()),
            s.get("title").and_then(|x| x.as_str()),
        ) else {
            continue;
        };
        let key = strip_decoration(title);
        if key.is_empty() || id.is_empty() {
            continue;
        }
        let cwd = s.get("cwd").and_then(|x| x.as_str()).unwrap_or_default().to_string();
        let activity = s.get("activityAt").and_then(|x| x.as_f64()).unwrap_or(0.0);
        // Тёзки: побеждает свежесть активности. Иначе только что открытая
        // сессия проигрывала бы суточной тёзке навсегда.
        match out.get(&key) {
            Some((_, prev)) if *prev >= activity => {}
            _ => {
                out.insert(key, (SessionRef { id: id.to_string(), cwd }, activity));
            }
        }
    }
    out.into_iter().map(|(k, (r, _))| (k, r)).collect()
}
```

Doc-комментарий функции поправить: «заголовок → id сессии» становится «заголовок → сессия: id и каталог».

- [x] **Step 4: Починить вызов в `tracker.rs`**

Тип параметра `index` в `Tracker::tick` меняется на `&BTreeMap<String, SessionRef>`; строка `t.session_id = Some(sid.clone());` становится `t.session_id = Some(sid.id.clone());`. Помощник `index(...)` в тестах `tracker.rs` меняет тип значения:

```rust
    fn index(pairs: &[(&str, &str)]) -> BTreeMap<String, crate::index::SessionRef> {
        pairs
            .iter()
            .map(|(t, s)| {
                (t.to_string(), crate::index::SessionRef { id: s.to_string(), cwd: String::new() })
            })
            .collect()
    }
```

Больше в `tracker.rs` на этом шаге ничего не трогать.

- [x] **Step 5: Прогнать**

Run: `cargo test -p mwm-core && cargo test -p macos-windows-manager`
Expected: PASS оба

- [x] **Step 6: Коммит**

```bash
git add crates/mwm-core/src/index.rs crates/mwm-core/src/tracker.rs
git commit -m "$(cat <<'EOF'
feat(index): дамп отдаёт и каталог сессии, не только id

Каталог нужен снимку: сессия из снимка может быть уже неизвестна агрегатору —
снимки затем и есть, — и пикеру взять каталог будет неоткуда.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Трекер помнит место и просит его вернуть

**Repo:** `~/projects/js/macos-windows-manager`

**Files:**
- Modify: `crates/mwm-core/src/tracker.rs`
- Modify: `src-tauri/src/ax.rs` — заглушка `bounds: None` в `Seen` (шаг 4); настоящую геометрию туда поставит задача 7

**Interfaces:**
- Consumes: `crate::geometry::Bounds` (задача 1), `crate::state::SlotState` (задача 2), `crate::index::SessionRef` (задача 3).
- Produces:
  - `Seen` получает поле `pub bounds: Option<Bounds>`
  - `pub fn placements(&self) -> Vec<(u64, Bounds)>` — какие окна поставить и куда
  - `pub fn take_dirty(&mut self) -> bool` — менялись ли слоты с прошлого спроса
  - `pub fn slots_state(&self) -> BTreeMap<String, SlotState>`
  - `pub fn load_slots(&mut self, slots: BTreeMap<String, SlotState>)`
  - `pub fn open_session_ids(&self) -> Vec<String>`

**Контекст:** это сердце этапа. Три правила, и каждое стоит починенной поломки, если его нарушить: ставится окно, которое **появилось** (а не любое незнакомое); первый такт не ставит ничего; новое положение попадает в слот только когда устоялось.

- [x] **Step 1: Написать падающие тесты**

Дописать в `mod tests` файла `tracker.rs`:

```rust
    fn seen_at(id: u64, title: &str, b: Bounds) -> Seen {
        Seen { id, title: title.to_string(), focused: false, bounds: Some(b) }
    }

    fn rect(x: i32, y: i32) -> Bounds {
        Bounds { x, y, width: 800, height: 600 }
    }

    #[test]
    fn an_appearing_window_is_asked_to_go_back_where_it_was() {
        // Ради этого весь этап: сессию открыли заново, окно встаёт туда же.
        let mut t = Tracker::new(1);
        let idx = index(&[("ccfzf", SID)]);
        let mut slots = BTreeMap::new();
        slots.insert(SID.to_string(), SlotState {
            bounds: Some(rect(100, 100)), ..Default::default()
        });
        t.load_slots(slots);
        // Первый такт после запуска не ставит ничего — правило ниже.
        t.tick(&[], &idx, 1_000);
        t.tick(&[seen_at(1, "ccfzf", rect(700, 700))], &idx, 2_000);
        assert_eq!(t.placements(), vec![(1, rect(100, 100))]);
    }

    #[test]
    fn the_first_tick_after_start_places_nothing() {
        // Перезапуск трекера случается на каждой выкатке. Без этого правила он
        // сгребал бы все открытые окна по вчерашним местам — включая те, что
        // человек только что подвинул сам.
        let mut t = Tracker::new(1);
        let idx = index(&[("ccfzf", SID)]);
        let mut slots = BTreeMap::new();
        slots.insert(SID.to_string(), SlotState {
            bounds: Some(rect(100, 100)), ..Default::default()
        });
        t.load_slots(slots);
        t.tick(&[seen_at(1, "ccfzf", rect(700, 700))], &idx, 1_000);
        assert!(t.placements().is_empty(), "первый такт не расставляет");
    }

    #[test]
    fn a_window_already_in_place_is_not_touched() {
        // Просьба к платформе стоит вызова Accessibility, а он синхронный.
        // Двигать окно туда, где оно уже стоит, — это плата ни за что.
        let mut t = Tracker::new(1);
        let idx = index(&[("ccfzf", SID)]);
        let mut slots = BTreeMap::new();
        slots.insert(SID.to_string(), SlotState {
            bounds: Some(rect(100, 100)), ..Default::default()
        });
        t.load_slots(slots);
        t.tick(&[], &idx, 1_000);
        t.tick(&[seen_at(1, "ccfzf", rect(100, 100))], &idx, 2_000);
        assert!(t.placements().is_empty());
    }

    #[test]
    fn a_window_that_stayed_is_not_placed_again() {
        // Ставится появившееся окно, а не любое видимое. Иначе трекер воевал бы
        // с человеком за каждое перетаскивание — и победил бы трекер.
        let mut t = Tracker::new(1);
        let idx = index(&[("ccfzf", SID)]);
        let mut slots = BTreeMap::new();
        slots.insert(SID.to_string(), SlotState {
            bounds: Some(rect(100, 100)), ..Default::default()
        });
        t.load_slots(slots);
        t.tick(&[], &idx, 1_000);
        t.tick(&[seen_at(1, "ccfzf", rect(700, 700))], &idx, 2_000);
        assert_eq!(t.placements().len(), 1);
        t.tick(&[seen_at(1, "ccfzf", rect(700, 700))], &idx, 3_000);
        assert!(t.placements().is_empty(), "окно уже было в прошлом такте");
    }

    #[test]
    fn a_session_seen_for_the_first_time_is_left_where_it_opened() {
        let mut t = Tracker::new(1);
        let idx = index(&[("ccfzf", SID)]);
        t.tick(&[], &idx, 1_000);
        t.tick(&[seen_at(1, "ccfzf", rect(700, 700))], &idx, 2_000);
        assert!(t.placements().is_empty(), "координат не помним — двигать некуда");
    }

    #[test]
    fn a_moved_window_is_remembered_only_after_it_settles() {
        // Пока окно тащат мышкой, координаты меняются каждый такт. Записывать
        // их немедленно значило бы звать fsync на каждый такт перетаскивания.
        let mut t = Tracker::new(2);
        let idx = index(&[("ccfzf", SID)]);
        t.tick(&[seen_at(1, "ccfzf", rect(0, 0))], &idx, 1_000);
        t.tick(&[seen_at(1, "ccfzf", rect(0, 0))], &idx, 2_000);
        assert_eq!(t.slots_state()[SID].bounds, Some(rect(0, 0)));
        // Потащили: два разных положения подряд, ни одно не устоялось.
        t.tick(&[seen_at(1, "ccfzf", rect(50, 0))], &idx, 3_000);
        t.tick(&[seen_at(1, "ccfzf", rect(120, 0))], &idx, 4_000);
        assert_eq!(t.slots_state()[SID].bounds, Some(rect(0, 0)), "на лету не запоминаем");
        // Отпустили: положение повторилось нужное число тактов.
        t.tick(&[seen_at(1, "ccfzf", rect(200, 0))], &idx, 5_000);
        t.tick(&[seen_at(1, "ccfzf", rect(200, 0))], &idx, 6_000);
        assert_eq!(t.slots_state()[SID].bounds, Some(rect(200, 0)), "устоялось — запомнили");
    }

    #[test]
    fn the_state_is_written_only_when_something_changed() {
        // Файл пишется с fsync. Писать его на каждом такте — плата за то, что
        // не изменилось.
        let mut t = Tracker::new(1);
        let idx = index(&[("ccfzf", SID)]);
        t.tick(&[seen_at(1, "ccfzf", rect(0, 0))], &idx, 1_000);
        assert!(t.take_dirty(), "первое появление слота — изменение");
        assert!(!t.take_dirty(), "спросили дважды — второй раз чисто");
        t.tick(&[seen_at(1, "ccfzf", rect(0, 0))], &idx, 2_000);
        assert!(!t.take_dirty(), "ничего не менялось");
        t.tick(&[seen_at(1, "ccfzf", rect(300, 300))], &idx, 3_000);
        assert!(t.take_dirty(), "координаты устоялись на новом месте");
    }

    #[test]
    fn the_working_directory_reaches_the_slot() {
        // Оттуда его возьмёт снимок.
        let mut t = Tracker::new(1);
        let mut idx = BTreeMap::new();
        idx.insert("ccfzf".to_string(), crate::index::SessionRef {
            id: SID.to_string(),
            cwd: "~/projects/js/ccfzf-picker".to_string(),
        });
        t.tick(&[seen_at(1, "ccfzf", rect(0, 0))], &idx, 1_000);
        assert_eq!(t.slots_state()[SID].cwd, "~/projects/js/ccfzf-picker");
    }

    #[test]
    fn a_loaded_focus_stamp_is_not_forgotten() {
        // Отметка взгляда переживает перезапуск: иначе после каждой выкатки
        // человек видел бы все сессии непрочитанными разом.
        let mut t = Tracker::new(1);
        let idx = index(&[("ccfzf", SID)]);
        let mut slots = BTreeMap::new();
        slots.insert(SID.to_string(), SlotState { focused_at_ms: 4_000, ..Default::default() });
        t.load_slots(slots);
        t.tick(&[seen_at(1, "ccfzf", rect(0, 0))], &idx, 9_000);
        assert_eq!(t.bound()[SID].focused_at_ms, 4_000);
    }

    #[test]
    fn open_sessions_are_listed_for_the_snapshotter() {
        let mut t = Tracker::new(1);
        let idx = index(&[("ccfzf", SID)]);
        t.tick(&[seen_at(1, "ccfzf", rect(0, 0))], &idx, 1_000);
        assert_eq!(t.open_session_ids(), vec![SID.to_string()]);
    }
```

В шапку `mod tests` дописать `use crate::geometry::Bounds;` и `use crate::state::SlotState;`. Существующий помощник `seen(id, title)` дополнить полем: `Seen { id, title: title.to_string(), focused: false, bounds: None }`, а все места, где `Seen` строится в тестах литералом (`Seen { id: 1, title: "ccfzf".into(), focused: true }`), дополнить `bounds: None`.

- [x] **Step 2: Прогнать и убедиться, что падает**

Run: `cargo test -p mwm-core`
Expected: FAIL — у `Seen` нет поля `bounds`, у `Tracker` нет `placements`.

- [x] **Step 3: Реализовать**

Шапка файла — дописать `use crate::geometry::Bounds;`, `use crate::index::SessionRef;`, `use crate::state::SlotState;`, `use std::collections::HashSet;`.

`Seen` получает поле:

```rust
pub struct Seen {
    /// Устойчив в пределах жизни трекера и больше нигде не нужен: в
    /// публикуемом файле идентификатора окна нет вовсе.
    pub id: u64,
    pub title: String,
    pub focused: bool,
    /// Где окно стоит сейчас. `None` — платформа не ответила; это норма такта,
    /// а не сбой, и стоит она ровно того, что положение в этот такт не
    /// обновится.
    pub bounds: Option<Bounds>,
}
```

`Slot` заменить целиком:

```rust
/// Слот переживает закрытие окна: он затем и заведён, чтобы вернуть сессию на
/// прежнее место и удержать привязку, пока заголовок меняется.
///
/// Устойчивое положение и то, что видно сейчас, разведены намеренно. Пока окно
/// тащат мышкой, координаты меняются каждый такт, а запоминать их значило бы
/// звать `fsync` на каждый такт перетаскивания.
#[derive(Debug, Default, Clone)]
struct Slot {
    focused_at_ms: u64,
    bounds: Option<Bounds>,
    pending: Option<Bounds>,
    pending_ticks: u32,
    title: String,
    cwd: String,
    last_seen_ms: u64,
}
```

`Tracker` получает поля:

```rust
pub struct Tracker {
    stable_ticks: u32,
    windows: HashMap<u64, Tracked>,
    slots: HashMap<String, Slot>,
    bound: BTreeMap<String, Bound>,
    unresolved: Vec<String>,
    /// Окна прошлого такта: по ним и только по ним видно, что окно появилось.
    prev_ids: HashSet<u64>,
    /// Первый такт после запуска не расставляет ничего. Отдельное правило, а не
    /// следствие: на первом такте прошлого такта нет, и все открытые окна
    /// выглядят только что появившимися.
    started: bool,
    placements: Vec<(u64, Bounds)>,
    dirty: bool,
}
```

В `Tracker::new` добавить `prev_ids: HashSet::new(), started: false, placements: Vec::new(), dirty: false`.

В `tick` изменения по порядку.

Сигнатура: `pub fn tick(&mut self, seen: &[Seen], index: &BTreeMap<String, SessionRef>, now_ms: u64)`.

Сразу после `self.unresolved.clear();` дописать:

```rust
        self.placements.clear();
        let appeared_ok = self.started;
        let prev: HashSet<u64> = std::mem::take(&mut self.prev_ids);
        self.prev_ids = seen.iter().map(|w| w.id).collect();
        self.started = true;
```

Блок после `let Some(sid) = t.session_id.clone() else { continue };` заменить на:

```rust
            let appeared = appeared_ok && !prev.contains(&w.id);
            let slot = self.slots.entry(sid.clone()).or_default();
            if w.focused && slot.focused_at_ms != now_ms {
                slot.focused_at_ms = now_ms;
                // Отметка взгляда живёт на диске — значит её смена и есть повод
                // файл переписать. Без этой строки перезапуск трекера показывал
                // бы человеку непрочитанным всё, на что он смотрел с прошлой
                // записи файла.
                self.dirty = true;
            }
            // `lastSeen` растёт каждый такт и поводом для записи не считается:
            // считался бы — файл писался бы с `fsync` раз в секунду вечно. На
            // диск он попадает попутно, когда файл переписывают по другой
            // причине, и этого достаточно: читает его один и тот же процесс.
            slot.last_seen_ms = now_ms;
            if slot.title != key {
                slot.title = key.clone();
                self.dirty = true;
            }
            if let Some(r) = index.get(&key) {
                if !r.cwd.is_empty() && slot.cwd != r.cwd {
                    slot.cwd = r.cwd.clone();
                    self.dirty = true;
                }
            }
            // Расстановка спрашивается до того, как слот примет нынешние
            // координаты: иначе он ответил бы «окно уже там, где нужно».
            if appeared {
                if let (Some(want), Some(now_at)) = (slot.bounds, w.bounds) {
                    if want != now_at {
                        self.placements.push((w.id, want));
                    }
                }
            }
            if let Some(b) = w.bounds {
                if slot.pending == Some(b) {
                    slot.pending_ticks += 1;
                } else {
                    slot.pending = Some(b);
                    slot.pending_ticks = 1;
                }
                if slot.pending_ticks >= self.stable_ticks && slot.bounds != Some(b) {
                    slot.bounds = Some(b);
                    self.dirty = true;
                }
            }
            self.bound.insert(
                sid.clone(),
                Bound {
                    session_id: sid,
                    title: key,
                    last_seen_ms: now_ms,
                    focused_at_ms: slot.focused_at_ms,
                },
            );
```

Новые методы рядом с `bound()`:

```rust
    /// Какие окна поставить на место и куда. Пусто — ставить нечего.
    ///
    /// Список живёт один такт: он про окна, появившиеся именно сейчас.
    pub fn placements(&self) -> Vec<(u64, Bounds)> {
        self.placements.clone()
    }

    /// Менялись ли слоты с прошлого вопроса. Спрашивается перед записью файла:
    /// он пишется с `fsync`, и писать его на каждом такте — плата за то, что не
    /// изменилось.
    pub fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    /// Слоты в том виде, в каком они уезжают на диск.
    pub fn slots_state(&self) -> BTreeMap<String, SlotState> {
        self.slots
            .iter()
            .map(|(sid, s)| {
                (
                    sid.clone(),
                    SlotState {
                        bounds: s.bounds,
                        title: s.title.clone(),
                        cwd: s.cwd.clone(),
                        last_seen_ms: s.last_seen_ms,
                        focused_at_ms: s.focused_at_ms,
                    },
                )
            })
            .collect()
    }

    /// Поднять слоты с диска. Зовётся один раз при старте, до первого такта.
    ///
    /// `pending` не восстанавливается намеренно: устойчивость меряется тактами
    /// этого запуска, а прошлый запуск про них ничего не знает.
    pub fn load_slots(&mut self, slots: BTreeMap<String, SlotState>) {
        for (sid, s) in slots {
            self.slots.insert(
                sid,
                Slot {
                    focused_at_ms: s.focused_at_ms,
                    bounds: s.bounds,
                    pending: None,
                    pending_ticks: 0,
                    title: s.title,
                    cwd: s.cwd,
                    last_seen_ms: s.last_seen_ms,
                },
            );
        }
    }

    /// Сессии, у которых окно открыто на этом такте. Из них снапшотер собирает
    /// состав раскладки.
    pub fn open_session_ids(&self) -> Vec<String> {
        self.bound.keys().cloned().collect()
    }
```

В `mark_unread` дописать в конец, перед закрывающей скобкой, отметку изменения:

```rust
        self.dirty = true;
```

- [x] **Step 4: Прогнать**

Run: `cargo test -p mwm-core && cargo test -p macos-windows-manager`
Expected: FAIL у второго — `ax.rs` строит `Seen` без поля `bounds`. Починить там одной строкой: в `list_windows` в `out.push(Seen { id, focused, title })` дописать `bounds: None` (настоящая геометрия — задача 7). Прогнать снова: PASS оба.

- [x] **Step 5: Коммит**

```bash
git add crates/mwm-core/src/tracker.rs src-tauri/src/ax.rs
git commit -m "$(cat <<'EOF'
feat(tracker): слот помнит место окна, а появившееся окно просится назад

Три правила, и каждое стоит поломки, если его нарушить: ставится окно, которое
появилось, а не любое незнакомое; первый такт после запуска не ставит ничего —
иначе перезапуск сгребал бы окна по вчерашним местам; новое положение попадает
в слот только когда устоялось — иначе fsync звался бы на каждый такт
перетаскивания.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Снимки — решение, дебаунс, обрезка

**Repo:** `~/projects/js/macos-windows-manager`

**Files:**
- Create: `crates/mwm-core/src/snapshots.rs`
- Modify: `crates/mwm-core/src/lib.rs`

**Interfaces:**
- Consumes: `crate::geometry::Bounds` (задача 1), `crate::state::SlotState` (задача 2).
- Produces:
  - `pub struct SnapshotSession { pub id: String, pub title: String, pub cwd: String, pub bounds: Bounds }`
  - `pub struct Snapshot { pub id: String, pub created_s: u64, pub updated_s: u64, pub sessions: Vec<SnapshotSession> }`
  - `pub enum Decision { Append, Update }`
  - `pub const DEBOUNCE_MS: u64 = 60_000;` и `pub const KEEP: usize = 20;`
  - `pub fn composition_key(ids: &[String]) -> String`
  - `pub fn decide(key: &str, last_key: &str, pending_key: &str, pending_since_ms: u64, now_ms: u64, debounce_ms: u64) -> Option<Decision>`
  - `pub fn track_composition(key: &str, pending_key: &str, pending_since_ms: u64, now_ms: u64) -> (String, u64)`
  - `pub fn sessions_of(open: &[String], slots: &BTreeMap<String, SlotState>) -> Vec<SnapshotSession>`
  - `pub fn append(snapshots: Vec<Snapshot>, id: String, sessions: Vec<SnapshotSession>, now_s: u64, keep: usize) -> Vec<Snapshot>`
  - `pub fn update_last(snapshots: Vec<Snapshot>, sessions: Vec<SnapshotSession>, now_s: u64) -> Vec<Snapshot>`
  - `pub fn snapshot_id(now_s: u64) -> String`

**Контекст:** это перенос уже отстоявшейся логики из `windows11-manager/src/claude-wt/snapshot-helpers.js`. Умолчания те же и это не совпадение: списки лежат рядом в одном режиме пикера, и разное поведение читалось бы как поломка.

- [x] **Step 1: Написать падающие тесты**

Создать `crates/mwm-core/src/snapshots.rs` — шапка, типы, константы, `todo!()` в телах, тесты:

```rust
//! Снимки раскладки: когда снимать, что снимать, сколько хранить.
//!
//! Перенос логики, отстоявшейся в windows11-manager: списки снимков лежат в
//! одном режиме пикера, и разное поведение двух машин читалось бы как поломка.

use crate::geometry::Bounds;
use crate::state::SlotState;
use std::collections::BTreeMap;

/// Сколько состав должен продержаться, чтобы стать снимком.
pub const DEBOUNCE_MS: u64 = 60_000;

/// Сколько снимков хранится. Дальше — вытесняются с хвоста.
pub const KEEP: usize = 20;

#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotSession {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub bounds: Bounds,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub id: String,
    pub created_s: u64,
    pub updated_s: u64,
    pub sessions: Vec<SnapshotSession>,
}

/// Что снапшотер должен сделать на этом такте.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Состав устоялся после изменения — новый снимок.
    Append,
    /// Состав тот же, съехали координаты — переписать последний.
    Update,
}

pub fn composition_key(ids: &[String]) -> String {
    todo!()
}

pub fn decide(
    key: &str,
    last_key: &str,
    pending_key: &str,
    pending_since_ms: u64,
    now_ms: u64,
    debounce_ms: u64,
) -> Option<Decision> {
    todo!()
}

pub fn track_composition(
    key: &str,
    pending_key: &str,
    pending_since_ms: u64,
    now_ms: u64,
) -> (String, u64) {
    todo!()
}

pub fn sessions_of(open: &[String], slots: &BTreeMap<String, SlotState>) -> Vec<SnapshotSession> {
    todo!()
}

pub fn append(
    snapshots: Vec<Snapshot>,
    id: String,
    sessions: Vec<SnapshotSession>,
    now_s: u64,
    keep: usize,
) -> Vec<Snapshot> {
    todo!()
}

pub fn update_last(
    snapshots: Vec<Snapshot>,
    sessions: Vec<SnapshotSession>,
    now_s: u64,
) -> Vec<Snapshot> {
    todo!()
}

pub fn snapshot_id(now_s: u64) -> String {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaa-1111-2222-3333-444444444444";
    const B: &str = "bbbbbbbb-1111-2222-3333-444444444444";

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn rect(x: i32) -> Bounds {
        Bounds { x, y: 0, width: 800, height: 600 }
    }

    fn slots(list: &[(&str, Option<Bounds>)]) -> BTreeMap<String, SlotState> {
        list.iter()
            .map(|(sid, b)| {
                (
                    sid.to_string(),
                    SlotState {
                        bounds: *b,
                        title: "ccfzf".to_string(),
                        cwd: "~/projects/js/ccfzf-picker".to_string(),
                        last_seen_ms: 1_000,
                        focused_at_ms: 0,
                    },
                )
            })
            .collect()
    }

    fn snap(id: &str, created: u64, sessions: Vec<SnapshotSession>) -> Snapshot {
        Snapshot { id: id.to_string(), created_s: created, updated_s: created, sessions }
    }

    fn session(id: &str, x: i32) -> SnapshotSession {
        SnapshotSession {
            id: id.to_string(),
            title: "ccfzf".to_string(),
            cwd: "~/projects/js/ccfzf-picker".to_string(),
            bounds: rect(x),
        }
    }

    #[test]
    fn the_key_does_not_depend_on_the_order() {
        // Порядок сессий задан обходом окон и меняется сам по себе. Ключ,
        // зависящий от него, объявлял бы новый состав на ровном месте.
        assert_eq!(composition_key(&ids(&[A, B])), composition_key(&ids(&[B, A])));
    }

    #[test]
    fn an_empty_composition_is_never_snapshotted() {
        // Закрыл всё на ночь — наутро восстанавливается последний рабочий
        // набор, а не пустота.
        assert_eq!(decide("", "anything", "", 0, 10_000, DEBOUNCE_MS), None);
    }

    #[test]
    fn the_same_composition_only_updates_coordinates() {
        // Окно подвинули, состав тот же. Новой строчки в списке быть не должно,
        // иначе таскание окна мышкой плодило бы снимки, и список стал бы
        // нечитаемым за один день.
        assert_eq!(decide("k", "k", "", 0, 10_000, DEBOUNCE_MS), Some(Decision::Update));
    }

    #[test]
    fn a_new_composition_waits_for_the_debounce() {
        // Пока открываются три сессии подряд, промежуточные конфигурации в
        // историю не попадают.
        assert_eq!(decide("new", "old", "new", 1_000, 1_000 + DEBOUNCE_MS - 1, DEBOUNCE_MS), None);
        assert_eq!(
            decide("new", "old", "new", 1_000, 1_000 + DEBOUNCE_MS, DEBOUNCE_MS),
            Some(Decision::Append)
        );
    }

    #[test]
    fn a_composition_that_only_just_changed_waits_a_full_round() {
        // Ключ ещё не в ожидании — таймер начнётся с этого такта, а решения
        // сейчас нет.
        assert_eq!(decide("new", "old", "другой", 1_000, 999_000, DEBOUNCE_MS), None);
    }

    #[test]
    fn the_timer_restarts_on_every_new_composition() {
        // Снимок фиксирует не момент изменения, а устоявшееся состояние.
        assert_eq!(track_composition("k", "k", 500, 9_000), ("k".to_string(), 500));
        assert_eq!(track_composition("k2", "k", 500, 9_000), ("k2".to_string(), 9_000));
    }

    #[test]
    fn a_session_without_coordinates_does_not_enter_a_snapshot() {
        // Записать её было бы нечестно: восстанавливать нечего, а строка в
        // списке появилась бы.
        let got = sessions_of(&ids(&[A, B]), &slots(&[(A, Some(rect(10))), (B, None)]));
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, A);
        assert_eq!(got[0].cwd, "~/projects/js/ccfzf-picker");
    }

    #[test]
    fn snapshot_sessions_are_ordered_by_id() {
        // Порядок обхода окон не наш и меняется. Отпечаток снимка не должен от
        // этого зависеть.
        let got = sessions_of(&ids(&[B, A]), &slots(&[(A, Some(rect(10))), (B, Some(rect(20)))]));
        assert_eq!(got.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec![A, B]);
    }

    #[test]
    fn a_new_snapshot_goes_to_the_head_and_the_tail_is_dropped() {
        let old = vec![snap("1", 100, vec![session(A, 0)]), snap("2", 90, vec![session(B, 0)])];
        let got = append(old, "3".to_string(), vec![session(A, 5)], 200, 2);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].id, "3");
        assert_eq!(got[1].id, "1", "вытеснился самый старый");
    }

    #[test]
    fn updating_the_last_one_keeps_its_id_and_creation_time() {
        // Иначе снимок «переезжал» бы в списке при каждом движении окна, и
        // выбрать «как было утром» стало бы невозможно.
        let old = vec![snap("1", 100, vec![session(A, 0)])];
        let got = update_last(old, vec![session(A, 400)], 300);
        assert_eq!(got[0].id, "1");
        assert_eq!(got[0].created_s, 100);
        assert_eq!(got[0].updated_s, 300);
        assert_eq!(got[0].sessions[0].bounds, rect(400));
    }

    #[test]
    fn updating_an_empty_list_does_nothing() {
        assert!(update_last(Vec::new(), vec![session(A, 0)], 300).is_empty());
    }

    #[test]
    fn the_id_is_readable_and_sorts_by_time() {
        // Идентификатор человек видит: он попадает в тело просьбы о
        // восстановлении и в жалобы. Непрозрачное число здесь стоило бы
        // лишнего шага при каждом разборе.
        assert_eq!(snapshot_id(0), "1970-01-01T00-00-00");
        assert_eq!(snapshot_id(1_765_000_000), "2025-12-06T05-46-40");
        assert!(snapshot_id(1_765_000_000) < snapshot_id(1_765_000_001));
    }
}
```

В `crates/mwm-core/src/lib.rs` дописать `pub mod snapshots;`.

- [x] **Step 2: Прогнать и убедиться, что падает**

Run: `cargo test -p mwm-core`
Expected: FAIL — паника `not yet implemented`.

- [x] **Step 3: Реализовать**

```rust
/// Ключ состава: отсортированные id через разделитель.
///
/// Сортировка обязательна: порядок сессий задан обходом окон и меняется сам по
/// себе, а ключ, зависящий от него, объявлял бы новый состав на ровном месте.
pub fn composition_key(ids: &[String]) -> String {
    let mut sorted: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
    sorted.sort_unstable();
    sorted.join("\u{1}")
}

/// Пустой состав не снимается вовсе: закрыл всё на ночь — наутро
/// восстанавливается последний рабочий набор, а не пустота.
pub fn decide(
    key: &str,
    last_key: &str,
    pending_key: &str,
    pending_since_ms: u64,
    now_ms: u64,
    debounce_ms: u64,
) -> Option<Decision> {
    if key.is_empty() {
        return None;
    }
    // Состав совпадает с последним снимком: остаются только координаты.
    if key == last_key {
        return if !pending_key.is_empty() && pending_key != key {
            None
        } else {
            Some(Decision::Update)
        };
    }
    // Состав другой — ждём, пока он устоится.
    if pending_key != key {
        return None;
    }
    if now_ms.saturating_sub(pending_since_ms) >= debounce_ms {
        Some(Decision::Append)
    } else {
        None
    }
}

/// Таймер перезапускается на каждое новое значение ключа: снимок фиксирует не
/// момент изменения, а устоявшееся состояние.
pub fn track_composition(
    key: &str,
    pending_key: &str,
    pending_since_ms: u64,
    now_ms: u64,
) -> (String, u64) {
    if key == pending_key {
        (pending_key.to_string(), pending_since_ms)
    } else {
        (key.to_string(), now_ms)
    }
}

/// Состав снимка из открытых сессий. Сессия без координат пропускается:
/// восстанавливать у неё нечего, а строка в списке появилась бы.
pub fn sessions_of(open: &[String], slots: &BTreeMap<String, SlotState>) -> Vec<SnapshotSession> {
    let mut ids: Vec<&String> = open.iter().collect();
    ids.sort_unstable();
    ids.dedup();
    ids.into_iter()
        .filter_map(|sid| {
            let s = slots.get(sid)?;
            Some(SnapshotSession {
                id: sid.clone(),
                title: s.title.clone(),
                cwd: s.cwd.clone(),
                bounds: s.bounds?,
            })
        })
        .collect()
}

/// Новый снимок в голову списка, лишние вытесняются с хвоста.
pub fn append(
    snapshots: Vec<Snapshot>,
    id: String,
    sessions: Vec<SnapshotSession>,
    now_s: u64,
    keep: usize,
) -> Vec<Snapshot> {
    let keep = if keep == 0 { KEEP } else { keep };
    let mut out = Vec::with_capacity(snapshots.len() + 1);
    out.push(Snapshot { id, created_s: now_s, updated_s: now_s, sessions });
    out.extend(snapshots);
    out.truncate(keep);
    out
}

/// Переписать координаты в последнем снимке.
///
/// Идентификатор и время создания сохраняются: иначе снимок «переезжал» бы в
/// списке при каждом движении окна, и выбрать «как было утром» стало бы
/// невозможно.
pub fn update_last(
    mut snapshots: Vec<Snapshot>,
    sessions: Vec<SnapshotSession>,
    now_s: u64,
) -> Vec<Snapshot> {
    if let Some(first) = snapshots.first_mut() {
        first.sessions = sessions;
        first.updated_s = now_s;
    }
    snapshots
}

/// Человекочитаемый идентификатор: время создания в UTC, без двоеточий.
///
/// UTC, а не местное время, и это осознанно: часового пояса в крейте нет, а
/// тянуть его ради строки, которую человек видит только в жалобах, незачем —
/// час и дату в списке пикер показывает из `created`, форматируя их у себя и в
/// местной зоне.
pub fn snapshot_id(now_s: u64) -> String {
    let days = (now_s / 86_400) as i64;
    let secs = now_s % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}-{:02}-{:02}",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

/// Дата из числа дней с эпохи. Алгоритм Хиннанта — тот же, что в `<chrono>`;
/// взят целиком, чтобы не тянуть крейт ради одной строки в час.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
```

- [x] **Step 4: Прогнать**

Run: `cargo test -p mwm-core`
Expected: PASS

- [x] **Step 5: Коммит**

```bash
git add crates/mwm-core/src/snapshots.rs crates/mwm-core/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(snapshots): решение о снимке, дебаунс состава и обрезка списка

Умолчания те же, что у windows11-manager, и это не совпадение: списки лежат
рядом в одном режиме пикера, и разное поведение читалось бы как поломка.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Снимки едут в файле окон, и конфиг знает пути

**Repo:** `~/projects/js/macos-windows-manager`

**Files:**
- Modify: `crates/mwm-core/src/publish.rs`
- Modify: `crates/mwm-core/src/config.rs`
- Modify: `src-tauri/src/main.rs` — седьмой аргумент `build_file` в вызове (шаг 5)

**Interfaces:**
- Consumes: `crate::snapshots::Snapshot` (задача 5).
- Produces:
  - `build_file(bound, host, pid, now_ms, can_focus, mqtt_base, snapshots: &[Snapshot]) -> serde_json::Value`
  - `Config` получает поля `pub state_path: String`, `pub snapshots_path: String`, `pub snapshots_keep: usize`, `pub snapshots_debounce_ms: u64`

- [x] **Step 1: Написать падающие тесты**

В `mod tests` файла `publish.rs` дописать помощник и тесты:

```rust
    use crate::geometry::Bounds;
    use crate::snapshots::{Snapshot, SnapshotSession};

    fn one_snapshot() -> Vec<Snapshot> {
        vec![Snapshot {
            id: "2026-08-14T02-15-30".to_string(),
            created_s: 1_765_000_000,
            updated_s: 1_765_000_600,
            sessions: vec![SnapshotSession {
                id: SID.to_string(),
                title: "ccfzf".to_string(),
                cwd: "~/projects/js/ccfzf-picker".to_string(),
                bounds: Bounds { x: 10, y: 20, width: 800, height: 600 },
            }],
        }]
    }

    #[test]
    fn snapshots_travel_in_the_window_file() {
        // Своей дороги у снимков нет и не заводится: читатель уже разбирает это
        // поле у Windows-трекера, а второй транспорт означал бы вторую точку
        // отказа ради тех же байтов.
        let v = build_file(&bound("ccfzf", 60_000), "mac-host", 7, 60_000, true, "", &one_snapshot());
        let snaps = v["snapshots"].as_array().unwrap();
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0]["id"], "2026-08-14T02-15-30");
        assert_eq!(snaps[0]["created"], 1_765_000_000_u64);
        assert_eq!(snaps[0]["sessions"][0]["id"], SID);
        assert_eq!(snaps[0]["sessions"][0]["cwd"], "~/projects/js/ccfzf-picker");
    }

    #[test]
    fn a_snapshot_session_carries_its_place() {
        // Координаты читателю не нужны — восстанавливает их та же машина, что
        // и сняла. Но в файле они есть: он же и есть хранилище снимков, а
        // второго у трекера нет.
        let v = build_file(&bound("ccfzf", 60_000), "mac-host", 7, 60_000, true, "", &one_snapshot());
        let b = &v["snapshots"][0]["sessions"][0]["bounds"];
        assert_eq!(b["x"], 10);
        assert_eq!(b["width"], 800);
    }

    #[test]
    fn no_snapshots_is_an_empty_list_not_a_missing_key() {
        // Отсутствие ключа читатель разберёт как «трекер прежней версии» и
        // промолчит.
        let v = build_file(&bound("ccfzf", 60_000), "mac-host", 7, 60_000, true, "", &[]);
        assert!(v["snapshots"].as_array().unwrap().is_empty());
    }
```

В `mod tests` файла `config.rs` дописать:

```rust
    #[test]
    fn state_paths_have_defaults() {
        // Трекер обязан работать с конфигом, в котором про состояние не сказано
        // ни слова: этап 3 добавил файлы, а конфиги у людей остались прежние.
        let c = parse_config("sshHost: remote-host\n", "mac-host");
        assert!(c.state_path.ends_with("macos-windows-manager/state.json"), "{}", c.state_path);
        assert!(c.snapshots_path.ends_with("macos-windows-manager/snapshots.json"), "{}", c.snapshots_path);
        assert_eq!(c.snapshots_keep, 20);
        assert_eq!(c.snapshots_debounce_ms, 60_000);
    }

    #[test]
    fn state_paths_can_be_moved() {
        let c = parse_config(
            "state:\n  path: /tmp/s.json\n  snapshotsPath: /tmp/snap.json\n  keep: 3\n  debounceMs: 5000\n",
            "mac-host",
        );
        assert_eq!(c.state_path, "/tmp/s.json");
        assert_eq!(c.snapshots_path, "/tmp/snap.json");
        assert_eq!(c.snapshots_keep, 3);
        assert_eq!(c.snapshots_debounce_ms, 5_000);
    }

    #[test]
    fn junk_in_one_state_field_does_not_cost_the_others() {
        // То же правило, что у остальных полей конфига: опечатка стоит поля, а
        // не всех настроек.
        let c = parse_config("state:\n  path: /tmp/s.json\n  keep: \"не число\"\n", "mac-host");
        assert_eq!(c.state_path, "/tmp/s.json");
        assert_eq!(c.snapshots_keep, 20);
    }
```

- [x] **Step 2: Прогнать и убедиться, что падает**

Run: `cargo test -p mwm-core`
Expected: FAIL — `build_file` принимает шесть аргументов, у `Config` нет полей состояния.

- [x] **Step 3: Реализовать в `publish.rs`**

Дописать параметр и сериализацию:

```rust
pub fn build_file(
    bound: &BTreeMap<String, Bound>,
    host: &str,
    pid: u32,
    now_ms: u64,
    can_focus: bool,
    mqtt_base: &str,
    snapshots: &[crate::snapshots::Snapshot],
) -> serde_json::Value {
```

В теле, перед сборкой итогового `json!`, добавить:

```rust
    let snaps: Vec<serde_json::Value> = snapshots
        .iter()
        .map(|s| {
            json!({
                "id": s.id,
                "created": s.created_s,
                "updated": s.updated_s,
                "sessions": s.sessions.iter().map(|m| json!({
                    "id": m.id,
                    "title": m.title,
                    "cwd": m.cwd,
                    "bounds": {
                        "x": m.bounds.x, "y": m.bounds.y,
                        "width": m.bounds.width, "height": m.bounds.height
                    },
                    // Виртуальных столов у macOS программно нет. Ключ есть,
                    // чтобы читатель разбирал запись тем же кодом, что и
                    // запись Windows-трекера.
                    "desktop": serde_json::Value::Null,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
```

и заменить `"snapshots": [],` на `"snapshots": snaps,`.

Doc-комментарий функции поправить: `snapshots` больше не пуст, и перечисление отличий от Windows-формата это учитывает.

- [x] **Step 4: Реализовать в `config.rs`**

В `Config` добавить поля:

```rust
    /// Где лежат слоты сессий. Не рядом с конфигом намеренно: конфиг человек
    /// правит руками, состояние пишет машина, и соседство приглашает спутать
    /// резервную копию одного с рабочим файлом другого.
    pub state_path: String,
    pub snapshots_path: String,
    pub snapshots_keep: usize,
    pub snapshots_debounce_ms: u64,
```

В `parse_config` перед сборкой `Config` — разбор по полям, как и всё остальное:

```rust
    let state_map = map
        .get("state")
        .and_then(|v| v.as_mapping())
        .cloned()
        .unwrap_or_default();
    let state_text = |key: &str| {
        state_map.get(key).and_then(|v| v.as_str()).unwrap_or_default().trim().to_string()
    };
    let state_dir = format!("{home}/.local/state/macos-windows-manager");
    let state_path = {
        let p = state_text("path");
        if p.is_empty() { format!("{state_dir}/state.json") } else { p }
    };
    let snapshots_path = {
        let p = state_text("snapshotsPath");
        if p.is_empty() { format!("{state_dir}/snapshots.json") } else { p }
    };
    let snapshots_keep = state_map
        .get("keep")
        .and_then(|v| v.as_u64())
        .and_then(|v| usize::try_from(v).ok())
        .filter(|v| *v > 0)
        .unwrap_or(crate::snapshots::KEEP);
    let snapshots_debounce_ms = state_map
        .get("debounceMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(crate::snapshots::DEBOUNCE_MS);
```

`parse_config` принимает только текст и имя машины, домашнего каталога у неё нет. Взять его прямо в функции, строкой выше разбора:

```rust
    // `HOME` на маке выставлен всегда — в отличие от Windows, где `load_config`
    // в пикере знает про запасной `USERPROFILE`. Пустая строка дала бы
    // относительный путь, и это заметили бы на первом же запуске: файл лёг бы
    // рядом с бинарём.
    let home = std::env::var("HOME").unwrap_or_default();
```

Добавить новые поля в возвращаемый `Config`.

- [x] **Step 5: Починить вызов `build_file` в `main.rs`**

Единственный вызов получает седьмым аргументом пустой срез: `&[]`. Настоящие снимки приедут в задаче 8.

- [x] **Step 6: Прогнать**

Run: `cargo test -p mwm-core && cargo test -p macos-windows-manager`
Expected: PASS оба

- [x] **Step 7: Коммит**

```bash
git add crates/mwm-core/src/publish.rs crates/mwm-core/src/config.rs src-tauri/src/main.rs
git commit -m "$(cat <<'EOF'
feat(publish): снимки едут в файле окон, конфиг знает пути состояния

Своей дороги у снимков нет и не заводится: читатель уже разбирает это поле у
Windows-трекера, а второй транспорт означал бы вторую точку отказа ради тех же
байтов.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Геометрия глазами Accessibility

**Repo:** `~/projects/js/macos-windows-manager`

**Files:**
- Modify: `src-tauri/src/ax.rs`

**Interfaces:**
- Consumes: `mwm_core::geometry::{Bounds, Display}` (задача 1).
- Produces:
  - `list_windows` заполняет `Seen.bounds`
  - `pub fn place(reg: &Registry, window_id: u64, b: Bounds) -> Result<(), String>`
  - `pub fn displays() -> Vec<Display>`

**Контекст и предупреждение:** этот файл тестами не покрыт намеренно, и на машине разработки **macOS-ветка не компилируется вовсе**. Ошибки в именах методов `accessibility` всплывут только на выкатке (задача 12); так было дважды — с `CFType::from` и с `NSRunningApplication::activate`. Поэтому: минимум кода, никакой логики, только вызовы платформы.

- [x] **Step 1: Чтение геометрии окна**

В `mod imp` (macOS-ветка) дописать рядом с `title_of`:

```rust
    /// Где стоит окно. Отказ — `None`, а не ошибка: окно могло закрыться между
    /// перечислением и вопросом, и это норма такта.
    ///
    /// Позиция и размер спрашиваются порознь — они и есть два разных атрибута
    /// Accessibility. Не ответил ни один — координат нет вовсе: половина
    /// прямоугольника хуже, чем ничего, потому что по ней окно поставили бы
    /// не туда.
    fn bounds_of(w: &AXUIElement) -> Option<Bounds> {
        let p = w.attribute(&AXAttribute::position()).ok()?;
        let s = w.attribute(&AXAttribute::size()).ok()?;
        let p: core_graphics::geometry::CGPoint = p.get_value().ok()?;
        let s: core_graphics::geometry::CGSize = s.get_value().ok()?;
        Some(Bounds {
            x: p.x as i32,
            y: p.y as i32,
            width: s.width as i32,
            height: s.height as i32,
        })
    }
```

В `list_windows` заменить `out.push(Seen { id, focused, title, bounds: None });` на `out.push(Seen { id, focused, title, bounds: bounds_of(&w) });` — **до** `alive.push(w)`, иначе `w` уже перемещён.

**Если на маке это не соберётся** (задача 12), пробовать по порядку, ничего больше не меняя:
1. `AXValue` в этой версии `accessibility` разворачивается не через `get_value()` → взять `accessibility::AXValueExt` или `TCFType`-обёртку и посмотреть, что предлагает компилятор в сообщении об отсутствующем методе;
2. `core_graphics` не в зависимостях → добавить `core-graphics = "0.24"` в `[target.'cfg(target_os = "macos")'.dependencies]` файла `src-tauri/Cargo.toml`, версию согласовать с той, что уже тянет `core-foundation`;
3. `AXAttribute::position()`/`size()` называются иначе → искать в крейте `accessibility` константы `kAXPositionAttribute`/`kAXSizeAttribute` и строить атрибут через `AXAttribute::new(&CFString::from_static_string("AXPosition"))`.

- [x] **Step 2: Установка геометрии**

В `mod imp` дописать:

```rust
    /// Поставить окно в заданный прямоугольник.
    ///
    /// Позиция ставится раньше размера. Порядок не безразличен: некоторые
    /// приложения ужимают размер под текущий экран, и заданный до переезда он
    /// обрезался бы по старому месту.
    ///
    /// Проверка «атрибут вообще настраиваемый» стоит перед записью: у окна в
    /// полноэкранном режиме позиция только для чтения, и без проверки отказ
    /// выглядел бы отказом Accessibility вообще.
    pub fn place(reg: &Registry, window_id: u64, b: Bounds) -> Result<(), String> {
        let el = reg
            .known
            .iter()
            .find(|(_, id)| *id == window_id)
            .map(|(el, _)| el.clone())
            .ok_or("window is gone")?;
        let pos = AXAttribute::position();
        let size = AXAttribute::size();
        if !el.is_attribute_settable(&pos).unwrap_or(false) {
            return Err("window position is read-only (full screen?)".to_string());
        }
        let p = core_graphics::geometry::CGPoint::new(f64::from(b.x), f64::from(b.y));
        let s = core_graphics::geometry::CGSize::new(f64::from(b.width), f64::from(b.height));
        el.set_attribute(&pos, AXValue::from_CGPoint(p).map_err(|e| format!("position value: {e:?}"))?)
            .map_err(|e| format!("set position: {e:?}"))?;
        el.set_attribute(&size, AXValue::from_CGSize(s).map_err(|e| format!("size value: {e:?}"))?)
            .map_err(|e| format!("set size: {e:?}"))?;
        Ok(())
    }
```

Дописать в `use` этого модуля `accessibility::AXValue`.

**Если не соберётся:** пробовать по порядку —
1. `AXValue::from_CGPoint` называется иначе (`AXValue::new`, `AXValue::from`) → взять то, что предложит компилятор;
2. `is_attribute_settable` отсутствует → звать `accessibility_sys::AXUIElementIsAttributeSettable` напрямую, как уже зовётся `AXUIElementPerformAction` в `raise`;
3. `set_attribute` требует другой формы значения → посмотреть сигнатуру в крейте и передать то, что она просит.

- [x] **Step 3: Список экранов**

В `mod imp` дописать:

```rust
    /// Экраны в той же системе координат, что и окна.
    ///
    /// `NSScreen.frame` считает от левого нижнего угла главного экрана, а
    /// Accessibility — от левого верхнего. Разница только в знаке `y` и только
    /// относительно высоты главного экрана, но перепутать их — значит вернуть
    /// окно зеркально, и человек увидит это как «трекер уносит окна вниз».
    pub fn displays() -> Vec<Display> {
        let screens = NSScreen::screens(unsafe { objc2_foundation::MainThreadMarker::new_unchecked() });
        let main_h = screens
            .iter()
            .next()
            .map(|s| s.frame().size.height)
            .unwrap_or(0.0);
        screens
            .iter()
            .map(|s| {
                let f = s.frame();
                Display {
                    bounds: Bounds {
                        x: f.origin.x as i32,
                        y: (main_h - f.origin.y - f.size.height) as i32,
                        width: f.size.width as i32,
                        height: f.size.height as i32,
                    },
                }
            })
            .collect()
    }
```

Дописать в `use` этого модуля `objc2_app_kit::NSScreen`.

**Если не соберётся:** пробовать по порядку —
1. `NSScreen::screens` требует `MainThreadMarker` иначе или не требует вовсе → взять форму, которую предлагает компилятор; поток здесь главный не всегда, и если API это запрещает — перейти к пробе 2;
2. заменить на Core Graphics: `core_graphics::display::CGDisplay::active_displays()` и `CGDisplay::new(id).bounds()` — они уже в координатах Accessibility и главного потока не требуют. **Это предпочтительный вариант, если проба 1 упрётся в поток**: такт трекера идёт в своём потоке, а не в главном.

- [x] **Step 4: Заглушки для не-macOS**

В `mod imp` под `#[cfg(not(target_os = "macos"))]` дописать:

```rust
    pub fn place(_reg: &Registry, _window_id: u64, _b: Bounds) -> Result<(), String> {
        Err("placing windows is available on macOS only".to_string())
    }
    pub fn displays() -> Vec<Display> { Vec::new() }
```

и добавить `use mwm_core::geometry::{Bounds, Display};` в шапку файла (рядом с `use mwm_core::tracker::Seen;`), а `place` и `displays` — в общий `pub use imp::{…}`.

- [x] **Step 5: Собрать не-macOS ветку**

Run: `cargo test -p mwm-core && cargo test -p macos-windows-manager`
Expected: PASS оба (собираются заглушки; macOS-ветка проверится только на выкатке)

- [x] **Step 6: Коммит**

```bash
git add src-tauri/src/ax.rs
# Только если зависимость и правда добавилась — на основном пути её нет:
# git add src-tauri/Cargo.toml Cargo.lock
git commit -m "$(cat <<'EOF'
feat(ax): чтение и установка геометрии окна, список экранов

Позиция ставится раньше размера: некоторые приложения ужимают размер под
текущий экран, и заданный до переезда он обрезался бы по старому месту.
Настраиваемость атрибута проверяется до записи — у полноэкранного окна позиция
только для чтения, и без проверки отказ выглядел бы отказом Accessibility.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Такт трекера расставляет окна и ведёт снимки

**Repo:** `~/projects/js/macos-windows-manager`

**Files:**
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: всё из задач 1–7.

**Контекст:** задача-сшивка. Логики в ней нет — вся она уже написана и покрыта тестами; здесь только порядок вызовов. Тестами такт не покрывается намеренно: `run_tracker` — бесконечный цикл с платформенными вызовами.

- [x] **Step 1: Поднять состояние при старте**

В `run_tracker`, после `let mut tracker = Tracker::new(2);`, дописать:

```rust
    // Слоты с прошлого запуска — до первого такта: иначе первое же окно
    // завело бы слот заново, и запомненное место было бы потеряно ровно тогда,
    // когда оно нужно.
    let state_path = std::path::PathBuf::from(&cfg.state_path);
    tracker.load_slots(mwm_core::state::read_state(&state_path));
    let snapshots_path = std::path::PathBuf::from(&cfg.snapshots_path);
    let mut snaps = load_snapshots(&snapshots_path);
    let mut pending_key = String::new();
    let mut pending_since_ms = 0u64;
```

- [x] **Step 2: Расставить появившиеся окна**

В теле такта, сразу после `tracker.tick(&seen, &index, now);`, дописать:

```rust
        // Расстановка — здесь и только здесь: реестр окон не `Send` и живёт в
        // этом потоке. Клампинг считается в момент расстановки, а не при
        // запоминании: экраны могли смениться, пока сессия была закрыта.
        let screens = ax::displays();
        for (window_id, want) in tracker.placements() {
            let target = mwm_core::geometry::clamp_to_displays(want, &screens);
            if let Err(e) = ax::place(&registry, window_id, target) {
                // Молчать нельзя: «поставил» и «не смог» отличаются только этим.
                eprintln!("mwm: place failed: {e}");
                *status.0.lock().unwrap() = format!("place failed: {e}");
            }
        }
```

- [x] **Step 3: Вести снимки**

Ниже, после сбора `window_of` и до `should_write`, дописать:

```rust
        // Снимок раскладки. Дорогого тут нет: пока состав не менялся и
        // координаты те же, всё сводится к склейке строки из id сессий.
        let open = tracker.open_session_ids();
        let key = mwm_core::snapshots::composition_key(&open);
        let last_key = snaps
            .first()
            .map(|s| {
                mwm_core::snapshots::composition_key(
                    &s.sessions.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
                )
            })
            .unwrap_or_default();
        let decision = mwm_core::snapshots::decide(
            &key, &last_key, &pending_key, pending_since_ms, now, cfg.snapshots_debounce_ms,
        );
        (pending_key, pending_since_ms) =
            mwm_core::snapshots::track_composition(&key, &pending_key, pending_since_ms, now);
        if let Some(d) = decision {
            let sessions = mwm_core::snapshots::sessions_of(&open, &tracker.slots_state());
            if !sessions.is_empty() {
                snaps = match d {
                    mwm_core::snapshots::Decision::Append => mwm_core::snapshots::append(
                        std::mem::take(&mut snaps),
                        mwm_core::snapshots::snapshot_id(now / 1000),
                        sessions,
                        now / 1000,
                        cfg.snapshots_keep,
                    ),
                    mwm_core::snapshots::Decision::Update => mwm_core::snapshots::update_last(
                        std::mem::take(&mut snaps),
                        sessions,
                        now / 1000,
                    ),
                };
                save_snapshots(&snapshots_path, &snaps);
            }
        }
```

- [x] **Step 4: Писать состояние, когда оно изменилось**

Ниже, рядом с публикацией файла окон, дописать:

```rust
        // Файл состояния пишется с `fsync`, и писать его на каждом такте —
        // плата за то, что не изменилось.
        if tracker.take_dirty() {
            if let Err(e) = mwm_core::state::write_atomic(
                &state_path,
                &mwm_core::state::state_json(&tracker.slots_state()),
            ) {
                eprintln!("mwm: state write failed: {e}");
            }
        }
```

Вызов `build_file` получает снимки: `build_file(&bound, &cfg.host, pid, now, link.is_live(), &cfg.mqtt.base, &snaps)`.

- [x] **Step 5: Дописать чтение и запись снимков**

Рядом с `run_tracker` в том же файле:

```rust
/// Снимки с диска. Формат — тот же, что уезжает в файле окон, и разбирается он
/// здесь же: заводить ради него отдельный модуль значило бы держать два места,
/// где знают одну структуру.
fn load_snapshots(path: &std::path::Path) -> Vec<mwm_core::snapshots::Snapshot> {
    use mwm_core::geometry::Bounds;
    use mwm_core::snapshots::{Snapshot, SnapshotSession};
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        eprintln!("mwm: broken snapshots file, starting empty");
        return Vec::new();
    };
    let mut out = Vec::new();
    for s in v.get("snapshots").and_then(|x| x.as_array()).into_iter().flatten() {
        let Some(id) = s.get("id").and_then(|x| x.as_str()).filter(|x| !x.is_empty()) else {
            continue;
        };
        let num = |k: &str| s.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        let mut sessions = Vec::new();
        for m in s.get("sessions").and_then(|x| x.as_array()).into_iter().flatten() {
            let Some(sid) = m.get("id").and_then(|x| x.as_str()).filter(|x| !x.is_empty()) else {
                continue;
            };
            let b = m.get("bounds").and_then(|x| x.as_object());
            let n = |k: &str| {
                b.and_then(|o| o.get(k)).and_then(|x| x.as_i64()).and_then(|x| i32::try_from(x).ok())
            };
            let (Some(x), Some(y), Some(width), Some(height)) =
                (n("x"), n("y"), n("width"), n("height"))
            else {
                continue;
            };
            let text = |k: &str| {
                m.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string()
            };
            sessions.push(SnapshotSession {
                id: sid.to_string(),
                title: text("title"),
                cwd: text("cwd"),
                bounds: Bounds { x, y, width, height },
            });
        }
        out.push(Snapshot {
            id: id.to_string(),
            created_s: num("created"),
            updated_s: num("updated"),
            sessions,
        });
    }
    out
}

fn save_snapshots(path: &std::path::Path, snaps: &[mwm_core::snapshots::Snapshot]) {
    let value = serde_json::json!({
        "version": 1,
        "snapshots": snaps.iter().map(|s| serde_json::json!({
            "id": s.id,
            "created": s.created_s,
            "updated": s.updated_s,
            "sessions": s.sessions.iter().map(|m| serde_json::json!({
                "id": m.id,
                "title": m.title,
                "cwd": m.cwd,
                "bounds": {
                    "x": m.bounds.x, "y": m.bounds.y,
                    "width": m.bounds.width, "height": m.bounds.height
                },
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    });
    if let Err(e) = mwm_core::state::write_atomic(path, &value) {
        eprintln!("mwm: snapshots write failed: {e}");
    }
}
```

- [x] **Step 6: Собрать и прогнать**

Run: `cargo test -p mwm-core && cargo test -p macos-windows-manager`
Expected: PASS оба

- [x] **Step 7: Коммит**

```bash
git add src-tauri/src/main.rs
git commit -m "$(cat <<'EOF'
feat(tracker): такт расставляет появившиеся окна и ведёт снимки

Клампинг считается в момент расстановки, а не при запоминании: экраны могли
смениться, пока сессия была закрыта. Состояние пишется только когда менялось —
файл идёт через fsync.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Снимок знает свою машину

**Repo:** `~/projects/shell/ccfzf`, ветка `main`

**Files:**
- Modify: `ccfzf` — `read_window_sources`
- Test: `tests/test_windows_merge.py`

**Interfaces:**
- Produces: каждая запись в `snapshots` ответа получает `host` и `mqttBase` источника.

**Контекст:** сейчас снимки всех трекеров складываются в один плоский список (`snaps += sn`) без указания владельца. Пока снимки делала одна машина, это работало. Начни их делать мак — пикер не отличил бы, чей снимок, и восстановил бы не там: молча, потому что у публикации нет ответа. Тот же класс, что этап 2 чинил для окон.

- [x] **Step 1: Написать падающий тест**

Помощник `_file(host, windows, pid=42, focus=None, projects=None, snapshots=None, open_session=None, mqtt_base=None)` в `tests/test_windows_merge.py` уже умеет принимать `snapshots` и `mqtt_base`. Дописать тест:

```python
def test_snapshot_carries_the_machine_that_took_it():
    # Восстанавливают снимок на той машине, где его сняли. Плоский список без
    # владельца заставил бы пикер угадывать — а промах здесь молчащий: у
    # публикации нет ответа.
    snap_pc = [{"id": "2026-08-14T01-00-00", "created": 100,
                "sessions": [{"id": UUID_A, "title": "ccfzf", "cwd": "/x"}]}]
    snap_mac = [{"id": "2026-08-14T02-00-00", "created": 200,
                 "sessions": [{"id": UUID_B, "title": "other", "cwd": "/y"}]}]
    _, _, _, snaps, _, _ = _merge(
        legacy=_file("windows-box", {}, snapshots=snap_pc),
        dir_files={"mac-host.json": _file("mac-host", {}, snapshots=snap_mac,
                                          mqtt_base="home/room/mac/windows")},
    )
    by_id = {s["id"]: s for s in snaps}
    assert by_id["2026-08-14T01-00-00"]["host"] == "windows-box", snaps
    assert by_id["2026-08-14T01-00-00"]["mqttBase"] == "", snaps
    assert by_id["2026-08-14T02-00-00"]["host"] == "mac-host", snaps
    assert by_id["2026-08-14T02-00-00"]["mqttBase"] == "home/room/mac/windows", snaps
```

- [x] **Step 2: Прогнать и убедиться, что падает**

Run: `cd ~/projects/shell/ccfzf && python3 tests/test_windows_merge.py`
Expected: FAIL — `KeyError: 'host'`.

- [x] **Step 3: Реализовать**

В `read_window_sources` заменить `snaps += sn` на:

```python
        # Машина-владелец приписывается снимку здесь и только здесь: сам трекер
        # её не пишет — он не знает, что снимков бывает несколько источников.
        snaps += [dict(s, host=host, mqttBase=mqtt_base) for s in sn]
```

В doc-комментарий функции дописать абзац:

```
    Снимку приписывается машина, которая его сняла. Восстанавливают раскладку
    там же, где снимали, а список у читателя один на все источники: без
    владельца он не отличил бы свой снимок от чужого, и промах был бы молчащим —
    у публикации нет ответа.
```

- [x] **Step 4: Прогнать оба файла**

Run: `python3 tests/test_windows_file.py && python3 tests/test_windows_merge.py`
Expected: PASS оба

- [x] **Step 5: Коммит**

```bash
git add ccfzf tests/test_windows_merge.py
git commit -m "$(cat <<'EOF'
feat(state): снимок называет машину, которая его сняла

Список у читателя один на все источники. Без владельца он не отличил бы свой
снимок от чужого, и промах был бы молчащим — у публикации нет ответа.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Пикер показывает снимки своей машины

**Repo:** `~/projects/js/ccfzf-picker`, ветка `windows-mqtt-migrate`

**Files:**
- Modify: `frontend-src/picker-snapshots.js`
- Test: `test/picker-snapshots.test.js`

**Interfaces:**
- Produces:
  - `snapshotsHere(state, configHost)` → массив снимков этой машины
  - `snapshotBase(snapshot)` → строка адреса (`''`, если адреса нет)
  - оба добавляются в экспорт рядом с `buildSnapshotRows`, `openIdsFromState`, `formatSnapshotTime`, `projectBasename`

**Контекст:** старый агрегатор владельца не пишет. Отбросив такие снимки, пикер после обновления показал бы пустой список там, где режим работал, — а обновляются пикер и агрегатор порознь, и порядок нам не подвластен.

- [x] **Step 1: Написать падающие тесты**

Дописать в `test/picker-snapshots.test.js` (форма файла — как у соседних тестов там же):

```js
test('снимки отбираются по своей машине', () => {
  // Снимок соседней машины в этом списке не помог бы ничем: восстановить
  // раскладку на чужом экране человеку нечего.
  const state = {
    snapshots: [
      { id: 'a', host: 'windows-box', sessions: [] },
      { id: 'b', host: 'mac-host', mqttBase: 'home/room/mac/windows', sessions: [] },
    ],
  };
  assert.deepEqual(PickerSnapshots.snapshotsHere(state, 'mac-host').map(s => s.id), ['b']);
});

test('снимок без машины считается своим', () => {
  // Старый агрегатор владельца не пишет, а трекер тогда был один — и все
  // снимки были его. Отбрось мы такие, режим опустел бы там, где работал.
  const state = { windowHost: 'windows-box', snapshots: [{ id: 'a', sessions: [] }] };
  assert.deepEqual(PickerSnapshots.snapshotsHere(state, 'windows-box').map(s => s.id), ['a']);
});

test('имя машины сравнивается без учёта регистра и пробелов', () => {
  const state = { snapshots: [{ id: 'a', host: 'Mac-Host ', sessions: [] }] };
  assert.equal(PickerSnapshots.snapshotsHere(state, ' mac-host').length, 1);
});

test('без снимков — пустой список, а не поломка', () => {
  assert.deepEqual(PickerSnapshots.snapshotsHere({}, 'mac-host'), []);
  assert.deepEqual(PickerSnapshots.snapshotsHere({ snapshots: 'нет' }, 'mac-host'), []);
});

test('адрес снимка берётся у снимка, а не у конфига', () => {
  assert.equal(
    PickerSnapshots.snapshotBase({ id: 'b', mqttBase: 'home/room/mac/windows' }),
    'home/room/mac/windows',
  );
});

test('снимок старого агрегатора адреса не называет, и это пустая строка', () => {
  // Пустая строка значит «спроси свой конфиг» — так пикер вёл себя до
  // появления поля.
  assert.equal(PickerSnapshots.snapshotBase({ id: 'a' }), '');
  assert.equal(PickerSnapshots.snapshotBase(null), '');
});
```

- [x] **Step 2: Прогнать и убедиться, что падает**

Run: `npm test`
Expected: FAIL — `PickerSnapshots.snapshotsHere is not a function`

- [x] **Step 3: Реализовать**

В `frontend-src/picker-snapshots.js`, рядом с `openIdsFromState`:

```js
  /** Имя машины — в сравнимый вид. То же правило, что в session-windows.js. */
  function normHost(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  /**
   * Снимки этой машины.
   *
   * Раскладку восстанавливают там, где снимали, а список у пикера один на все
   * источники: агрегатор складывает снимки всех трекеров вместе. Снимок
   * соседней машины здесь не помог бы ничем — восстановить её раскладку на
   * своём экране человеку нечего.
   *
   * Снимок без имени машины считается своим. Старый агрегатор владельца не
   * пишет, а трекер тогда был ровно один, и все снимки были его; отбрось мы
   * такие, режим опустел бы там, где работал. Пикер и агрегатор обновляются
   * порознь, и порядок нам не подвластен.
   */
  function snapshotsHere(state, configHost) {
    const all = Array.isArray(state?.snapshots) ? state.snapshots : [];
    const mine = normHost(configHost);
    return all.filter(s => {
      if (!s) return false;
      const host = normHost(s.host);
      return host ? host === mine : true;
    });
  }

  /**
   * Куда просить о восстановлении этого снимка.
   *
   * Адрес называет снимок, а не машина-менеджер: у каждой машины свой префикс
   * топиков, и просьба обязана уйти той, что снимок сняла. Пустая строка значит
   * «спроси свой конфиг» — так пикер вёл себя до появления поля, и так он
   * обязан вести себя со старым агрегатором.
   */
  function snapshotBase(snapshot) {
    const base = snapshot && typeof snapshot.mqttBase === 'string' ? snapshot.mqttBase.trim() : '';
    return base;
  }
```

и в возврат модуля добавить `snapshotsHere, snapshotBase`.

- [x] **Step 4: Прогнать**

Run: `npm test`
Expected: PASS

- [x] **Step 5: Коммит**

```bash
git add frontend-src/picker-snapshots.js test/picker-snapshots.test.js
git commit -m "$(cat <<'EOF'
feat(picker): режим снимков показывает раскладки своей машины

Список у пикера один на все источники. Снимок соседней машины в нём не помог бы
ничем: восстановить её раскладку на своём экране человеку нечего. Снимок без
владельца считается своим — старый агрегатор его не пишет, а трекер тогда был
один.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Восстановление ветвится по машине снимка

**Repo:** `~/projects/js/ccfzf-picker`

**Files:**
- Modify: `sessions.html`
- Test: `test/restore-branches.test.js` (создаётся)

**Interfaces:**
- Consumes: `PickerSnapshots.snapshotsHere`, `PickerSnapshots.snapshotBase` (задача 10); `OpenTransport.chooseOpenTransport` и `SessionWindows.openManager` (этап 2, без изменений).

**Контекст:** задача-сшивка. На машине с менеджером снимок восстанавливается как сегодня — публикацией. На маке менеджера нет, и восстановление там значит «открыть сессии снимка», что пикер уже умеет: этап 2 на этом стоит и не отменяется.

- [x] **Step 1: Отобрать снимки своей машины**

В `sessions.html` найти строку `snapshotRows = Array.isArray(state.snapshots) ? state.snapshots : [];` (около 939) и заменить на:

```js
      // Снимки соседних машин в списке не нужны: восстановить их раскладку на
      // своём экране человеку нечего.
      snapshotRows = window.PickerSnapshots.snapshotsHere(state, CONFIG.windowHost);
```

- [x] **Step 2: Завести помощника «где этот снимок сняли»**

Рядом с `openManagerHere` дописать:

```js
  /** Запись снимка по его id — из отобранных, то есть только своей машины. */
  function snapshotById(id) {
    return snapshotRows.find(s => s && s.id === id) || null;
  }

  /**
   * Машина, которой уходит просьба о восстановлении, — или `null`, если такой
   * машины нет.
   *
   * Вопрос здесь не «чей это снимок»: снимки в списке и так только свои,
   * `snapshotsHere` отобрала их по машине. Вопрос — «берётся ли менеджер этой
   * машины за раскладку», и отвечает на него `openManager`: он же отбирает
   * трекеры по полю `openSession`. Второй разбор того же списка разошёлся бы с
   * ним на первой же правке.
   *
   * Мак снимки делает, а менеджера у него нет: трекер там объявляет
   * `openSession: false`, `openManager` его отбрасывает и отвечает либо чужой
   * машиной, либо `null` — в обоих случаях `chooseOpenTransport` даёт `local`,
   * и восстановление уходит в местную ветку. Возьми мы `host` прямо у снимка,
   * на маке вышло бы `manager`, и просьба уехала бы в топик, который никто не
   * слушает: молча, потому что у публикации нет ответа.
   *
   * Адрес при этом берётся у снимка, а не у менеджера: у каждой машины свой
   * префикс топиков, и просьба обязана уйти той, что снимок сняла. Пустая
   * строка значит «спроси свой конфиг» — так её читает `resolve_base` в
   * `src-tauri/src/mqtt.rs`.
   */
  function snapshotOwner(id) {
    const snap = snapshotById(id);
    if (!snap) return null;
    const manager = window.SessionWindows.openManager(lastState, CONFIG.windowHost);
    if (!manager) return null;
    return { host: manager.host, mqttBase: window.PickerSnapshots.snapshotBase(snap) };
  }
```

- [x] **Step 3: Разветвить `restoreSnapshot`**

Заменить тело `restoreSnapshot` (около 1054) целиком:

```js
  /**
   * Поднять раскладку снимка.
   *
   * Две дороги, и выбирает между ними та же проверка, что у Enter на строке
   * сессии. На машине с менеджером просьба уходит ему — как было всегда.
   * На маке менеджера нет: там восстановление значит «открыть сессии снимка»,
   * и открывает их сам пикер, а места им расставит оконный трекер, когда окна
   * появятся. Знать о восстановлении трекеру для этого не нужно.
   *
   * Адрес просьбы берётся у снимка: у каждой машины свой префикс топиков, и
   * уйти она обязана той, что снимок сняла.
   *
   * Пикер гасится до просьбы, как и на фокусе: окна поднимутся на том же
   * экране, и держать поверх них список незачем.
   *
   * Пустой `sessionIds` значит «весь снимок»: так просит заголовок раскладки.
   */
  async function restoreSnapshot(snapshotId, sessionIds) {
    const owner = snapshotOwner(snapshotId);
    const transport = window.OpenTransport.chooseOpenTransport(
      owner, CONFIG.windowHost, CONFIG.mqtt.configured,
    );
    await invoke('hide_picker');
    if (transport !== 'manager') return restoreLocally(snapshotId, sessionIds);
    try {
      await invoke('restore_snapshot_mqtt', {
        id: snapshotId, sessionIds,
        base: (owner || {}).mqttBase || '',
      });
    } catch (e) {
      error = String(e);
      render();
      return;
    }
    error = '';
  }

  /**
   * Восстановление своими силами: поднять сессии снимка по одной.
   *
   * Именно **поднять**, а не завести новые. Место запомнено за идентификатором
   * сессии, и новая сессия получила бы новый id — трекеру было бы нечего
   * искать, и окно осталось бы там, куда его положила система. Отсюда и форма
   * строки: без `window`, `tmux` и `pid` `chooseOpenStrategy` отвечает
   * `resume`, а это ровно то, что нужно.
   *
   * По одной и с паузой — не украшение. Два терминала, поднявшиеся разом,
   * трекер не различит: у обоих заголовок ещё не устоялся, а привязка идёт
   * именно по нему. Windows-сторона делает то же самое и по той же причине.
   *
   * Уже открытые пропускаются: второе окно той же сессии дралось бы с первым
   * за один слот, и место досталось бы неизвестно какому.
   */
  async function restoreLocally(snapshotId, sessionIds) {
    const snap = snapshotById(snapshotId);
    if (!snap) return;
    const wanted = new Set(sessionIds || []);
    const open = window.PickerSnapshots.openIdsFromState(lastState);
    const list = (Array.isArray(snap.sessions) ? snap.sessions : [])
      .filter(s => s && s.id && !open.has(s.id))
      .filter(s => !wanted.size || wanted.has(s.id));
    for (const s of list) {
      await openSession({ id: s.id, cwd: s.cwd || '', title: s.title || '', kind: 'snapshot-session' });
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
    error = '';
  }
```

- [x] **Step 4: Сверить форму строки с тем, что её читает**

Строка, которую `restoreLocally` собирает сама, проходит через `chooseOpenStrategy` (`frontend-src/open-strategy.js`) и `chooseEnterAction` (`frontend-src/open-transport.js`). Прочитать обе и убедиться:

- `chooseOpenStrategy` на такой строке отвечает `resume` — то есть у строки нет `window`, нет `tmux`/`zellij`, нет пары `live` + `pid`;
- `chooseEnterAction` на маке отвечает `local` — то есть `openManagerHere()` называет соседнюю машину, и ветка менеджера не включается;
- `kind: 'snapshot-session'` входит в `SESSION_ID_ROW_KINDS`.

Если какое-то из трёх не сходится — чинить строку, а не эти функции: у них есть тесты на каждый вид строки, и правка там аукнется в Enter на строке списка.

- [x] **Step 5: Сторож развилки**

Развилка молчащая: у публикации в MQTT нет ответа, и просьба, уехавшая в топик, который никто не слушает, выглядит как сработавший Enter. Сторож проверяет настоящий код страницы, а не его копию.

Создать `test/restore-branches.test.js`:

```js
// Развилка восстановления снимка: берётся ли менеджер этой машины за раскладку.
//
// Снимок мака и снимок Windows-машины в списке выглядят одинаково, а
// восстанавливаются по-разному: там просьба менеджеру, здесь — открытие сессий
// силами самого пикера. Ошибка тут молчащая: у публикации в MQTT нет ответа, и
// просьба, уехавшая в топик, который никто не слушает, выглядит как сработавший
// Enter.
//
// Проверяется настоящий код страницы: `snapshotOwner` вычитывается из
// sessions.html и исполняется в vm с настоящими `SessionWindows` и
// `PickerSnapshots` — тем же приёмом, что и в `hide-before-request.test.js`.
// Копия разъехалась бы молча, а сторож остался бы зелёным.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SESSIONS_HTML = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');
const SessionWindows = require('../frontend-src/session-windows.js');
const PickerSnapshots = require('../frontend-src/picker-snapshots.js');
const { chooseOpenTransport } = require('../frontend-src/open-transport.js');

function sourceOf(name) {
  const re = new RegExp(`\\n {2}function ${name}\\([\\s\\S]*?\\n {2}\\}\\n`);
  const found = SESSIONS_HTML.match(re);
  assert.ok(found, `${name} не найдена в sessions.html — тест сторожит не то`);
  return found[0];
}

const SNAP = { id: 'snap-1', mqttBase: 'home/room/mac/windows', sessions: [] };

/** Ответ `snapshotOwner` на машине `configHost` при таком списке трекеров. */
function ownerOf(configHost, windowHosts, snapshot = SNAP) {
  const ctx = {
    CONFIG: { windowHost: configHost, mqtt: { configured: true } },
    lastState: { windowHosts },
    snapshotRows: [snapshot],
    window: { SessionWindows, PickerSnapshots },
    result: null,
  };
  vm.runInNewContext(
    `${sourceOf('snapshotById')}\n${sourceOf('snapshotOwner')}\nresult = snapshotOwner('snap-1');`,
    ctx,
  );
  return ctx.result;
}

const MAC = { host: 'mac', pid: 11, canFocus: true, openSession: false };
const WIN = { host: 'pc-win', pid: 22, canFocus: true };

test('на маке снимок восстанавливается своими силами', () => {
  // Трекер мака объявляет `openSession: false` — менеджера там нет вовсе.
  // Возьми развилка машину прямо у снимка, вышло бы `manager`, и просьба
  // уехала бы в топик мака, который никто не слушает.
  const owner = ownerOf('mac', [MAC]);
  assert.equal(owner, null, 'машины, берущейся за раскладку, на маке нет');
  assert.equal(chooseOpenTransport(owner, 'mac', true), 'local');
});

test('живой Windows-трекер не делает мак машиной менеджера', () => {
  // Соседняя машина в списке есть, и `openManager` называет её — но это не
  // наша машина, и восстанавливать её силами нашу раскладку нечего.
  const owner = ownerOf('mac', [MAC, WIN]);
  assert.equal(chooseOpenTransport(owner, 'mac', true), 'local');
});

test('на машине с менеджером просьба уходит ему, адрес — от снимка', () => {
  const snap = { id: 'snap-1', mqttBase: 'home/room/pc/windows', sessions: [] };
  const owner = ownerOf('pc-win', [WIN], snap);
  assert.equal(chooseOpenTransport(owner, 'pc-win', true), 'manager');
  assert.equal(owner.mqttBase, 'home/room/pc/windows',
    'адрес называет снимок: у каждой машины свой префикс топиков');
});

test('снимок без адреса уводит просьбу на свой конфиг', () => {
  // Пустая строка значит «спроси свой конфиг» — так её читает `resolve_base`
  // в `src-tauri/src/mqtt.rs`. Старый трекер адреса не называет вовсе.
  const owner = ownerOf('pc-win', [WIN], { id: 'snap-1', sessions: [] });
  assert.equal(owner.mqttBase, '');
});
```

- [x] **Step 6: Прогнать**

Run: `npm test && (cd src-tauri && cargo test)`
Expected: PASS оба

Если падает сторож порядка `test/hide-before-request.test.js` — читать и чинить: гашение обязано идти до просьбы, и в новой форме оно идёт до обеих веток. Это регрессия, а не устаревший тест.

- [x] **Step 7: Коммит**

```bash
git add sessions.html test/restore-branches.test.js
git commit -m "$(cat <<'EOF'
feat(picker): снимок восстанавливается там, где его сняли

На машине с менеджером — просьбой ему, как было всегда. На маке менеджера нет,
и восстановление значит «открыть сессии снимка»: открывает их пикер, места
расставит трекер, когда окна появятся. По одной и с паузой — два терминала,
поднявшиеся разом, трекер не различит.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Выкатка, проверка вживую, документация

**Repos:** все три

**Files:**
- Modify: `macos-windows-manager/README.md` — раздел «Правила, за которые уже заплачено»
- Modify: `ccfzf-picker/CLAUDE.md` — раздел «Правила, за которые уже заплачено»

**Контекст:** здесь впервые компилируется macOS-ветка задачи 7. Ошибки в именах методов `accessibility` — ожидаемая часть этой задачи, а не сюрприз: так было дважды.

- [x] **Step 1: Запушить все три репозитория**

Выкатка первым шагом делает `git pull` на целевой машине — выкатывается запушенное, а не то, что в рабочем каталоге.

```bash
cd ~/projects/shell/ccfzf && git push
cd ~/projects/js/macos-windows-manager && git push
cd ~/projects/js/ccfzf-picker && git push
```

- [x] **Step 2: Выкатить пикер — раньше трекера, и это важно**

Run: `cd ~/projects/js/ccfzf-picker && ./data/scripts/deploy-win.sh && ./data/scripts/deploy-mac.sh --all`

Порядок обратный тому, каким план был написан сперва, и причина конкретная.
Агрегатор здесь — симлинк на рабочее дерево, то есть его половина уже живая и
приписывает снимкам владельца. Выкати трекер первым — и мак начнёт публиковать
снимки, а необновлённый Windows-пикер прочитает `state.snapshots` без отбора:
покажет маковские снимки в своём `^S` и по Enter опубликует id маковского
снимка в windows-mqtt. Ответ — «unknown snapshot» в чужой лог, а у публикации
ответа нет. Это ровно та поломка, которую этап и чинит.

Пикер в обратную сторону совместим: со старым агрегатором (снимок без `host`
считается своим) и со старым трекером (пустой `mqttBase` читается как «спроси
свой конфиг»). Значит выкатывать его первым безопасно, а вторым — нет.

- [x] **Step 3: Собрать и выкатить трекер на оба мака**

Run: `cd ~/projects/js/macos-windows-manager && MWM_HOST=<хост мака> ./data/scripts/deploy-mac.sh`
Expected: сборка проходит, подпись проходит, задача перезапускается

Маков два, и выкатывать надо на оба — у каждого свой `windowHost` и свой префикс топиков.

Ошибки компиляции macOS-ветки чинить по подсказкам компилятора (порядок проб — в задаче 7), коммитить и выкатывать заново. Помнить про грабли: одинарных кавычек внутрь `run()` не класть; `;` в удалённой команде не ставить; ждать подписи по результату, а не по часам. **Выкатка выходит с кодом 0, даже когда сборка упала** — смотреть вывод, а не код возврата.

- [x] **Step 4: Проверить файлы состояния**

На маке:

```bash
python3 -c "import json;o=json.load(open('$HOME/.local/state/macos-windows-manager/state.json'));print(len(o['slots']));print(list(o['slots'].values())[0])"
```

Expected: число слотов больше нуля, у слота есть `bounds`, `cwd`, `title`.

- [x] **Step 5: Проверить расстановку** — подтверждено человеком на обеих маках.

1. Открыть сессию, подвинуть её окно в угол, подождать пару секунд (устойчивость), закрыть окно.
2. Открыть ту же сессию заново из пикера.
3. Окно встаёт в тот же угол.

Если не встаёт — смотреть `/tmp/mwm.err.log` на маке: жалоба `place failed:` называет причину.

- [ ] **Step 6: Проверить клампинг**

Отключить внешний экран (или сменить раскладку мониторов), повторить проверку из шага 4 для сессии, чьё окно стояло на пропавшем экране. Окно обязано появиться на оставшемся, а не пропасть.

- [ ] **Step 7: Проверить снимки**

Открыть две-три сессии, подождать дебаунс (минута), затем:

```bash
python3 -c "import json;o=json.load(open('$HOME/.local/state/macos-windows-manager/snapshots.json'));print([(s['id'], len(s['sessions'])) for s in o['snapshots']])"
```

Expected: хотя бы один снимок с нужным числом сессий.

Затем в пикере `^S`: снимок виден, у него час и дата. Убедиться, что снимков Windows-машины в этом списке **нет**, а на Windows-пикере нет маковских.

- [ ] **Step 8: Проверить восстановление**

Закрыть все терминалы сессий снимка. В пикере `^S`, Enter на заголовке снимка. Сессии открываются по одной, окна встают по местам.

- [ ] **Step 9: Проверить, что Windows не изменился**

Пикер там уже выкачен шагом 2. На Windows проверить руками: `^S` открывается и показывает свои снимки; Enter на снимке восстанавливает раскладку, как раньше; Enter на строке с окном поднимает окно; `^N` заводит сессию.

- [x] **Step 10: Записать добытое**

В `macos-windows-manager/README.md`, в раздел «Правила, за которые уже заплачено», дописать то, что выяснилось на этой выкатке. Кандидаты — писать только подтвердившееся:

- что именно не собралось из `accessibility`/`core-graphics` и чем заменено;
- поддался ли `AXPosition`/`AXSize` на каждом терминале из списка, и если нет — на каком;
- в какой системе координат в итоге оказались экраны и как это выяснилось;
- сколько на деле длится «устоялось» при перетаскивании окна мышкой.

В `ccfzf-picker/CLAUDE.md`, в тот же раздел, дописать про снимки: почему владелец приписывается снимку в агрегаторе, а не в трекере; почему восстановление на маке — это открытие сессий, а не просьба; почему открываются они по одной с паузой.

- [x] **Step 11: Прогнать все тесты в трёх репозиториях**

```bash
cd ~/projects/js/ccfzf-picker && npm test && (cd src-tauri && cargo test)
cd ~/projects/js/macos-windows-manager && cargo test -p mwm-core && cargo test -p macos-windows-manager
cd ~/projects/shell/ccfzf && python3 tests/test_windows_file.py && python3 tests/test_windows_merge.py
```

Expected: всё зелёное

- [x] **Step 12: Коммит документации**

```bash
cd ~/projects/js/macos-windows-manager
git add README.md
git commit -m "$(cat <<'EOF'
docs: правила, добытые на выкатке расстановки и снимков

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"

cd ~/projects/js/ccfzf-picker
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: снимок восстанавливается там, где его сняли

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Порядок и зависимости

Задачи 1, 2, 3, 5 независимы друг от друга. Задача 2 требует 1 (`Bounds`). Задача 4 требует 1, 2, 3. Задача 6 требует 5 и трогает `config.rs`, которого больше не трогает никто. Задача 7 самостоятельна, но её первый шаг ставит настоящую геометрию вместо заглушки `bounds: None`, которую поставила задача 4, — значит идёт после неё. Задача 8 требует 4, 6, 7. Задача 9 самостоятельна. Задача 10 требует 9 только на бумаге. Задача 11 требует 10. Задача 12 требует всего.

Пикер между задачами 10 и 11 работает: задача 10 только добавляет функции и никого не ломает. Трекер между задачами 4 и 7 собирается, но геометрии не видит — `Seen.bounds` всегда `None`, расстановка молчит, снимки пусты. Это ожидаемо и живёт ровно три задачи.

Выкатывать трекер имеет смысл сразу после задачи 8, не дожидаясь двенадцатой: macOS-ветка на машине разработки не компилируется вовсе, и чем раньше она соберётся на маке, тем дешевле обойдутся ошибки в именах методов. Пикер выкатывается только после задачи 11.
