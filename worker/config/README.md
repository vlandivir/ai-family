# Настройки агента на хосте

Секреты здесь не лежат. Их держат в `/etc/ai-family.env` на машине воркера: ключ Cursor, GitHub, Telegram, Supabase и бакет фото Hetzner.

Повторить на новом хосте:

1. Запустить `scripts/setup-worker.sh` от root. Он ставит Node.js 22 и Cursor CLI.
2. Положить `/etc/ai-family.env` и запустить `scripts/install-agent-config.sh` от root. Скрипт копирует `mcp.json` в `/root/.cursor/mcp.json` и вливает `cli-permissions.json` в `/root/.cursor/cli-config.json`.
3. Склонировать этот репозиторий в `/opt/ai-family` и включить `worker/ai-family-worker.service`.
4. Пуш в `main` деплоит сам: GitHub Actions заходит по отдельному SSH-ключу и запускает `scripts/deploy.sh`. Ключ на сервере ограничен этой командой. Приватная половина лежит в секретах репозитория `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS`.

`cli-permissions.json` разрешает веб-поиск, чтение страниц, `git`, файлы рабочей папки и MCP GitHub. Чтение `.env` и `rm` запрещены.

Сессии диалогов — каталог `/var/lib/ai-family/chats/` на хосте. Личный чат — файл `user:<id>`, тема группы — `topic:<chat>:<тема>`. В файле id чата Cursor, `startedAt` и `updatedAt`. Это состояние машины, в git его нет. Репозитории проектов воркер держит в `/var/lib/ai-family/repos/` и обновляет перед заданием. Вложения из Telegram попадают в `inbox/` этой копии. Витрину выкладывает не этот репозиторий, а пуш в `main` репозитория проекта.
