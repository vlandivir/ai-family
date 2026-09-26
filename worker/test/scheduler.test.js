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
