import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function formatInline(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparator(line) {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line.trim());
}

function isTableRow(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.slice(1).includes("|");
}

const renderScript = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/render-table.py");

function parseTable(rows) {
  const headers = splitRow(rows[0]);
  const body = rows.slice(1).filter((line) => !isSeparator(line)).map(splitRow);
  return { headers, rows: body };
}

function renderTable(table) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [renderScript]);
    const chunks = [];
    let err = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(err.trim() || "table render failed"));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(JSON.stringify(table));
  });
}

function tableToHtml(rows) {
  const headers = splitRow(rows[0]);
  const body = rows.slice(1).filter((line) => !isSeparator(line));
  return body
    .map((line) => {
      const cells = splitRow(line);
      const title = formatInline(cells[0] || "");
      const rest = headers.slice(1).map((header, index) => {
        const value = cells[index + 1] || "";
        if (!value || value === "—") return "";
        return `${formatInline(header)}: ${formatInline(value)}`;
      }).filter(Boolean);
      return [`<b>${title}</b>`, ...rest].join("\n");
    })
    .join("\n\n");
}

export function toTelegramHtml(text) {
  const lines = text.split("\n");
  const chunks = [];
  let index = 0;
  while (index < lines.length) {
    if (!isTableRow(lines[index])) {
      const start = index;
      while (index < lines.length && !isTableRow(lines[index])) index += 1;
      chunks.push(formatInline(lines.slice(start, index).join("\n")).replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>"));
      continue;
    }
    const start = index;
    while (index < lines.length && (isTableRow(lines[index]) || isSeparator(lines[index]))) index += 1;
    chunks.push(tableToHtml(lines.slice(start, index)));
  }
  return chunks.join("\n");
}

async function sendPhoto(chatId, png, threadId) {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (threadId != null) form.set("message_thread_id", String(threadId));
  form.set("photo", new Blob([png], { type: "image/png" }), "table.png");
  const response = await fetch(`${api}/bot${token()}/sendPhoto`, { method: "POST", body: form });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.description || "sendPhoto");
}

export async function sendAnswer(chatId, text, threadId) {
  const lines = (text || "").split("\n");
  let index = 0;
  let sent = false;
  while (index < lines.length) {
    if (!isTableRow(lines[index])) {
      const start = index;
      while (index < lines.length && !isTableRow(lines[index])) index += 1;
      const chunk = lines.slice(start, index).join("\n").trim();
      if (chunk) {
        await sendMessage(chatId, chunk, threadId);
        sent = true;
      }
      continue;
    }
    const start = index;
    while (index < lines.length && (isTableRow(lines[index]) || isSeparator(lines[index]))) index += 1;
    try {
      await sendPhoto(chatId, await renderTable(parseTable(lines.slice(start, index))), threadId);
    } catch (error) {
      console.error("table image", error.message);
      await sendMessage(chatId, lines.slice(start, index).join("\n"), threadId);
    }
    sent = true;
  }
  if (!sent) await sendMessage(chatId, text, threadId);
}

export function sendMessage(chatId, text, threadId) {
  const chunks = [];
  let rest = text || "пусто";
  while (rest.length > 0) {
    chunks.push(rest.slice(0, 4000));
    rest = rest.slice(4000);
  }
  const thread = threadId == null ? {} : { message_thread_id: threadId };
  return chunks.reduce(async (chain, chunk) => {
    await chain;
    try {
      await call("sendMessage", {
        chat_id: chatId,
        text: toTelegramHtml(chunk),
        parse_mode: "HTML",
        ...thread,
      });
    } catch {
      await call("sendMessage", { chat_id: chatId, text: chunk, ...thread });
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
      if (!message?.text || message.from?.is_bot) continue;
      const chatType = message.chat?.type;
      const userId = String(message.from.id);
      const inGroup = chatType === "group" || chatType === "supergroup";
      if (!inGroup && chatType !== "private") continue;
      if (!inGroup && !allow.has(userId)) {
        console.error(`denied telegram user id=${userId}`);
        continue;
      }
      const name = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
      try {
        await onText({
          chatId: message.chat.id,
          userId,
          text: message.text,
          threadId: message.message_thread_id ?? null,
          inGroup,
          senderName: name || message.from.username || userId,
        });
      } catch (error) {
        console.error("handler", error.message);
      }
    }
  }
}
