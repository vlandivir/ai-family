import assert from "node:assert/strict";
import { test } from "node:test";
import { createScheduler } from "../src/agent/scheduler.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("runs different contexts in parallel and preserves order within a context", async () => {
  const scheduler = createScheduler(2);
  const first = deferred();
  const second = deferred();
  const started = [];
  const finished = deferred();

  assert.equal(scheduler.enqueue("private:1", async () => {
    started.push("first");
    await first.promise;
  }), false);
  assert.equal(scheduler.enqueue("private:1", async () => {
    started.push("second");
    await second.promise;
  }), true);
  assert.equal(scheduler.enqueue("topic:2:3", async () => {
    started.push("other");
    finished.resolve();
  }), true);

  await finished.promise;
  assert.deepEqual(started, ["first", "other"]);
  first.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first", "other", "second"]);
  second.resolve();
});

test("pause waits for active work and leaves pending work for database recovery", async () => {
  const scheduler = createScheduler(1);
  const active = deferred();
  const started = deferred();
  let pendingRan = false;
  scheduler.enqueue("one", async () => {
    started.resolve();
    await active.promise;
  });
  scheduler.enqueue("two", async () => { pendingRan = true; });
  await started.promise;
  let stopped = false;
  const stopping = scheduler.pause().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  active.resolve();
  await stopping;
  assert.equal(pendingRan, false);
  scheduler.enqueue("three", async () => { pendingRan = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingRan, false);
});
