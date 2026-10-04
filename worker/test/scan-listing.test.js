import assert from "node:assert/strict";
import { test } from "node:test";
import { runListing } from "../src/queue.js";

const checkedAt = "2026-09-29T08:00:00.000Z";
const topic = { project: "belgrade-apartments", repo: "owner/repo", scan: { checkedAt, maxPriceEur: 200000, scenario: "living" } };
const url = "https://4zida.rs/listing/123";
const message = { inGroup: false, chatId: 0, userId: "scan:check", text: url };
function setup(card = { is_listing: true, status: "fit", category: "living", address: "Belgrade", asking_price_eur: 180000 }, known = [], current = {}) {
  const inserted = [], patched = [];
  let prompt;
  return {
    inserted, patched,
    get prompt() { return prompt; },
    dependencies: {
      open: async () => ({ id: "conversation", cursor_chat_id: "cursor" }),
      repo: async () => "/repo",
      agent: async (key, text) => {
        prompt = text;
        return { text: typeof card === "string" ? card : `Подходит\n<<<JSON>>>${JSON.stringify(card)}<<<END>>>`, chatId: "cursor", model: "model" };
      },
      get: async path => path.startsWith("projects?") ? [{ id: "project" }]
        : path.startsWith("listings?id=") ? [current] : known,
      insert: async (table, row) => { inserted.push({ table, row }); return [{ id: "job", ...(table === "listings" ? { catalog_number: 123 } : {}), ...row }]; },
      patch: async (path, row) => { patched.push({ path, row }); return [row]; },
    },
  };
}

test("background listing jobs use independent source and store daily check stamp", async () => {
  const mock = setup();
  const outcome = await runListing(message, "scan:check", topic, url, undefined, mock.dependencies);
  assert.match(outcome.notification, /Объект №123/);
  assert.match(outcome.notification, /https:\/\/4zida.rs\/listing\/123/);
  assert.equal(mock.inserted[0].row.source, "scan");
  assert.match(mock.prompt, /Сценарий поиска: living/);
  assert.match(mock.prompt, /не больше 200000 EUR/);
  assert.match(mock.prompt, /запросы к сайтам не чаще одного раза в 60 секунд/);
  const row = mock.inserted.find(item => item.table === "listings").row;
  assert.equal(row.details.availabilityCheckedAt, checkedAt);
  assert.equal(row.details.availabilityChecked, "2026-09-29");
  assert.deepEqual(row.details.priceHistory.map(item => item.price), [180000]);
});

test("scan price exceeding search budget records rejection without catalog insert", async () => {
  const mock = setup({ is_listing: true, status: "fit", category: "living", asking_price_eur: 250000 });
  await runListing(message, "scan:check", topic, url, undefined, mock.dependencies);
  assert.equal(mock.inserted.filter(item => item.table === "listings").length, 0);
  assert.equal(mock.patched.at(-1).row.result.scanResult, "over_budget");
  assert.equal(mock.patched.at(-1).row.status, "succeeded");
});

test("scan merges canonical source alias and preserves details and price history", async () => {
  const history = [{ date: "2026-09-20", price: 190000 }];
  const mock = setup(undefined, [{ id: "existing", source_url: "https://example.com/other", source_urls: [`https://www.4zida.rs/listing/123/?utm_source=site`] }], { catalog_number: 182, status: "fit", asking_price_eur: 190000, details: { custom: "retained", category: "rental", priceHistory: history } });
  const { notification: answer } = await runListing(message, "scan:check", topic, url, undefined, mock.dependencies);
  assert.match(answer, /Цена изменилась: 190\s*000 € → 180\s*000 €/);
  assert.match(answer, /Объект №182/);
  assert.match(answer, /Статус: Подходит/);
  assert.match(answer, /https:\/\/4zida.rs\/listing\/123/);
  assert.equal(mock.inserted.filter(item => item.table === "listings").length, 0);
  const update = mock.patched.find(item => item.path === "listings?id=eq.existing").row;
  assert.equal(update.details.custom, "retained");
  assert.equal(update.details.category, "living");
  assert.equal(update.details.availabilityCheckedAt, checkedAt);
  assert.deepEqual(update.details.priceHistory.map(item => item.price), [190000, 180000]);
  assert.equal(history.length, 1);
  assert.ok(update.source_urls.includes(url));
});

for (const answer of ["Без карточки", "<<<JSON>>>{malformed}<<<END>>>", "<<<JSON>>>null<<<END>>>", "<<<JSON>>>{}<<<END>>>", "<<<JSON>>>[]<<<END>>>"]) {
  test(`invalid scan response throws without saving an error or bogus listing: ${answer}`, async () => {
    const mock = setup(answer);
    await assert.rejects(runListing(message, "scan:check", topic, url, undefined, mock.dependencies), { code: "SCAN_NO_CARD" });
    assert.equal(mock.inserted.filter(item => item.table === "listings").length, 0);
    assert.equal(mock.patched.at(-1).row.status, "failed");
  });
}

test("manual listing analysis retains Telegram source and does not add scan stamp", async () => {
  const mock = setup();
  await runListing(message, "user:1", { ...topic, scan: undefined }, url, undefined, mock.dependencies);
  assert.equal(mock.inserted[0].row.source, "telegram");
  assert.equal(mock.inserted.find(item => item.table === "listings").row.details.availabilityCheckedAt, undefined);
});

