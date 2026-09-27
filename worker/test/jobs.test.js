import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverInterruptedJobs, startTelegramJobs } from "../src/agent/jobs.js";

test("interrupted job returns to queue with its context and attempt count", async () => {
  const original = { id: "one", attempts: 1, payload: { sessionKey: "topic:42:8", message: { text: "Задача" } } };
  const changes = [];
  await recoverInterruptedJobs({
    get: async () => [original],
    patch: async (path, value) => changes.push({ path, value }),
    notifyInterrupted: async () => assert.fail("should not notify on first interruption"),
  });
  assert.equal(changes[0].path, "agent_jobs?id=eq.one&status=eq.running");
  assert.deepEqual(changes[0].value, { status: "queued", started_at: null, finished_at: null, error: null });
  assert.equal(original.payload.sessionKey, "topic:42:8");
  assert.equal(original.attempts, 1);
});

test("job interrupted three times fails and notifies", async () => {
  let notified = false;
  let status;
  await recoverInterruptedJobs({
    get: async () => [{ id: "three", attempts: 3, payload: { sessionKey: "user:1", message: { chatId: 1 } } }],
    patch: async (_path, value) => { status = value.status; },
    notifyInterrupted: async () => { notified = true; },
  });
  assert.equal(status, "failed");
  assert.equal(notified, true);
});

test("shutdown waits for claimed job and does not claim the next queued job", async () => {
  let finish;
  let started;
  const working = new Promise((resolve) => { finish = resolve; });
  const claimed = new Promise((resolve) => { started = resolve; });
  const rows = [
    { id: "one", attempts: 0, payload: { sessionKey: "one" } },
    { id: "two", attempts: 0, payload: { sessionKey: "one" } },
  ];
  const claims = [];
  const jobs = startTelegramJobs({
    pollIntervalMs: 0,
    get: async (path) => path.includes("status=eq.running") ? [] : rows,
    patch: async (path, value) => {
      if (value.status === "running") {
        claims.push(path);
        return [{ ...rows.find((row) => path.includes(`id=eq.${row.id}`)), attempts: 1 }];
      }
      return [{}];
    },
    processJob: async () => { started(); await working; },
    notifyInterrupted: async () => {},
  });
  await jobs.ready;
  await claimed;
  let stopped = false;
  const stopping = jobs.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  finish();
  await stopping;
  assert.equal(claims.length, 1);
});
