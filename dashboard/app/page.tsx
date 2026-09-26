import { allowedUser } from "@/lib/access";
import { dashboardData } from "@/lib/data";
import { ChatScroll } from "./chat-scroll";
import { Refresh } from "./refresh";

export const dynamic = "force-dynamic";

function time(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Belgrade", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

const labels: Record<string, string> = {
  queued: "В очереди", running: "В работе", succeeded: "Готово",
  failed: "Ошибка", cancelled: "Отменено", idle: "Нет задач",
};

function content(text: string) {
  return text.split(/(https?:\/\/[^\s<>]+)/g).map((part, index) =>
    /^https?:\/\//.test(part)
      ? <a href={part} target="_blank" rel="noopener noreferrer" key={index}>{part}</a>
      : part,
  );
}

export default async function Home({ searchParams }: { searchParams: Promise<{ chat?: string }> }) {
  const user = await allowedUser();
  if (!user) return <main className="gate"><div className="gate-card"><div className="brand-mark">◈</div><p className="eyebrow">AI FAMILY / МОНИТОРИНГ</p><h1>Работа семьи<br />в одном месте.</h1><p className="gate-desc">Войдите через разрешённый Google аккаунт, чтобы видеть состояние всех задач и диалогов.</p><a className="google-button" href="/auth/login"><span className="google-g">G</span> Войти через Google <span aria-hidden>↗</span></a><p className="gate-note">Доступ есть только у адресов из настроек.</p></div></main>;

  const { branches, totalJobs, updatedAt } = await dashboardData();
  const { chat } = await searchParams;
  const selected = branches.find((branch) => branch.id === chat) || branches[0];
  const running = branches.filter((branch) => branch.state === "running").length;
  const queued = branches.reduce((count, branch) => count + branch.queueLength, 0);
  const failed = branches.filter((branch) => branch.state === "failed").length;
  const branchTitle = (branch: typeof branches[number]) => branch.kind === "private"
    ? `Личный диалог · ${branch.opened_by || branch.telegram_chat_id}`
    : branch.project?.name || `Тема ${branch.telegram_topic_id}`;

  return <main className="shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">◈</span><div><strong>AI Family</strong><small>Диалоги и задачи</small></div></div><div className="top-actions"><span className="user-email">{user.email}</span><form action="/auth/logout" method="post"><button className="logout">Выйти</button></form></div></header>
    <section className="dialogue-intro"><div><p className="eyebrow">TELEGRAM / АГЕНТЫ</p><h1>Диалоги</h1><p>Сообщения семьи, ответы бота и ход обработки в каждой ветке.</p></div><div className="intro-actions"><small>Обновлено {time(updatedAt)}</small><Refresh /></div></section>
    <section className="dialogue-stats" aria-label="Сводка"><span><b>{branches.length}</b> ветки</span><span><b>{running}</b> в работе</span><span><b>{queued}</b> в очереди</span><span><b>{failed}</b> с ошибкой</span><span><b>{totalJobs}</b> задач всего</span></section>
    <div className="dialogue-layout">
      <aside className="dialogue-list" aria-label="Диалоги"><div className="dialogue-list-head"><strong>Все ветки</strong><span>{branches.length}</span></div>
        {branches.map((branch) => {
          const preview = branch.latest?.payload?.message?.text || branch.latest?.payload?.text || "Сообщение без текста";
          return <a className={`dialogue-item ${selected?.id === branch.id ? "selected" : ""}`} href={`/?chat=${encodeURIComponent(branch.id)}`} key={branch.id} aria-current={selected?.id === branch.id ? "page" : undefined}>
            <span className="dialogue-avatar">{branch.kind === "private" ? "↗" : "⌘"}</span><span className="dialogue-item-body"><span className="dialogue-item-line"><strong>{branchTitle(branch)}</strong><time>{time(branch.latest?.created_at)}</time></span><span className="dialogue-preview">{preview}</span><span className="dialogue-item-foot"><span className={`small-status ${branch.state}`}>{labels[branch.state] || branch.state}</span>{branch.queueLength > 0 && <span>Очередь: {branch.queueLength}</span>}</span></span>
          </a>;
        })}
      </aside>
      <section className="conversation" aria-label="Переписка">
        {selected ? <><div className="conversation-head"><span className="dialogue-avatar large">{selected.kind === "private" ? "↗" : "⌘"}</span><div><h2>{branchTitle(selected)}</h2><p>{selected.kind === "private" ? "Личный диалог" : `Семейный чат · тема ${selected.telegram_topic_id}`}</p></div><span className={`badge ${selected.state}`}>{labels[selected.state] || selected.state}</span></div>
          <ChatScroll conversationId={selected.id} lastActivity={`${selected.latest?.id || ""}:${selected.latest?.status || ""}:${selected.latest?.finished_at || ""}`}>
            <div className="chat-timeline">{[...selected.jobs].reverse().map((job) => {
              const incoming = job.payload?.message?.text || job.payload?.text || (job.payload?.message?.files?.length ? "Вложение" : "Сообщение без текста");
              const sender = job.payload?.message?.senderName || (selected.kind === "private" ? "Вы" : "Участник");
              return <div className="exchange" key={job.id}>
                <div className="message incoming"><div className="message-meta"><strong>{sender}</strong><time>{time(job.created_at)}</time></div><div className="message-text">{content(incoming)}</div></div>
                {job.result?.text && <div className="message outgoing"><div className="message-meta"><strong>Бот</strong><time>{time(job.finished_at)}</time></div><div className="message-text">{content(job.result.text)}</div></div>}
                {job.status !== "succeeded" && <div className={`processing-note ${job.status}`}><span className={`status-dot ${job.status}`} />{job.status === "failed" ? `Ошибка: ${job.error || "обработка не завершилась"}` : job.status === "running" ? "Бот обрабатывает сообщение" : labels[job.status] || job.status}{job.attempts > 1 && ` · попытка ${job.attempts}`}</div>}
              </div>;
            })}</div>
          </ChatScroll>
          <div className="conversation-foot">Диалог доступен только для просмотра · Ответы берутся из сохранённых результатов задач</div>
        </> : <div className="conversation-empty">Диалоги появятся после первого сообщения боту.</div>}
      </section>
    </div>
    <footer>AI FAMILY <span>·</span> ВРЕМЯ — БЕЛГРАД</footer>
  </main>;
}
