import { spawn } from "node:child_process";
import { clearChatId, getChatId, setChatId } from "./sessions.js";

const agentBin = process.env.AGENT_BIN || "/root/.local/bin/agent";
const workspace = process.env.AGENT_WORKSPACE || "/var/lib/ai-family/workspace";

let busy = false;

export function agentBusy() {
  return busy;
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(agentBin, args, { cwd: workspace, env: process.env });
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
        reject(new Error(err.trim() || `agent exited ${code}`));
        return;
      }
      resolve(out.trim());
    });
  });
}

async function createChat(userId) {
  const id = (await run(["create-chat"])).split("\n").filter(Boolean).at(-1);
  if (!id) throw new Error("agent create-chat returned no id");
  await setChatId(userId, id);
  return id;
}

export async function runAgent(userId, prompt) {
  if (busy) {
    return Promise.reject(new Error("busy"));
  }
  busy = true;
  try {
    let chatId = await getChatId(userId);
    if (!chatId) chatId = await createChat(userId);
    try {
      return await run(["-p", "--trust", "--approve-mcps", "--resume", chatId, prompt]);
    } catch {
      await clearChatId(userId);
      chatId = await createChat(userId);
      return await run(["-p", "--trust", "--approve-mcps", "--resume", chatId, prompt]);
    }
  } finally {
    busy = false;
  }
}
