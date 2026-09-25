const api = "https://api.telegram.org";

function allowedIds() {
  return new Set(
    (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function token() {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) {
    throw new Error("TELEGRAM_BOT_TOKEN is empty");
  }
  return value;
}

async function call(method, body) {
  const response = await fetch(`${api}/bot${token()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(payload.description || method);
  }
  return payload.result;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function toTelegramHtml(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

export function sendMessage(chatId, text) {
  const chunks = [];
  let rest = text || "пусто";
  while (rest.length > 0) {
    chunks.push(rest.slice(0, 4000));
    rest = rest.slice(4000);
  }
  return chunks.reduce(async (chain, chunk) => {
    await chain;
    try {
      await call("sendMessage", {
        chat_id: chatId,
        text: toTelegramHtml(chunk),
        parse_mode: "HTML",
      });
    } catch {
      await call("sendMessage", { chat_id: chatId, text: chunk });
    }
  }, Promise.resolve());
}

export async function poll(onText) {
  let offset = 0;
  const allow = allowedIds();
  for (;;) {
    let updates = [];
    try {
      updates = await call("getUpdates", { offset, timeout: 50 });
    } catch (error) {
      console.error("telegram poll", error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      const message = update.message;
      if (!message || message.chat?.type !== "private" || !message.text) {
        continue;
      }
      const userId = String(message.from.id);
      if (!allow.has(userId)) {
        console.error(`denied telegram user id=${userId}`);
        continue;
      }
      try {
        await onText(message.chat.id, userId, message.text);
      } catch (error) {
        console.error("handler", error.message);
      }
    }
  }
}
