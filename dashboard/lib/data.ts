import "server-only";

type Conversation = {
  id: string; project_id: string | null; kind: "private" | "topic";
  telegram_chat_id: number; telegram_topic_id: number | null;
  opened_by: string | null; started_at: string; closed_at: string | null;
};
type Project = { id: string; name: string; slug: string };
type Job = {
  id: string; conversation_id: string; created_at: string; started_at: string | null;
  finished_at: string | null; status: string; attempts: number; model: string | null;
  error: string | null; external_user_id: string | null;
  payload: { message?: { text?: string; senderName?: string; files?: unknown[] }; text?: string } | null;
  result: { text?: string } | null;
};

async function rows<T>(path: string): Promise<T[]> {
  const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}`);
  return response.json();
}

async function allRows<T>(path: string): Promise<T[]> {
  const result: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await rows<T>(`${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${offset}`);
    result.push(...page);
    if (page.length < 1000) return result;
  }
}

export async function dashboardData() {
  const [conversations, projects, jobs] = await Promise.all([
    allRows<Conversation>("conversations?select=id,project_id,kind,telegram_chat_id,telegram_topic_id,opened_by,started_at,closed_at&order=started_at.desc"),
    allRows<Project>("projects?select=id,name,slug"),
    allRows<Job>("agent_jobs?source=eq.telegram&select=id,conversation_id,created_at,started_at,finished_at,status,attempts,model,error,external_user_id,payload,result&order=created_at.desc"),
  ]);
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const jobsByConversation = new Map<string, Job[]>();
  for (const job of jobs) {
    const list = jobsByConversation.get(job.conversation_id) || [];
    list.push(job);
    jobsByConversation.set(job.conversation_id, list);
  }
  const branches = conversations.map((conversation) => {
    const branchJobs = jobsByConversation.get(conversation.id) || [];
    const active = branchJobs.find((job) => job.status === "running");
    const queued = branchJobs.filter((job) => job.status === "queued");
    const latest = branchJobs[0] || null;
    return {
      ...conversation,
      project: conversation.project_id ? projectById.get(conversation.project_id) || null : null,
      latest,
      active: active || null,
      queueLength: queued.length,
      state: active ? "running" : queued.length ? "queued" : latest?.status || "idle",
      jobs: branchJobs,
    };
  });
  branches.sort((a, b) => (b.latest?.created_at || b.started_at).localeCompare(a.latest?.created_at || a.started_at));
  return { branches, totalJobs: jobs.length, updatedAt: new Date().toISOString() };
}
