import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const dir = process.env.TELEGRAM_SESSIONS_DIR || "/var/lib/ai-family/chats";
const legacyPath = process.env.TELEGRAM_SESSIONS_PATH || "/var/lib/ai-family/telegram-chats.json";

function fileFor(userId) {
  return join(dir, `${userId}.json`);
}

async function migrateLegacy() {
  let legacy;
  try {
    legacy = JSON.parse(await readFile(legacyPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const when = new Date().toISOString();
  await mkdir(dir, { recursive: true });
  for (const [userId, chatId] of Object.entries(legacy)) {
    if (!chatId) continue;
    await writeFile(
      fileFor(userId),
      JSON.stringify({ chatId, startedAt: when, updatedAt: when }, null, 2) + "\n",
    );
  }
  await rename(legacyPath, `${legacyPath}.migrated`);
}

let migrated = false;

async function ensureMigrated() {
  if (migrated) return;
  await migrateLegacy();
  migrated = true;
}

export async function getChatId(userId) {
  await ensureMigrated();
  try {
    const session = JSON.parse(await readFile(fileFor(userId), "utf8"));
    return session.chatId || null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function setChatId(userId, chatId) {
  await ensureMigrated();
  await mkdir(dir, { recursive: true });
  const path = fileFor(userId);
  let startedAt = new Date().toISOString();
  try {
    const existing = JSON.parse(await readFile(path, "utf8"));
    if (existing.startedAt) startedAt = existing.startedAt;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(
    path,
    JSON.stringify({ chatId, startedAt, updatedAt: new Date().toISOString() }, null, 2) + "\n",
  );
}

export async function clearChatId(userId) {
  await ensureMigrated();
  await unlink(fileFor(userId)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function listSessions() {
  await ensureMigrated();
  let names = [];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const sessions = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    const session = JSON.parse(await readFile(path, "utf8"));
    const info = await stat(path);
    sessions.push({
      userId: name.slice(0, -".json".length),
      chatId: session.chatId,
      startedAt: session.startedAt || info.birthtime.toISOString(),
      updatedAt: session.updatedAt || info.mtime.toISOString(),
    });
  }
  sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return sessions;
}
