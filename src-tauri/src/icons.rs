//! Иконки приложений для меню действий.
//!
//! Разбор — здесь и без `cfg(windows)`: и буфер reparse, и пиксели приезжают
//! байтами, а байты одинаковы везде. Под `cfg(windows)` остаётся обвязка над
//! WinAPI, у которой своей логики нет и проверять в ней нечего.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// Один запрос от страницы: чья иконка и под каким id её вернуть.
#[derive(serde::Deserialize)]
pub struct IconSpec {
    pub id: String,
    pub path: String,
}

/// Настоящий exe за app-execution alias.
///
/// `wt.exe` в `WindowsApps` — файл нулевой длины с reparse-тегом
/// `IO_REPARSE_TAG_APPEXECLINK`; иконку система отдаёт по нему дежурную.
/// Настоящий путь лежит внутри самого буфера третьей UTF-16 строкой: первые
/// две — имя пакета и AppUserModelID, четвёртая — тип приложения.
///
/// Прописать этот путь в конфиг руками нельзя: в нём стоит версия пакета, и
/// после обновления Terminal он протухнет молча — иконка просто исчезнет.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn appexec_target(buf: &[u8]) -> Option<String> {
    const TAG: u32 = 0x8000_001B;
    if buf.len() < 12 {
        return None;
    }
    if u32::from_le_bytes(buf[0..4].try_into().ok()?) != TAG {
        return None;
    }
    let len = u16::from_le_bytes(buf[4..6].try_into().ok()?) as usize;
    // Длина с диска: верить ей нельзя, поэтому get, а не срез.
    let data = buf.get(8..8usize.checked_add(len)?)?;
    let words: Vec<u16> = data
        .get(4..)?
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let exe = words.split(|&w| w == 0).nth(2)?;
    if exe.is_empty() {
        return None;
    }
    Some(String::from_utf16_lossy(exe))
}

/// Пиксели иконки из `GetDIBits` — в RGBA для PNG.
///
/// Альфа берётся из битмапа, если она там есть хоть где-то. Нулевая во всём
/// битмапе значит «иконка старая, без альфа-канала» — тогда прозрачность
/// собирается по маске, где белый пиксель это дырка. Взять такую альфу как
/// есть значило бы показать пустой квадрат.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn to_rgba(bgra: &[u8], mask: &[u8]) -> Vec<u8> {
    let has_alpha = bgra.chunks_exact(4).any(|px| px[3] != 0);
    let mut out = Vec::with_capacity(bgra.len());
    for (i, px) in bgra.chunks_exact(4).enumerate() {
        let alpha = if has_alpha {
            px[3]
        } else {
            match mask.get(i * 4) {
                Some(&m) if m != 0 => 0,
                _ => 255,
            }
        };
        out.extend_from_slice(&[px[2], px[1], px[0], alpha]);
    }
    out
}

/// Голое имя — в путь по `PATH`.
///
/// Предикат существования отдельным аргументом: без него тест зависел бы от
/// того, что стоит на машине, где его гоняют.
pub fn resolve_name(
    name: &str,
    path_var: &str,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let file = if name.to_ascii_lowercase().ends_with(".exe") {
        name.to_string()
    } else {
        format!("{name}.exe")
    };
    // Path::join режет по `/`: на Linux, где тесты и гоняют, обратный слэш —
    // обычный символ, и склейка через него разошлась бы с ожиданием. Слэш
    // свой и разделитель `;` у split ниже — по той же причине: функция по
    // форме виндовая, `PATH` она разбирает так, как это делает Windows.
    // На маке `resolve()` тоже её зовёт — единственный кандидат тогда
    // получается мусорным (весь PATH, склеенный `:`, целиком за один
    // каталог), но результата у него никто не спрашивает: `extract()` на
    // маке всегда `None`, и до stat дело не доходит без вреда.
    // Хвостовой разделитель у элемента PATH срезаем сами: Windows его туда
    // пускает, а склейка форматом дала бы двойной `\\`.
    path_var
        .split(';')
        .filter(|dir| !dir.is_empty())
        .map(|dir| PathBuf::from(format!("{}\\{file}", dir.trim_end_matches(['\\', '/']))))
        .find(|candidate| exists(candidate))
}

