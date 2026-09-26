import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dbGet, dbPatch } from "./db.js";
import { ensureRepo, runListing } from "./queue.js";
import { sendMessage } from "./telegram/poll.js";

const dayMs = 24 * 60 * 60 * 1000;
const statePath = process.env.SCAN_STATE_PATH || "/var/lib/ai-family/scan-state.json";

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
  if (node["@graph"]) return offerPrice(node["@graph"]);
  return null;
}

export function extractPrice(html) {
  const blocks = html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
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
  for (const match of html.matchAll(/href="([^"]+)"/gi)) {
    let absolute;
    try {
      absolute = new URL(match[1], baseUrl).toString();
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
  const checked = details?.availabilityChecked;
  if (!checked) return true;
  const then = new Date(`${checked}T00:00:00Z`);
  return Date.now() - then.getTime() >= hours * 60 * 60 * 1000;
}

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return { lastDiscovery: null, pending: [], skipped: [], analyzedOn: null, analyzed: 0 };
  }
}

async function writeState(state) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state));
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

function priceUpdate(details, price, url) {
  const history = Array.isArray(details.priceHistory) ? [...details.priceHistory] : [];
  const last = history.at(-1);
  const changed = !last || last.price !== price;
  if (changed) {
    history.push({
      date: today(),
      price,
      sourceUrl: url,
      note: last ? `Было ${last.price.toLocaleString("ru-RU")} €` : "Первая автоматическая проверка",
    });
  }
  return {
    changed,
    previous: last?.price ?? null,
    details: {
      ...details,
      priceHistory: history,
      availabilityChecked: today(),
      availabilityStatus: "active",
      availabilityLabel: changed && last ? "Цена изменилась" : "На месте",
      availabilityNote: changed && last
        ? `Страница открыта. ${last.price.toLocaleString("ru-RU")} € → ${price.toLocaleString("ru-RU")} €.`
        : "Страница открыта, цена без изменений.",
    },
  };
}

async function recheck(rows, hours) {
  const due = rows
    .filter((row) => row.source_url && row.status !== "test" && stale(row.details, hours))
    .sort((a, b) => String(a.details?.availabilityChecked || "").localeCompare(String(b.details?.availabilityChecked || "")))
    .slice(0, 1);
  const changes = [];
  for (const row of due) {
    let page;
    try {
      page = await fetchPage(row.source_url);
    } catch (error) {
      console.error("scan fetch", row.catalog_number, error.message);
      const details = {
        ...(row.details || {}),
        availabilityChecked: today(),
        availabilityLabel: "Сайт не ответил",
        availabilityNote: "Повтор через сутки.",
      };
      await dbPatch(`listings?id=eq.${row.id}`, { details });
      continue;
    }
    const details = { ...(row.details || {}) };
    if (page.status === 404 || page.status === 410) {
      details.availabilityChecked = today();
      details.availabilityStatus = "removed";
      details.availabilityLabel = "Снято";
      details.availabilityNote = `Страница ответила ${page.status}.`;
      await dbPatch(`listings?id=eq.${row.id}`, { details });
      changes.push(`№${row.catalog_number || "?"} ${row.address || "без адреса"}: снято`);
      continue;
    }
    const price = page.status === 200 ? extractPrice(page.html) : null;
    if (!price) {
      details.availabilityChecked = today();
      details.availabilityStatus = details.availabilityStatus || "active";
      details.availabilityLabel = "Проверено";
      details.availabilityNote = "Страница открылась, цену в разметке не нашёл.";
      await dbPatch(`listings?id=eq.${row.id}`, { details });
      continue;
    }
    const next = priceUpdate(details, price, row.source_url);
    const patch = { details: next.details };
    if (next.changed) patch.asking_price_eur = price;
    await dbPatch(`listings?id=eq.${row.id}`, patch);
    if (next.changed && next.previous != null) {
      changes.push(`№${row.catalog_number || "?"} ${row.address || "без адреса"}: ${next.previous.toLocaleString("ru-RU")} € → ${price.toLocaleString("ru-RU")} €`);
    }
  }
  return changes;
}

function searchEntry(entry) {
  if (typeof entry === "string") return { url: entry, maxPriceEur: 200000 };
  if (!entry?.url) return null;
  return { url: entry.url, maxPriceEur: entry.maxPriceEur || 200000 };
}

async function readSearches(dir) {
  try {
    const config = JSON.parse(await readFile(join(dir, "scan.json"), "utf8"));
    return {
      searches: (config.searches || []).map(searchEntry).filter(Boolean),
    };
  } catch {
    return { searches: [] };
  }
}

function queuedUrl(item) {
  if (typeof item === "string" && item.startsWith("{")) {
    try {
      return JSON.parse(item);
    } catch {
      return { url: item, maxPriceEur: 200000 };
    }
  }
  if (typeof item === "string") return { url: item, maxPriceEur: 200000 };
  return item;
}

