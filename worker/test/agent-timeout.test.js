import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { run } from "../src/agent/run.js";
import { startTelegramJobs } from "../src/agent/jobs.js";

test("agent process is stopped when its deadline expires", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let stopped = false;
  child.kill = () => {
    stopped = true;
    setImmediate(() => child.emit("close", null));
  };
  await assert.rejects(
    run(["-p"], "/tmp", { timeoutMs: 10, spawnChild: () => child }),
    (error) => error.code === "AGENT_TIMEOUT",
  );
  assert.equal(stopped, true);
});

test("timed-out job retries before the next message in the same context", async () => {
  const rows = [
    { id: "first", status: "queued", attempts: 0, created_at: "1", payload: { sessionKey: "topic:1:2" } },
    { id: "second", status: "queued", attempts: 0, created_at: "2", payload: { sessionKey: "topic:1:2" } },
  ];
  const calls = [];
  let done;
  const completed = new Promise((resolve) => { done = resolve; });
  const get = async (path) => path.includes("status=eq.running")
    ? [] : rows.filter((row) => row.status === "queued").map((row) => ({ ...row }));
  const patch = async (path, values) => {
    const id = path.match(/id=eq.([^&]+)/)?.[1];
    const status = path.match(/status=eq.([^&]+)/)?.[1];
    const row = rows.find((item) => item.id === id && item.status === status);
    if (!row) return [];
    Object.assign(row, values);
    return [{ ...row }];
  };
  const jobs = startTelegramJobs({ get, patch, pollIntervalMs: 0,
    notifyInterrupted: async () => {},
    processJob: async (job) => {
      calls.push(`${job.id}:${job.attempts}`);
      if (job.id === "first" && job.attempts === 1) {
        const error = new Error("timed out");
        error.code = "AGENT_TIMEOUT";
        throw error;
      }
      await patch(`agent_jobs?id=eq.${job.id}&status=eq.running`, { status: "succeeded" });
      if (job.id === "second") done();
    },
  });
  await jobs.ready;
  await completed;
  assert.deepEqual(calls, ["first:1", "first:2", "second:1"]);
  assert.deepEqual(rows.map((row) => row.status), ["succeeded", "succeeded"]);
});
