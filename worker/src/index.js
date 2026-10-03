import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { retryableJobError, startTelegramJobs } from "./agent/jobs.js";
import { catalogNumberFromMessage, lookupCatalogNumber } from "./catalog-lookup.js";
import { dbInsert, dbPatch } from "./db.js";
import { startHeartbeat } from "./health.js";
import { ensureRepo, listingUrl, openConversation, runListing, runQueued } from "./queue.js";
import { startScan } from "./scan.js";
import { archiveAttachments, materializeObject, safeFileName } from "./storage.js";
import { isOwnerPrivateMessage, ownerMcpContextForJob } from "./owner-mcp.js";
import { poll, sendAnswer, sendMessage, setMessageReaction } from "./telegram/poll.js";
import { splitVoiceAnswer, storedVoicePaths, transcribeVoice, voiceInstruction } from "./voice.js";

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

function mediaNote(message) {
  const parts = [];
  if (message.filePaths?.length) {
    parts.push(`К сообщению приложены файлы. Прочитай их и учти в ответе:\n${message.filePaths.map((path) => `- ${path}`).join("\n")}`);
  }
  if (message.location) {
    const { latitude, longitude, title, address } = message.location;
    parts.push(`Геометка: ${latitude}, ${longitude}${title ? `; ${title}` : ""}${address ? `; ${address}` : ""}. Учти координаты в ответе.`);
  }
  if (message.unavailableFiles?.length) {
    parts.push(`Эти вложения Telegram не дал скачать из-за лимита 20 МБ: ${message.unavailableFiles.join(", ")}. Явно скажи об этом в ответе; не утверждай, что просмотрел их.`);
  }
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}

function promptFor(message, topic) {
  const body = message.inGroup ? `${message.senderName}: ${message.text}` : message.text;
  const prompt = topic.rule ? `${topic.rule}\n\n${body}` : body;
  const voice = message.voiceTranscript ? `\n\n${voiceInstruction(message.voiceTranscript)}` : "";
  return `${prompt}${voice}${mediaNote(message)}`;
}

async function saveFiles(artifacts, jobId, cwd) {
  const dir = join(cwd || process.env.AGENT_WORKSPACE || "/var/lib/ai-family/workspace", "inbox");
  const paths = [];
  for (const file of artifacts.filter((item) => item.status === "stored" && item.kind !== "location")) {
    const dest = join(dir, jobId, `${file.sourceIndex}-${safeFileName(file.name)}`);
    await materializeObject(file.objectKey, dest);
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
  const ownerMcp = ownerMcpContextForJob(job);
  const reply = (text) => sendMessage(message.chatId, text, message.threadId, message.messageId);
  const retryRule = job.attempts > 1
    ? "Предыдущий запуск этой задачи прервался. Продолжи в том же контексте: сначала проверь уже сделанные изменения и не повторяй завершённые действия."
    : "";
  const taskTopic = retryRule ? { ...topic, rule: [topic.rule, retryRule].filter(Boolean).join("\n\n") } : topic;
  try {
    await queuedReactions.get(job.id);
    try {
      await setMessageReaction(message.chatId, message.messageId, "⚡");
    } catch (error) {
      console.error("telegram working reaction", error.message);
    }
    let artifacts;
    try {
      artifacts = await archiveAttachments(message, job.id, job.artifacts);
      if (message.files?.length || message.location) {
        await dbPatch(`agent_jobs?id=eq.${job.id}`, { artifacts });
      }
    } catch (error) {
      throw new Error(`Не удалось сохранить вложение в Hetzner Storage: ${error.message}`);
    }
    const cwd = topic.repo ? await ensureRepo(topic.repo, key) : await workspaceFor(key);
    message.filePaths = await saveFiles(artifacts, job.id, cwd);
    message.unavailableFiles = artifacts.filter((item) => item.status === "unavailable").map((item) => item.name);
    const voiceFiles = storedVoicePaths(artifacts, message.filePaths);
    if (voiceFiles.length) {
      try {
        const parts = [];
        for (const filePath of voiceFiles) {
          const text = await transcribeVoice(filePath);
          if (text) parts.push(text);
        }
        message.voiceTranscript = parts.join("\n");
      } catch (error) {
        console.error("voice", error.message);
        await reply("Не удалось распознать голосовое. Подробность осталась в логе сервера.");
        const wrapped = new Error(error.message);
        wrapped.code = "REPLIED";
        throw wrapped;
      }
      if (!message.voiceTranscript) {
        await reply("Не удалось разобрать голосовое.");
        const wrapped = new Error("empty voice transcript");
        wrapped.code = "REPLIED";
        throw wrapped;
      }
      message.filePaths = message.filePaths.filter((path) => !voiceFiles.includes(path));
    }
    const answer = taskTopic.project && url && !message.voiceTranscript
      ? await runListing(message, key, taskTopic, url, job)
      : await runQueued(message, key, promptFor(message, taskTopic), cwd, taskTopic, job, { ownerMcp });
    if (message.voiceTranscript) {
      const spoken = splitVoiceAnswer(answer);
      const transcriptId = await sendMessage(
        message.chatId,
        spoken.transcript || message.voiceTranscript,
        message.threadId,
        message.messageId,
      );
      const replyText = spoken.transcript ? spoken.answer : answer;
      if (replyText) await sendAnswer(message.chatId, replyText, message.threadId, transcriptId || message.messageId);
    } else {
      await sendAnswer(message.chatId, answer, message.threadId, message.messageId);
    }
  } catch (error) {
    console.error("job failed", error.message);
    if (error.code !== "REPLIED" && !retryableJobError(job, error)) {
      await reply(error.code === "AGENT_TIMEOUT"
        ? "Не удалось завершить обработку за несколько попыток. Задача остановлена, чтобы не держать ветку занятой."
        : "Не вышло разобрать сообщение. Подробность осталась в логе сервера.");
    }
    throw error;
  }
}

const scan = startScan();
const jobs = startTelegramJobs({
  processJob: processTelegramJob,
  notifyInterrupted: (message) => sendMessage(
    message.chatId,
    "Обработка прерывалась несколько раз. Не удалось завершить задачу автоматически; пожалуйста, отправь её ещё раз.",
    message.threadId,
    message.messageId,
  ),
});
const shutdown = new AbortController();
let draining;
let stopHeartbeat;
function stop() {
  if (draining) return;
  console.log("worker draining active jobs");
  shutdown.abort();
  draining = Promise.all([jobs.stop(), scan.stop()]).finally(() => stopHeartbeat?.());
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

await jobs.ready;
if (!draining) stopHeartbeat = startHeartbeat();
await poll(async (message) => {
  const reply = (text) => sendMessage(message.chatId, text, message.threadId, message.messageId);
  if (message.text === "/start") {
    await reply("Можно писать задачу.");
    return;
  }
  const number = catalogNumberFromMessage(message.text);
  if (number) {
    try {
      await reply(await lookupCatalogNumber(number, topicConfig(message).project));
    } catch (error) {
      console.error("catalog lookup", error.message);
      await reply("Не удалось получить карточку. Попробуй ещё раз чуть позже.");
    }
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
      payload: { message, topic, sessionKey: key, url: listingUrl(message.text), ownerMcpEligible: isOwnerPrivateMessage(message) },
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
}, { signal: shutdown.signal });
if (draining) await draining;
