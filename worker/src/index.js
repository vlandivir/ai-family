import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentBusy } from "./agent/run.js";
import { listingUrl, runListing, runQueued } from "./queue.js";
import { poll, sendAnswer, sendMessage } from "./telegram/poll.js";

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

function promptFor(message, topic) {
  const body = message.inGroup ? `${message.senderName}: ${message.text}` : message.text;
  return topic.rule ? `${topic.rule}\n\n${body}` : body;
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
    const url = listingUrl(message.text);
    const answer = topic.project && url
      ? await runListing(message, sessionKey(message), topic, url)
      : await runQueued(message, sessionKey(message), promptFor(message, topic));
    await sendAnswer(message.chatId, answer, message.threadId);
  } catch (error) {
    console.error("job failed", error.message);
    await reply("Не вышло разобрать сообщение. Подробность осталась в логе сервера.");
  }
});
