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

Файл целиком заменяется, а не дополняется. Пиши, что уже сделано, не планы и не устройство системы. Каждый пункт — с глагола прошедшего времени. Без секретов и без пересказа диффа по файлам.

```markdown
# 2026-09-23

- сделал репозиторий публичным
- записал набросок архитектуры
- добавил дневник дня перед коммитом

<!-- dev-diary-stamp: HASH -->
```

Последняя строка — штамп подготовленных файлов, её пишет не человек.

## Перед коммитом

1. `git add` всего, что войдёт в коммит, кроме `dev-diary/`. Это ещё не коммит: git только запоминает набор файлов.
2. Возьми штамп этого набора: `.githooks/pre-commit --stamp`
3. Прочитай уже существующий `dev-diary/YYYY-MM-DD.md`, коммиты с полуночи (`git log --since="$(date +%Y-%m-%d) 00:00" --pretty=format:%s`) и краткий `git diff --cached --stat -- . ':(exclude)dev-diary'`.
4. Перепиши файл целиком: список сделанного за день, включая этот коммит. Каждый пункт с глагола. В конец поставь `<!-- dev-diary-stamp: HASH -->` с штампом из шага 2.
5. `git add dev-diary/YYYY-MM-DD.md`, затем один коммит вместе с остальными файлами.

Если за день коммит не первый, не дописывай пункты к старому списку. Собери день заново.

Коммит, где кроме дневника ничего нет, хук пропускает. Один коммит без дневника: `DEV_DIARY_SKIP=1 git commit ...`
