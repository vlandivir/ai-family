import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { dbGet, dbInsert, dbPatch } from "./db.js";
import { getChatId } from "./agent/sessions.js";
import { retryableJobError } from "./agent/jobs.js";
import { runAgent } from "./agent/run.js";
import { cardText } from "./catalog-lookup.js";
import { assessmentStatuses, interestingListing } from "./listing-policy.js";
import { photoUrlsFromCard } from "./listing-photos.js";
import { splitVoiceAnswer } from "./voice.js";

const git = promisify(execFile);
const repoRoot = process.env.PROJECT_REPOS_DIR || "/var/lib/ai-family/repos";

export function listingUrl(text) {
  return text.match(/https?:\/\/[^\s)]+/)?.[0] || null;
}

function safeError(error) {
  return String(error.message || error)
    .replace(/github_pat_\S+/g, "[скрыто]")
    .replace(/Bearer\s+\S+/g, "Bearer [скрыто]")
    .slice(0, 500);
}

export async function ensureRepo(repo, sessionKey) {
  const name = repo.split("/")[1];
  const dir = sessionKey
    ? join(repoRoot, "contexts", name, createHash("sha256").update(sessionKey).digest("hex").slice(0, 16))
    : join(repoRoot, name);
  const askpass = join(dirname(fileURLToPath(import.meta.url)), "../scripts/git-askpass.sh");
  await chmod(askpass, 0o700);
  const env = {
    ...process.env,
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: "0",
  };
  const runGit = (args) => git("git", args, { env });
  try {
    await runGit(["-C", dir, "rev-parse", "--is-inside-work-tree"]);
  } catch {
    await mkdir(dirname(dir), { recursive: true });
    await runGit(["clone", `https://github.com/${repo}.git`, dir]);
    return dir;
  }
  try {
    await runGit(["-C", dir, "pull", "--ff-only"]);
  } catch (error) {
    console.error("repo pull", error.message);
  }
  return dir;
}

function cardFromAnswer(answer) {
  const match = answer.match(/<<<JSON>>>([\s\S]*?)<<<END>>>/);
  if (!match) return { prose: answer, card: null };
  let card = null;
  try {
    card = JSON.parse(match[1]);
  } catch {
    card = null;
  }
  return { prose: answer.replace(match[0], "").trim(), card };
}

function cardsFromAnswer(answer) {
  const cards = [];
  let prose = answer;
  const re = /<<<JSON>>>([\s\S]*?)<<<END>>>/g;
  let match;
  while ((match = re.exec(answer))) {
    try {
      cards.push(JSON.parse(match[1]));
    } catch {
      // skip invalid JSON blocks
    }
    prose = prose.replace(match[0], "");
  }
  return { prose: prose.trim(), cards };
}

function shouldUpsertListing(card) {
  if (!card || typeof card !== "object") return false;
  if (card.is_listing === false) return false;
  if (card.is_listing === true) return true;
  return Boolean(categoryOf(card));
}

function listingUrlFromCard(card) {
  if (card?.source_url) return String(card.source_url);
  if (Array.isArray(card?.source_urls) && card.source_urls[0]) return String(card.source_urls[0]);
  return null;
}

async function upsertListingFromCard(project, url, card, prose) {
  const known = await dbGet(`listings?project_id=eq.${project.id}&select=id,source_url,source_urls`);
  const match = known.find((item) => item.id === card?.match_id);
  const row = listingRow(project.id, url, card, prose);
  const banned = districtExclusion(row.address, row.neighborhood);
  if (Array.isArray(card?.source_urls) && card.source_urls.length) {
    row.source_urls = [...new Set([...card.source_urls, url].filter(Boolean))];
  }
  if (match) {
    row.source_urls = mergeUrls(
      { ...match, source_urls: row.source_urls || match.source_urls },
      url,
    );
    delete row.project_id;
    if (!banned) delete row.status;
    if (row.details) {
      const current = await dbGet(`listings?id=eq.${match.id}&select=details`);
      row.details = { ...(current[0]?.details || {}), ...row.details };
    }
    await dbPatch(`listings?id=eq.${match.id}`, row);
  } else {
    if (!row.source_urls) row.source_urls = [url];
    return cardText({ ...row, ...(await dbInsert("listings", row))[0] });
  }
  return null;
}

