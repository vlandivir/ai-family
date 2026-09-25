# Настройки агента на хосте

Секреты здесь не лежат. Их держат в `/etc/ai-family.env` на машине воркера: `CURSOR_API_KEY`, `GITHUB_PAT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, ключи Supabase.

Повторить на новом хосте:

1. Запустить `scripts/setup-worker.sh` от root. Он ставит Node.js 22 и Cursor CLI.
2. Положить `/etc/ai-family.env` и запустить `scripts/install-agent-config.sh` от root. Скрипт копирует `mcp.json` в `/root/.cursor/mcp.json` и вливает `cli-permissions.json` в `/root/.cursor/cli-config.json`.
3. Скопировать каталог `worker/` в `/opt/ai-family/worker` и включить `worker/ai-family-worker.service`.

`cli-permissions.json` разрешает веб-поиск, чтение страниц, `git`, файлы рабочей папки и MCP GitHub. Чтение `.env` и `rm` запрещены.

Сессии диалогов — каталог `/var/lib/ai-family/chats/` на хосте, один файл на Telegram id. В файле id чата Cursor, `startedAt` и `updatedAt`. Это состояние машины, в git его нет. Самые старые — с самой ранней `startedAt`. Старый общий `telegram-chats.json` при первом запуске раскладывается по этим файлам.
