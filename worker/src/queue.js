import { execFile } from "node:child_process";
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { dbGet, dbInsert, dbPatch } from "./db.js";
import { getChatId } from "./agent/sessions.js";
import { runAgent } from "./agent/run.js";

const git = promisify(execFile);
const repoRoot = process.env.PROJECT_REPOS_DIR || "/var/lib/ai-family/repos";

export function listingUrl(text) {
  return text.match(/https?:\/\/[^\s)]+/)?.[0] || null;
}

function safeError(error) {
  return String(error.message || error)
    .replace(/github_pat_\S+/g, "[скрыто]")
    .replace(/Bearer\s+\S+/g, "Bearer [скрыто]")
    .slice(0, 500);
}

export async function ensureRepo(repo) {
  const dir = `${repoRoot}/${repo.split("/")[1]}`;
  const askpass = join(dirname(fileURLToPath(import.meta.url)), "../scripts/git-askpass.sh");
  await chmod(askpass, 0o700);
  const env = {
    ...process.env,
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: "0",
  };
  const runGit = (args) => git("git", args, { env });
  try {
    await runGit(["-C", dir, "pull", "--ff-only"]);
  } catch {
    await runGit(["clone", `https://github.com/${repo}.git`, dir]);
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

export async function runQueued(message, sessionKey, prompt, cwd) {
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
    const { text, chatId, model } = await runAgent(sessionKey, prompt, conversation.cursor_chat_id, cwd);
    if (chatId && chatId !== conversation.cursor_chat_id) {
      await dbPatch(`conversations?id=eq.${conversation.id}`, { cursor_chat_id: chatId });
    }
    await dbPatch(`agent_jobs?id=eq.${job.id}`, {
      status: "succeeded",
      finished_at: new Date().toISOString(),
      model,
      result: { text },
    });
    return text;
  } catch (error) {
    await dbPatch(`agent_jobs?id=eq.${job.id}`, {
      status: "failed",
      finished_at: new Date().toISOString(),
      model: error.model || null,
      error: safeError(error),
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
    "Сначала реши, это страница одного объявления о квартире или доме.",
    "Витрина, каталог, поиск, статья и наша собственная страница — не объявление.",
    "Если это не объявление, ответь по смыслу и закончи блоком {\"is_listing\":false}. Карточку не заполняй.",
    "Если это объявление, ответь коротко, насколько квартира подходит.",
    "Один и тот же объект объединяй, даже если ссылка отличается параметрами.",
    "Сверяй адрес, дом, площадь и площадку, не полную строку URL.",
    "Уже известные карточки:",
    await knownListings(project.id),
    "Если это уже известный объект, поставь его id в match_id. Иначе match_id оставь null.",
    "В конце добавь блок ровно в таком виде:",
    "<<<JSON>>>",
    '{"is_listing":true,"match_id":null,"address":"","neighborhood":"","asking_price_eur":null,"area_m2":null,"rooms":null,"floor":null,"year_built":null,"heating":"","fit":"","notes":""}',
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
    const { text, chatId, model } = await runAgent(sessionKey, prompt, conversation.cursor_chat_id, dir);
    if (chatId && chatId !== conversation.cursor_chat_id) {
      await dbPatch(`conversations?id=eq.${conversation.id}`, { cursor_chat_id: chatId });
    }
    const { prose, card } = cardFromAnswer(text);
    if (card?.is_listing === false) {
      await dbPatch(`agent_jobs?id=eq.${job.id}`, {
        status: "succeeded",
        finished_at: new Date().toISOString(),
        model,
        result: { text: prose },
      });
      return prose || "Это не страница объявления.";
    }
    const known = await dbGet(`listings?project_id=eq.${project.id}&select=id,source_url,source_urls`);
    const match = known.find((item) => item.id === card?.match_id);
    const row = listingRow(project.id, url, card, prose);
    if (match) {
      row.source_urls = mergeUrls(match, url);
      delete row.project_id;
      delete row.status;
      await dbPatch(`listings?id=eq.${match.id}`, row);
    } else {
      row.source_urls = [url];
      await dbInsert("listings", row);
    }
    await dbPatch(`agent_jobs?id=eq.${job.id}`, {
      status: card ? "succeeded" : "failed",
      finished_at: new Date().toISOString(),
      model,
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
      notes: safeError(error),
    });
    await dbPatch(`agent_jobs?id=eq.${job.id}`, {
      status: "failed",
      finished_at: new Date().toISOString(),
      model: error.model || null,
      error: safeError(error),
    });
    throw error;
  }
}

async function knownListings(projectId) {
  const rows = await dbGet(
    `listings?project_id=eq.${projectId}&status=neq.error&select=id,address,neighborhood,area_m2,source_url,source_urls&order=created_at.desc&limit=40`,
  );
  if (!rows.length) return "нет";
  return rows
    .map((row) => {
      const urls = Array.isArray(row.source_urls) && row.source_urls.length
        ? row.source_urls
        : [row.source_url];
      return [row.id, row.address || "", row.neighborhood || "", row.area_m2 ?? "", urls.filter(Boolean).join(" ")].join(" | ");
    })
    .join("\n");
}

function mergeUrls(match, url) {
  const urls = new Set(
    [...(Array.isArray(match.source_urls) ? match.source_urls : []), match.source_url, url].filter(Boolean),
  );
  return [...urls];
}

function listingRow(projectId, url, card, prose) {
  return {
    project_id: projectId,
    status: "new",
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
    notes: card?.notes || prose || null,
    fit: card?.fit || null,
  };
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
