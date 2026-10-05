import assert from "node:assert/strict";
import { test } from "node:test";
import { checkNext, searchSweep } from "../src/scan.js";
import { createScanRequestGate } from "../src/scan-rate-limit.js";
import { createScanStore } from "../src/scan-state.js";

const initialTime = Date.parse("2026-09-29T10:00:00Z");
function setup(value = {}) {
  let clock = initialTime, saved;
  const waits = [];
  const now = () => clock;
  const sleep = async ms => { waits.push(ms); clock += ms; };
  const store = createScanStore("unused", { now, load: async () => value, save: async (path, state) => { saved = structuredClone(state); } });
  return { now, sleep, store, waits, advance: ms => { clock += ms; }, saved: () => saved };
}

test("search and checking share one minute gate, including concurrent attempts and failures", async () => {
  const env = setup();
  const request = createScanRequestGate(env.store, env);
  const starts = [];
  const results = await Promise.allSettled([
    request(async () => { starts.push(env.now()); env.advance(5000); }),
    request(async () => { starts.push(env.now()); throw new Error("HTTP 403"); }),
    request(async () => { starts.push(env.now()); }),
  ]);
  assert.deepEqual(starts, [initialTime, initialTime + 65000, initialTime + 125000]);
  assert.deepEqual(env.waits, [60000, 60000]);
  assert.equal(results[1].status, "rejected");
});

test("restart preserves the remaining minute rather than allowing an immediate request", async () => {
  const env = setup({ lastRequestAt: new Date(initialTime - 15000).toISOString() });
  const request = createScanRequestGate(env.store, env);
  let started;
  await request(async () => { started = env.now(); });
  assert.equal(started, initialTime + 45000);
  assert.deepEqual(env.waits, [45000]);
  assert.equal(env.saved().lastRequestAt, new Date(started).toISOString());
});

test("actual search pages and old/new checks use the same gate", async () => {
  const env = setup({ queue: [
    { kind: "existing", url: "https://4zida.rs/old", listingId: "old" },
    { kind: "new", url: "https://4zida.rs/new" },
  ] });
  const request = createScanRequestGate(env.store, env);
  const starts = [];
  const topic = { project: "belgrade-apartments", repo: "repo" };
  const checks = {
    request, now: env.now, record: async () => {},
    process: async task => { starts.push({ kind: task.kind, at: env.now(), stamp: task.checkedAt }); return []; },
  };
  await Promise.all([
    searchSweep(topic, "project", env.store, {
      request, now: env.now, repo: async () => "repo", listings: async () => [], record: async () => {},
      searches: async () => [{ url: "https://4zida.rs/search1" }, { url: "https://4zida.rs/search2" }],
      fetch: async () => { starts.push({ kind: "search", at: env.now() }); return { status: 200, html: "" }; },
    }),
    (async () => { while (await checkNext(topic, "project", env.store, checks)) {} })(),
  ]);
  assert.equal(starts.length, 4);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i].at - starts[i - 1].at >= 60000);
  for (const start of starts.filter(item => item.stamp)) assert.equal(Date.parse(start.stamp), start.at);
});

test("stopping during the minute wait leaves the object queued and unchecked", async () => {
  const env = setup({ lastRequestAt: new Date(initialTime).toISOString(), queue: [{ kind: "new", url: "https://4zida.rs/new" }] });
  const shutdown = new AbortController();
  let processed = false;
  const request = createScanRequestGate(env.store, { now: env.now, signal: shutdown.signal,
    sleep: async () => { shutdown.abort(); shutdown.signal.throwIfAborted(); },
  });
  await assert.rejects(checkNext({}, "project", env.store, {
    request, now: env.now, record: async () => {}, process: async () => { processed = true; return []; },
  }), { name: "AbortError" });
  const state = await env.store.read();
  assert.equal(processed, false);
  assert.equal(state.queue.length, 1);
  assert.equal(state.activeTask, null);
  assert.deepEqual(state.checkedUrls, {});
});