/// Кеш иконок на время жизни процесса.
///
/// Ключ — путь плюс mtime: обновился Cursor, сменился mtime, иконка
/// перечиталась сама. Кеш по одному пути протух бы незаметно и держался до
/// перезапуска пикера, а перезапускают его только при выкатке. `None` в
/// значении кеширует неудачу извлечения — `resolve()` путь нашёл, а
/// `extract()` иконку не отдал. Неудача самого `resolve()` (путь не нашёлся —
/// ровно случай `claude.exe`, которого на машине нет) до кеша не доходит
/// вовсе: `icons_for` уходит по `continue` раньше, чем построит ключ. Цена
/// такого промаха — лишний проход по `PATH` на каждый вызов `icons_for`, а не
/// на каждый показ меню: страница просит иконки при старте и на смену
/// конфига, а не на `^K`.
#[derive(Default)]
pub struct Cache(Mutex<HashMap<(PathBuf, Option<SystemTime>), Option<String>>>);

/// Иконки для списка запросов. Чего не нашлось — просто нет в ответе.
///
/// Один id страница вправе прислать несколько раз: это кандидаты, и выигрывает
/// первый, давший иконку. Так спрашивают агента, которого на Windows может не
/// быть в `PATH` (см. `NEW_ICON_PATHS` в `action-icons.js`).
pub fn icons_for(specs: &[IconSpec], cache: &Cache) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for spec in specs {
        if out.contains_key(&spec.id) {
            continue;
        }
        let Some(path) = resolve(&spec.path) else {
            continue;
        };
        let stamp = std::fs::metadata(&path).ok().and_then(|m| m.modified().ok());
        let key = (path.clone(), stamp);
        let cached = cache.0.lock().unwrap().get(&key).cloned();
        let value = match cached {
            Some(value) => value,
            None => {
                let value = extract(&path);
                let mut map = cache.0.lock().unwrap();
                // Записи того же пути с прежним mtime больше не спросят
                // никогда: спрашивают всегда про нынешний файл. Без выброса
                // карта росла бы на каждое обновление exe и до перезапуска
                // держала бы иконки, которых уже нет.
                map.retain(|(seen, _), _| seen != &path);
                map.insert(key, value.clone());
                value
            }
        };
        if let Some(uri) = value {
            out.insert(spec.id.clone(), uri);
        }
    }
    out
}

/// Путь с `*` в одном сегменте — в существующий путь.
///
/// Заведено ради агента: установщик кладёт его в каталог, у которого версия
/// стоит прямо в имени, и записанный жёстко путь протух бы с первым же
/// обновлением — молча, значок просто исчез бы. Каталоги и существование
/// приезжают предикатами: без них тест зависел бы от того, что стоит на
/// машине, где его гоняют.
///
/// Совпадений может быть несколько (две версии рядом — обычное дело после
/// обновления). Берём последнее по имени: иконка у всех одна, и выбор нужен
/// только затем, чтобы он не менялся от запуска к запуску — иначе кеш в
/// `Cache` пересчитывался бы на ровном месте.
pub fn glob_expand(
    pattern: &str,
    list: &dyn Fn(&Path) -> Vec<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    // Склейка через `\`, как и в `resolve_name`, и по той же причине: форма
    // виндовая, а гоняют тест на Linux, где `Path::join` разделитель ставит
    // свой.
    let segments: Vec<&str> = pattern.split(['\\', '/']).collect();
    let star = segments.iter().position(|s| s.contains('*'))?;
    let (prefix, suffix) = segments[star].split_once('*')?;
    // Второй `*` — не наш случай: разбирать его пришлось бы перебором
    // каталогов вглубь, а просят об этом ровно один путь, и в нём звезда одна.
    if suffix.contains('*') || segments[star + 1..].iter().any(|s| s.contains('*')) {
        return None;
    }
    let base = segments[..star].join("\\");
    let tail = segments[star + 1..].join("\\");
    let mut names = list(Path::new(&base));
    names.sort();
    names
        .iter()
        .rev()
        .filter(|n| n.len() >= prefix.len() + suffix.len())
        .filter(|n| n.starts_with(prefix) && n.ends_with(suffix))
        .map(|n| {
            let hit = format!("{base}\\{n}");
            PathBuf::from(if tail.is_empty() { hit } else { format!("{hit}\\{tail}") })
        })
        .find(|candidate| exists(candidate))
}

