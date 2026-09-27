import assert from "node:assert/strict";
import { test } from "node:test";
import { nextScanAction } from "../src/scan.js";

test("scanner continues discovery after the daily analysis limit", () => {
  const date = "2026-09-27";
  const capped = { pending: ["https://example.com/old"], analyzedOn: date, analyzed: 3 };
  assert.equal(nextScanAction({ ...capped, queue: ["https://example.com/new"] }, date), "candidate");
  assert.equal(nextScanAction({ ...capped, queue: [] }, date), "search_page");
  assert.equal(nextScanAction({ ...capped, analyzedOn: "2026-09-26" }, date), "analyze");
});
