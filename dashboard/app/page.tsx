import { allowedUser } from "@/lib/access";
import { dashboardData } from "@/lib/data";
import { Refresh } from "./refresh";

export const dynamic = "force-dynamic";

function time(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Belgrade", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

const labels: Record<string, string> = {
  queued: "В очереди", running: "В работе", succeeded: "Готово", failed: "Ошибка", cancelled: "Отменено", idle: "Нет задач",
};

export default async function Home() {
  const user = await allowedUser();
  if (!user) return <main className="gate"><div className="gate-card"><div className="brand-mark">◈</div><p className="eyebrow">AI FAMILY / МОНИТОРИНГ</p><h1>Работа семьи<br />в одном месте.</h1><p className="gate-desc">Войдите через разрешённый Google аккаунт, чтобы видеть состояние всех задач и диалогов.</p><a className="google-button" href="/auth/login"><span className="google-g">G</span> Войти через Google <span aria-hidden>↗</span></a><p className="gate-note">Доступ есть только у адресов из настроек.</p></div></main>;

  const { branches, totalJobs, updatedAt } = await dashboardData();
  const running = branches.filter((branch) => branch.state === "running").length;
  const queued = branches.reduce((count, branch) => count + branch.queueLength, 0);
  const failed = branches.filter((branch) => branch.state === "failed").length;
  return <main className="shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">◈</span><div><strong>AI Family</strong><small>Центр задач</small></div></div><div className="top-actions"><span className="user-email">{user.email}</span><form action="/auth/logout" method="post"><button className="logout">Выйти</button></form></div></header>
    <section className="hero"><div><p className="eyebrow">ОБЗОР / СЕГОДНЯ</p><h1>Все ветки<br /><em>под рукой.</em></h1><p>Состояние личных диалогов и тем семейного чата. Данные обновляются каждые 10 секунд.</p></div><div className="hero-aside"><span className="hero-orbit">◎</span><span>TELEGRAM → AGENTS → RESULT</span></div></section>
    <section className="stats" aria-label="Сводка"><div><span>Веток</span><strong>{branches.length}</strong></div><div><span>В работе</span><strong className="blue">{running}</strong></div><div><span>В очереди</span><strong className="orange">{queued}</strong></div><div><span>С ошибкой</span><strong className="red">{failed}</strong></div><div><span>Всего задач</span><strong>{totalJobs}</strong></div></section>
    <section className="section-head"><div><p className="eyebrow">ПОТОК ЗАДАЧ</p><h2>Ветки <span>{branches.length}</span></h2></div><div className="section-actions"><small>Обновлено {time(updatedAt)}</small><Refresh /></div></section>
    <div className="branch-grid">{branches.map((branch) => {
      const title = branch.kind === "private" ? `Личный диалог · ${branch.opened_by || branch.telegram_chat_id}` : branch.project?.name || `Тема ${branch.telegram_topic_id}`;
      const detail = branch.kind === "private" ? "Личный диалог" : `Семейный чат / тема ${branch.telegram_topic_id}`;
      const current = branch.active || branch.latest;
      const text = current?.payload?.message?.text || current?.payload?.text || "Сообщение без текста";
      return <article className="branch" key={branch.id}>
        <div className="branch-top"><div className="branch-icon">{branch.kind === "private" ? "↗" : "⌘"}</div><span className={`badge ${branch.state}`}>{labels[branch.state] || branch.state}</span></div>
        <p className="branch-kind">{detail}</p><h3>{title}</h3>
        <div className="current"><span>{branch.active ? "Сейчас обрабатывается" : "Последнее сообщение"}</span><p>{text}</p></div>
        {current?.error && <p className="error-text">{current.error}</p>}
        <div className="branch-meta"><span>Ожидает: <b>{branch.queueLength}</b></span><span>Последняя: {time(branch.latest?.created_at)}</span></div>
        <details><summary>История задач <span>↗</span></summary><div className="job-list">{branch.jobs.map((job) => <div className="job" key={job.id}><span className={`status-dot ${job.status}`} /><div><strong>{labels[job.status] || job.status}</strong><p>{job.payload?.message?.text || job.payload?.text || "Сообщение без текста"}</p>{job.error && <small>{job.error}</small>}</div><time>{time(job.created_at)}</time></div>)}</div></details>
      </article>;
    })}</div>
    {!branches.length && <div className="empty">Веток пока нет. Они появятся после первого сообщения боту.</div>}
    <footer>AI FAMILY <span>·</span> ВРЕМЯ — БЕЛГРАД</footer>
  </main>;
}
