import assert from "node:assert/strict";
import { test } from "node:test";
import { extractListingUrls, extractPrice, recheck } from "../src/scan.js";

test("discovers real listing paths with either quote style and ignores catalog links", () => {
  const path = "/prodaja-stanova/juzni-bulevar-vracar-beograd/dvosoban-stan/6ab254bddb227fdad102a351";
  assert.deepEqual(extractListingUrls(`<a href='${path}?utm_source=test'>one</a><a href="${path}">two</a><a href='/prodaja-stanova/beograd'>catalog</a>`, "https://www.4zida.rs"), [`https://4zida.rs${path}`]);
});

test("reads an Offer nested inside listing JSON-LD with script attributes", () => {
  const html = `<script id="listing" type='application/ld+json'>{"@type":"RealEstateListing","offers":{"@type":"Offer","price":175000,"priceCurrency":"EUR"}}</script>`;
  assert.equal(extractPrice(html), 175000);
});

test("first automatic price check compares against the catalog and returns the updated card", async () => {
  const updates = [], events = [];
  const row = { id: "listing", catalog_number: 182, address: "Белград, улица 1", status: "fit", asking_price_eur: 180000, source_url: "https://example.com/listing", details: {} };
  const changes = await recheck([row], 24, "project", {
    fetch: async () => ({ status: 200, html: '<script type="application/ld+json">{"@type":"Offer","price":175000}</script>' }),
    patch: async (path, update) => updates.push(update),
    record: async (project, event) => events.push(event),
  });
  assert.equal(updates[0].asking_price_eur, 175000);
  assert.deepEqual(updates[0].details.priceHistory.map(item => item.price), [180000, 175000]);
  assert.equal(events[0].result, "price_changed");
  assert.match(changes[0], /180\s*000 € → 175\s*000 €/);
  assert.match(changes[0], /Объект №182/);
  assert.match(changes[0], /Адрес: Белград, улица 1/);
  assert.match(changes[0], /Статус: Подходит/);
  assert.match(changes[0], /https:\/\/example.com\/listing/);
});

test("daily check stores photo links from the already fetched listing page", async () => {
  let update;
  await recheck([{ id: "listing", status: "fit", source_url: "https://4zida.rs/prodaja-stanova/beograd/stan/1234567890abcdef", asking_price_eur: 180000, details: {} }], 24, "project", {
    fetch: async () => ({ status: 200, html: '<meta property="og:image" content="https://resizer2.4zida.rs/listing.jpg"><script type="application/ld+json">{"@type":"Offer","price":180000}</script>' }),
    patch: async (path, value) => { update = value; }, record: async () => {},
  });
  assert.deepEqual(update.details.photoUrls, ["https://resizer2.4zida.rs/listing.jpg"]);
});

test("an unchanged first price check is quiet and recent checks are not repeated", async () => {
  const row = { id: "listing", source_url: "https://example.com/listing", asking_price_eur: 175000, details: {} };
  let updated;
  let fetches = 0;
  const dependencies = {
    fetch: async () => { fetches++; return { status: 200, html: '<script type="application/ld+json">{"@type":"Offer","price":175000}</script>' }; },
    patch: async (path, update) => { updated = update; }, record: async () => {},
  };
  assert.deepEqual(await recheck([row], 24, "project", dependencies), []);
  assert.deepEqual(await recheck([{ ...row, details: updated.details }], 24, "project", dependencies), []);
  assert.equal(fetches, 1);
});

for (const row of [{ status: "excluded" }, { status: "reference" }, { status: "new", fit: "исключён — первый этаж" }, { status: "conditional" }, { status: "new", fit: "подходит — хороший вариант" }]) {
  test(`price monitoring only notifies previously interesting objects: ${JSON.stringify(row)}`, async () => {
    let updated;
    const notifications = await recheck([{ ...row, id: "listing", catalog_number: 123, asking_price_eur: 180000, source_url: "https://example.com/listing", details: {} }], 24, "project", {
      fetch: async () => ({ status: 200, html: '<script type="application/ld+json">{"@type":"Offer","price":175000}</script>' }),
      patch: async (path, value) => { updated = value; }, record: async () => {},
    });
    assert.equal(updated.asking_price_eur, 175000);
    assert.equal(notifications.length, row.status === "conditional" || row.fit?.startsWith("подходит") ? 1 : 0);
  });
}

test("removal is sent once and only for previously suitable objects", async () => {
  for (const [status, availabilityStatus, expected] of [["fit", "active", 1], ["fit", "removed", 0], ["excluded", "active", 0]]) {
    const changes = await recheck([{ id: "listing", status, source_url: "https://example.com/listing", details: { availabilityStatus } }], 24, "project", {
      fetch: async () => ({ status: 404 }), patch: async () => {}, record: async () => {},
    });
    assert.equal(changes.length, expected);
  }
});

test("house price changes and removals update the database quietly", async () => {
  for (const status of [200, 404]) {
    const updates = [];
    const changes = await recheck([{ id: "house", status: "fit", asking_price_eur: 180000,
      source_url: "https://example.com/house", details: { category: "houses" } }], 24, "project", {
      fetch: async () => ({ status, html: '<script type="application/ld+json">{"@type":"Offer","price":175000}</script>' }),
      patch: async (path, row) => updates.push(row), record: async () => {},
    });
    assert.equal(changes.length, 0);
    assert.equal(updates.length, 1);
    if (status === 200) assert.equal(updates[0].asking_price_eur, 175000);
    else assert.equal(updates[0].details.availabilityStatus, "removed");
  }
});
