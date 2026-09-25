import { dbGet, dbInsert, dbPatch } from "./db.js";
import { getChatId } from "./agent/sessions.js";
import { runAgent } from "./agent/run.js";

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
