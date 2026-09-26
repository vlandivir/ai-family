# AI Family · статусы задач

Отдельный Next.js сайт для всех личных диалогов и тем Telegram. Слева список веток, справа сообщения и сохранённые ответы агента по порядку, вместе с состоянием каждой задачи. Обновляется каждые 10 секунд.

Во время обработки показывается прошедшее время. Если задача остаётся в работе более 12 минут, сайт помечает её как задержанную вместо обычного состояния «в работе».

Текст ответа сохраняется в `agent_jobs.result.text`. Наличие текста в базе не подтверждает доставку в Telegram: идентификаторы отправленных сообщений пока не записываются.

Вложения входящих сообщений хранятся в закрытом Hetzner Object Storage; ключи объектов записаны в `agent_jobs.artifacts`. Сайт выдаёт авторизованному посетителю краткоживущую ссылку для просмотра фото, видео и файлов. Геометки показываются ссылкой на карту.

Корень проекта Vercel: `dashboard`. Для локальной разработки скопируйте нужные значения из игнорируемого корневого `.env` в игнорируемый `dashboard/.env.local` и добавьте публичный ключ Supabase:

```text
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ALLOWED_EMAILS=
HETZNER_S3_ENDPOINT=
HETZNER_S3_BUCKET=
HETZNER_S3_ACCESS_KEY=
HETZNER_S3_SECRET_KEY=
```

Пуш изменений `dashboard/` запускает сборку с тестовыми значениями окружения в GitHub Actions. Production-версия сайта статусов пока выкладывается вручную из этого репозитория; Vercel Git Integration для проекта ещё не подключена.

`ALLOWED_EMAILS` — адреса через запятую. Пустой список закрывает доступ всем. Ключ `SUPABASE_SERVICE_ROLE_KEY` используется только на сервере. Google OAuth должен быть настроен в Supabase Auth с callback `https://<supabase-project>.supabase.co/auth/v1/callback`; в Supabase URL Configuration разрешите `https://<site>/auth/callback`.

```sh
npm ci
npm run build
npm run dev
```
