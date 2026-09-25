import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const path = process.env.TELEGRAM_SESSIONS_PATH || "/var/lib/ai-family/telegram-chats.json";

async function load() {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function save(sessions) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(sessions, null, 2) + "\n");
}

export async function getChatId(userId) {
  const sessions = await load();
  return sessions[userId] || null;
}

export async function setChatId(userId, chatId) {
  const sessions = await load();
  sessions[userId] = chatId;
  await save(sessions);
}

export async function clearChatId(userId) {
  const sessions = await load();
  delete sessions[userId];
  await save(sessions);
}