/// Имена в каталоге. Нет каталога — нет и имён: спрашивают про кандидата.
fn dir_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}

/// Путь из конфига — в путь на диске: переменные окружения, PATH, alias.
fn resolve(raw: &str) -> Option<PathBuf> {
    let expanded = expand_env(raw);
    let direct = Path::new(&expanded);
    let path = if expanded.contains('*') {
        glob_expand(&expanded, &dir_names, &|p: &Path| p.exists())?
    } else if expanded.contains('\\') || expanded.contains('/') {
        if !direct.exists() {
            return None;
        }
        direct.to_path_buf()
    } else {
        let path_var = std::env::var("PATH").unwrap_or_default();
        resolve_name(&expanded, &path_var, &|p: &Path| p.exists())?
    };
    Some(alias_target(&path).unwrap_or(path))
}

#[cfg(not(windows))]
fn expand_env(raw: &str) -> String {
    raw.to_string()
}

#[cfg(not(windows))]
fn alias_target(_path: &Path) -> Option<PathBuf> {
    None
}

/// Вне Windows иконок не бывает: `.app` — другой API и другая задача.
#[cfg(not(windows))]
fn extract(_path: &Path) -> Option<String> {
    None
}

#[cfg(windows)]
use std::mem::size_of;
#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
};
#[cfg(windows)]
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, OPEN_EXISTING,
};
#[cfg(windows)]
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
#[cfg(windows)]
use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
#[cfg(windows)]
use windows::Win32::System::IO::DeviceIoControl;
#[cfg(windows)]
use windows::Win32::UI::Shell::{SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGetFileInfoW};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

/// Код FSCTL_GET_REPARSE_POINT. Записан числом, а не взят из
/// `Win32_System_Ioctl`: ради одной константы тянуть ещё одну feature
/// `windows` дороже, чем написать её здесь.
#[cfg(windows)]
const FSCTL_GET_REPARSE_POINT: u32 = 0x0009_00A8;

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// `%SystemRoot%\explorer.exe` → настоящий путь.
///
/// Раскрытие живёт только в этой ветке: `argv` запускается без шелла
/// (`spawn_detached`), и раскрывать переменные там значило бы завести второй
/// разбор команды.
#[cfg(windows)]
fn expand_env(raw: &str) -> String {
    let src = wide(raw);
    let mut buf = vec![0u16; 4096];
    let len = unsafe { ExpandEnvironmentStringsW(PCWSTR(src.as_ptr()), Some(&mut buf)) } as usize;
    // Ответ считается вместе с нулём в конце; ноль и переполнение значат
    // «не вышло», и тогда путь остаётся тем, что дал человек.
    if len == 0 || len > buf.len() {
        return raw.to_string();
    }
    String::from_utf16_lossy(&buf[..len - 1])
}

