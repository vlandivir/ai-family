import { readJson, writeJson } from "./health.js";

export const dayMs = 24 * 60 * 60 * 1000;
export const searchEveryMs = dayMs / 2;
export const dailyAnalysisLimit = 100;

export function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.replace(/^www\./, "");
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

export function scanDate(now) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Belgrade", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function checkedTime(details) {
  const value = details?.availabilityCheckedAt || details?.availabilityChecked;
  return Date.parse(value?.length === 10 ? `${value}T00:00:00Z` : value) || 0;
}

export function taskUrls(task) {
  return [...new Set([task.url, ...(task.sourceUrls || [])].map(canonicalUrl).filter(Boolean))];
}

function legacyTask(value) {
  if (typeof value === "string" && value.startsWith("{")) value = JSON.parse(value);
  if (typeof value === "string") value = { url: value };
  const url = canonicalUrl(value?.url);
  return url ? { kind: "new", maxPriceEur: 200000, ...value, url } : null;
}

export function normalizeScanState(value = {}, now = Date.now()) {
  const state = {
    version: 2, queue: [], checkedUrls: {}, analyzedOn: value.analyzedOn || null,
    analyzed: value.analyzed || 0, lastDiscovery: value.lastDiscovery || null,
    searchRun: value.searchRun || null, activeTask: null,
    notifications: value.notifications || [],
    lastRequestAt: value.lastRequestAt || null,
  };
  state.checkedUrls = { ...(value.checkedUrls || {}) };
  if (value.version !== 2) {
    for (const url of value.skipped || []) {
      if (canonicalUrl(url)) state.checkedUrls[canonicalUrl(url)] = new Date(now).toISOString();
    }
  }
  const tasks = [...(value.activeTask ? [value.activeTask] : []), ...(value.pending || []), ...(value.queue || [])];
  const seen = new Set();
  for (const item of tasks) {
    const task = legacyTask(item);
    if (task && !seen.has(task.url)) {
      seen.add(task.url);
      state.queue.push(task);
    }
  }
  return state;
}

// Both background workers mutate one state through this serialized, atomic writer.
export function createScanStore(path, { load = readJson, save = writeJson, now = Date.now } = {}) {
  let state;
  let chain = Promise.resolve().then(async () => { state = normalizeScanState(await load(path) || {}, now()); });
  return {
    async read() { await chain; return structuredClone(state); },
    update(mutate) {
      const operation = chain.then(async () => {
        const next = structuredClone(state);
        const result = mutate(next);
        await save(path, next);
        state = next;
        return result;
      });
      chain = operation.catch(() => {});
      return operation;
    },
  };
}

export function enqueueTasks(state, tasks) {
  const queued = new Set([...state.queue, ...(state.activeTask ? [state.activeTask] : [])].flatMap(taskUrls));
  for (const task of tasks) {
    const urls = taskUrls(task);
    if (!urls.length || urls.some(url => queued.has(url))) continue;
    state.queue.push({ ...task, url: urls[0] });
    urls.forEach(url => queued.add(url));
  }
}

export function taskDueAt(state, task) {
  return Math.max(task.availableAt || 0, ...taskUrls(task).map(url => {
    const checked = Date.parse(state.checkedUrls[url]);
    return Number.isFinite(checked) ? checked + dayMs : 0;
  }));
}

export function claimTask(state, now = Date.now()) {
  if (state.activeTask) return null;
  const date = scanDate(now);
  if (state.analyzedOn !== date) { state.analyzedOn = date; state.analyzed = 0; }
  const index = state.queue.findIndex(task => taskDueAt(state, task) <= now &&
    (task.kind !== "new" || state.analyzed < dailyAnalysisLimit));
  if (index < 0) return null;
  const [task] = state.queue.splice(index, 1);
  task.checkedAt = new Date(now).toISOString();
  taskUrls(task).forEach(url => { state.checkedUrls[url] = task.checkedAt; });
  if (task.kind === "new") state.analyzed += 1;
  state.activeTask = task;
  return task;
}

export function finishTask(state, task, { retry = false, notifications = [] } = {}) {
  state.activeTask = null;
  state.notifications.push(...notifications);
  if (retry) enqueueTasks(state, [{ ...task, availableAt: Date.parse(task.checkedAt) + dayMs }]);
}