export async function openConversation(message, sessionKey) {
  if (message.inGroup) {
    const topicId = message.threadId ?? 1;
    const found = await dbGet(
      `conversations?kind=eq.topic&telegram_chat_id=eq.${message.chatId}&telegram_topic_id=eq.${topicId}&select=*&limit=1`,
    );
    if (found[0]) return found[0];
    const created = await dbInsert("conversations", {
      kind: "topic",
      telegram_chat_id: message.chatId,
      telegram_topic_id: topicId,
      opened_by: message.userId,
      cursor_chat_id: await getChatId(sessionKey),
    });
    return created[0];
  }

  const found = await dbGet(
    `conversations?kind=eq.private&opened_by=eq.${message.userId}&closed_at=is.null&select=*&limit=1`,
  );
  if (found[0]) return found[0];
  const created = await dbInsert("conversations", {
    kind: "private",
    telegram_chat_id: message.chatId,
    opened_by: message.userId,
    cursor_chat_id: await getChatId(sessionKey),
  });
  return created[0];
}

export async function runQueued(message, sessionKey, prompt, cwd, topic = {}, queuedJob, { ownerMcp = null } = {}) {
  const conversation = await openConversation(message, sessionKey);
  const inserted = queuedJob ? [queuedJob] : await dbInsert("agent_jobs", {
    conversation_id: conversation.id,
    source: "telegram",
    external_user_id: message.userId,
    kind: "chat",
    payload: { text: message.text },
    status: "running",
    started_at: new Date().toISOString(),
    attempts: 1,
  });
  const job = inserted[0];
  try {
    const { text, chatId, model } = await runAgent(sessionKey, prompt, conversation.cursor_chat_id, cwd, { ownerMcp });
    if (chatId && chatId !== conversation.cursor_chat_id) {
      await dbPatch(`conversations?id=eq.${conversation.id}`, { cursor_chat_id: chatId });
    }
    const { prose, cards } = cardsFromAnswer(text);
    const spoken = splitVoiceAnswer(prose);
    const savedCards = [];
    const listingCards = cards.filter(shouldUpsertListing);
    if (listingCards.length && topic.project) {
      const project = (await dbGet(`projects?slug=eq.${topic.project}&select=id&limit=1`))[0];
      if (project) {
        for (const card of listingCards) {
          const url = listingUrlFromCard(card) || listingUrl(message.text) || card.address || "manual";
          const savedCard = await upsertListingFromCard(project, url, card, prose);
          if (savedCard) savedCards.push(savedCard);
        }
      }
    }
    const visible = spoken.transcript ? [spoken.transcript, spoken.answer].filter(Boolean).join("\n\n") : prose;
    await dbPatch(`agent_jobs?id=eq.${job.id}`, {
      status: "succeeded",
      finished_at: new Date().toISOString(),
      model,
      result: { text: visible },
    });
    return [...savedCards, prose].filter(Boolean).join("\n\n");
  } catch (error) {
    if (retryableJobError(job, error)) throw error;
    await dbPatch(`agent_jobs?id=eq.${job.id}`, {
      status: "failed",
      finished_at: new Date().toISOString(),
      model: error.model || null,
      error: safeError(error),
    });
    throw error;
  }
}