/// Настоящий exe за app-execution alias — или `None`, если это обычный файл.
#[cfg(windows)]
fn alias_target(path: &Path) -> Option<PathBuf> {
    let name = wide(&path.to_string_lossy());
    // OPEN_REPARSE_POINT обязателен: без него открывается цель, а нам нужен
    // сам reparse point. BACKUP_SEMANTICS — чтобы не спорить с ACL каталога.
    let handle: HANDLE = unsafe {
        CreateFileW(
            PCWSTR(name.as_ptr()),
            0,
            FILE_SHARE_READ,
            None,
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
    }
    .ok()?;
    let mut buf = vec![0u8; 16 * 1024];
    let mut returned = 0u32;
    let ok = unsafe {
        DeviceIoControl(
            handle,
            FSCTL_GET_REPARSE_POINT,
            None,
            0,
            Some(buf.as_mut_ptr() as *mut _),
            buf.len() as u32,
            Some(&mut returned),
            None,
        )
    };
    unsafe {
        let _ = CloseHandle(handle);
    }
    ok.ok()?;
    appexec_target(&buf[..returned as usize]).map(PathBuf::from)
}

/// COM на время извлечения.
///
/// `SHGetFileInfoW` — вход в шелл, а шелл живёт на COM: за иконкой он идёт в
/// расширения, и без апартамента у потока они не отвечают. Апартамента у нас
/// нет ниоткуда: команда `async`, то есть исполняется на воркере пула, а не в
/// потоке, который Tauri инициализировал под себя. Дороже всего это стоит на
/// целях внутри `WindowsApps` — путь туда как раз через расширения, — и
/// стоило бы молча: отказ `SHGetFileInfoW` неотличим от «иконки у файла нет»,
/// то есть в меню просто не было бы картинки и ни строчки о причине.
///
/// Разынициализируется ровно то, что удалось инициализировать: `S_OK` и
/// `S_FALSE` обе значат «апартамент наш, парный вызов за нами», а
/// `RPC_E_CHANGED_MODE` — «поток уже в другом апартаменте», и `CoUninitialize`
/// на неё уронил бы чужой счётчик. Отсюда флаг внутри и `Drop`, а не два
/// вызова по месту: между ними стоит `?`, и на раннем выходе парность
/// потерялась бы.
#[cfg(windows)]
struct Com(bool);

#[cfg(windows)]
impl Com {
    fn init() -> Self {
        Self(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok())
    }
}

#[cfg(windows)]
impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

/// Иконка файла — в `data:image/png;base64,…`.
#[cfg(windows)]
fn extract(path: &Path) -> Option<String> {
    let _com = Com::init();
    let name = wide(&path.to_string_lossy());
    let mut info = SHFILEINFOW::default();
    let ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(name.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut info),
            size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if ok == 0 || info.hIcon.is_invalid() {
        return None;
    }
    let png = icon_png(info.hIcon);
    // Хендл иконки принадлежит нам, и его не возвращают: без DestroyIcon на
    // каждый перечит утекает GDI-объект, а их у процесса десять тысяч.
    unsafe {
        let _ = DestroyIcon(info.hIcon);
    }
    png
}

#[cfg(windows)]
fn icon_png(icon: HICON) -> Option<String> {
    let mut ii = ICONINFO::default();
    unsafe { GetIconInfo(icon, &mut ii) }.ok()?;
    let colour = read_dib(ii.hbmColor);
    let mask = read_dib(ii.hbmMask);
    unsafe {
        let _ = DeleteObject(ii.hbmColor.into());
        let _ = DeleteObject(ii.hbmMask.into());
    }
    let (width, height, bgra) = colour?;
    let mask_px = mask.map(|(_, _, px)| px).unwrap_or_default();
    let rgba = to_rgba(&bgra, &mask_px);

    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().ok()?.write_image_data(&rgba).ok()?;
    }
    use base64::Engine;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}

