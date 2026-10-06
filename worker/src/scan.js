import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dbGet, dbInsert, dbPatch, dbUpsert } from "./db.js";
import { ensureRepo, runListing } from "./queue.js";
import { interestingListing, priceRejected, catalogPriority, scanBudgetEur } from "./listing-policy.js";
import { extractListingPhotos } from "./listing-photos.js";
import { sendMessage } from "./telegram/poll.js";
import { cardText } from "./catalog-lookup.js";
import { canonicalUrl, checkedTime, claimTask, createScanStore, dayMs, dismissTask, enqueueTasks, finishTask, queueSnapshot, searchSlot, blockedScanUrl, scenarioPriority, informationPage } from "./scan-state.js";
import { createScanRequestGate } from "./scan-rate-limit.js";
export { canonicalUrl, dailyAnalysisLimit } from "./scan-state.js";

const statePath = process.env.SCAN_STATE_PATH || "/var/lib/ai-family/scan-state.json";

export async function recordScan(projectId, event, { insert = dbInsert } = {}) {
  try {
    await insert("scan_events", { project_id: projectId, ...event,
      details: { ...event.details, agent: event.action === "search_page" ? "search" : "checker" },
      error: event.error ? String(event.error).slice(0, 500) : null });
  } catch (error) {
    console.error("scan log", error.message);
  }
}

export async function publishQueueStatus(projectId, store, { upsert = dbUpsert, now = Date.now } = {}) {
  try {
    const snapshot = queueSnapshot(await store.read(), now());
    await upsert("scan_queue_status", {
      project_id: projectId,
      updated_at: new Date(now()).toISOString(),
      queue_total: snapshot.queueTotal,
      ready_now: snapshot.ready,
      waiting: snapshot.waiting,
      notifications: snapshot.notifications,
      dismissed_total: snapshot.dismissedTotal,
      apartment_used: snapshot.apartmentUsed,
      apartment_limit: snapshot.apartmentLimit,
      house_used: snapshot.houseUsed,
      house_limit: snapshot.houseLimit,
      active_task: snapshot.activeTask,
      search_state: snapshot.searchState,
      by_source: snapshot.bySource,
      by_scenario: snapshot.byScenario,
    }, "project_id");
  } catch (error) {
    console.error("scan queue status", error.message);
  }
}

function offerPrice(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = offerPrice(item);
      if (found) return found;
    }
    return null;
  }
  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("Offer") && String(node.priceCurrency || "EUR").toUpperCase() === "EUR") {
    const price = Number(node.price);
    if (price >= 20000 && price <= 5000000) return Math.round(price);
  }
  for (const key of ["@graph", "offers", "mainEntity", "itemOffered"]) {
    const price = offerPrice(node[key]);
    if (price) return price;
  }
  return null;
}

export function extractPrice(html) {
  const blocks = html.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of blocks) {
    try {
      const price = offerPrice(JSON.parse(block[1]));
      if (price) return price;
    } catch {
      // The next block may still be valid JSON-LD.
    }
  }
  return null;
}

const listingPatterns = [
  /^https:\/\/(?:www\.)?4zida\.rs\/prodaja-(?:stanova|kuca)\/[a-z0-9-]+\/[a-z0-9-]+\/[a-f0-9]{16,}$/i,
  /^https:\/\/(?:www\.)?4zida\.rs\/novogradnja\/[a-z0-9/-]+\/\d+$/i,
  /^https:\/\/(?:www\.)?cityexpert\.rs\/(?:prodaja-nekretnina|izdavanje-nekretnina)\/.+\/\d{3,}\/.+$/i,
  /^https:\/\/(?:www\.)?cityexpert\.rs\/(?:a\/)?novogradnja\/.+\/.+$/i,
  /^https:\/\/(?:www\.)?nekretnine\.rs\/oglasi\/\d+\/?$/i,
  /^https:\/\/(?:www\.)?oglasi\.rs\/oglas\/[a-z0-9/-]+$/i,
  /^https:\/\/(?:www\.)?halooglasi\.com\/nekretnine\/.+\/\d{5,}\/?$/i,
  /^https:\/\/estitor\.com\/rs\/nekretnine\/.+\/id-\d+\/?$/i,
  /^https:\/\/(?:www\.)?nadjidom\.com\/sr\/details\/\d+\/.+$/i,
];

