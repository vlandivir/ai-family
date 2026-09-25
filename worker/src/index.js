import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentBusy, runAgent } from "./agent/run.js";
import { poll, sendMessage } from "./telegram/poll.js";

const topicsPath = join(dirname(fileURLToPath(import.meta.url)), "../config/topics.json");
const topics = JSON.parse(await readFile(topicsPath, "utf8"));

if (!process.env.TELEGRAM_ALLOWED_USER_IDS?.trim()) {
  console.error("TELEGRAM_ALLOWED_USER_IDS is empty, private chats are closed");
}

function sessionKey(message) {
  if (!message.inGroup) return `user:${message.userId}`;
  return `topic:${message.chatId}:${message.threadId ?? 1}`;
}

function promptFor(message) {
  const rule = message.inGroup
    ? topics.topics?.[String(message.threadId ?? 1)] || topics.default || ""
    : "";
  const body = message.inGroup ? `${message.senderName}: ${message.text}` : message.text;
  return rule ? `${rule}\n\n${body}` : body;
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
    const answer = await runAgent(sessionKey(message), promptFor(message));
    await reply(answer);
  } catch (error) {
    await reply(`Не вышло: ${error.message}`);
  }
});