/// Битмап → (ширина, высота, BGRA).
///
/// Высота в заголовке отрицательная намеренно: так строки идут сверху вниз.
/// С положительной DIB приезжает снизу вверх, и иконка встала бы вверх ногами
/// — молча, потому что размеры при этом верные.
#[cfg(windows)]
fn read_dib(bitmap: HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
    let mut bm = BITMAP::default();
    let read = unsafe {
        GetObjectW(
            bitmap.into(),
            size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut _),
        )
    };
    if read == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 {
        return None;
    }
    let (width, height) = (bm.bmWidth as u32, bm.bmHeight as u32);
    let mut info = BITMAPINFO::default();
    info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = bm.bmWidth;
    info.bmiHeader.biHeight = -bm.bmHeight;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB.0;
    // Счёт в usize, а не в u32 с приведением потом: в release переполнение
    // молча обернулось бы, и WinAPI писал бы пиксели в буфер короче
    // обещанного. Для иконки это недостижимо, но недостижимость тут держится
    // на размерах, которые пришли снаружи.
    let mut pixels = vec![0u8; width as usize * height as usize * 4];
    let hdc = unsafe { CreateCompatibleDC(None) };
    let rows = unsafe {
        GetDIBits(
            hdc,
            bitmap,
            0,
            height,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    unsafe {
        let _ = DeleteDC(hdc);
    }
    if rows == 0 {
        return None;
    }
    Some((width, height, pixels))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Буфер AppExecLink — как его отдаёт FSCTL_GET_REPARSE_POINT.
    fn appexec_buf(strings: &[&str]) -> Vec<u8> {
        let mut data = vec![3u8, 0, 0, 0]; // версия
        for s in strings {
            for w in s.encode_utf16() {
                data.extend_from_slice(&w.to_le_bytes());
            }
            data.extend_from_slice(&[0, 0]); // NUL
        }
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x8000_001Bu32.to_le_bytes()); // тег
        buf.extend_from_slice(&(data.len() as u16).to_le_bytes());
        buf.extend_from_slice(&[0, 0]); // Reserved
        buf.extend_from_slice(&data);
        buf
    }

    /// Третья строка, а не первая: первые две — имя пакета и AppUserModelID.
    /// Взяв первую, мы бы кормили SHGetFileInfo именем пакета, а он на такое
    /// отвечает дежурной иконкой — то есть ровно тем, из-за чего вся эта
    /// ветка и появилась.
    #[test]
    fn appexec_target_is_the_third_string() {
        let buf = appexec_buf(&[
            "Microsoft.WindowsTerminal_8wekyb3d8bbwe",
            "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App",
            r"X:\Program Files\WindowsApps\Microsoft.WindowsTerminal\WindowsTerminal.exe",
        ]);
        assert_eq!(
            appexec_target(&buf).as_deref(),
            Some(r"X:\Program Files\WindowsApps\Microsoft.WindowsTerminal\WindowsTerminal.exe"),
        );
    }

    /// Чужой тег — не наше дело: обычный symlink разбирать этим разбором
    /// нельзя, у него другая раскладка байт.
    #[test]
    fn other_reparse_tags_are_left_alone() {
        let mut buf = appexec_buf(&["a", "b", "c"]);
        buf[0..4].copy_from_slice(&0xA000_000Cu32.to_le_bytes()); // symlink
        assert_eq!(appexec_target(&buf), None);
    }

    /// Обрезанный буфер даёт None, а не панику: это данные с диска, и
    /// доверять их длине нельзя.
    #[test]
    fn truncated_buffer_is_none() {
        let buf = appexec_buf(&["a", "b", "c"]);
        for cut in [0usize, 4, 8, 12] {
            assert_eq!(appexec_target(&buf[..cut]), None, "обрезка до {cut} байт");
        }
        assert_eq!(appexec_target(&appexec_buf(&["a", "b"])), None, "строк меньше трёх");
    }

    /// Иконка с альфа-каналом берётся как есть, порядок каналов — BGRA→RGBA.
    #[test]
    fn bgra_becomes_rgba() {
        let bgra = vec![10, 20, 30, 255, 1, 2, 3, 128];
        let out = to_rgba(&bgra, &[]);
        assert_eq!(out, vec![30, 20, 10, 255, 3, 2, 1, 128]);
    }

    /// Старая иконка без альфы: во всём битмапе ноль, и взять её как есть
    /// значило бы показать пустоту. Прозрачность собирается по маске, где
    /// белый — дырка.
    #[test]
    fn alpha_comes_from_the_mask_when_missing() {
        let bgra = vec![10, 20, 30, 0, 40, 50, 60, 0];
        let mask = vec![0, 0, 0, 255, 255, 255, 255, 255];
        let out = to_rgba(&bgra, &mask);
        assert_eq!(out, vec![30, 20, 10, 255, 60, 50, 40, 0]);
    }

    /// Голое имя ищется по PATH с дописанным .exe; путь с разделителем не
    /// трогается вовсе — иначе `wt.exe` из PATH перебил бы путь из конфига.
    #[test]
    fn bare_name_is_looked_up_in_path() {
        let path_var = r"X:\one;X:\two";
        let exists = |p: &std::path::Path| p.to_string_lossy() == r"X:\two\cursor.exe";
        assert_eq!(
            resolve_name("cursor", path_var, &exists).map(|p| p.to_string_lossy().to_string()),
            Some(r"X:\two\cursor.exe".to_string()),
        );
        assert_eq!(resolve_name("nope", path_var, &exists), None);
    }

    /// Элемент `PATH` с хвостовым `\` — законная запись на Windows; без
    /// среза склейка дала бы двойной разделитель, и `exists` не нашёл бы
    /// файл, хотя он там есть.
    #[test]
    fn trailing_separator_in_a_path_entry_does_not_matter() {
        let path_var = r"X:\one\;X:\two";
        let exists = |p: &std::path::Path| p.to_string_lossy() == r"X:\one\cursor.exe";
        assert_eq!(
            resolve_name("cursor", path_var, &exists).map(|p| p.to_string_lossy().to_string()),
            Some(r"X:\one\cursor.exe".to_string()),
        );
    }

    /// Каталог с версией в имени: звезда закрывает ровно его, хвост после неё
    /// приклеивается как есть.
    #[test]
    fn star_matches_a_versioned_directory() {
        let list = |_: &std::path::Path| vec!["2.1.222".to_string(), "2.1.227".to_string()];
        let exists = |p: &std::path::Path| p.to_string_lossy().starts_with(r"X:\app\claude-code\2.1.");
        assert_eq!(
            glob_expand(r"X:\app\claude-code\*\claude.exe", &list, &exists)
                .map(|p| p.to_string_lossy().to_string()),
            Some(r"X:\app\claude-code\2.1.227\claude.exe".to_string()),
        );
    }

    /// Совпало имя каталога, но файла в нём нет — берётся следующий кандидат,
    /// а не пустота: после обновления рядом лежат две версии, и недокачанная
    /// новая не должна гасить значок.
    #[test]
    fn star_falls_through_to_the_next_match() {
        let list = |_: &std::path::Path| vec!["1.0".to_string(), "2.0".to_string()];
        let exists = |p: &std::path::Path| p.to_string_lossy() == r"X:\app\1.0\claude.exe";
        assert_eq!(
            glob_expand(r"X:\app\*\claude.exe", &list, &exists)
                .map(|p| p.to_string_lossy().to_string()),
            Some(r"X:\app\1.0\claude.exe".to_string()),
        );
    }

    /// Пустой каталог и вторая звезда — оба «не нашлось», а не паника.
    #[test]
    fn star_without_a_match_is_none() {
        let empty = |_: &std::path::Path| Vec::new();
        let all = |_: &std::path::Path| true;
        assert_eq!(glob_expand(r"X:\app\*\claude.exe", &empty, &all), None);
        let two = |_: &std::path::Path| vec!["a".to_string()];
        assert_eq!(glob_expand(r"X:\*\*\claude.exe", &two, &all), None, "двух звёзд не разбираем");
    }

    /// Вне Windows меню целиком глифовое — это дизайн, а не поломка. Контракт
    /// мака ничем не был закреплён: `extract()` там всегда `None`, но без
    /// теста откат этого правила не покраснел бы нигде.
    #[cfg(not(windows))]
    #[test]
    fn icons_for_is_empty_off_windows() {
        let specs = [IconSpec { id: "new".into(), path: "claude.exe".into() }];
        assert_eq!(icons_for(&specs, &Cache::default()), HashMap::new());
    }
}