export function extractListingUrls(html, baseUrl) {
  const found = new Set();
  for (const match of html.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gi)) {
    let absolute;
    try {
      absolute = new URL(match[2].replace(/&amp;/gi, "&"), baseUrl).toString();
    } catch {
      continue;
    }
    const url = canonicalUrl(absolute);
    if (url && listingPatterns.some((pattern) => pattern.test(url))) found.add(url);
  }
  return [...found];
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function stale(details, hours) {
  return Date.now() - checkedTime(details) >= hours * 60 * 60 * 1000;
}

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "ai-family-scan/1.0", accept: "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  return { status: response.status, html: await response.text() };
}

function knownUrls(rows) {
  const urls = new Set();
  for (const row of rows) {
    for (const value of [row.source_url, ...(Array.isArray(row.source_urls) ? row.source_urls : [])]) {
      const url = canonicalUrl(value);
      if (url) urls.add(url);
    }
  }
  return urls;
}

function priceUpdate(details, price, url, currentPrice) {
  const history = Array.isArray(details.priceHistory) ? [...details.priceHistory] : [];
  const last = history.at(-1);
  const previous = currentPrice == null ? last?.price ?? null : Number(currentPrice);
  const changed = previous != null && previous !== price;
  if (!last && previous != null) {
    history.push({ date: today(), price: previous, sourceUrl: url, note: "Цена в каталоге до автоматической проверки" });
  }
  if (history.at(-1)?.price !== price) {
    history.push({
      date: today(),
      price,
      sourceUrl: url,
      note: changed ? `Было ${previous.toLocaleString("ru-RU")} €` : "Автоматическая проверка",
    });
  }
  return {
    changed,
    previous,
    details: {
      ...details,
      priceHistory: history,
      availabilityChecked: today(),
      availabilityCheckedAt: new Date().toISOString(),
      availabilityStatus: "active",
      availabilityLabel: changed ? "Цена изменилась" : "На месте",
      availabilityNote: changed
        ? `Страница открыта. ${previous.toLocaleString("ru-RU")} € → ${price.toLocaleString("ru-RU")} €.`
        : "Страница открыта, цена без изменений.",
    },
  };
}

export async function recheck(rows, hours, projectId, { fetch = fetchPage, patch = dbPatch, record = recordScan } = {}) {
  const due = rows
    .filter((row) => !blockedScanUrl(row.source_url) && row.source_url && row.status !== "test" && stale(row.details, hours))
    .sort((a, b) => String(a.details?.availabilityCheckedAt || a.details?.availabilityChecked || "").localeCompare(String(b.details?.availabilityCheckedAt || b.details?.availabilityChecked || "")))
    .slice(0, 1);
  const changes = [];
  for (const row of due) {
    let page;
    try {
      page = await fetch(row.source_url);
    } catch (error) {
      console.error("scan fetch", row.catalog_number, error.message);
      const details = {
        ...(row.details || {}),
        availabilityChecked: today(),
        availabilityCheckedAt: new Date().toISOString(),
        availabilityLabel: "Сайт не ответил",
        availabilityNote: "Повтор через сутки.",
      };
      await patch(`listings?id=eq.${row.id}`, { details });
      await record(projectId, { listing_id: row.id, source_url: row.source_url, action: "recheck", result: "fetch_error", error: error.message });
      continue;
    }
    const details = { ...(row.details || {}) };
    if (page.status === 200 && !details.photoUrls?.length) {
      const photos = extractListingPhotos(page.html, row.source_url);
      if (photos.length) details.photoUrls = photos;
    }
    if (page.status === 404 || page.status === 410) {
      details.availabilityChecked = today();
      details.availabilityCheckedAt = new Date().toISOString();
      details.availabilityStatus = "removed";
      details.availabilityLabel = "Снято";
      details.availabilityNote = `Страница ответила ${page.status}.`;
      await patch(`listings?id=eq.${row.id}`, { details });
      await record(projectId, { listing_id: row.id, source_url: row.source_url, action: "recheck", result: "removed", http_status: page.status });
      if (row.details?.category !== "houses" && interestingListing(row) && row.details?.availabilityStatus !== "removed") changes.push(`Снято с публикации\n${cardText(row)}`);
      continue;
    }
    const price = page.status === 200 ? extractPrice(page.html) : null;
    if (!price) {
      details.availabilityChecked = today();
      details.availabilityCheckedAt = new Date().toISOString();
      details.availabilityStatus = details.availabilityStatus || "active";
      details.availabilityLabel = page.status === 200 ? "Проверено" : "Сайт недоступен";
      details.availabilityNote = page.status === 200
        ? "Страница открылась, цену в разметке не нашёл."
        : `Страница ответила ${page.status}. Повтор через сутки.`;
      await patch(`listings?id=eq.${row.id}`, { details });
      await record(projectId, { listing_id: row.id, source_url: row.source_url, action: "recheck", result: page.status === 200 ? "price_unknown" : "http_error", http_status: page.status });
      continue;
    }
    const next = priceUpdate(details, price, row.source_url, row.asking_price_eur);
    const update = { details: next.details, asking_price_eur: price };
    if (price > scanBudgetEur && interestingListing(row)) {
      update.status = 'excluded';
      update.fit = `Цена выше лимита ${scanBudgetEur} EUR`;
      update.details.exclusionReason = 'over_budget';
    }
    await patch(`listings?id=eq.${row.id}`, update);
    await record(projectId, { listing_id: row.id, source_url: row.source_url, action: "recheck", result: next.changed ? "price_changed" : "unchanged", http_status: page.status, details: { price, previous: next.previous } });
    if (row.details?.category !== "houses" && interestingListing(row) && next.changed && next.previous != null) {
      changes.push(`Цена изменилась: ${next.previous.toLocaleString("ru-RU")} € → ${price.toLocaleString("ru-RU")} €\n${cardText({ ...row, ...update })}`);
    }
  }
  return changes;
}

