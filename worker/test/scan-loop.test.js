import assert from "node:assert/strict";
import { test } from "node:test";
import { checkNext, searchSweep, startScan } from "../src/scan.js";
import { createScanStore } from "../src/scan-state.js";

const time = Date.parse("2026-09-29T08:00:00Z");
const topic = { project: "belgrade-apartments", repo: "owner/repo" };
const url = "https://4zida.rs/prodaja-stanova/beograd/dvosoban-stan/6ab254bddb227fdad102a351";
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function memoryStore(initial = {}) {
  let saved = structuredClone(initial);
  const store = createScanStore("/unused", {
    load: async () => saved, save: async (path, value) => { saved = structuredClone(value); }, now: () => time,
  });
  return { store, saved: () => structuredClone(saved) };
}
const record = async () => {};
const basics = { get: async path => path.startsWith("projects?") ? [{ id: "project" }] : [], loadTopic: async () => topic,
  listings: async () => [], notify: async () => {}, now: () => time, idleMs: 60_000,
  request: operation => operation(), publish: async () => {} };

test("a temporary startup database failure retries instead of permanently disabling both workers", { timeout: 2000 }, async () => {
  const { store } = memoryStore();
  const started = deferred();
  let attempts = 0;
  const worker = startScan({ ...basics, store, idleMs: 1,
    get: async path => {
      if (!path.startsWith("projects?")) return [];
      if (++attempts === 1) throw new Error("temporary database outage");
      return [{ id: "project" }];
    },
    search: async () => false, next: async () => { started.resolve(); return false; },
  });
  try { await started.promise; assert.equal(attempts, 2); }
  finally { await worker.stop(); }
});

test("startup removes historically rejected URLs from the durable queue", async () => {
  const rejected = "https://4zida.rs/rejected";
  const { store } = memoryStore({ version: 2, queue: [{ kind: "new", scenario: "living", url: rejected }] });
  const worker = startScan({ ...basics, store, search: async () => false, next: async () => false,
    get: async path => path.startsWith("projects?") ? [{ id: "project" }]
      : path.startsWith("agent_jobs?source=eq.scan") && path.includes("offset=0") ? [{ payload: { url: rejected }, finished_at: new Date(time).toISOString(), result: { scanResult: "excluded", reason: "район" } }]
        : [],
  });
  try {
    await worker.ready;
    const state = await store.read();
    assert.equal(state.queue.length, 0);
    assert.equal(state.dismissedUrls[rejected].reason, "район");
  } finally { await worker.stop(); }
});

test("background checker drains a mixed queue continuously and never checks two listings concurrently", { timeout: 2000 }, async () => {
  const { store } = memoryStore({ version: 2, queue: [
    { kind: "existing", listingId: "old", url: "https://4zida.rs/old" },
    { kind: "new", url },
    { kind: "existing", listingId: "other", url: "https://4zida.rs/other" },
  ] });
  const started = deferred(), release = deferred(), done = deferred();
  let active = 0, peak = 0;
  const order = [];
  const worker = startScan({ ...basics, store, search: async () => false,
    busy: () => true,
    next: (a, b, c) => checkNext(a, b, c, { now: () => time, record, process: async task => {
      active++; peak = Math.max(peak, active); order.push(task.kind);
      if (order.length === 1) { started.resolve(); await release.promise; }
      active--;
      if (order.length === 3) done.resolve();
      return [];
    } }),
  });
  try {
    await started.promise;
    assert.deepEqual(order, ["existing"]);
    release.resolve();
    await done.promise;
    assert.deepEqual(order, ["existing", "new", "existing"]);
    assert.equal(peak, 1);
  } finally { release.resolve(); await worker.stop(); }
});

test("independent search persists newly discovered work while the checker is busy", { timeout: 2000 }, async () => {
  const memory = memoryStore({ version: 2, queue: [{ kind: "existing", listingId: "old", url: "https://4zida.rs/old" }] });
  const started = deferred(), release = deferred(), discovered = deferred(), drained = deferred();
  const order = [];
  const worker = startScan({ ...basics, store: memory.store,
    search: (a, b, c, options) => searchSweep(a, b, c, { ...options, record,
      repo: async () => "/repo", searches: async () => [{ url: "https://4zida.rs/prodaja-stanova/beograd", maxPriceEur: 200000 }], listings: async () => [],
      fetch: async () => { await started.promise; return { status: 200, html: `<a href="${url}">listing</a>` }; },
      wake: () => { options.wake(); discovered.resolve(); },
    }),
    next: (a, b, c) => checkNext(a, b, c, { now: () => time, record, process: async task => {
      order.push(task.kind);
      if (task.kind === "existing") { started.resolve(); await release.promise; }
      else drained.resolve();
      return [];
    } }),
  });
  try {
    await discovered.promise;
    const saved = memory.saved();
    assert.equal(saved.activeTask.kind, "existing");
    assert.equal(saved.queue[0].url, url);
    release.resolve();
    await drained.promise;
    assert.deepEqual(order, ["existing", "new"]);
  } finally { release.resolve(); await worker.stop(); }
});

