# AI Family · статусы задач

Отдельный Next.js сайт для всех личных диалогов и тем Telegram. Слева список веток, справа сообщения и сохранённые ответы агента по порядку, вместе с состоянием каждой задачи. Обновляется каждые 10 секунд.

Текст ответа сохраняется в `agent_jobs.result.text`. Наличие текста в базе не подтверждает доставку в Telegram: идентификаторы отправленных сообщений пока не записываются.

Корень проекта Vercel: `dashboard`. Для локальной разработки скопируйте нужные значения из игнорируемого корневого `.env` в игнорируемый `dashboard/.env.local` и добавьте публичный ключ Supabase:

```text
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ALLOWED_EMAILS=
```

`ALLOWED_EMAILS` — адреса через запятую. Пустой список закрывает доступ всем. Ключ `SUPABASE_SERVICE_ROLE_KEY` используется только на сервере. Google OAuth должен быть настроен в Supabase Auth с callback `https://<supabase-project>.supabase.co/auth/v1/callback`; в Supabase URL Configuration разрешите `https://<site>/auth/callback`.

```sh
npm ci
npm run build
npm run dev
```