async function peekOne(rows, state) {
  const known = knownUrls(rows);
  const skipped = new Set(state.skipped || []);
  const pending = [...(state.pending || [])];
  const queue = [...(state.queue || [])];
  const next = queuedUrl(queue.shift());
  if (!next?.url) return state;
  if (known.has(next.url) || skipped.has(next.url) || pending.includes(next.url)) {
    return { ...state, queue };
  }
  let price = null;
  try {
    const page = await fetchPage(next.url);
    if (page.status === 200) price = extractPrice(page.html);
  } catch (error) {
    console.error("scan peek", error.message);
  }
  if (price != null && price > next.maxPriceEur) skipped.add(next.url);
  else pending.push(next.url);
  return {
    ...state,
    queue,
    pending: pending.slice(0, 20),
    skipped: [...skipped].slice(-500),
  };
}

async function readOneSearch(dir, rows, state) {
  const { searches } = await readSearches(dir);
  if (!searches.length) return state;
  const cursor = state.searchCursor || 0;
  const entry = searches[cursor % searches.length];
  const url = entry.url;
  const maxPrice = entry.maxPriceEur;
  let page;
  try {
    page = await fetchPage(url);
  } catch (error) {
    console.error("scan search", error.message);
    return { ...state, searchCursor: cursor + 1 };
  }
  const known = knownUrls(rows);
  const skipped = new Set(state.skipped || []);
  const pending = new Set(state.pending || []);
  const queue = new Set(state.queue || []);
  if (page.status === 200) {
    for (const found of extractListingUrls(page.html, url)) {
      if (!known.has(found) && !skipped.has(found) && !pending.has(found)) {
        queue.add(JSON.stringify({ url: found, maxPriceEur: maxPrice }));
      }
    }
  }
  return {
    ...state,
    searchCursor: cursor + 1,
    queue: [...queue].slice(0, 100),
  };
}

async function analyzeOne(topic, state) {
  const limit = 3;
  if (state.analyzedOn !== today()) {
    state.analyzedOn = today();
    state.analyzed = 0;
  }
  if (!state.pending?.length || state.analyzed >= limit) return state;
  const url = state.pending[0];
  const message = {
    inGroup: false,
    chatId: 0,
    userId: "scan:belgrade",
    text: url,
    filePaths: [],
  };
  try {
    const prose = await runListing(message, "scan:belgrade", topic, url);
    state.pending.shift();
    state.analyzed += 1;
    const topicChat = (await dbGet("conversations?kind=eq.topic&telegram_topic_id=eq.28&select=telegram_chat_id,telegram_topic_id&limit=1"))[0];
    if (topicChat) await sendMessage(topicChat.telegram_chat_id, prose || `Новая карточка: ${url}`, topicChat.telegram_topic_id);
  } catch (error) {
    console.error("scan analyze", error.message);
    state.pending.shift();
    state.skipped = [...(state.skipped || []), url].slice(-500);
  }
  return state;
}

export async function scanOnce(topic) {
  const project = (await dbGet(`projects?slug=eq.${topic.project}&select=id&limit=1`))[0];
  if (!project) return;
  const rows = await dbGet(
    `listings?project_id=eq.${project.id}&status=neq.error&select=id,catalog_number,address,status,source_url,source_urls,asking_price_eur,details&order=catalog_number.asc&limit=1000`,
  );
  const dir = await ensureRepo(topic.repo, "scan:belgrade");
  const changes = await recheck(rows, 24);
  if (changes.length || rows.some((row) => row.source_url && row.status !== "test" && stale(row.details, 24))) {
    if (changes.length) {
      const topicChat = (await dbGet("conversations?kind=eq.topic&telegram_topic_id=eq.28&select=telegram_chat_id,telegram_topic_id&limit=1"))[0];
      if (topicChat) await sendMessage(topicChat.telegram_chat_id, ["Проверка цен", ...changes].join("\n"), topicChat.telegram_topic_id);
    }
    return;
  }
  let state = await readState();
  if (state.pending?.length) {
    state = await analyzeOne(topic, state);
  } else if (state.queue?.length) {
    state = await peekOne(rows, state);
  } else {
    state = await readOneSearch(dir, rows, state);
  }
  await writeState(state);
}

export function startScan({ busy }) {
  let running = false;
  const tick = async () => {
    if (running || busy()) return;
    running = true;
    try {
      const topics = JSON.parse(await readFile(new URL("../config/topics.json", import.meta.url), "utf8"));
      const topic = Object.values(topics.topics || {}).find((item) => item?.project === "belgrade-apartments");
      if (topic) await scanOnce(topic);
    } catch (error) {
      console.error("scan", error.message);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 20_000);
  const timer = setInterval(tick, Number(process.env.SCAN_EVERY_MS || 15 * 60 * 1000));
  timer.unref?.();
}