test("shutdown waits for both active lanes and starts no next listing", { timeout: 2000 }, async () => {
  const { store } = memoryStore({ version: 2, queue: [
    { kind: "existing", listingId: "old", url: "https://4zida.rs/old" },
    { kind: "new", url },
  ] });
  const checkStarted = deferred(), searchStarted = deferred(), checkRelease = deferred(), searchRelease = deferred();
  let checks = 0, searches = 0;
  const worker = startScan({ ...basics, store,
    search: async () => { searches++; searchStarted.resolve(); await searchRelease.promise; },
    next: (a, b, c) => checkNext(a, b, c, { now: () => time, record, process: async () => {
      checks++; checkStarted.resolve(); await checkRelease.promise; return [];
    } }),
  });
  await Promise.all([checkStarted.promise, searchStarted.promise]);
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  checkRelease.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  searchRelease.resolve();
  await stopping;
  assert.equal(checks, 1);
  assert.equal(searches, 1);
  assert.equal((await store.read()).queue.length, 1);
});

test("full search sweep skips blocked sites, follows filtered pagination and deduplicates loops", async () => {
  const { store } = memoryStore();
  const first = "https://4zida.rs/prodaja-stanova/beograd?budget=200000";
  const second = `${first}&page=2`;
  const blocked = "https://halooglasi.com/nekretnine/prodaja-stanova/beograd";
  const fetched = [], events = [];
  await searchSweep(topic, "project", store, {
    repo: async () => "/repo", searches: async () => [{ url: first, scenario: "living", maxPriceEur: 200000 }, { url: blocked }], listings: async () => [], now: () => time,
    record: async (project, event) => events.push(event),
    fetch: async page => {
      fetched.push(page);
      if (page === blocked) return { status: 403, html: "blocked" };
      return { status: 200, html: `<a href="http://[">malformed</a><a href="${url}">listing</a><a href="${second}">next</a><a href="${first}">back</a><a href="?budget=999999&page=3">wrong budget</a><a href="https://other.com/?budget=200000&page=3">other site</a>` };
    },
  });
  assert.deepEqual(fetched, [first, second]);
  assert.deepEqual(events.filter(event => event.source_url === blocked).map(event => event.result), []);
  const state = await store.read();
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].scenario, "living");
  assert.equal(state.queue[0].maxPriceEur, 200000);
  assert.equal(state.searchRun, null);
});

test("a completed sweep runs again at exactly twelve hours, not earlier", async () => {
  const { store } = memoryStore();
  let clock = time, fetches = 0;
  const deps = { repo: async () => "/repo", searches: async () => [{ url: "https://4zida.rs/search" }], listings: async () => [], record, now: () => clock,
    fetch: async () => { fetches++; return { status: 200, html: "" }; },
  };
  assert.equal(await searchSweep(topic, "project", store, deps), true);
  clock += 12 * 60 * 60 * 1000 - 1;
  assert.equal(await searchSweep(topic, "project", store, deps), false);
  assert.equal(fetches, 1);
  clock++;
  assert.equal(await searchSweep(topic, "project", store, deps), true);
  assert.equal(fetches, 2);
});

test("unfinished search resumes its durable cursor after restart without repeating pages", async () => {
  const memory = memoryStore();
  let stopping = false;
  const fetched = [];
  const entries = [{ url: "https://4zida.rs/first" }, { url: "https://4zida.rs/second" }];
  await searchSweep(topic, "project", memory.store, {
    repo: async () => "/repo", searches: async () => entries, listings: async () => [], record, now: () => time,
    stopped: () => stopping,
    fetch: async page => { fetched.push(page); stopping = true; return { status: 200, html: "" }; },
  });
  assert.deepEqual(memory.saved().searchRun.remaining, [entries[1]]);
  const restarted = memoryStore(memory.saved());
  await searchSweep(topic, "project", restarted.store, {
    repo: async () => { throw new Error("must reuse existing cursor"); }, listings: async () => [], record, now: () => time,
    fetch: async page => { fetched.push(page); return { status: 200, html: "" }; },
  });
  assert.deepEqual(fetched, entries.map(entry => entry.url));
  assert.equal((await restarted.store.read()).searchRun, null);
});


test("search wake delivered while checker decides it is idle is not lost", { timeout: 2000 }, async () => {
  const { store } = memoryStore();
  const checking = deferred(), enqueued = deferred(), processed = deferred();
  let nextCalls = 0, searchCalls = 0;
  const worker = startScan({ ...basics, store,
    search: async (a, b, c, { wake }) => {
      if (++searchCalls > 1) return false;
      await checking.promise;
      await c.update(state => { state.queue.push({ kind: "new", url }); });
      wake();
      enqueued.resolve();
      return true;
    },
    next: async (a, b, c) => {
      if (++nextCalls === 1) {
        checking.resolve();
        await enqueued.promise;
        return false;
      }
      return checkNext(a, b, c, { now: () => time, record, process: async () => { processed.resolve(); return []; } });
    },
  });
  try { await processed.promise; }
  finally { await worker.stop(); }
  assert.ok(nextCalls >= 2);
});
