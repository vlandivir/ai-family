import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogTasks, checkNext, checkTask, readListings, recordScan, recoverScanJobs } from "../src/scan.js";
import { claimTask, createScanStore, dayMs, enqueueTasks, finishTask, normalizeScanState } from "../src/scan-state.js";

const now = Date.parse("2026-09-29T10:00:00Z");
const task = (name, kind = "new") => ({ kind, url: `https://example.com/${name}` });

function memoryStore(value = {}) {
  let saved;
  const store = createScanStore("unused", { load: async () => value, save: async (path, state) => { saved = structuredClone(state); }, now: () => now });
  return { store, saved: () => saved };
}

test("migrates the entire legacy queue without truncation and recovers interrupted checks", () => {
  const legacy = { pending: ["https://example.com/pending"], queue: Array.from({ length: 150 }, (_, i) => JSON.stringify(task(i))) };
  const migrated = normalizeScanState(legacy, now);
  assert.equal(migrated.queue.length, 151);
  const first = claimTask(migrated, now);
  const recovered = normalizeScanState(migrated, now + 1);
  assert.equal(recovered.queue.length, 151);
  assert.equal(recovered.queue[0].url, first.url);
  assert.notEqual(claimTask(recovered, now + 1).url, first.url);
});

test("serializes simultaneous search and checker writes without losing queued URLs", async () => {
  const { store, saved } = memoryStore();
  await Promise.all([
    store.update(state => enqueueTasks(state, [task("new")])),
    store.update(state => enqueueTasks(state, [task("old", "existing")])),
  ]);
  assert.equal(saved().queue.length, 2);
  const claimed = await store.update(state => claimTask(state, now));
  await Promise.all([
    store.update(state => enqueueTasks(state, [task("during-check")])),
    store.update(state => finishTask(state, claimed)),
  ]);
  assert.deepEqual(saved().queue.map(item => item.url), [task("old").url, task("during-check").url]);
});

test("canonical URL aliases are deduplicated and a failed check waits exactly 24 hours", () => {
  const state = normalizeScanState({}, now);
  enqueueTasks(state, [{ ...task("one"), sourceUrls: ["https://www.example.com/alias?utm=1"] }]);
  enqueueTasks(state, [{ kind: "new", url: "https://example.com/alias" }]);
  assert.equal(state.queue.length, 1);
  const claimed = claimTask(state, now);
  assert.equal(claimTask(state, now), null);
  finishTask(state, claimed, { retry: true });
  assert.equal(claimTask(state, now + dayMs - 1), null);
  assert.equal(claimTask(state, now + dayMs).url, claimed.url);
});

test("100-new quota does not stop old checks and resets on the next Belgrade day", () => {
  const state = normalizeScanState({}, now);
  enqueueTasks(state, Array.from({ length: 101 }, (_, i) => task(i)));
  enqueueTasks(state, [task("old", "existing")]);
  for (let i = 0; i < 100; i++) {
    const claimed = claimTask(state, now);
    assert.equal(claimed.kind, "new");
    finishTask(state, claimed);
  }
  const old = claimTask(state, now);
  assert.equal(old.kind, "existing");
  finishTask(state, old);
  assert.equal(claimTask(state, now), null);
  assert.equal(claimTask(state, now + dayMs).kind, "new");
});

test("catalog loading paginates past 1000 and queues recent rows for their next due time", async () => {
  const paths = [];
  const rows = await readListings("project", async path => {
    paths.push(path);
    return path.endsWith("offset=0") ? Array.from({ length: 1000 }, (_, id) => ({ id, source_url: `https://example.com/${id}`, details: {} }))
      : [{ id: "recent", source_url: "https://example.com/recent", details: { availabilityCheckedAt: new Date(now).toISOString() } }];
  });
  assert.equal(rows.length, 1001);
  assert.match(paths[1], /offset=1000$/);
  const tasks = catalogTasks(rows);
  assert.equal(tasks.at(-1).availableAt, now + dayMs);
});

