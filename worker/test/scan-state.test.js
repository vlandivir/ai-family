import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogTasks, checkNext, checkTask, publishQueueStatus, readListings, recordScan, recoverScanJobs } from "../src/scan.js";
import { claimTask, createScanStore, dayMs, enqueueTasks, finishTask, normalizeScanState, queueSnapshot, dailyAnalysisLimit, dailyHouseAnalysisLimit } from "../src/scan-state.js";

const now = Date.parse("2026-09-29T10:00:00Z");
const task = (name, kind = "new") => ({ kind, url: `https://4zida.rs/${name}` });

function memoryStore(value = {}) {
  let saved;
  const store = createScanStore("unused", { load: async () => value, save: async (path, state) => { saved = structuredClone(state); }, now: () => now });
  return { store, saved: () => saved };
}

test("migrates the entire legacy queue without truncation and recovers interrupted checks", () => {
  const legacy = { pending: ["https://4zida.rs/pending"], queue: Array.from({ length: 150 }, (_, i) => JSON.stringify(task(i))) };
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
  enqueueTasks(state, [{ ...task("one"), sourceUrls: ["https://www.4zida.rs/alias?utm=1"] }]);
  enqueueTasks(state, [{ kind: "new", url: "https://4zida.rs/alias" }]);
  assert.equal(state.queue.length, 1);
  const claimed = claimTask(state, now);
  assert.equal(claimTask(state, now), null);
  finishTask(state, claimed, { retry: true });
  assert.equal(claimTask(state, now + dayMs - 1), null);
  assert.equal(claimTask(state, now + dayMs).url, claimed.url);
});

