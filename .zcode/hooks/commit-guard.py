#!/usr/bin/env python3
"""Скрипт хука коммита и пуша. Политики репозитория kbju.

1. Прямой коммит в main запрещён: работа идёт в своей ветке, а main получает вливания
   через --no-ff. Исключение — завершение слияния, когда есть MERGE_HEAD.
2. Коммит с персональными данными владельца запрещён. Проверяются две вещи: значения из
   списка .misc/private-values.txt и строки, похожие на отчёт с измерениями.
3. Пуш, который кладёт в main чужую ветку в обход слияния, запрещён.

Режимы вызова:
  zcode       — хук ZCode: описание вызова приходит в JSON на стандартный вход;
  pre-commit  — хук git перед коммитом;
  pre-push    — хук git перед пушем, строки ссылок приходят на стандартный вход.

Код возврата: 0 — пропустить, 1 — ошибка режима, 2 — заблокировать с причиной в stderr.
При своей поломке скрипт пропускает действие: сломанный хук не должен останавливать
работу. Это осознанный выбор, он записан в AGENTS.md.
"""

import json
import os
import re
import shlex
import subprocess
import sys

MEASUREMENT_WORDS = (
    "биоимпеданс",
    "тощая масса",
    "жировая масса",
    "основной обмен",
    "базальный",
    "висцеральный",
    "состав тела",
    "процент жира",
)

NUMBER = re.compile(r"\d+[.,]?\d*")


def read_command() -> str:
    """Достаёт команду из описания вызова. Форма описания может отличаться."""
    try:
        raw = sys.stdin.read()
    except Exception:
        return ""
    if not raw.strip():
        return ""
    try:
        data = json.loads(raw)
    except Exception:
        return raw
    if not isinstance(data, dict):
        return ""
    for key in ("tool_input", "input", "arguments", "parameters"):
        value = data.get(key)
        if isinstance(value, dict) and isinstance(value.get("command"), str):
            return value["command"]
    if isinstance(data.get("command"), str):
        return data["command"]
    return ""


def git(*args: str) -> str:
    try:
        done = subprocess.run(
            ("git",) + args, capture_output=True, text=True, timeout=15, check=False
        )
        return done.stdout
    except Exception:
        return ""


def staged_diff(command: str) -> str:
    parts = [git("diff", "--cached", "--unified=0")]
    # При `git commit -a` в коммит уходят и правки рабочего дерева, не попавшие в индекс.
    if " -a" in command or "--all" in command or "-am" in command:
        parts.append(git("diff", "--unified=0"))
    return "\n".join(parts)


def added_lines(diff: str) -> list:
    return [
        line
        for line in diff.splitlines()
        if line.startswith("+") and not line.startswith("+++")
    ]


def load_values() -> list:
    path = os.environ.get("KBJU_VALUES_FILE") or ".misc/private-values.txt"
    if not os.path.exists(path):
        return []
    values = []
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line and not line.startswith("#"):
                    values.append(line)
    except Exception:
        return []
    return values


def find_values(diff: str) -> list:
    """Точная проверка: значения из списка владельца. Это блокирующая проверка."""
    lines = added_lines(diff)
    found = []
    for value in load_values():
        pattern = re.compile(r"(?<![\d.,])" + re.escape(value) + r"(?![\d.,])")
        for line in lines:
            if pattern.search(line):
                found.append(f"значение из списка: {line.strip()[:90]}")
                break
    return found


def find_report_like(diff: str) -> list:
    """Мягкая проверка: строка похожа на отчёт с измерениями.

    Блокировать по ней нельзя: выдуманный пример в тестах и спецификациях выглядит ровно
    так же, как настоящие числа, и различить их по образцу невозможно. Поэтому проверка
    только предупреждает, а блокирует точный список значений.
    """
    found = []
    for line in added_lines(diff):
        low = line.lower()
        has_word = any(word in low for word in MEASUREMENT_WORDS)
        if has_word and len(NUMBER.findall(line)) >= 3:
            found.append(f"похоже на отчёт с измерениями: {line.strip()[:90]}")
    return found


def check_commit(command: str = "") -> int:
    branch = git("rev-parse", "--abbrev-ref", "HEAD").strip()
    merging = git("rev-parse", "-q", "--verify", "MERGE_HEAD").strip()
    if branch == "main" and not merging:
        print(
            "Заблокировано: прямой коммит в main.\n"
            "Работа идёт в своей ветке, а main получает вливания через --no-ff.\n"
            "Создай ветку и повтори: git checkout -b <вид>/<имя>",
            file=sys.stderr,
        )
        return 2

    diff = staged_diff(command)
    values = find_values(diff)
    if values:
        print(
            "Заблокировано: в коммите персональные данные владельца.\n"
            + "\n".join(values)
            + "\nПравило записано в AGENTS.md, спецификация — openspec/specs/document-privacy.",
            file=sys.stderr,
        )
        return 2

    for line in find_report_like(diff):
        print(
            f"Внимание: {line}\n"
            "Если это настоящие измерения владельца, коммит останавливается и правка обезличивается.\n"
            "Если это выдуманный пример из тестов, спецификаций или набора задач — так и должно быть.",
            file=sys.stderr,
        )

    return 0