export async function readSearches(dir) {
  const config = JSON.parse(await readFile(join(dir, "scan.json"), "utf8"));
  return (config.searches || []).map(entry => typeof entry === "string" ? { url: entry } : entry)
    .filter(entry => entry?.url && !blockedScanUrl(entry.url))
    .map(entry => ({ ...entry, maxPriceEur: scanBudgetEur }))
    .sort((a, b) => scenarioPriority(a) - scenarioPriority(b));
}

export async function readListings(projectId, get = dbGet) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await get(`listings?project_id=eq.${projectId}&status=not.in.(error,test)&select=id,catalog_number,address,neighborhood,municipality,status,fit,source_url,source_urls,asking_price_eur,details&order=id.asc&limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

export function catalogTasks(rows) {
  return rows.filter(row => catalogPriority(row) !== null && !blockedScanUrl(row.source_url) && (row.source_url || row.source_urls?.some(Boolean)))
    .sort((a, b) => checkedTime(a.details) - checkedTime(b.details))
    .map(row => ({ kind: "existing", priority: catalogPriority(row), priceRejected: priceRejected(row), scenario: row.details?.category, listingId: row.id, url: row.source_url || row.source_urls.find(Boolean),
      sourceUrls: row.source_urls || [], availableAt: checkedTime(row.details) ? checkedTime(row.details) + dayMs : 0 }));
}

// Follow pagination only within the configured search, preserving all its filters.
export function paginationUrls(html, baseUrl) {
  const base = new URL(baseUrl);
  const found = new Set();
  for (const match of html.matchAll(/<(?:a|link)\b[^>]*>/gi)) {
    const href = match[0].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!href) continue;
    let target;
    try { target = new URL(href.replace(/&amp;/gi, "&"), base); } catch { continue; }
    if (target.origin !== base.origin || target.pathname !== base.pathname) continue;
    const keys = new Set([...base.searchParams.keys(), ...target.searchParams.keys()]);
    let pageChanged = false, sameFilters = true;
    for (const key of keys) {
      if (/^(page|strana|stranica|pagenumber)$/i.test(key)) {
        pageChanged ||= target.searchParams.get(key) !== base.searchParams.get(key);
      } else if (base.searchParams.getAll(key).join("\0") !== target.searchParams.getAll(key).join("\0")) sameFilters = false;
    }
    if (pageChanged && sameFilters) {
      target.hash = "";
      found.add(target.toString());
    }
  }
  return [...found];
}

export function searchDue(state, now = Date.now()) {
  const last = Date.parse(state.lastDiscovery);
  return Boolean(state.searchRun) || !Number.isFinite(last) || searchSlot(now) > searchSlot(last);
}

export async function recoverScanJobs(projectId, { get = dbGet, patch = dbPatch } = {}) {
  const jobs = await get(`agent_jobs?source=eq.scan&project_id=eq.${projectId}&status=eq.running&select=id`);
  for (const job of jobs) {
    await patch(`agent_jobs?id=eq.${job.id}&source=eq.scan&status=eq.running`, {
      status: "failed", finished_at: new Date().toISOString(),
      error: "Фоновая проверка прервана перезапуском; объект остаётся в очереди для проверки через 24 часа",
    });
  }
}

export async function searchSweep(topic, projectId, store, {
  repo = ensureRepo, searches = readSearches, listings = readListings, fetch = fetchPage,
  record = recordScan, now = Date.now, stopped = () => false, wake = () => {},
  request = operation => operation(),
  status = async () => {},
} = {}) {
  const state = await store.read();
  if (!searchDue(state, now()) || stopped()) return false;
  if (!state.searchRun || !state.lastDiscovery || searchSlot(now()) > searchSlot(Date.parse(state.lastDiscovery))) {
    const dir = await repo(topic.repo, `scan:${topic.project}:search`);
    const entries = await searches(dir);
    await store.update(current => {
      current.lastDiscovery = new Date(now()).toISOString();
      // Start fresh first pages at every slot without losing unfinished pagination.
      const freshUrls = new Set(entries.map(entry => entry.url));
      const continuation = (current.searchRun?.remaining || []).filter(entry => !freshUrls.has(entry.url));
      current.searchRun = { remaining: [...entries, ...continuation], visited: [] };
    });
  }
  const rows = await listings(projectId);
  const known = knownUrls(rows);
  while (!stopped()) {
    const current = await store.read();
    if (current.lastDiscovery && searchSlot(now()) > searchSlot(Date.parse(current.lastDiscovery))) return true;
    const entry = current.searchRun?.remaining[0];
    if (entry && blockedScanUrl(entry.url)) {
      await store.update(value => { value.searchRun.remaining.shift(); });
      continue;
    }
    if (!entry) {
      await store.update(value => { value.searchRun = null; });
      return true;
    }
    let page, error;
    await request(async () => {
      await record(projectId, { source_url: entry.url, action: "search_page", result: "started" });
      try { page = await fetch(entry.url); } catch (caught) { error = caught; }
    });
    const found = page?.status === 200 ? extractListingUrls(page.html, entry.url) : [];
    const pages = page?.status === 200 ? paginationUrls(page.html, entry.url) : [];
    const queuedCount = await store.update(value => {
      const before = value.queue.length;
      enqueueTasks(value, found.filter(url => !known.has(url)).map(url => ({
        kind: "new", url, maxPriceEur: entry.maxPriceEur, scenario: entry.scenario,
      })));
      const run = value.searchRun;
      run.remaining.shift();
      run.visited.push(entry.url);
      const seen = new Set([...run.visited, ...run.remaining.map(item => item.url)]);
      for (const url of pages) if (!seen.has(url)) { run.remaining.push({ ...entry, url }); seen.add(url); }
      run.remaining.sort((a, b) => scenarioPriority(a) - scenarioPriority(b));
      return value.queue.length - before;
    });
    wake();
    await status(projectId, store);
    await record(projectId, { source_url: entry.url, action: "search_page",
      result: error ? "fetch_error" : page.status !== 200 ? "http_error" : found.length ? "scanned" : "no_listing_links",
      http_status: page?.status, error: error?.message, details: { foundCount: found.length, queuedCount } });
  }
  return true;
}

export async function checkTask(task, topic, projectId, {
  get = dbGet, check = recheck, analyze = runListing, now = Date.now,
} = {}) {
  if (task.kind === "existing") {
    const row = (await get(`listings?id=eq.${task.listingId}&select=*`))[0];
    if (!row || row.status === "test" || now() - checkedTime(row.details) < dayMs) return [];
    if (catalogPriority(row) === null) return [];
    if (!priceRejected(row)) return check([{ ...row, source_url: row.source_url || task.url }], 24, projectId);
    // Reassess price-only exclusions against the current budget and all other criteria.
    task = { ...task, scenario: row.details?.category };

  }
  // Do not pre-fetch a new listing: its dedicated agent opens it once and does the complete analysis.
  const key = `scan:${topic.project}:check`;
  const message = { inGroup: false, chatId: 0, userId: key, text: task.url, filePaths: [] };
  const outcome = await analyze(message, key, { ...topic, scan: {
    checkedAt: task.checkedAt, maxPriceEur: scanBudgetEur, scenario: task.scenario,
  } }, task.url);
  if (outcome && typeof outcome === "object") return {
    notifications: outcome.notification ? [outcome.notification] : [],
    scanResult: outcome.scanResult, details: { reason: outcome.reason },
  };
  return outcome ? [outcome] : [];
}

export async function sendScanNotifications(store, { get = dbGet, send = sendMessage } = {}) {
  const state = await store.read();
  if (!state.notifications.length) return;
  const chat = (await get("conversations?kind=eq.topic&telegram_topic_id=eq.28&select=telegram_chat_id,telegram_topic_id&limit=1"))[0];
  if (!chat) return;
  for (const notification of state.notifications) {
    // Older releases persisted text notifications; suppress queued house cards too.
    const number = String(notification).match(/Объект №(\d+)/)?.[1];
    const card = number ? (await get(`listings?catalog_number=eq.${number}&select=details&limit=1`))[0] : null;
    if (card?.details?.category === "houses") {
      await store.update(current => { current.notifications.shift(); });
      continue;
    }
    await send(chat.telegram_chat_id, notification, chat.telegram_topic_id);
    await store.update(current => { current.notifications.shift(); });
  }
}

export async function checkNext(topic, projectId, store, {
  process = checkTask, record = recordScan, now = Date.now,
  request = operation => operation(),
  status = async () => {},
} = {}) {
  // Do not reserve a minute or mark an object checked when no task is ready.
  if (!claimTask(await store.read(), now())) return false;
  return request(async () => {
    const task = await store.update(state => claimTask(state, now()));
    if (!task) return false;
    let notifications = [], error, outcome;
    await record(projectId, { source_url: task.url, listing_id: task.listingId,
      action: task.kind === "new" ? "analyze" : "recheck", result: "started" });
    await status(projectId, store);
    try {
      outcome = await process(task, topic, projectId);
      notifications = Array.isArray(outcome) ? outcome : outcome?.notifications || [];
    } catch (caught) { error = caught; }
    await store.update(state => {
      if (task.kind !== "existing" && ['excluded', 'reference'].includes(outcome?.scanResult) && !priceRejected({ status: 'excluded', fit: outcome?.details?.reason })) {
        dismissTask(state, task, outcome.scanResult, outcome?.details?.reason);
      }
      if (informationPage(task.url) || outcome?.scanResult === "not_listing") state.inspectedPages[task.url] = task.checkedAt;
      finishTask(state, task, { retry: Boolean(error) && !informationPage(task.url), notifications });
      if (outcome?.scanResult === 'over_budget') enqueueTasks(state, [{ ...task, kind: 'price', priority: 3, availableAt: Date.parse(task.checkedAt) + dayMs }]);
    });
    await status(projectId, store);
    if (error) {
      console.error("scan check", error.message);
      await record(projectId, { source_url: task.url, listing_id: task.listingId,
        action: task.kind === "new" ? "analyze" : "recheck", result: "failed", error: error.message });
    } else {
      await record(projectId, { source_url: task.url, listing_id: task.listingId,
        action: task.kind === "new" ? "analyze" : "recheck", result: outcome?.scanResult || (task.kind === "new" ? "processed" : "finished"), details: outcome?.details });
    }
    return true;
  });
}

export function startScan({
  get = dbGet, patch = dbPatch, loadTopic = async () => {
    const topics = JSON.parse(await readFile(new URL("../config/topics.json", import.meta.url), "utf8"));
    return Object.values(topics.topics || {}).find(item => item?.project === "belgrade-apartments");
  },
  store = createScanStore(statePath), listings = readListings, search = searchSweep,
  next = checkNext, notify = sendScanNotifications, now = Date.now,
  idleMs = 60_000,
  request,
  publish = publishQueueStatus,
} = {}) {
  let stopping = false;
  const shutdown = new AbortController();
  request ??= createScanRequestGate(store, { now, signal: shutdown.signal });
  let generation = 0;
  const waiters = new Set();
  const wake = () => { generation++; for (const resolve of [...waiters]) resolve(); };
  const wait = observed => new Promise(resolve => {
    const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
    const timer = setTimeout(done, idleMs);
    waiters.add(done);
    if (stopping || observed !== generation) done();
  });
  let topic, projectId;
  const ready = (async () => {
    while (!stopping) {
      const observed = generation;
      try {
        topic = await loadTopic();
        if (!topic) return;
        projectId = (await get(`projects?slug=eq.${topic.project}&select=id&limit=1`))[0]?.id;
        if (!projectId) throw new Error("Проект фонового обхода не найден");
        await store.read();
        // Recover past non-listing verdicts so existing investor pages are never reopened.
        const latestVerdicts = new Map();
        for (let offset = 0; ; offset += 1000) {
          const pages = await get(`agent_jobs?source=eq.scan&project_id=eq.${projectId}&select=payload,finished_at,result&order=finished_at.asc.nullsfirst,id.asc&limit=1000&offset=${offset}`);
          for (const page of pages) {
            const url = canonicalUrl(page.payload?.url);
            if (url && page.result?.scanResult) latestVerdicts.set(url, page);
          }
          if (pages.length < 1000) break;
        }
        await store.update(state => {
          for (const [url, page] of latestVerdicts) {
            const verdict = page.result.scanResult;
            const priceOnly = verdict === 'over_budget' || priceRejected({ status: 'excluded', fit: page.result.reason });
            if (informationPage(url) || verdict === 'not_listing') state.inspectedPages[url] = page.finished_at || new Date(now()).toISOString();
            if (['excluded', 'reference'].includes(verdict) && !priceOnly) state.dismissedUrls[url] = {result:verdict,reason:page.result.reason,checkedAt:page.finished_at || new Date(now()).toISOString()};
            else delete state.dismissedUrls[url];
            if (priceOnly) { delete state.dismissedUrls[url]; enqueueTasks(state, [{ kind: 'price', priority: 3, url, availableAt: (Date.parse(page.finished_at) || 0) + dayMs }]); }
            else state.queue = state.queue.filter(task => task.url !== url || task.kind !== 'price');
          }
          state.queue = state.queue.filter(task => !state.inspectedPages[task.url] && !state.dismissedUrls[task.url]);
        });
        await recoverScanJobs(projectId, { get, patch });
        await publish(projectId, store, { now });
        return;
      } catch (error) {
        if (!stopping) console.error("scan startup", error.message);
      }
      await wait(observed);
    }
  })();
  const checker = (async () => {
    await ready;
    if (!projectId) return;
    let lastRefresh = -Infinity;
    while (!stopping) {
      const observed = generation;
      try {
        if (now() - lastRefresh >= idleMs) {
          const rows = await listings(projectId);
          await store.update(state => {
            const tasks = catalogTasks(rows);
            for (const row of rows) {
              for (const url of [row.source_url, ...(row.source_urls || [])].map(canonicalUrl).filter(Boolean)) {
                if (catalogPriority(row) === null) state.dismissedUrls[url] = { result: row.status, reason: row.fit, checkedAt: new Date(now()).toISOString() };
                else delete state.dismissedUrls[url];
              }
            }
            const known = new Set(rows.flatMap(row => [row.source_url, ...(row.source_urls || [])]).map(canonicalUrl).filter(Boolean));
            state.queue = state.queue.filter(task => !state.dismissedUrls[task.url] && !(task.kind === 'price' && known.has(task.url)));
            const byId = new Map(tasks.map(task => [task.listingId, task]));
            state.queue = state.queue.filter(task => task.kind !== 'existing' || byId.has(task.listingId))
              .map(task => task.kind === 'existing' ? { ...task, ...byId.get(task.listingId) } : task);
            enqueueTasks(state, tasks);
          });
          await publish(projectId, store, { now });
          lastRefresh = now();
        }
        try { await notify(store); } catch (error) { console.error("scan notify", error.message); }
        if (stopping) break;
        if (await next(topic, projectId, store, { now, request, status: publish })) continue;
      } catch (error) { if (!stopping) console.error("scan checker", error.message); }
      await wait(observed);
    }
  })();
  const searcher = (async () => {
    await ready;
    if (!projectId) return;
    while (!stopping) {
      const observed = generation;
      try { await search(topic, projectId, store, { stopped: () => stopping, wake, now, request, status: publish }); }
      catch (error) { if (!stopping) console.error("scan searcher", error.message); }
      if (!stopping) await wait(observed);
    }
  })();
  // Attach handlers immediately; readiness errors must not become unhandled rejections.
  const running = Promise.allSettled([checker, searcher]);
  void ready.catch(error => console.error("scan startup", error.message));
  return {
    ready,
    stop() { stopping = true; shutdown.abort(); wake(); return running; },
  };
}
