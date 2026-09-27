import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogNumberFromMessage, lookupCatalogNumber } from "../src/catalog-lookup.js";

test("recognizes an exact card request without intercepting an ordinary task", () => {
  assert.equal(catalogNumberFromMessage("/card 182"), 182);
  assert.equal(catalogNumberFromMessage("№182"), 182);
  assert.equal(catalogNumberFromMessage("покажи карточку №182"), 182);
  assert.equal(catalogNumberFromMessage("Что думаешь о квартире №182?"), null);
  assert.equal(catalogNumberFromMessage("/card 0"), null);
});

test("looks up a card by its indexed project number and formats the answer", async () => {
  const paths = [];
  const get = async (path) => {
    paths.push(path);
    if (path.startsWith("projects?")) return [{ id: "project-id", name: "Квартира в Белграде", slug: "belgrade-apartments" }];
    return [{
      catalog_number: 182,
      address: "Белград, улица 1",
      status: "fit",
      asking_price_eur: 175000,
      source_url: "https://example.com/listing",
    }];
  };
  const text = await lookupCatalogNumber(182, "belgrade-apartments", { get });
  assert.match(paths[1], /project_id=eq.project-id&catalog_number=eq.182/);
  assert.match(text, /Объект №182/);
  assert.match(text, /Статус: Подходит/);
  assert.match(text, /175\s*000 €/);
  assert.match(text, /https:\/\/example.com\/listing/);
});
