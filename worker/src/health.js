import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const heartbeatPath = process.env.WORKER_HEARTBEAT_PATH || "/var/lib/ai-family/worker-heartbeat.json";

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

export function heartbeatProblem(heartbeat, now = Date.now(), expectedPid) {
  if (!heartbeat || !Number.isInteger(heartbeat.pid) || !heartbeat.at) {
    return "нет сигнала от worker";
  }
  if (expectedPid && heartbeat.pid !== expectedPid) {
    return "worker ещё не подтвердил запуск";
  }
  const age = now - Date.parse(heartbeat.at);
  if (!Number.isFinite(age) || age < -30_000 || age > 90_000) {
    return "сигнал worker устарел";
  }
  return null;
}

export function queueProblem(jobs, now = Date.now()) {
  const running = jobs.filter((job) => job.status === "running");
  const queued = jobs.filter((job) => job.status === "queued" &&
    Date.parse(job.not_before || job.created_at) <= now);
  const oldestRunning = running.reduce((age, job) =>
    Math.max(age, now - Date.parse(job.started_at || job.created_at)), 0);
  if (oldestRunning > 40 * 60_000) return "задача выполняется более 40 минут";
  const oldestQueued = queued.reduce((age, job) =>
    Math.max(age, now - Date.parse(job.created_at)), 0);
  if (!running.length && oldestQueued > 10 * 60_000) {
    return "задача ждёт в очереди более 10 минут без работающего агента";
  }
  return null;
}

export function startHeartbeat({ path = heartbeatPath, intervalMs = 10_000 } = {}) {
  const write = () => writeJson(path, { pid: process.pid, at: new Date().toISOString() })
    .catch((error) => console.error("worker heartbeat", error.message));
  void write();
  const timer = setInterval(write, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
