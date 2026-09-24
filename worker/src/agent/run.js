import { spawn } from "node:child_process";

const agentBin = process.env.AGENT_BIN || "/root/.local/bin/agent";
const workspace = process.env.AGENT_WORKSPACE || "/var/lib/ai-family/workspace";

let busy = false;

export function agentBusy() {
  return busy;
}

export function runAgent(prompt) {
  if (busy) {
    return Promise.reject(new Error("busy"));
  }
  busy = true;
  return new Promise((resolve, reject) => {
    const child = spawn(agentBin, ["-p", "--trust", "--approve-mcps", prompt], {
      cwd: workspace,
      env: process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", (error) => {
      busy = false;
      reject(error);
    });
    child.on("close", (code) => {
      busy = false;
      if (code !== 0) {
        reject(new Error(err.trim() || `agent exited ${code}`));
        return;
      }
      resolve(out.trim());
    });
  });
}
