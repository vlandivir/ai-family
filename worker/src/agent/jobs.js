import { dbGet, dbPatch } from "../db.js";
import { createScheduler } from "./scheduler.js";

const maxConcurrent = Number(process.env.MAX_CONCURRENT_AGENTS || 3);
const maxAttempts = 3;

export async function recoverInterruptedJobs({ get = dbGet, patch = dbPatch, notifyInterrupted }) {
  const jobs = await get("agent_jobs?source=eq.telegram&status=eq.running&select=id,payload,attempts&limit=1000");
  for (const job of jobs) {
    if ((job.attempts || 0) < maxAttempts && job.payload?.sessionKey) {
      await patch(`agent_jobs?id=eq.${job.id}&status=eq.running`, {
        status: "queued",
        started_at: null,
        finished_at: null,
        error: null,
      });
    } else {
      await patch(`agent_jobs?id=eq.${job.id}&status=eq.running`, {
        status: "failed",
        finished_at: new Date().toISOString(),
        error: job.payload?.sessionKey
          ? "Обработка прерывалась после нескольких запусков воркера"
          : "Не найден контекст задачи для восстановления",
      });
      const message = job.payload?.message;
      if (message) {
        try {
          await notifyInterrupted(message);
        } catch (error) {
          console.error("telegram interrupted notice", error.message);
        }
      }
    }
  }
}

export function startTelegramJobs({ processJob, notifyInterrupted }) {
  const scheduler = createScheduler(maxConcurrent);
  const scheduled = new Set();
  let checking = false;

  async function check() {
    if (checking) return;
    checking = true;
    try {
      const jobs = await dbGet("agent_jobs?source=eq.telegram&status=eq.queued&select=*&order=created_at.asc,id.asc&limit=100");
      for (const job of jobs) {
        if (scheduled.has(job.id)) continue;
        const key = job.payload?.sessionKey;
        if (!key) continue;
        scheduled.add(job.id);
        scheduler.enqueue(key, async () => {
          try {
            const claimed = await dbPatch(`agent_jobs?id=eq.${job.id}&status=eq.queued`, {
              status: "running",
              started_at: new Date().toISOString(),
              attempts: (job.attempts || 0) + 1,
            });
            if (claimed.length) await processJob(claimed[0]);
          } catch (error) {
            console.error("telegram job", job.id, error.message);
            await dbPatch(`agent_jobs?id=eq.${job.id}&status=eq.running`, {
              status: "failed",
              finished_at: new Date().toISOString(),
              error: String(error.message || error).slice(0, 500),
            }).catch((patchError) => console.error("telegram job status", patchError.message));
          } finally {
            scheduled.delete(job.id);
            setImmediate(() => void check());
          }
        });
      }
    } catch (error) {
      console.error("telegram queue", error.message);
    } finally {
      checking = false;
    }
  }

  const ready = recoverInterruptedJobs({ notifyInterrupted }).then(check);
  const timer = setInterval(() => void check(), 1000);
  timer.unref?.();
  return { ready, wake: check };
}
