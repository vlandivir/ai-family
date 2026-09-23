---
name: dev-diary
description: >-
  Rewrites the one-file-per-day developer diary in dev-diary/ before every git
  commit. Use before committing, when the user asks to commit, or when the
  pre-commit hook rejects a commit because the diary stamp is missing.
---

# Дневник разработчика

Перед каждым `git commit` перепиши файл текущего дня. Хук `.githooks/pre-commit` проверяет это у любого агента.

## Куда писать

Один день — один файл: `dev-diary/YYYY-MM-DD.md`. Дата локальная, `date +%Y-%m-%d`.

Файл целиком заменяется, а не дополняется. В нём одно-три предложения: что изменилось за день и зачем. Без списка файлов, без секретов, без пересказа диффа.

```markdown
# 2026-09-23

Репозиторий стал публичным. Проекты вынесены в отдельные репозитории, очередь задач одна.

<!-- dev-diary-stamp: HASH -->
```

Последняя строка — штамп индекса, её пишет не человек.

## Перед коммитом

1. Добавь в индекс всё, что войдёт в коммит, кроме `dev-diary/`.
2. Возьми штамп: `.githooks/pre-commit --stamp`
3. Прочитай уже существующий `dev-diary/YYYY-MM-DD.md`, коммиты с полуночи (`git log --since="$(date +%Y-%m-%d) 00:00" --pretty=format:%s`) и краткий `git diff --cached --stat -- . ':(exclude)dev-diary'`.
4. Перепиши файл целиком так, чтобы он описывал весь день, включая этот коммит. В конец поставь `<!-- dev-diary-stamp: HASH -->` с штампом из шага 2.
5. `git add dev-diary/YYYY-MM-DD.md`, затем коммит.

Если за день коммит не первый, старый текст не сохраняй абзацами. Сожми день заново в те же одно-три предложения.

Коммит, где кроме дневника ничего нет, хук пропускает. Один коммит без дневника: `DEV_DIARY_SKIP=1 git commit ...`