export async function runListing(message, sessionKey, topic, url, queuedJob, {
  get = dbGet, insert = dbInsert, patch = dbPatch, repo = ensureRepo,
  open = openConversation, agent = runAgent, ownerMcp = null,
} = {}) {
  const scan = topic.scan;
  const conversation = await open(message, sessionKey);
  const project = (await get(`projects?slug=eq.${topic.project}&select=id&limit=1`))[0];
  const dir = await repo(topic.repo, sessionKey);
  const prompt = [
    topic.rule,
    `Ссылка: ${url}`,
    scan ? "Фоновый обход: до 500 новых разборов в сутки. Приоритет: rental, living, newbuild, houses. Nekretnine.rs и Halo Oglasi автоматически не обходятся, только ручные ссылки. Эти указания покупателя важнее прежних правил файла." : "",
    scan?.scenario ? `Сценарий поиска: ${scan.scenario}. Оцени объект по этому сценарию.` : "",
    scan?.maxPriceEur ? `Бюджет поиска: не больше ${scan.maxPriceEur} EUR. Укажи достоверную цену в asking_price_eur.` : "",
    scan ? "Во время фонового разбора делай запросы к сайтам не чаще одного раза в 60 секунд. Объявление открывай один раз, повторные запросы к нему в этом разборе не делай." : "",
    scan ? "Это первичный автоматический отбор. Обязательно поставь status: fit (подходит), conditional (интересный с оговоркой), excluded (исключён) или reference (только ориентир). При нарушении жёстких критериев выбирай excluded. Новые excluded/reference квартир не сохраняются в каталог и не отправляются в чат. Дома сохраняются при любом статусе для сравнения цен по районам и динамики, без сообщений в чат. Не называй исключённый объект интересным." : "",
    scan ? "Дома никогда не отправляй в чат. В чат сообщаем только о новых fit/conditional и о существенных изменениях ранее подходящих объектов. Старые исключённые и ориентиры не возвращай в активную подборку. Неизменившиеся объекты, отказы, превышение бюджета и ошибки оставляй в журнале." : "",
    "Прочитай APARTMENT_SELECTION_INSTRUCTIONS.md в текущей папке и открой ссылку.",
    "Сначала реши, это страница одного объявления о квартире или доме.",
    "Витрина, каталог, поиск, статья и наша собственная страница — не объявление.",
    "Если это страница инвестора или застройщика, изучи информацию при первом открытии; повторять просмотр не нужно. Если это не объявление, ответь по смыслу и закончи блоком {\"is_listing\":false}. Карточку не заполняй.",
    "Если это объявление, ответь коротко, насколько квартира подходит.",
    "Поставь category ровно одним из значений: rental, living, houses, newbuild.",
    "Если страница содержит фотографии объекта, скопируй до восьми настоящих HTTPS-адресов изображений из страницы в photo_urls. Не придумывай адреса и не добавляй логотипы площадки. Отсутствуют — оставь пустой массив.",
    "rental — квартира под сдачу. living — квартира для жизни семьи. houses — дом. newbuild — новостройка или проект со сдачей в будущем.",
    "Один и тот же объект объединяй, даже если ссылка отличается параметрами.",
    "Сверяй адрес, дом, площадь и площадку, не полную строку URL.",
    "Уже известные карточки:",
    await knownListings(project.id, get),
    "Если это уже известный объект, поставь его id в match_id. Иначе match_id оставь null.",
    scan
      ? "Borča, Mirijevo, Karaburma и блоки 71–72 исключены: укажи район в neighborhood и status excluded. Новый объект оттуда не должен попасть в каталог или чат."
      : "Borča, Mirijevo, Karaburma и блоки 71–72 исключены. При разборе ручной ссылки объясни причину и заполни карточку для сохранения решения покупателя.",
    message.filePaths?.length ? `К сообщению приложены файлы. Прочитай их вместе со страницей:\n${message.filePaths.map((path) => `- ${path}`).join("\n")}` : "",
    message.location ? `К сообщению приложена геометка: ${message.location.latitude}, ${message.location.longitude}. Учти её при проверке адреса.` : "",
    message.unavailableFiles?.length ? `Эти вложения Telegram не дал скачать из-за лимита 20 МБ: ${message.unavailableFiles.join(", ")}. Не утверждай, что просмотрел их.` : "",
    "В конце добавь блок ровно в таком виде:",
    "<<<JSON>>>",
    '{"is_listing":true,"status":"fit","category":"rental","match_id":null,"address":"","neighborhood":"","asking_price_eur":null,"area_m2":null,"rooms":null,"floor":null,"year_built":null,"heating":"","fit":"","notes":"","photo_urls":[]}',
    "<<<END>>>",
  ].join("\n");
  const inserted = queuedJob ? [queuedJob] : await insert("agent_jobs", {
    conversation_id: conversation.id,
    project_id: project?.id,
    source: scan ? "scan" : "telegram",
    external_user_id: message.userId,
    kind: "analyze_listing",
    payload: { text: message.text, url },
    status: "running",
    started_at: new Date().toISOString(),
    attempts: 1,
  });
  const job = inserted[0];
  try {
    const { text, chatId, model } = await agent(sessionKey, prompt, conversation.cursor_chat_id, dir, { ownerMcp });
    if (chatId && chatId !== conversation.cursor_chat_id) {
      await patch(`conversations?id=eq.${conversation.id}`, { cursor_chat_id: chatId });
    }
    const { prose, card } = cardFromAnswer(text);
    if (card?.is_listing === false) {
      await patch(`agent_jobs?id=eq.${job.id}`, {
        status: "succeeded",
        finished_at: new Date().toISOString(),
        model,
        result: { text: prose, ...(scan ? { scanResult: "not_listing" } : {}) },
      });
      return scan ? { scanResult: "not_listing", notification: null } : prose || "Это не страница объявления.";
    }
    if (scan && (!card || typeof card !== "object" || Array.isArray(card) || !shouldUpsertListing(card))) {
      const error = new Error("Агент не вернул JSON карточки объявления");
      error.code = "SCAN_NO_CARD";
      throw error;
    }
    if (scan) {
      const outcome = await saveScannedListing(project.id, url, card, prose, scan, { get, insert, patch });
      await patch(`agent_jobs?id=eq.${job.id}`, {
        status: "succeeded", finished_at: new Date().toISOString(), model,
        result: { text: prose, scanResult: outcome.scanResult, reason: outcome.reason },
      });
      return outcome;
    }
    const known = await get(`listings?project_id=eq.${project.id}&select=id,source_url,source_urls`);
    const match = known.find((item) => item.id === card?.match_id);
    const row = listingRow(project.id, url, card, prose);
    const banned = districtExclusion(row.address, row.neighborhood);
    if (banned) {
      row.status = "excluded";
      row.fit = `Исключён: ${banned}`;
      row.notes = [`Район ${banned} исключён с 21 сентября 2026. Карточка остаётся в списке.`, row.notes].filter(Boolean).join("\n");
    }
    let savedCard;
    if (match) {
      row.source_urls = mergeUrls(match, url);
      delete row.project_id;
      if (!banned) delete row.status;
      if (row.details) {
        const current = await get(`listings?id=eq.${match.id}&select=details,asking_price_eur,catalog_number,address,neighborhood,municipality,status`);
        row.details = { ...(current[0]?.details || {}), ...row.details };
      }
      await patch(`listings?id=eq.${match.id}`, row);
    } else {
      row.source_urls = [url];
      savedCard = { ...row, ...(await insert("listings", row))[0] };
    }
    await patch(`agent_jobs?id=eq.${job.id}`, {
      status: card ? "succeeded" : "failed",
      finished_at: new Date().toISOString(),
      model,
      result: { text: prose },
      error: card ? null : "no card json",
    });
    return savedCard ? [cardText(savedCard), prose].filter(Boolean).join("\n\n") : prose || "Карточка записана, но текст оценки пустой.";
  } catch (error) {
    if (!scan && retryableJobError(job, error)) throw error;
    if (!scan) await insert("listings", {
      project_id: project.id,
      status: "error",
      city: "Belgrade",
      source_url: url,
      fit: "не разобрано",
      notes: safeError(error),
    });
    await patch(`agent_jobs?id=eq.${job.id}`, {
      status: "failed",
      finished_at: new Date().toISOString(),
      model: error.model || null,
      error: safeError(error),
    });
    throw error;
  }
}

