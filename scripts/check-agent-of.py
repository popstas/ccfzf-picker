"""Проверка agent_of() из ccfzf: `last activity` не должна ехать за
перерисовкой статуслайна.

Тесты проекта — node --test и про фронтенд; питон внутри ccfzf ими не
покрывается, а именно там жила ошибка «last activity постоянно сбрасывается».
Скрипт вытаскивает PY-блок из ccfzf и зовёт agent_of() на подложных файлах.

Запуск: python3 scripts/check-agent-of.py vendor/ccfzf
"""
import json
import os
import sys
import tempfile

src = sys.argv[1]
lines = open(src, encoding="utf-8").read().splitlines()
start = next(i for i, l in enumerate(lines) if l.startswith("read -r -d '' PY"))
end = next(i for i, l in enumerate(lines) if l == "PYEOF")
body = lines[start + 1:end]
# Ниже `mode = sys.argv[1]` начинается разбор режимов; нужны только функции.
body = body[:next(i for i, l in enumerate(body) if l.startswith("mode = sys.argv"))]
code = "\n".join(body)

mod = {"__name__": "ccfzf_py"}
exec(compile(code, "ccfzf.PY", "exec"), mod)

tmp = tempfile.mkdtemp()
mod["STATUS_DIR"] = tmp

def write(sid, suffix, obj):
    with open(os.path.join(tmp, sid + suffix), "w", encoding="utf-8") as fh:
        json.dump(obj, fh)

agent_of = mod["agent_of"]
fails = []
checks = 0

def check(name, got, want):
    global checks
    checks += 1
    if got != want:
        fails.append("%s: got %r, want %r" % (name, got, want))

# 1. Сессия спит шесть часов, но её терминал открыт, и статуслайн по таймеру
#    переписывает status.json каждые 5 секунд. Активность — та, что в state.json.
IDLE, NOW = 1785934867, 1785958293
write("idle", ".state.json", {"state": "idle", "updated": IDLE})
write("idle", ".status.json", {"costUsd": 3, "contextPct": 40, "updated": NOW})
check("живой простой: updated", agent_of("idle")["updated"], IDLE)
check("живой простой: costUsd", agent_of("idle")["costUsd"], 3)
check("живой простой: contextPct", agent_of("idle")["contextPct"], 40)

# 2. Старая сессия без state.json: кроме статуслайна взять нечего.
write("old", ".status.json", {"costUsd": 1, "updated": 1785676913})
check("без state.json", agent_of("old")["updated"], 1785676913)

# 3. Испорченное поле не должно давать отрицательный или строковый ответ.
write("bad", ".state.json", {"state": "idle", "updated": "nope"})
write("bad", ".status.json", {"updated": NOW})
check("испорченный updated", agent_of("bad")["updated"], NOW)

# 4. Нет ни того, ни другого файла.
check("нет файлов", agent_of("missing"), None)

# Дальше — проверки, которым нужна <id>.meta.json, и у них свой каталог.
# meta_all в ccfzf запоминает проход по каталогу на весь срок процесса, и это
# верно: агрегатор одноразовый, за свой тик каталог не меняется. Скрипт живёт
# дольше и дописывает файлы между вызовами — в общем каталоге пустая память,
# снятая проверкой 1, скрыла бы meta.json, положенную ниже. Поэтому каталог
# новый, а файлы в нём кладутся все сразу, до первого вызова: ровно так их и
# видит настоящий агрегатор.
tmp = tempfile.mkdtemp()
mod["STATUS_DIR"] = tmp

# meta_all отбирает из каталога только файлы вида <uuid>.meta.json — не любой
# <id>.meta.json, а строго по UUID_RE. Прежним sid вида "idle"/"old"/"bad" это
# было всё равно: их meta.json никто не писал. Здесь пишем, и без формата
# настоящего id запись прошла бы мимо фильтра и не попала бы в ответ.
FULL, METAONLY = (
    "aaaaaaaa-1111-2222-3333-444444444444",
    "bbbbbbbb-1111-2222-3333-444444444444",
)
TURN, START = 1785958000, 1785950000
write(FULL, ".state.json", {
    "state": "question", "updated": NOW, "turnAt": TURN,
    "question": "Какой вариант?",
    "message": "Claude needs your permission to use Bash",
})
write(FULL, ".meta.json", {"started": START})
# Сессия старше появления полей: state.json есть, meta.json нет.
write("older", ".state.json", {"state": "idle", "updated": IDLE})
write("badturn", ".state.json", {"state": "active", "updated": NOW, "turnAt": "90"})
write(METAONLY, ".meta.json", {"started": START})

# 5. Четыре поля, каждое из своего файла: ход, вопрос и уведомление — из
#    state.json, старт сессии — из meta.json.
full = agent_of(FULL)
check("ход: turnAt", full["turnAt"], TURN)
check("старт: started", full["started"], START)
check("вопрос", full["question"], "Какой вариант?")
check("уведомление", full["message"], "Claude needs your permission to use Bash")

# 6. Сессия старше появления этих полей: умолчания, а не KeyError.
check("нет turnAt", agent_of("older")["turnAt"], 0)
check("нет started", agent_of("older")["started"], 0)
check("нет question", agent_of("older")["question"], "")
check("нет message", agent_of("older")["message"], "")

# 7. Испорченная отметка хода — ноль, как и у updated.
check("строковый turnAt", agent_of("badturn")["turnAt"], 0)

# 8. Одна meta.json записи агента не создаёт: «запись есть» значит «хук хоть
#    раз сработал», а старт сессии об этом не говорит.
check("только meta.json", agent_of(METAONLY), None)

if fails:
    print("FAIL")
    for f in fails:
        print("  " + f)
    sys.exit(1)
print("OK, проверок: %d" % checks)
