import { spawn } from "node:child_process";
import { clearChatId, getChatId, setChatId } from "./sessions.js";

const agentBin = process.env.AGENT_BIN || "/root/.local/bin/agent";
const workspace = process.env.AGENT_WORKSPACE || "/var/lib/ai-family/workspace";

let busy = false;

export function agentBusy() {
  return busy;
}

function run(args, cwd = workspace) {
  return new Promise((resolve, reject) => {
    const child = spawn(agentBin, args, { cwd, env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const error = new Error(err.trim() || `agent exited ${code}`);
        error.stdout = out;
        reject(error);
        return;
      }
      resolve(out.trim());
    });
  });
}

function parseAgentOutput(raw) {
  let model = null;
  let text = "";
  for (const line of String(raw || "").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "system" && event.subtype === "init" && event.model) {
      model = event.model;
    }
    if (event.type === "assistant") {
      const parts = event.message?.content || [];
      const piece = parts.filter((part) => part.type === "text").map((part) => part.text).join("");
      if (piece) text = piece;
    }
  }
  return { text: text.trim(), model };
}

async function createChat(userId, cwd) {
  const id = (await run(["create-chat"], cwd)).split("\n").filter(Boolean).at(-1);
  if (!id) throw new Error("agent create-chat returned no id");
  await setChatId(userId, id);
  return id;
}

export async function runAgent(userId, prompt, cursorChatId, cwd = workspace) {
  if (busy) {
    return Promise.reject(new Error("busy"));
  }
  busy = true;
  try {
    let chatId = cursorChatId || (await getChatId(userId));
    if (!chatId) chatId = await createChat(userId, cwd);
    const ask = async (id) => {
      try {
        return parseAgentOutput(await run(
          ["-p", "--trust", "--approve-mcps", "--output-format", "stream-json", "--resume", id, prompt],
          cwd,
        ));
      } catch (error) {
        const parsed = parseAgentOutput(error.stdout);
        error.model = parsed.model;
        throw error;
      }
    };
    try {
      return { ...(await ask(chatId)), chatId };
    } catch (error) {
      if (error.message === "busy") throw error;
      await clearChatId(userId);
      chatId = await createChat(userId, cwd);
      try {
        return { ...(await ask(chatId)), chatId };
      } catch (retryError) {
        retryError.model = retryError.model || error.model;
        throw retryError;
      }
    }
  } finally {
    busy = false;
  }
}