async function saveScannedListing(projectId, url, card, prose, scan, { get, insert, patch }) {
  if (!assessmentStatuses.has(card.status)) {
    const error = new Error("Автоматический разбор не вернул итоговый статус");
    error.code = "SCAN_NO_VERDICT";
    throw error;
  }
  const known = await get(`listings?project_id=eq.${projectId}&select=id,status,source_url,source_urls`);
  const canonical = comparableListingUrl(url);
  const match = known.find(item => item.id === card.match_id)
    || known.find(item => canonical && [item.source_url, ...(Array.isArray(item.source_urls) ? item.source_urls : [])]
      .some(value => comparableListingUrl(value) === canonical));
  const row = listingRow(projectId, url, card, prose);
  row.status = card.status;
  const banned = districtExclusion(row.address, row.neighborhood);
  const overBudget = row.asking_price_eur != null && row.asking_price_eur > scan.maxPriceEur;
  if (banned || overBudget) row.status = "excluded";
  const reason = banned ? `Исключённый район: ${banned}` : overBudget ? `Цена выше лимита ${scan.maxPriceEur} EUR` : card.fit || card.notes || prose;
  if (banned || overBudget) row.fit = reason;
  if (!match && row.details?.category !== "houses" && !interestingListing(row)) {
    return { scanResult: overBudget ? "over_budget" : row.status, reason, notification: null };
  }
  if (match) {
    const current = { ...match, ...(await get(`listings?id=eq.${match.id}&select=*`))[0] };
    const wasInteresting = interestingListing(current);
    if (["excluded", "reference"].includes(current.status)) {
      row.status = current.status;
      row.fit = current.fit;
    }
    row.source_urls = mergeUrls(current, url);
    delete row.project_id;
    row.details = scannedDetails({ ...(current.details || {}), ...row.details }, row.asking_price_eur, url, scan.checkedAt, current.asking_price_eur);
    const changed = ["status", "asking_price_eur", "address", "neighborhood", "area_m2", "rooms", "floor", "year_built", "heating"]
      .some(field => (current[field] ?? null) !== (row[field] ?? null));
    const saved = { ...current, ...row, ...(await patch(`listings?id=eq.${match.id}`, row))[0] };
    const previous = numberOrNull(current.asking_price_eur);
    const priceChanged = previous != null && row.asking_price_eur != null && previous !== row.asking_price_eur;
    const heading = priceChanged ? `Цена изменилась: ${previous.toLocaleString("ru-RU")} € → ${row.asking_price_eur.toLocaleString("ru-RU")} €` : "Объект изменился";
    return { scanResult: changed ? "updated" : "unchanged", reason,
      notification: saved.details?.category !== "houses" && current.details?.category !== "houses" && wasInteresting && changed ? [heading, cardText(saved), prose].filter(Boolean).join("\n\n") : null };
  }
  row.source_urls = [url];
  row.details = scannedDetails(row.details, row.asking_price_eur, url, scan.checkedAt);
  const saved = { ...row, ...(await insert("listings", row))[0] };
  return { scanResult: "processed", notification: saved.details?.category === "houses" ? null : [cardText(saved), prose].filter(Boolean).join("\n\n") };
}

