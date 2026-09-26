import { spawn } from "node:child_process";
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearChatId, getChatId, setChatId } from "./sessions.js";

const askpass = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/git-askpass.sh");

const agentBin = process.env.AGENT_BIN || "/root/.local/bin/agent";
const workspace = process.env.AGENT_WORKSPACE || "/var/lib/ai-family/workspace";
export const agentTimeoutMs = Number(process.env.AGENT_TIMEOUT_MS || 10 * 60 * 1000);
if (!Number.isFinite(agentTimeoutMs) || agentTimeoutMs < 1000) {
  throw new Error("AGENT_TIMEOUT_MS must be at least 1000 milliseconds");
}

const active = new Set();

export function agentBusy(key) {
  return key == null ? active.size > 0 : active.has(key);
}

export function run(args, cwd = workspace, { spawnChild = spawn, timeoutMs = agentTimeoutMs } = {}) {
  const env = {
    ...process.env,
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Family bot",
    GIT_AUTHOR_EMAIL: "vladimir.rybakov@gmail.com",
    GIT_COMMITTER_NAME: "Family bot",
    GIT_COMMITTER_EMAIL: "vladimir.rybakov@gmail.com",
  };
  return new Promise((resolve, reject) => {
    const child = spawnChild(agentBin, args, { cwd, env, detached: true });
    let out = "";
    let err = "";
    let timedOut = false;
    let forceKill;
    const stop = (signal) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error.code !== "ESRCH") console.error("agent stop", error.message);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
      forceKill = setTimeout(() => stop("SIGKILL"), 5000);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      out = (out + chunk).slice(-5_000_000);
    });
    child.stderr.on("data", (chunk) => {
      err = (err + chunk).slice(-100_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      if (timedOut) {
        const error = new Error(`Агент не завершил работу за ${Math.ceil(timeoutMs / 60_000)} мин`);
        error.code = "AGENT_TIMEOUT";
        error.stdout = out;
        reject(error);
        return;
      }
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
  if (active.has(userId)) {
    return Promise.reject(new Error("busy"));
  }
  active.add(userId);
  await chmod(askpass, 0o700).catch(() => {});
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
      if (!/(?:chat|conversation|session).*(?:not found|invalid|does not exist)/i.test(error.message)) {
        throw error;
      }
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
    active.delete(userId);
  }
}
