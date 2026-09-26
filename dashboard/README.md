# AI Family · статусы задач

Отдельный Next.js сайт для всех личных диалогов и тем Telegram. Показывает текущую задачу, очередь, состояние последней задачи и историю. Обновляется каждые 10 секунд.

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