test("scan agent timeout marks background job failed without creating an error listing", async () => {
  const mock = setup();
  mock.dependencies.agent = async () => { const error = new Error("timed out"); error.code = "AGENT_TIMEOUT"; throw error; };
  await assert.rejects(runListing(message, "scan:check", topic, url, undefined, mock.dependencies), { code: "AGENT_TIMEOUT" });
  assert.equal(mock.inserted.filter(item => item.table === "listings").length, 0);
  assert.equal(mock.patched.at(-1).row.status, "failed");
});

for (const [status, address] of [["excluded", "Belgrade"], ["reference", "Belgrade"], ["fit", "Karaburma"]]) {
  test(`initial automatic rejection stays out of catalog and chat: ${status} ${address}`, async () => {
    const mock = setup({ is_listing: true, status, address, fit: "Не подходит", asking_price_eur: 180000 });
    const outcome = await runListing(message, "scan:check", topic, url, undefined, mock.dependencies);
    assert.equal(outcome.notification, null);
    assert.equal(outcome.scanResult, status === "fit" ? "excluded" : status);
    assert.equal(mock.inserted.filter(item => item.table === "listings").length, 0);
    assert.ok(outcome.reason);
  });
}

test("missing verdict cannot silently become a new card", async () => {
  const mock = setup({ is_listing: true, asking_price_eur: 180000 });
  await assert.rejects(runListing(message, "scan:check", topic, url, undefined, mock.dependencies), { code: "SCAN_NO_VERDICT" });
  assert.equal(mock.inserted.filter(item => item.table === "listings").length, 0);
});

test("new conditional object sends the saved numbered card", async () => {
  const mock = setup({ is_listing: true, status: "conditional", address: "Belgrade", asking_price_eur: 180000 });
  const outcome = await runListing(message, "scan:check", topic, url, undefined, mock.dependencies);
  assert.match(outcome.notification, /Объект №123/);
  assert.equal(mock.inserted.find(item => item.table === "listings").row.status, "conditional");
});

test("new listing saves image URLs supplied from the already opened source page", async () => {
  const mock = setup({ is_listing: true, status: "fit", category: "living", address: "Belgrade", asking_price_eur: 180000,
    photo_urls: ["https://resizer2.4zida.rs/first.webp#large", "https://resizer2.4zida.rs/second.webp"] });
  await runListing(message, "scan:check", topic, url, undefined, mock.dependencies);
  assert.deepEqual(mock.inserted.find(item => item.table === "listings").row.details.photoUrls,
    ["https://resizer2.4zida.rs/first.webp", "https://resizer2.4zida.rs/second.webp"]);
});

for (const oldStatus of ["fit", "conditional", "excluded", "reference"]) {
  test(`rediscovered price change respects prior status ${oldStatus}`, async () => {
    const mock = setup({ is_listing: true, status: "fit", asking_price_eur: 250000 }, [{ id: "existing", source_url: url }], { catalog_number: 182, status: oldStatus, asking_price_eur: 190000 });
    const outcome = await runListing(message, "scan:check", topic, url, undefined, mock.dependencies);
    assert.equal(mock.inserted.filter(item => item.table === "listings").length, 0);
    const update = mock.patched.find(item => item.path === "listings?id=eq.existing").row;
    assert.equal(update.asking_price_eur, 250000);
    if (["fit", "conditional"].includes(oldStatus)) {
      assert.equal(update.status, "excluded");
      assert.match(outcome.notification, /190\s*000 € → 250\s*000 €/);
      assert.match(outcome.notification, /Объект №182/);
    } else {
      assert.equal(update.status, oldStatus);
      assert.equal(outcome.notification, null);
    }
  });
}

test("unchanged suitable object is updated quietly", async () => {
  const mock = setup(undefined, [{ id: "existing", source_url: url }], { status: "fit", asking_price_eur: 180000, address: "Belgrade" });
  const outcome = await runListing(message, "scan:check", topic, url, undefined, mock.dependencies);
  assert.equal(outcome.scanResult, "unchanged");
  assert.equal(outcome.notification, null);
});

for (const status of ["fit", "conditional", "reference", "excluded"]) {
  test(`houses are saved quietly for price research with status ${status}`, async () => {
    const mock = setup({ is_listing: true, status, category: "houses", address: "Karaburma", asking_price_eur: 180000 });
    const outcome = await runListing(message, "scan:check", topic, url, undefined, mock.dependencies);
    assert.equal(outcome.notification, null);
    assert.equal(mock.inserted.filter(item => item.table === "listings").length, 1);
    assert.equal(mock.inserted.find(item => item.table === "listings").row.details.category, "houses");
  });
}

test("known house price changes are persisted without notifications", async () => {
  const mock = setup({ is_listing: true, status: "fit", category: "houses", asking_price_eur: 170000 },
    [{ id: "existing", source_url: url }], { status: "fit", asking_price_eur: 180000, details: { category: "houses" } });
  const outcome = await runListing(message, "scan:check", topic, url, undefined, mock.dependencies);
  assert.equal(outcome.notification, null);
  assert.equal(mock.patched.find(x => x.path === "listings?id=eq.existing").row.asking_price_eur, 170000);
});
