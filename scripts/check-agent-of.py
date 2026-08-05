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

def check(name, got, want):
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

if fails:
    print("FAIL")
    for f in fails:
        print("  " + f)
    sys.exit(1)
print("OK: 4 проверки")