test("raised new quota does not stop old checks and resets on the next Belgrade day", () => {
  const state = normalizeScanState({}, now);
  enqueueTasks(state, Array.from({ length: dailyAnalysisLimit + 1 }, (_, i) => task(i)));
  enqueueTasks(state, [task("old", "existing")]);
  for (let i = 0; i < dailyAnalysisLimit; i++) {
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

test("houses use a separate residual quota and never consume the apartment quota", () => {
  const state = normalizeScanState({}, now);
  enqueueTasks(state, Array.from({ length: dailyHouseAnalysisLimit + 1 }, (_, i) => ({ ...task(`house-${i}`), scenario: "houses" })));
  enqueueTasks(state, [{ ...task("apartment"), scenario: "living" }]);
  assert.equal(claimTask(state, now).scenario, "living");
  finishTask(state, state.activeTask);
  for (let i = 0; i < dailyHouseAnalysisLimit; i++) {
    const claimed = claimTask(state, now);
    assert.equal(claimed.scenario, "houses");
    finishTask(state, claimed);
  }
  assert.equal(claimTask(state, now), null);
  assert.equal(state.apartmentAnalyzed, 1);
  assert.equal(state.houseAnalyzed, dailyHouseAnalysisLimit);
});

test("catalog loading paginates past 1000 and queues recent rows for their next due time", async () => {
  const paths = [];
  const rows = await readListings("project", async path => {
    paths.push(path);
    return path.endsWith("offset=0") ? Array.from({ length: 1000 }, (_, id) => ({ id, status: "fit", source_url: `https://4zida.rs/${id}`, details: {} }))
      : [{ id: "recent", status: "fit", source_url: "https://4zida.rs/recent", details: { availabilityCheckedAt: new Date(now).toISOString() } }];
  });
  assert.equal(rows.length, 1001);
  assert.match(paths[1], /offset=1000$/);
  const tasks = catalogTasks(rows);
  assert.equal(tasks.at(-1).availableAt, now + dayMs);
});

test("a new listing is analyzed once without a preliminary fetch in its own agent context", async () => {
  let invocation;
  await checkTask({ ...task("new"), checkedAt: new Date(now).toISOString(), maxPriceEur: 240000, scenario: "newbuild" }, { project: "belgrade-apartments" }, "project", {
    get: async () => { throw new Error("new listing must not run old checks"); },
    analyze: async (...args) => { invocation = args; return "card"; },
  });
  assert.equal(invocation[0].userId, "scan:belgrade-apartments:check");
  assert.equal(invocation[1], invocation[0].userId);
  assert.equal(invocation[2].scan.maxPriceEur, 240000);
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
  await recordScan("project", { source_url: "https://4zida.rs/search", action: "search_page", result: "scanned", details: { foundCount: 5 } }, { insert });
  await recordScan("project", { source_url: "https://4zida.rs/listing", action: "recheck", result: "price_changed", details: { price: 175000 } }, { insert });
  await recordScan("project", { source_url: "https://4zida.rs/new", action: "analyze", result: "started" }, { insert });
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

test("initial rejection logs its reason and never enters the notification queue", async () => {
  const { store, saved } = memoryStore({ queue: [task("excluded")] });
  const events = [];
  await checkNext({}, "project", store, { now: () => now,
    process: (task, topic, project) => checkTask(task, topic, project, { analyze: async () => ({ scanResult: "excluded", reason: "Первый этаж", notification: null }) }),
    record: async (project, event) => events.push(event),
  });
  assert.deepEqual(saved().notifications, []);
  assert.equal(events.at(-1).result, "excluded");
  assert.equal(events.at(-1).details.reason, "Первый этаж");
  const restarted = normalizeScanState(saved(), now + dayMs * 5);
  enqueueTasks(restarted, [task("excluded")]);
  assert.equal(restarted.queue.length, 0);
  assert.equal(restarted.dismissedUrls[task("excluded").url].result, "excluded");
});

test("queue snapshot explains readiness and groups work by source and scenario", () => {
  const state = normalizeScanState({ queue: [
    { ...task("ready"), scenario: "living" },
    { kind: "new", scenario: "houses", url: "https://cityexpert.rs/prodaja-nekretnina/beograd/123/example", availableAt: now + dayMs },
  ], dismissedUrls: { "https://4zida.rs/rejected": { result: "excluded" } } }, now);
  const snapshot = queueSnapshot(state, now);
  assert.equal(snapshot.queueTotal, 2);
  assert.equal(snapshot.ready, 1);
  assert.equal(snapshot.waiting, 1);
  assert.equal(snapshot.byScenario.living.ready, 1);
  assert.equal(snapshot.byScenario.houses.waiting, 1);
  assert.equal(snapshot.bySource["4zida.rs"].total, 1);
  assert.equal(snapshot.dismissedTotal, 1);
});

test("queue status is published as one project snapshot", async () => {
  const { store } = memoryStore({ queue: [{ ...task("ready"), scenario: "living" }] });
  let call;
  await publishQueueStatus("project", store, { now: () => now, upsert: async (...args) => { call = args; } });
  assert.deepEqual(call.slice(0, 1), ["scan_queue_status"]);
  assert.equal(call[1].project_id, "project");
  assert.equal(call[1].queue_total, 1);
  assert.equal(call[1].by_scenario.living.ready, 1);
  assert.equal(call[2], "project_id");
});

test("ready tasks follow category priority in a restored mixed queue", () => {
  const state = normalizeScanState({ queue: [
    { ...task("house"), scenario: "houses" }, { ...task("build"), scenario: "newbuild" },
    { ...task("living"), scenario: "living" }, { ...task("rental"), scenario: "rental" },
  ] }, now);
  for (const scenario of ["rental", "living", "newbuild", "houses"]) {
    const claimed = claimTask(state, now);
    assert.equal(claimed.scenario, scenario);
    finishTask(state, claimed);
  }
});

test("blocked sources and inspected information pages stay out after restart", () => {
  const inspected = "https://4zida.rs/novogradnja/investitor/123";
  const state = normalizeScanState({ inspectedPages: { [inspected]: new Date(now).toISOString() }, queue: [
    { kind: "new", url: inspected }, { kind: "existing", url: "https://www.halooglasi.com/nekretnine/123" },
    { kind: "new", url: "https://nekretnine.rs/oglasi/123" }, task("allowed"),
  ] }, now + dayMs * 5);
  assert.deepEqual(state.queue.map(x => x.url), [task("allowed").url]);
  enqueueTasks(state, [{ kind: "new", url: inspected }]);
  assert.equal(state.queue.length, 1);
});

test("only listing platforms and aggregators enter the scan queue", () => {
  const state = normalizeScanState({ queue: [
    { kind: "existing", scenario: "newbuild", url: "https://newport.rs/" },
    { kind: "existing", scenario: "newbuild", url: "https://deltaland.rs/project" },
    { kind: "existing", scenario: "newbuild", url: "https://google.com/maps/search/example" },
    { kind: "existing", scenario: "living", url: "Адрес без ссылки" },
    { kind: "existing", scenario: "newbuild", url: "https://4zida.rs/novogradnja/project/123/456" },
    { kind: "existing", scenario: "living", url: "https://cityexpert.rs/prodaja-nekretnina/beograd/123/example" },
    { kind: "existing", scenario: "living", url: "https://oglasi.rs/oglas/example" },
    { kind: "existing", scenario: "living", url: "https://estitor.com/rs/nekretnine/example/id-1" },
    { kind: "existing", scenario: "living", url: "https://nadjidom.com/sr/details/1/example" },
  ] }, now);
  assert.deepEqual(state.queue.map(item => new URL(item.url).hostname), [
    "4zida.rs", "cityexpert.rs", "oglasi.rs", "estitor.com", "nadjidom.com",
  ]);
});

test("information pages are inspected once even if their first response fails", async () => {
  const url = "https://4zida.rs/novogradnja/investitor/123";
  const { store, saved } = memoryStore({ queue: [{ kind: "new", url }] });
  await checkNext({}, "project", store, { now: () => now, record: async () => {},
    process: async () => { throw new Error("no JSON"); },
  });
  const restarted = normalizeScanState(saved(), now + dayMs * 2);
  enqueueTasks(restarted, [{ kind: "new", url }]);
  assert.equal(restarted.queue.length, 0);
});
