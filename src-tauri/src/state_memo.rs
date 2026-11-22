//! Условный опрос: отпечаток прошлого ответа по источнику.
//!
//! `ccfzf --state` кладёт в полный ответ поле `fingerprint`, а на
//! `--if-changed <fp>` с совпавшим отпечатком отвечает одной строкой
//! `{"unchanged":true,...}` вместо сотен килобайт. Здесь хранится, что
//! посылать каждому источнику и чем подменить короткий ответ.
//!
//! Совместимость держится на происхождении ключа, а не на разборе отказов:
//! отпечаток посылается только тот, что пришёл от этого же источника. Агрегатор
//! прошлой версии поля не отдаёт — значит и ключа не получает никогда, а
//! незнакомый ключ его обёртка отвергла бы кодом 2.

use crate::state_source::Source;
use serde_json::Value;
use std::collections::HashMap;

/// Имя поля отпечатка в полном и в коротком ответе.
pub const FIELD: &str = "fingerprint";

/// Похоже ли значение на отпечаток: шестнадцать знаков hex в нижнем регистре.
///
/// Строка пришла из чужого ответа и уезжает в командную строку удалённого
/// шелла — ровно как id сессии (`looks_like_session_id`). Пропусти мы сюда
/// пробел или `;`, разбирал бы их уже он.
pub fn looks_like_fingerprint(fp: &str) -> bool {
    fp.len() == 16 && fp.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Последний полный ответ источника и его отпечаток.
#[derive(Clone, Debug)]
struct Entry {
    fingerprint: String,
    answer: Value,
}

/// Чем кончился разбор ответа.
#[derive(Debug, PartialEq)]
pub enum Absorbed {
    /// Готовый ответ прежней формы: полный, либо сохранённый вместо короткого.
    Ready(Value),
    /// Короткий ответ, подменить который нечем, — память сброшена, спросить
    /// заново без ключа.
    Refetch,
    /// Отказ источника. Память его сброшена: следующий опрос полный.
    Failed(String),
}

/// Память по источникам. Ключ — метка источника (`Source::label`).
#[derive(Default)]
pub struct Memo {
    by_source: HashMap<String, Entry>,
}

impl Memo {
    /// Что послать источнику в `--if-changed`; `None` — спрашивать полный.
    pub fn key_for(&self, source: &Source) -> Option<String> {
        self.by_source.get(&source.label()).map(|e| e.fingerprint.clone())
    }

    /// Забыть всё: сменились источники в настройках.
    pub fn clear(&mut self) {
        self.by_source.clear();
    }

    /// Разобрать ответ источника.
    ///
    /// Короткий ответ до страницы не доходит никогда: в нём нет `sessions`, и
    /// `validateState` отверг бы его, погасив весь список. Вместо него уходит
    /// сохранённый полный — с `generated` из короткого, потому что слияние
    /// берёт возраст по самому старому куску. Поле `fingerprint` у полного
    /// снимается: документ для страницы и слияния остаётся прежней формы.
    pub fn absorb(&mut self, source: &Source, reply: Result<Value, String>) -> Absorbed {
        let label = source.label();
        let mut answer = match reply {
            Ok(v) => v,
            Err(e) => {
                self.by_source.remove(&label);
                return Absorbed::Failed(e);
            }
        };
        let fp = answer
            .get(FIELD)
            .and_then(|v| v.as_str())
            .filter(|fp| looks_like_fingerprint(fp))
            .map(str::to_string);

        if answer.get("unchanged").and_then(|v| v.as_bool()) == Some(true) {
            let Some(entry) = self.by_source.get(&label) else {
                return Absorbed::Refetch;
            };
            if fp.as_deref() != Some(entry.fingerprint.as_str()) {
                self.by_source.remove(&label);
                return Absorbed::Refetch;
            }
            let mut cached = entry.answer.clone();
            if let (Some(obj), Some(g)) = (cached.as_object_mut(), answer.get("generated")) {
                obj.insert("generated".to_string(), g.clone());
            }
            return Absorbed::Ready(cached);
        }

        if let Some(obj) = answer.as_object_mut() {
            obj.remove(FIELD);
        }
        match fp {
            Some(fingerprint) => {
                self.by_source
                    .insert(label, Entry { fingerprint, answer: answer.clone() });
            }
            // Агрегатор прошлой версии или кривое поле — ключа не посылать.
            None => {
                self.by_source.remove(&label);
            }
        }
        Absorbed::Ready(answer)
    }
}

/// Опросить источник с памятью: ключ из памяти, разбор ответа, повтор без
/// ключа, если короткий ответ подменить нечем.
///
/// `fetch` — параметром, чтобы тест подставил ответы без ssh. Замок берётся
/// только на чтение ключа и на разбор, не на сам вызов: `fresh_state` зовёт
/// опрос из другого потока, и ssh под замком держал бы его секундами.
pub fn fetch_with<F>(
    memo: &std::sync::Mutex<Memo>,
    source: &Source,
    mut fetch: F,
) -> Result<Value, String>
where
    F: FnMut(Option<&str>) -> Result<Value, String>,
{
    let key = memo.lock().unwrap().key_for(source);
    let reply = fetch(key.as_deref());
    match memo.lock().unwrap().absorb(source, reply) {
        Absorbed::Ready(v) => return Ok(v),
        Absorbed::Failed(e) => return Err(e),
        Absorbed::Refetch => {}
    }
    // Второй круг — без ключа. Короткий ответ на него значил бы сломанный
    // агрегатор; повторять дальше незачем, это отказ.
    match memo.lock().unwrap().absorb(source, fetch(None)) {
        Absorbed::Ready(v) => Ok(v),
        Absorbed::Failed(e) => Err(e),
        Absorbed::Refetch => Err("ccfzf --state answered unchanged to a full request".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    const FP: &str = "0123456789abcdef";
    const FP2: &str = "fedcba9876543210";

    fn ssh() -> Source {
        Source::Ssh("remote-host".into())
    }

    fn full(fp: &str, ids: &[&str]) -> Value {
        json!({
            "generated": 100,
            "sessions": ids.iter().map(|id| json!({"id": id})).collect::<Vec<_>>(),
            "fingerprint": fp,
        })
    }

    fn short(fp: &str, generated: i64) -> Value {
        json!({"unchanged": true, "fingerprint": fp, "generated": generated})
    }

    #[test]
    fn otpechatok_tolko_shestnadtsat_znakov_hex() {
        assert!(looks_like_fingerprint(FP));
        assert!(!looks_like_fingerprint("0123456789ABCDEF"), "верхний регистр ccfzf не пишет");
        assert!(!looks_like_fingerprint("0123456789abcde"));
        assert!(!looks_like_fingerprint("0123456789abcdef0"));
        assert!(!looks_like_fingerprint("0123456789abcd;f"), "едет в чужой шелл");
        assert!(!looks_like_fingerprint(""));
    }

    #[test]
    fn polnyi_otvet_zapominaetsya_i_otdayotsya_bez_polya_otpechatka() {
        let mut memo = Memo::default();
        assert_eq!(memo.key_for(&ssh()), None, "первый опрос — полный");
        let got = memo.absorb(&ssh(), Ok(full(FP, &["a"])));
        let Absorbed::Ready(v) = got else { panic!("{got:?}") };
        assert!(v.get(FIELD).is_none(), "документ для страницы — прежней формы");
        assert_eq!(v["sessions"][0]["id"], "a");
        assert_eq!(memo.key_for(&ssh()).as_deref(), Some(FP));
    }

    #[test]
    fn korotkii_otvet_podmenyaetsya_sohranyonnym_so_svezhim_generated() {
        let mut memo = Memo::default();
        memo.absorb(&ssh(), Ok(full(FP, &["a", "b"])));
        let got = memo.absorb(&ssh(), Ok(short(FP, 200)));
        let Absorbed::Ready(v) = got else { panic!("{got:?}") };
        assert_eq!(v["sessions"].as_array().unwrap().len(), 2, "до страницы доходит полный список");
        assert_eq!(v["generated"], 200, "возраст — от короткого ответа");
        assert!(v.get("unchanged").is_none());
        assert_eq!(memo.key_for(&ssh()).as_deref(), Some(FP), "память не сбита");
        // Повторный короткий — снова полный список: подмена не портит память.
        let Absorbed::Ready(v) = memo.absorb(&ssh(), Ok(short(FP, 300))) else { panic!() };
        assert_eq!(v["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(v["generated"], 300);
    }

    #[test]
    fn korotkii_bez_pamyati_ili_s_chuzhim_otpechatkom_prosit_polnyi() {
        let mut memo = Memo::default();
        assert_eq!(memo.absorb(&ssh(), Ok(short(FP, 1))), Absorbed::Refetch);
        memo.absorb(&ssh(), Ok(full(FP, &["a"])));
        assert_eq!(memo.absorb(&ssh(), Ok(short(FP2, 1))), Absorbed::Refetch);
        assert_eq!(memo.key_for(&ssh()), None, "чужой отпечаток сбрасывает память");
    }

    #[test]
    fn otkaz_sbrasyvaet_pamyat_istochnika() {
        let mut memo = Memo::default();
        memo.absorb(&ssh(), Ok(full(FP, &["a"])));
        assert_eq!(
            memo.absorb(&ssh(), Err("exited with 255".into())),
            Absorbed::Failed("exited with 255".into())
        );
        assert_eq!(memo.key_for(&ssh()), None, "после обрыва — полный опрос");
    }

    #[test]
    fn staryi_agregator_bez_otpechatka_klyucha_ne_poluchaet() {
        // Старый ccfzf на незнакомый ключ выходит с кодом 2 — слать его туда
        // нельзя. Он и не узнает: без поля в ответе памяти нет.
        let mut memo = Memo::default();
        memo.absorb(&ssh(), Ok(json!({"generated": 1, "sessions": []})));
        assert_eq!(memo.key_for(&ssh()), None);
        // Тот же источник, откатившийся на старую версию, забывает ключ.
        memo.absorb(&ssh(), Ok(full(FP, &[])));
        memo.absorb(&ssh(), Ok(json!({"generated": 1, "sessions": []})));
        assert_eq!(memo.key_for(&ssh()), None);
        // Кривое поле — то же, что его отсутствие.
        memo.absorb(&ssh(), Ok(full("x; rm -rf ~", &[])));
        assert_eq!(memo.key_for(&ssh()), None);
    }

    #[test]
    fn pamyat_u_kazhdogo_istochnika_svoya() {
        let mut memo = Memo::default();
        memo.absorb(&ssh(), Ok(full(FP, &["a"])));
        memo.absorb(&Source::Local, Ok(full(FP2, &["b"])));
        assert_eq!(memo.key_for(&ssh()).as_deref(), Some(FP));
        assert_eq!(memo.key_for(&Source::Local).as_deref(), Some(FP2));
        memo.absorb(&Source::Local, Err("ccfzf not found".into()));
        assert_eq!(memo.key_for(&ssh()).as_deref(), Some(FP), "отказ одного не трогает другого");
        memo.clear();
        assert_eq!(memo.key_for(&ssh()), None);
    }

    #[test]
    fn fetch_with_shlyot_klyuch_i_povtoryaet_bez_nego() {
        let memo = Mutex::new(Memo::default());
        let mut sent: Vec<Option<String>> = Vec::new();
        let v = fetch_with(&memo, &ssh(), |key| {
            sent.push(key.map(str::to_string));
            Ok(full(FP, &["a"]))
        })
        .unwrap();
        assert_eq!(v["sessions"][0]["id"], "a");
        let v = fetch_with(&memo, &ssh(), |key| {
            sent.push(key.map(str::to_string));
            Ok(short(FP, 5))
        })
        .unwrap();
        assert_eq!(v["generated"], 5);
        assert_eq!(sent, vec![None, Some(FP.to_string())]);

        // Агрегатор сменил отпечаток в коротком ответе (перезапуск, гонка):
        // второй круг идёт без ключа и берёт полный.
        sent.clear();
        let mut replies = vec![Ok(full(FP2, &["c"])), Ok(short(FP2, 1))];
        let v = fetch_with(&memo, &ssh(), |key| {
            sent.push(key.map(str::to_string));
            replies.pop().unwrap()
        })
        .unwrap();
        assert_eq!(v["sessions"][0]["id"], "c");
        assert_eq!(sent, vec![Some(FP.to_string()), None]);
        assert_eq!(memo.lock().unwrap().key_for(&ssh()).as_deref(), Some(FP2));
    }

    #[test]
    fn korotkii_na_polnyi_zapros_eto_otkaz_a_ne_tsikl() {
        let memo = Mutex::new(Memo::default());
        let mut calls = 0;
        let got = fetch_with(&memo, &ssh(), |_| {
            calls += 1;
            Ok(short(FP, 1))
        });
        assert!(got.is_err(), "{got:?}");
        assert_eq!(calls, 2, "один повтор, не больше");
    }
}