async function knownListings(projectId, get = dbGet) {
  const rows = await get(
    `listings?project_id=eq.${projectId}&status=neq.error&select=id,catalog_number,address,neighborhood,area_m2,source_url,source_urls&order=created_at.desc&limit=40`,
  );
  if (!rows.length) return "нет";
  return rows
    .map((row) => {
      const urls = Array.isArray(row.source_urls) && row.source_urls.length
        ? row.source_urls
        : [row.source_url];
      return `№${row.catalog_number ?? "—"} | ${row.id} | ${row.address || ""} | ${row.neighborhood || ""} | ${row.area_m2 ?? ""} | ${urls.filter(Boolean).join(" ")}`;
    })
    .join("\n");
}

function comparableListingUrl(value) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    url.hostname = url.hostname.replace(/^www\./, "");
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function scannedDetails(details, price, url, checkedAt, previousPrice) {
  const stamp = Number.isFinite(Date.parse(checkedAt)) ? new Date(checkedAt).toISOString() : new Date().toISOString();
  const date = stamp.slice(0, 10);
  const history = Array.isArray(details.priceHistory) ? [...details.priceHistory] : [];
  const previous = numberOrNull(previousPrice);
  if (!history.length && previous != null) {
    history.push({ date, price: previous, sourceUrl: url, note: "Цена в каталоге до автоматической проверки" });
  }
  if (price != null && history.at(-1)?.price !== price) {
    history.push({ date, price, sourceUrl: url, note: "Автоматический разбор объявления" });
  }
  return {
    ...details, availabilityChecked: date, availabilityCheckedAt: stamp,
    availabilityStatus: "active", availabilityLabel: "Проверено",
    ...(history.length ? { priceHistory: history } : {}),
  };
}

function mergeUrls(match, url) {
  const urls = new Set(
    [...(Array.isArray(match.source_urls) ? match.source_urls : []), match.source_url, url].filter(Boolean),
  );
  return [...urls];
}

function listingRow(projectId, url, card, prose) {
  const banned = districtExclusion(card?.address, card?.neighborhood);
  return {
    project_id: projectId,
    status: banned ? "excluded" : assessmentStatuses.has(card?.status) ? card.status : "new",
    city: "Belgrade",
    neighborhood: card?.neighborhood || null,
    address: card?.address || null,
    source_url: url,
    asking_price_eur: numberOrNull(card?.asking_price_eur),
    area_m2: numberOrNull(card?.area_m2),
    rooms: numberOrNull(card?.rooms),
    floor: numberOrNull(card?.floor),
    year_built: numberOrNull(card?.year_built),
    heating: card?.heating || null,
    notes: banned
      ? [`Район ${banned} исключён с 21 сентября 2026. Карточка остаётся в списке.`, card?.notes || prose].filter(Boolean).join("\n")
      : (card?.notes || prose || null),
    fit: banned ? `Исключён: ${banned}` : (card?.fit || null),
    details: { ...(categoryOf(card) ? { category: categoryOf(card) } : {}),
      ...(photoUrlsFromCard(card, url).length ? { photoUrls: photoUrlsFromCard(card, url) } : {}) },
  };
}

const excludedDistricts = [
  [/bor[cč]a|борча/i, "Borča"],
  [/mirijevo|миријево/i, "Mirijevo"],
  [/karaburma|карабурма/i, "Karaburma"],
  [/blok(?:\s|-)*71\b|блок(?:\s|-)*71\b/i, "блок 71"],
  [/blok(?:\s|-)*72\b|блок(?:\s|-)*72\b/i, "блок 72"],
];

export function districtExclusion(address, neighborhood) {
  const text = `${address || ""} ${neighborhood || ""}`;
  const found = excludedDistricts.find(([pattern]) => pattern.test(text));
  return found ? found[1] : null;
}

const categories = new Set(["rental", "living", "houses", "newbuild"]);

function categoryOf(card) {
  const value = String(card?.category || "").trim();
  return categories.has(value) ? value : null;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