test("a new listing is analyzed once without a preliminary fetch in its own agent context", async () => {
  let invocation;
  await checkTask({ ...task("new"), checkedAt: new Date(now).toISOString(), maxPriceEur: 250000, scenario: "newbuild" }, { project: "belgrade-apartments" }, "project", {
    get: async () => { throw new Error("new listing must not run old checks"); },
    analyze: async (...args) => { invocation = args; return "card"; },
  });
  assert.equal(invocation[0].userId, "scan:belgrade-apartments:check");
  assert.equal(invocation[1], invocation[0].userId);
  assert.equal(invocation[2].scan.maxPriceEur, 250000);
  assert.equal(invocation[2].scan.scenario, "newbuild");
});

test("a recent old listing is skipped before fetching and failures retain a retry", async () => {
  let checked = false;
  await checkTask({ ...task("old", "existing"), listingId: "old" }, {}, "project", {
    get: async () => [{ details: { availabilityCheckedAt: new Date(now).toISOString() } }],
    now: () => now, check: async () => { checked = true; },
  });
  assert.equal(checked, false);
  const { store } = memoryStore({ queue: [task("broken")] });
  assert.equal(await checkNext({}, "project", store, {
    now: () => now, process: async () => { throw new Error("offline"); }, record: async () => {},
  }), true);
  const state = await store.read();
  assert.equal(state.activeTask, null);
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].availableAt, now + dayMs);
});

test("notification failure does not require repeating the object's site check after restart", async () => {
  const { store, saved } = memoryStore({ queue: [task("new")] });
  await checkNext({}, "project", store, { now: () => now, process: async () => ["changed card"], record: async () => {} });
  const restarted = normalizeScanState(saved(), now);
  assert.deepEqual(restarted.notifications, ["changed card"]);
  enqueueTasks(restarted, [task("new")]);
  assert.equal(claimTask(restarted, now), null);
});

test("restart completes interrupted scan jobs without touching Telegram jobs", async () => {
  const paths = [], updates = [];
  await recoverScanJobs("project", {
    get: async path => { paths.push(path); return [{ id: "old-scan-job" }]; },
    patch: async (path, row) => { updates.push({ path, row }); },
  });
  assert.match(paths[0], /source=eq.scan&project_id=eq.project&status=eq.running/);
  assert.match(updates[0].path, /source=eq.scan&status=eq.running/);
  assert.equal(updates[0].row.status, "failed");
});

test("both agents write to the dashboard scan log with their identity and details", async () => {
  const inserted = [];
  const insert = async (table, row) => inserted.push({ table, row });
  await recordScan("project", { source_url: "https://example.com/search", action: "search_page", result: "scanned", details: { foundCount: 5 } }, { insert });
  await recordScan("project", { source_url: "https://example.com/listing", action: "recheck", result: "price_changed", details: { price: 175000 } }, { insert });
  await recordScan("project", { source_url: "https://example.com/new", action: "analyze", result: "started" }, { insert });
  assert.deepEqual(inserted.map(item => item.table), ["scan_events", "scan_events", "scan_events"]);
  assert.deepEqual(inserted.map(item => item.row.details.agent), ["search", "checker", "checker"]);
  assert.equal(inserted[0].row.details.foundCount, 5);
  assert.equal(inserted[1].row.details.price, 175000);
});

test("the checker logs start and finish around old and new work", async () => {
  for (const kind of ["existing", "new"]) {
    const { store } = memoryStore({ queue: [task(kind, kind)] });
    const order = [];
    await checkNext({}, "project", store, {
      now: () => now,
      record: async (project, event) => order.push(event.result),
      process: async () => { order.push("checked"); return []; },
    });
    assert.deepEqual(order, ["started", "checked", kind === "new" ? "processed" : "finished"]);
  }
});
