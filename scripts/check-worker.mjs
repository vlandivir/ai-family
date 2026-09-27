#!/usr/bin/env node
import { heartbeatPath, heartbeatProblem, queueProblem, readJson, writeJson } from "../worker/src/health.js";

const mode = process.argv[2] || "monitor";
const heartbeat = await readJson(heartbeatPath);
if (mode === "startup") {
  const pid = Number(process.argv[3]);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Expected worker PID");
  const problem = heartbeatProblem(heartbeat, Date.now(), pid);
  if (problem) throw new Error(problem);
  console.log(`Worker heartbeat is current (PID ${pid})`);
  process.exit(0);
}
if (mode !== "monitor") throw new Error("Usage: check-worker.mjs [startup PID|monitor]");

const statePath = process.env.WORKER_ALERT_STATE_PATH || "/var/lib/ai-family/worker-alert-state.json";
let problem = heartbeatProblem(heartbeat);
if (!problem) {
  try {
    process.kill(heartbeat.pid, 0);
  } catch {
    problem = "процесс worker не найден";
  }
}
if (!problem) {
  try {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/agent_jobs?source=eq.telegram&status=in.(queued,running)&select=id,status,created_at,started_at,not_before&order=created_at.asc&limit=1000`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`Supabase HTTP ${response.status}`);
    problem = queueProblem(await response.json());
  } catch (error) {
    problem = `не удалось проверить очередь: ${error.message}`;
  }
}

const previous = await readJson(statePath) || { problem: null, sentAt: null };
const now = Date.now();
const alertDue = problem && (problem !== previous.problem || now - Date.parse(previous.sentAt || 0) > 60 * 60_000);
const recoveryDue = !problem && previous.problem;
if (alertDue || recoveryDue) {
  const explicit = process.env.TELEGRAM_ALERT_CHAT_ID;
  const allowed = (process.env.TELEGRAM_ALLOWED_USER_IDS || "").split(",").map((id) => id.trim()).filter(Boolean);
  const chatId = explicit || (allowed.length === 1 ? allowed[0] : null);
  if (!chatId) throw new Error("Set TELEGRAM_ALERT_CHAT_ID for worker health notifications");
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is empty");
  const message = problem
    ? `⚠️ ai-family: ${problem}. Проверь worker и очередь задач.`
    : "✅ ai-family: worker и очередь снова работают.";
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || !(await response.json()).ok) throw new Error("Telegram health notification failed");
  await writeJson(statePath, { problem, sentAt: new Date().toISOString() });
  console.log(problem ? `Health alert sent: ${problem}` : "Health recovery sent");
} else {
  console.log(problem ? `Health issue already reported: ${problem}` : "Worker and queue healthy");
}
