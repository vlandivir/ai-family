import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The Telegram poller accepts both private chats and family groups.
// A matching sender in a group is never enough to expose the owner's MCP.
export function isOwnerPrivateMessage(message, ownerId = process.env.VLANDIVIR_MCP_OWNER_USER_ID) {
  const expected = String(ownerId || "").trim();
  return /^\d+$/.test(expected)
    && message?.chatType === "private"
    && message.inGroup === false
    && String(message.userId) === expected
    && String(message.chatId) === expected;
}

// Jobs may wait in Supabase or be retried after a worker restart. Require
// both the decision made when Telegram delivered the message and a fresh
// identity check immediately before starting the agent.
export function ownerMcpContextForJob(job, ownerId = process.env.VLANDIVIR_MCP_OWNER_USER_ID) {
  const message = job?.payload?.message;
  if (job?.payload?.ownerMcpEligible !== true || !isOwnerPrivateMessage(message, ownerId)) {
    return null;
  }
  return { chatId: String(message.chatId) };
}

const mcpUrl = "https://vlandivir.com/mcp";
const envReference = (name) => "$" + "{env:" + name + "}";

export const ownerThreadsReplyRule = [
  "Для задач с текстом Threads работай только в этом личном чате. Прочитай текст из сообщения или нужный черновик через threads_list/threads_get.",
  "Если владелец просит исправить орфографию, сохрани смысл, тон, абзацы, ссылки, имена и смешение русского, сербского и английского. Не переводи языки и не заменяй сербскую латиницу кириллицей или наоборот без просьбы. Исправляй орфографию и пунктуацию; не переписывай стиль без просьбы.",
  "Если владелец просит проверить факты, используй веб-поиск и открывай источники. Сверяй даты и утверждения с надёжными, по возможности первичными источниками. Не выдавай догадки за проверенные факты; спорные и непроверенные утверждения пометь отдельно.",
  "Готовый для копирования текст поста положи в блок:",
  "<<<THREADS_COPY>>>",
  "текст поста",
  "<<<END>>>",
  "Блок в обычный ответ не копируй повторно: бот отправит его отдельным сообщением. После блока — правки, список изменений, фактчек и ссылки (для фактчекинга кратко перечисли существенные исправления и источники). Если нужен только текст — после блока ничего не пиши. Не меняй и не создавай черновик Threads, не публикуй пост: владелец сделает это сам. Если он просит записать или опубликовать, всё равно пришли текст для ручного действия.",
].join("\n");

export function splitThreadsAnswer(text) {
  const match = String(text || "").match(/<<<THREADS_COPY>>>([\s\S]*?)<<<END>>>/);
  if (!match) return { copy: null, notes: String(text || "").trim() };
  return {
    copy: match[1].replace(/^\n/, "").replace(/\n$/, "").trimEnd(),
    notes: String(text).replace(match[0], "").replace(/\n{3,}/g, "\n\n").trim(),
  };
}

export function configuredOwnerMcpContextForJob(job, env = process.env) {
  const context = ownerMcpContextForJob(job, env.VLANDIVIR_MCP_OWNER_USER_ID);
  if (!context || !env.VLANDIVIR_MCP_API_KEY || !env.VLANDIVIR_GTD_MCP_TOKEN) {
    return null;
  }
  return context;
}

export async function prepareOwnerMcpWorkspace(cwd, context) {
  if (!context) return;
  const dir = join(cwd, ".cursor");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "mcp.json");
  const config = {
    mcpServers: {
      vlandivir: {
        url: mcpUrl,
        headers: {
          Authorization: "Bearer " + envReference("VLANDIVIR_MCP_API_KEY"),
          "X-Chat-Id": envReference("VLANDIVIR_MCP_CHAT_ID"),
        },
      },
      "vlandivir-gtd": {
        url: mcpUrl,
        headers: {
          Authorization: "Bearer " + envReference("VLANDIVIR_GTD_MCP_TOKEN"),
        },
      },
    },
  };
  await writeFile(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(file, 0o600);
}
