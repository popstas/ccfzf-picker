//! Иконки приложений для меню действий.
//!
//! Разбор — здесь и без `cfg(windows)`: и буфер reparse, и пиксели приезжают
//! байтами, а байты одинаковы везде. Под `cfg(windows)` остаётся обвязка над
//! WinAPI, у которой своей логики нет и проверять в ней нечего.
use std::path::{Path, PathBuf};

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
    // обычный символ, и склейка через него разошлась бы с ожиданием. Каталоги
    // здесь всегда виндовые (PATH с целевой машины), поэтому слэш свой.
    path_var
        .split(';')
        .filter(|dir| !dir.is_empty())
        .map(|dir| PathBuf::from(format!("{dir}\\{file}")))
        .find(|candidate| exists(candidate))
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
}
