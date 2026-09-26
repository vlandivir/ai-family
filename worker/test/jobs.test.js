import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverInterruptedJobs } from "../src/agent/jobs.js";

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
