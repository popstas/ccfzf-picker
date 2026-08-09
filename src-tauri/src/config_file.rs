//! Запись config.yaml из окна настроек.

/// Шапка переписанного конфига.
///
/// Записывается затем, что перезапись через serde_yaml теряет комментарии — а
/// в config.yaml они и есть документация. Человек, открывший файл после
/// первого сохранения, должен сразу понимать, куда делись его пометки и где
/// лежит прежний файл. Сама шапка — комментарий, разбор её выбрасывает, и на
/// следующем сохранении она не удваивается.
pub const HEADER: &str = "\
# Этот файл ведёт окно настроек ccfzf-picker: при сохранении он переписывается
# целиком, и комментарии в нём не сохраняются. Прежний файл лежит рядом —
# config.yaml.bak. Описание всех ключей — в config.example.yml репозитория.
";

/// Влить патч в документ.
///
/// Отображения сливаются по ключам, всё остальное заменяется целиком. Разница
/// не косметическая: `mqtt.password` окно настроек не показывает и обратно не
/// присылает, и замена блока целиком стирала бы пароль на каждом сохранении.
/// Списки, наоборот, заменяются: слить два списка проектов по ключам нечем, а
/// «дописать» — не то, чего хочет человек, убравший строку из формы.
pub fn merge_patch(doc: &mut serde_yaml::Value, patch: &serde_json::Value) -> Result<(), String> {
    let Some(fields) = patch.as_object() else {
        return Err("настройки пришли не объектом".into());
    };
    if doc.is_null() {
        *doc = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
    }
    let Some(map) = doc.as_mapping_mut() else {
        return Err("config.yaml — не отображение, править его нечем".into());
    };
    for (key, value) in fields {
        let key = serde_yaml::Value::String(key.clone());
        // Решение принимается до `get_mut`: заимствование от него живёт до
        // конца ветки, и `insert` в соседней уже не собрался бы.
        let nested = value.as_object().is_some()
            && map.get(&key).map(|v| v.is_mapping()).unwrap_or(false);
        if nested {
            // `unwrap` безопасен: `nested` истинно только когда ключ есть.
            merge_patch(map.get_mut(&key).unwrap(), value)?;
        } else {
            let incoming: serde_yaml::Value =
                serde_yaml::to_value(value).map_err(|e| format!("не перевести значение: {e}"))?;
            map.insert(key, incoming);
        }
    }
    Ok(())
}

/// Документ в текст, без шапки: её ставит вызывающий.
pub fn render(doc: &serde_yaml::Value) -> Result<String, String> {
    serde_yaml::to_string(doc).map_err(|e| format!("не собрать yaml: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(yaml: &str) -> serde_yaml::Value {
        serde_yaml::from_str(yaml).unwrap()
    }

    /// Нетронутые ключи переживают запись.
    ///
    /// Ради этого патч и слияние: окно настроек не знает про `actions` вовсе,
    /// а перезапись целиком стёрла бы их человеку молча.
    #[test]
    fn untouched_keys_survive() {
        let mut d = doc("sshHost: old\nactions:\n  - id: finder\n    argv: ['open', '{localPath}']\n");
        merge_patch(&mut d, &serde_json::json!({"sshHost": "new"})).unwrap();
        let out = render(&d).unwrap();
        assert!(out.contains("new"), "новое значение записано: {out}");
        assert!(!out.contains("old"), "старое значение заменено: {out}");
        assert!(out.contains("finder"), "чужой ключ на месте: {out}");
    }

    /// Вложенное отображение сливается по ключам, а не заменяется целиком.
    ///
    /// Из-за пароля: окно настроек не показывает его и не присылает обратно —
    /// замена блока целиком стирала бы пароль на каждом сохранении.
    #[test]
    fn nested_maps_merge_key_by_key() {
        let mut d = doc("mqtt:\n  host: broker\n  base: home/room/pc\n  password: secret\n");
        merge_patch(&mut d, &serde_json::json!({"mqtt": {"host": "other"}})).unwrap();
        let out = render(&d).unwrap();
        assert!(out.contains("other"));
        assert!(out.contains("secret"), "пароль не тронут: {out}");
        assert!(out.contains("home/room/pc"), "префикс топиков не тронут: {out}");
    }

    /// Списки заменяются целиком: слить два списка проектов по ключам нечем,
    /// а «дописать» — не то, чего хочет человек, убравший строку из формы.
    #[test]
    fn lists_are_replaced_whole() {
        let mut d = doc("projects:\n  - path: /a\n    hotkey: Cmd+Shift+1\n  - path: /b\n");
        merge_patch(&mut d, &serde_json::json!({
            "projects": [{"path": "/a", "hotkey": "Cmd+Shift+9"}]
        })).unwrap();
        let out = render(&d).unwrap();
        assert!(out.contains("Cmd+Shift+9"));
        assert!(!out.contains("/b"), "убранный проект не воскресает: {out}");
    }

    /// Пустой документ — не отказ: конфига могло не быть вовсе.
    #[test]
    fn empty_document_becomes_a_mapping() {
        let mut d = serde_yaml::Value::Null;
        merge_patch(&mut d, &serde_json::json!({"sshHost": "host"})).unwrap();
        assert!(render(&d).unwrap().contains("host"));
    }

    /// Патч не той формы — отказ, а не молчаливая порча файла.
    #[test]
    fn non_object_patch_is_refused() {
        let mut d = doc("sshHost: old\n");
        assert!(merge_patch(&mut d, &serde_json::json!("строка")).is_err());
        assert!(merge_patch(&mut d, &serde_json::json!([1, 2])).is_err());
    }

    /// Шапка — комментарий, и обратно она не читается: значит, на следующем
    /// сохранении не удвоится.
    #[test]
    fn header_is_a_comment_and_does_not_accumulate() {
        let once = format!("{HEADER}sshHost: host\n");
        let parsed: serde_yaml::Value = serde_yaml::from_str(&once).unwrap();
        let twice = format!("{HEADER}{}", render(&parsed).unwrap());
        assert_eq!(twice.matches("окно настроек").count(), HEADER.matches("окно настроек").count());
    }
}
