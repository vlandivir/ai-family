import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentBusy } from "./agent/run.js";
import { ensureRepo, listingUrl, runListing, runQueued } from "./queue.js";
import { downloadTelegramFile, poll, sendAnswer, sendMessage } from "./telegram/poll.js";

const topicsPath = join(dirname(fileURLToPath(import.meta.url)), "../config/topics.json");
const topics = JSON.parse(await readFile(topicsPath, "utf8"));

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

await poll(async (message) => {
  const reply = (text) => sendMessage(message.chatId, text, message.threadId);
  if (message.text === "/start") {
    await reply("Можно писать задачу.");
    return;
  }
  if (agentBusy()) {
    await reply("Уже занят, подожди.");
    return;
  }
  await reply("Беру в работу.");
  try {
    const topic = topicConfig(message);
    const cwd = topic.repo ? await ensureRepo(topic.repo) : undefined;
    try {
      message.filePaths = await saveFiles(message, cwd);
    } catch (error) {
      console.error("telegram file", error.message);
      await reply("Файл не скачался. Бот получает вложения до 20 МБ.");
      if (!message.text) return;
    }
    const url = listingUrl(message.text);
    const answer = topic.project && url
      ? await runListing(message, sessionKey(message), topic, url)
      : await runQueued(message, sessionKey(message), promptFor(message, topic), cwd);
    await sendAnswer(message.chatId, answer, message.threadId);
  } catch (error) {
    console.error("job failed", error.message);
    await reply("Не вышло разобрать сообщение. Подробность осталась в логе сервера.");
  }
});
