import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTelegramJobs } from "./agent/jobs.js";
import { agentBusy } from "./agent/run.js";
import { dbInsert } from "./db.js";
import { ensureRepo, listingUrl, openConversation, runListing, runQueued } from "./queue.js";
import { startScan } from "./scan.js";
import { downloadTelegramFile, poll, sendAnswer, sendMessage, setMessageReaction } from "./telegram/poll.js";

const topicsPath = join(dirname(fileURLToPath(import.meta.url)), "../config/topics.json");
const topics = JSON.parse(await readFile(topicsPath, "utf8"));
const queuedReactions = new Map();

if (!process.env.TELEGRAM_ALLOWED_USER_IDS?.trim()) {
  console.error("TELEGRAM_ALLOWED_USER_IDS is empty, private chats are closed");
}

function topicConfig(message) {
  if (!message.inGroup) return {};
  const value = topics.topics?.[String(message.threadId ?? 1)];
  if (!value) return { rule: topics.default || "" };
  if (typeof value === "string") return { rule: value };
  return value;
}

function sessionKey(message) {
  if (!message.inGroup) return `user:${message.userId}`;
  return `topic:${message.chatId}:${message.threadId ?? 1}`;
}

function jobIdFor(message) {
  const hex = createHash("sha256")
    .update(`telegram:${message.chatId}:${message.updateId}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function fileNote(paths) {
  if (!paths?.length) return "";
  return `\n\nК сообщению приложены файлы. Прочитай их и учти в ответе:\n${paths.map((path) => `- ${path}`).join("\n")}`;
}

function promptFor(message, topic) {
  const body = message.inGroup ? `${message.senderName}: ${message.text}` : message.text;
  const prompt = topic.rule ? `${topic.rule}\n\n${body}` : body;
  return `${prompt}${fileNote(message.filePaths)}`;
}

async function saveFiles(message, cwd) {
  const dir = join(cwd || process.env.AGENT_WORKSPACE || "/var/lib/ai-family/workspace", "inbox");
  const paths = [];
  for (const [index, file] of (message.files || []).entries()) {
    const dest = join(dir, `${Date.now()}-${index}-${file.name}`);
    await downloadTelegramFile(file.id, dest);
    paths.push(dest);
  }
  return paths;
}

async function workspaceFor(key) {
  const root = process.env.AGENT_WORKSPACE || "/var/lib/ai-family/workspace";
  const name = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const dir = join(root, "contexts", name);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function processTelegramJob(job) {
  const { message, topic, sessionKey: key, url } = job.payload;
  const reply = (text) => sendMessage(message.chatId, text, message.threadId, message.messageId);
  try {
    await queuedReactions.get(job.id);
    try {
      await setMessageReaction(message.chatId, message.messageId, "⚡");
    } catch (error) {
      console.error("telegram working reaction", error.message);
    }
    const cwd = topic.repo ? await ensureRepo(topic.repo, key) : await workspaceFor(key);
    try {
      message.filePaths = await saveFiles(message, cwd);
    } catch (error) {
      console.error("telegram file", error.message);
      await reply("Файл не скачался. Бот получает вложения до 20 МБ.");
      if (!message.text) throw error;
    }
    const answer = topic.project && url
      ? await runListing(message, key, topic, url, job)
      : await runQueued(message, key, promptFor(message, topic), cwd, topic, job);
    await sendAnswer(message.chatId, answer, message.threadId, message.messageId);
  } catch (error) {
    console.error("job failed", error.message);
    await reply("Не вышло разобрать сообщение. Подробность осталась в логе сервера.");
    throw error;
  }
}

startScan({ busy: agentBusy });
const jobs = startTelegramJobs({
  processJob: processTelegramJob,
  notifyInterrupted: (message) => sendMessage(
    message.chatId,
    "Обработка прервалась из-за перезапуска бота. Пожалуйста, отправь сообщение ещё раз.",
    message.threadId,
    message.messageId,
  ),
});
await jobs.ready;

await poll(async (message) => {
  const reply = (text) => sendMessage(message.chatId, text, message.threadId, message.messageId);
  if (message.text === "/start") {
    await reply("Можно писать задачу.");
    return;
  }
  const key = sessionKey(message);
  const topic = topicConfig(message);
  const conversation = await openConversation(message, key);
  const jobId = jobIdFor(message);
  if (queuedReactions.has(jobId)) return;
  let releaseReaction;
  queuedReactions.set(jobId, new Promise((resolve) => { releaseReaction = resolve; }));
  try {
    await dbInsert("agent_jobs", {
      id: jobId,
      conversation_id: conversation.id,
      source: "telegram",
      external_user_id: message.userId,
      kind: topic.project && listingUrl(message.text) ? "analyze_listing" : "chat",
      payload: { message, topic, sessionKey: key, url: listingUrl(message.text) },
      status: "queued",
    });
  } catch (error) {
    releaseReaction();
    queuedReactions.delete(jobId);
    if (/23505/.test(error.message)) return;
    throw error;
  }
  void setMessageReaction(message.chatId, message.messageId, "👀")
    .catch((error) => console.error("telegram queued reaction", error.message))
    .finally(() => {
      releaseReaction();
      queuedReactions.delete(jobId);
    });
  void jobs.wake();
});
