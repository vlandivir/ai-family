import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dbGet, dbInsert, dbPatch } from "./db.js";
import { getChatId } from "./agent/sessions.js";
import { runAgent } from "./agent/run.js";

const git = promisify(execFile);
const repoRoot = process.env.PROJECT_REPOS_DIR || "/var/lib/ai-family/repos";

export function listingUrl(text) {
  return text.match(/https?:\/\/[^\s)]+/)?.[0] || null;
}

async function ensureRepo(repo) {
  const dir = `${repoRoot}/${repo.split("/")[1]}`;
  const header = `AUTHORIZATION: Bearer ${process.env.GITHUB_PAT}`;
  const args = ["-c", `http.extraheader=${header}`];
  try {
    await git("git", [...args, "-C", dir, "pull", "--ff-only"]);
  } catch {
    await git("git", [...args, "clone", `https://github.com/${repo}.git`, dir]);
  }
  return dir;
}

function cardFromAnswer(answer) {
  const match = answer.match(/<<<JSON>>>([\s\S]*?)<<<END>>>/);
  if (!match) return { prose: answer, card: null };
  let card = null;
  try {
    card = JSON.parse(match[1]);
  } catch {
    card = null;
  }
  return { prose: answer.replace(match[0], "").trim(), card };
}

async function openConversation(message, sessionKey) {
  if (message.inGroup) {
    const topicId = message.threadId ?? 1;
    const found = await dbGet(
      `conversations?kind=eq.topic&telegram_chat_id=eq.${message.chatId}&telegram_topic_id=eq.${topicId}&select=*&limit=1`,
    );
    if (found[0]) return found[0];
    const created = await dbInsert("conversations", {
      kind: "topic",
      telegram_chat_id: message.chatId,
      telegram_topic_id: topicId,
      opened_by: message.userId,
      cursor_chat_id: await getChatId(sessionKey),
    });
    return created[0];
  }

  const found = await dbGet(
    `conversations?kind=eq.private&opened_by=eq.${message.userId}&closed_at=is.null&select=*&limit=1`,
  );
  if (found[0]) return found[0];
  const created = await dbInsert("conversations", {
    kind: "private",
    telegram_chat_id: message.chatId,
    opened_by: message.userId,
    cursor_chat_id: await getChatId(sessionKey),
  });
  return created[0];
}

export async function runQueued(message, sessionKey, prompt) {
  const conversation = await openConversation(message, sessionKey);
  const inserted = await dbInsert("agent_jobs", {
    conversation_id: conversation.id,
    source: "telegram",
    external_user_id: message.userId,
    kind: "chat",
    payload: { text: message.text },
    status: "running",
    started_at: new Date().toISOString(),
    attempts: 1,
  });
  const job = inserted[0];
  try {
    const { text, chatId } = await runAgent(sessionKey, prompt, conversation.cursor_chat_id);
    if (chatId && chatId !== conversation.cursor_chat_id) {
      await dbPatch(`conversations?id=eq.${conversation.id}`, { cursor_chat_id: chatId });
    }
    await dbPatch(`agent_jobs?id=eq.${job.id}`, {
      status: "succeeded",
      finished_at: new Date().toISOString(),
      result: { text },
    });
    return text;
  } catch (error) {
    await dbPatch(`agent_jobs?id=eq.${job.id}`, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error: error.message,
    });
    throw error;
  }
}

export async function runListing(message, sessionKey, topic, url) {
  const conversation = await openConversation(message, sessionKey);
  const project = (await dbGet(`projects?slug=eq.${topic.project}&select=id&limit=1`))[0];
  const dir = await ensureRepo(topic.repo);
  const prompt = [
    topic.rule,
    `Ссылка: ${url}`,
    "Прочитай APARTMENT_SELECTION_INSTRUCTIONS.md в текущей папке и открой ссылку.",
    "Ответь коротко, насколько квартира подходит.",
    "В конце добавь блок ровно в таком виде:",
    "<<<JSON>>>",
    '{"address":"","neighborhood":"","asking_price_eur":null,"area_m2":null,"rooms":null,"floor":null,"year_built":null,"heating":"","fit":"","notes":""}',
    "<<<END>>>",
  ].join("\n");
  const inserted = await dbInsert("agent_jobs", {
    conversation_id: conversation.id,
    project_id: project?.id,
    source: "telegram",
    external_user_id: message.userId,
    kind: "analyze_listing",
    payload: { text: message.text, url },
    status: "running",
    started_at: new Date().toISOString(),
    attempts: 1,
  });
  const job = inserted[0];
  try {
    const { text, chatId } = await runAgent(sessionKey, prompt, conversation.cursor_chat_id, dir);
    if (chatId && chatId !== conversation.cursor_chat_id) {
      await dbPatch(`conversations?id=eq.${conversation.id}`, { cursor_chat_id: chatId });
    }
    const { prose, card } = cardFromAnswer(text);
    const row = {
      project_id: project.id,
      status: card ? "new" : "error",
      city: "Belgrade",
      neighborhood: card?.neighborhood || null,
      address: card?.address || null,
      source_url: url,
      asking_price_eur: numberOrNull(card?.asking_price_eur),
      area_m2: numberOrNull(card?.area_m2),
      rooms: numberOrNull(card?.rooms),
      floor: numberOrNull(card?.floor),
      year_built: numberOrNull(card?.year_built),
      heating: card?.heating || null,
      fit: card?.fit || "не разобрано",
      notes: card ? card.notes || prose : prose || "Агент не вернул карточку",
    };
    await dbInsert("listings", row);
    await dbPatch(`agent_jobs?id=eq.${job.id}`, {
      status: card ? "succeeded" : "failed",
      finished_at: new Date().toISOString(),
      result: { text: prose },
      error: card ? null : "no card json",
    });
    return prose || "Карточка записана, но текст оценки пустой.";
  } catch (error) {
    await dbInsert("listings", {
      project_id: project.id,
      status: "error",
      city: "Belgrade",
      source_url: url,
      fit: "не разобрано",
      notes: error.message,
    });
    await dbPatch(`agent_jobs?id=eq.${job.id}`, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error: error.message,
    });
    throw error;
  }
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
