import assert from "node:assert/strict";
import { test } from "node:test";
import { heartbeatProblem, queueProblem } from "../src/health.js";

const now = Date.parse("2026-09-27T12:00:00Z");
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();

test("startup requires a current heartbeat from the new worker process", () => {
  assert.equal(heartbeatProblem({ pid: 42, at: ago(0) }, now, 42), null);
  assert.match(heartbeatProblem({ pid: 41, at: ago(0) }, now, 42), /запуск/);
  assert.match(heartbeatProblem({ pid: 42, at: ago(2) }, now, 42), /устарел/);
});

test("queue alert distinguishes idle backlog from an active agent", () => {
  const queued = { status: "queued", created_at: ago(11), not_before: ago(11) };
  assert.match(queueProblem([queued], now), /очереди/);
  assert.equal(queueProblem([queued, { status: "running", created_at: ago(11), started_at: ago(5) }], now), null);
  assert.match(queueProblem([{ status: "running", created_at: ago(45), started_at: ago(41) }], now), /40 минут/);
  assert.equal(queueProblem([{ ...queued, not_before: new Date(now + 60_000).toISOString() }], now), null);
});