def push_targets_main(command: str) -> tuple:
    """Разбирает команду git push. Возвращает (идёт в main, в обход ветки).

    Обход — это когда в main кладут чужую ветку: `git push origin feat:main`.
    """
    try:
        tokens = shlex.split(command)
    except Exception:
        return (False, False)
    try:
        index = tokens.index("push")
    except ValueError:
        return (False, False)

    tail = [token for token in tokens[index + 1 :] if not token.startswith("-")]
    pairs = []
    # Первый аргумент без флага — имя удалённого репозитория, дальше идут ссылки.
    for token in tail[1:]:
        if ":" in token:
            local, remote = token.split(":", 1)
        else:
            local = remote = token
        pairs.append((local.strip(), remote.strip()))
    if not pairs:
        branch = git("rev-parse", "--abbrev-ref", "HEAD").strip()
        pairs = [(branch, branch)]

    goes_to_main = False
    bypass = False
    for local, remote in pairs:
        if remote in ("main", "refs/heads/main"):
            goes_to_main = True
            if local not in ("main", "refs/heads/main", "HEAD"):
                bypass = True
    return (goes_to_main, bypass)


def run_checks() -> list:
    """Прогоняет проверки репозитория. Возвращает список провалов."""
    failures = []
    for title, command in (
        ("тесты", ["node", "--test"]),
        ("спецификации", ["openspec", "validate", "--all", "--strict"]),
    ):
        try:
            done = subprocess.run(
                command, capture_output=True, text=True, timeout=300, check=False
            )
        except FileNotFoundError:
            print(
                f"Внимание: {command[0]} не найдена, проверка «{title}» пропущена.",
                file=sys.stderr,
            )
            continue
        except Exception as error:
            print(f"Внимание: проверка «{title}» не запустилась: {error}", file=sys.stderr)
            continue
        if done.returncode != 0:
            tail = (done.stdout or "")[-1200:] + (done.stderr or "")[-600:]
            failures.append(f"{title}:\n{tail.strip()}")
    return failures


def verify_before_main() -> int:
    """Перед отправкой в main проверки должны пройти здесь, а не только в CI."""
    failures = run_checks()
    if failures:
        print(
            "Заблокировано: проверки перед отправкой в main не прошли.\n"
            + "\n".join(failures)
            + "\nПочини и повтори.",
            file=sys.stderr,
        )
        return 2
    return 0


def check_push() -> int:
    """Разбирает строки хука pre-push: локальная ссылка, хеш, удалённая ссылка, хеш."""
    try:
        rows = sys.stdin.read().splitlines()
    except Exception:
        return 0

    goes_to_main = False
    for row in rows:
        parts = row.split()
        if len(parts) < 3:
            continue
        local_ref, remote_ref = parts[0], parts[2]
        if remote_ref != "refs/heads/main":
            continue
        goes_to_main = True
        if local_ref != "refs/heads/main":
            print(
                "Заблокировано: пуш кладёт в main чужую ветку.\n"
                f"Локальная ссылка: {local_ref}. Прямой путь в main закрыт: работа вливается\n"
                "веткой через --no-ff, а затем выкладывается пушем самой ветки main.",
                file=sys.stderr,
            )
            return 2

    if goes_to_main:
        return verify_before_main()
    return 0


def check_push_command(command: str) -> int:
    """Проверяет команду git push, вызванную агентом."""
    goes_to_main, bypass = push_targets_main(command)
    if bypass:
        print(
            "Заблокировано: команда кладёт в main чужую ветку.\n"
            f"Команда: {command.strip()[:120]}\n"
            "Работа вливается веткой через --no-ff, а затем выкладывается пушем ветки main.",
            file=sys.stderr,
        )
        return 2
    # Проверки перед отправкой в main прогоняет хук git: он срабатывает всегда, в том числе
    # когда команду даёт агент. Здесь остаются только ограничения.
    return 0


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "zcode"
    if mode == "pre-commit":
        return check_commit()
    if mode == "pre-push":
        return check_push()
    if mode == "zcode":
        command = read_command()
        if not command:
            # Запуск без описания вызова: считаем, что это коммит.
            return check_commit()
        if "git commit" in command:
            return check_commit(command)
        if "git push" in command:
            return check_push_command(command)
        return 0
    print(f"Неизвестный режим: {mode}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as error:  # хук не должен останавливать работу при своей поломке
        print(f"Хук пропущен из-за своей ошибки: {error}", file=sys.stderr)
        sys.exit(0)
