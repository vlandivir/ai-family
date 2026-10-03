import "server-only";
import { canViewConversation } from "./visibility";

type Conversation = {
  id: string; project_id: string | null; kind: "private" | "topic";
  telegram_chat_id: number; telegram_topic_id: number | null;
  opened_by: string | null; started_at: string; closed_at: string | null;
};
type Project = { id: string; name: string; slug: string };
export type ScanEvent = {
  id: number; project_id: string; listing_id: string | null; created_at: string;
  source_url: string; action: string; result: string;
  http_status: number | null; error: string | null;
  details: { agent?: "search" | "checker"; foundCount?: number; queuedCount?: number; price?: number; previous?: number; reason?: string } | null;
  projectName?: string;
};
export type Artifact = {
  kind: string; status: string; name?: string; mimeType?: string;
  size?: number | null; objectKey?: string; sourceIndex?: number;
  latitude?: number; longitude?: number; address?: string | null; title?: string | null;
  reason?: string;
};
type Job = {
  id: string; conversation_id: string; created_at: string; started_at: string | null;
  finished_at: string | null; status: string; attempts: number; model: string | null;
  error: string | null; external_user_id: string | null;
  payload: { message?: { text?: string; senderName?: string; files?: unknown[]; location?: Artifact }; text?: string } | null;
  result: { text?: string } | null;
  artifacts: Artifact[] | null;
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

export async function dashboardData(viewerEmail: string) {
  const [conversations, projects, scanEvents] = await Promise.all([
    allRows<Conversation>("conversations?select=id,project_id,kind,telegram_chat_id,telegram_topic_id,opened_by,started_at,closed_at&order=started_at.desc"),
    allRows<Project>("projects?select=id,name,slug"),
    rows<ScanEvent>("scan_events?select=id,project_id,listing_id,created_at,source_url,action,result,http_status,error,details&order=created_at.desc&limit=100"),
  ]);
  const visibleConversations = conversations.filter((conversation) => canViewConversation(
    conversation, viewerEmail,
    process.env.PRIVATE_CHAT_OWNER_EMAIL,
    process.env.PRIVATE_CHAT_OWNER_USER_ID,
  ));
  const visibleIds = new Set(visibleConversations.map((conversation) => conversation.id));
  const chunks: string[][] = [];
  for (let index = 0; index < visibleConversations.length; index += 50) {
    chunks.push(visibleConversations.slice(index, index + 50).map((conversation) => conversation.id));
  }
  const jobs = (await Promise.all(chunks.map((ids) => allRows<Job>(
    `agent_jobs?source=eq.telegram&conversation_id=in.(${ids.join(",")})&select=id,conversation_id,created_at,started_at,finished_at,status,attempts,model,error,external_user_id,payload,result,artifacts&order=created_at.desc`,
  )))).flat().sort((a, b) => b.created_at.localeCompare(a.created_at));
  const visibleJobs = jobs.filter((job) => visibleIds.has(job.conversation_id));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const jobsByConversation = new Map<string, Job[]>();
  for (const job of visibleJobs) {
    const list = jobsByConversation.get(job.conversation_id) || [];
    list.push(job);
    jobsByConversation.set(job.conversation_id, list);
  }
  const branches = visibleConversations.map((conversation) => {
    const branchJobs = jobsByConversation.get(conversation.id) || [];
    const active = branchJobs.find((job) => job.status === "running");
    const queued = branchJobs.filter((job) => job.status === "queued");
    const latest = branchJobs[0] || null;
    const stalled = active?.started_at && Date.now() - new Date(active.started_at).getTime() > 12 * 60_000;
    return {
      ...conversation,
      project: conversation.project_id ? projectById.get(conversation.project_id) || null : null,
      latest,
      active: active || null,
      queueLength: queued.length,
      state: active ? (stalled ? "stalled" : "running") : queued.length ? "queued" : latest?.status || "idle",
      jobs: branchJobs,
    };
  });
  branches.sort((a, b) => (b.latest?.created_at || b.started_at).localeCompare(a.latest?.created_at || a.started_at));
  return {
    branches,
    scanEvents: scanEvents.map((event) => ({ ...event, projectName: projectById.get(event.project_id)?.name || "Проект" })),
    totalJobs: visibleJobs.length,
    updatedAt: new Date().toISOString(),
  };
}
