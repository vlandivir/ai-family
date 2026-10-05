import { readJson, writeJson } from "./health.js";

export const dayMs = 24 * 60 * 60 * 1000;
export const searchEveryMs = dayMs / 2;
export const dailyAnalysisLimit = 500;
export const dailyHouseAnalysisLimit = 100;

export const scenarioOrder = ["rental", "living", "newbuild", "houses"];
export function blockedScanUrl(value) {
  try { return /^(?:www\.)?(?:nekretnine\.rs|halooglasi\.com)$/.test(new URL(value).hostname); } catch { return false; }
}
export function informationPage(value) {
  try {
    const url = new URL(value);
    if (/(?:^|\/)(?:investitor|investitori|developer|developers|zastupnik|agencija)(?:\/|$)/i.test(url.pathname)) return true;
    return /(?:^|\.)4zida\.rs$/.test(url.hostname) && /\/novogradnja\/.+\/\d+$/.test(url.pathname) && !/\/\d+\/\d+$/.test(url.pathname);
  } catch { return false; }
}
export function scenarioPriority(task) {
  const scenario = task.scenario || (/prodaja-kuca/.test(task.url) ? "houses" : /novogradnja/.test(task.url) ? "newbuild" : "living");
  return scenarioOrder.indexOf(scenario) < 0 ? 4 : scenarioOrder.indexOf(scenario);
}

export function houseTask(task) {
  return scenarioPriority(task) === scenarioOrder.indexOf("houses");
}

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
  const legacyAnalyzed = value.analyzed || 0;
  const state = {
    version: 3, queue: [], checkedUrls: {}, analyzedOn: value.analyzedOn || null,
    analyzed: legacyAnalyzed,
    apartmentAnalyzed: value.apartmentAnalyzed ?? 0,
    houseAnalyzed: value.houseAnalyzed ?? (value.version === 3 ? 0 : legacyAnalyzed),
    lastDiscovery: value.lastDiscovery || null,
    searchRun: value.searchRun ? { ...value.searchRun, remaining: value.searchRun.remaining.filter(entry => !blockedScanUrl(entry.url)).sort((a, b) => scenarioPriority(a) - scenarioPriority(b)) } : null, activeTask: null,
    notifications: value.notifications || [],
    lastRequestAt: value.lastRequestAt || null,
    inspectedPages: { ...(value.inspectedPages || {}) },
    dismissedUrls: { ...(value.dismissedUrls || {}) },
  };
  state.checkedUrls = { ...(value.checkedUrls || {}) };
  if (!value.version || value.version < 2) {
    for (const url of value.skipped || []) {
      if (canonicalUrl(url)) state.checkedUrls[canonicalUrl(url)] = new Date(now).toISOString();
    }
  }
  const tasks = [...(value.activeTask ? [value.activeTask] : []), ...(value.pending || []), ...(value.queue || [])];
  const seen = new Set();
  for (const item of tasks) {
    const task = legacyTask(item);
    if (task && !blockedScanUrl(task.url) && !taskUrls(task).some(url => state.inspectedPages[url] || state.dismissedUrls[url]) && !seen.has(task.url)) {
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
    if (!urls.length || blockedScanUrl(urls[0]) || urls.some(url => queued.has(url) || state.inspectedPages?.[url] || state.dismissedUrls?.[url])) continue;
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
  if (state.analyzedOn !== date) {
    state.analyzedOn = date;
    state.analyzed = 0;
    state.apartmentAnalyzed = 0;
    state.houseAnalyzed = 0;
  }
  let index = -1;
  for (let i = 0; i < state.queue.length; i++) {
    const task = state.queue[i];
    const quotaReached = task.kind === "new" && (houseTask(task)
      ? state.houseAnalyzed >= dailyHouseAnalysisLimit
      : state.apartmentAnalyzed >= dailyAnalysisLimit);
    if (blockedScanUrl(task.url) || state.inspectedPages?.[task.url] || state.dismissedUrls?.[task.url] ||
      taskDueAt(state, task) > now || quotaReached) continue;
    if (index < 0 || scenarioPriority(task) < scenarioPriority(state.queue[index])) index = i;
  }
  if (index < 0) return null;
  const [task] = state.queue.splice(index, 1);
  task.checkedAt = new Date(now).toISOString();
  taskUrls(task).forEach(url => { state.checkedUrls[url] = task.checkedAt; });
  if (task.kind === "new") {
    state.analyzed += 1;
    if (houseTask(task)) state.houseAnalyzed += 1;
    else state.apartmentAnalyzed += 1;
  }
  state.activeTask = task;
  return task;
}

export function dismissTask(state, task, result, reason, checkedAt = task.checkedAt) {
  for (const url of taskUrls(task)) state.dismissedUrls[url] = { checkedAt, result, reason: reason || null };
  state.queue = state.queue.filter(queued => !taskUrls(queued).some(url => state.dismissedUrls[url]));
}

function sourceName(value) {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return "unknown"; }
}

export function queueSnapshot(state, now = Date.now()) {
  const date = scanDate(now);
  const apartmentUsed = state.analyzedOn === date ? state.apartmentAnalyzed || 0 : 0;
  const houseUsed = state.analyzedOn === date ? state.houseAnalyzed || 0 : 0;
  const bySource = {}, byScenario = {};
  let ready = 0;
  for (const task of state.queue) {
    const scenario = task.scenario || scenarioOrder[scenarioPriority(task)] || "other";
    const source = sourceName(task.url);
    const quotaBlocked = task.kind === "new" && (houseTask(task) ? houseUsed >= dailyHouseAnalysisLimit : apartmentUsed >= dailyAnalysisLimit);
    const taskReady = taskDueAt(state, task) <= now && !quotaBlocked;
    if (taskReady) ready++;
    for (const [group, key] of [[bySource, source], [byScenario, scenario]]) {
      group[key] ||= { total: 0, ready: 0, waiting: 0, new: 0, existing: 0 };
      group[key].total++;
      group[key][taskReady ? "ready" : "waiting"]++;
      group[key][task.kind === "new" ? "new" : "existing"]++;
    }
  }
  return {
    queueTotal: state.queue.length,
    ready,
    waiting: state.queue.length - ready,
    notifications: state.notifications.length,
    dismissedTotal: Object.keys(state.dismissedUrls || {}).length,
    apartmentUsed,
    apartmentLimit: dailyAnalysisLimit,
    houseUsed,
    houseLimit: dailyHouseAnalysisLimit,
    activeTask: state.activeTask || null,
    searchState: state.searchRun ? { remaining: state.searchRun.remaining.length, visited: state.searchRun.visited.length } : null,
    bySource,
    byScenario,
  };
}

export function finishTask(state, task, { retry = false, notifications = [] } = {}) {
  state.activeTask = null;
  state.notifications.push(...notifications);
  if (retry) enqueueTasks(state, [{ ...task, availableAt: Date.parse(task.checkedAt) + dayMs }]);
}
