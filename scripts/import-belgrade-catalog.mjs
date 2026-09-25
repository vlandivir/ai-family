import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const catalogDir = process.argv[2] || "/Users/vladryba/dev/codex-notes-ai-2026/20260909-serbia-real-estate";
const dataPath = join(catalogDir, "assets/listings-data.js");
const photosDir = join(catalogDir, "assets/listings");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is empty`);
  return value;
}

function loadListings() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(`${readFileSync(dataPath, "utf8")}\nthis.listings = listings;`, context);
  return context.listings;
}

function yearOf(value) {
  const year = Number(value);
  return Number.isInteger(year) ? year : null;
}

function photoNames(item) {
  const names = [];
  for (let index = 0; index < (item.images || 0); index += 1) {
    const number = item.photoOrder ? item.photoOrder[index] : index + 1;
    const name = `${String(number).padStart(2, "0")}.jpg`;
    if (existsSync(join(photosDir, item.slug, name))) names.push(name);
  }
  return names;
}

async function rest(path, { method = "GET", body } = {}) {
  const response = await fetch(`${required("SUPABASE_URL")}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: required("SUPABASE_SERVICE_ROLE_KEY"),
      authorization: `Bearer ${required("SUPABASE_SERVICE_ROLE_KEY")}`,
      "content-type": "application/json",
      prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

function uploadPhotos() {
  const result = spawnSync("aws", [
    "s3", "sync", photosDir, `s3://${required("HETZNER_S3_BUCKET")}/catalog/`,
    "--endpoint-url", required("HETZNER_S3_ENDPOINT"),
    "--region", "fsn1",
    "--only-show-errors",
  ], {
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: required("HETZNER_S3_ACCESS_KEY"),
      AWS_SECRET_ACCESS_KEY: required("HETZNER_S3_SECRET_KEY"),
    },
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("photo upload failed");
}

const listings = loadListings();
uploadPhotos();
const project = (await rest("projects?slug=eq.belgrade-apartments&select=id&limit=1"))[0];
const present = new Set(
  (await rest("listings?catalog_number=not.is.null&select=catalog_number")).map((row) => row.catalog_number),
);

let inserted = 0;
let photos = 0;
for (const [index, item] of listings.entries()) {
  const catalogNumber = index + 1;
  if (present.has(catalogNumber)) continue;
  const names = photoNames(item);
  const created = await rest("listings", {
    method: "POST",
    body: {
      project_id: project.id,
      catalog_number: catalogNumber,
      status: item.status || "new",
      city: "Belgrade",
      neighborhood: item.location || null,
      address: item.title || null,
      source_url: item.url || null,
      source_urls: item.url ? [item.url] : [],
      asking_price_eur: Number.isFinite(item.price) ? item.price : null,
      area_m2: item.area ?? null,
      year_built: yearOf(item.year),
      fit: item.statusLabel || null,
      notes: Array.isArray(item.problems) ? item.problems.join("\n") : null,
      details: {
        slug: item.slug,
        floor: item.floor || null,
        year: item.year || null,
        route: item.route || null,
        category: item.category || null,
        description: item.description || null,
        problems: item.problems || [],
        criteria: item.criteria || [],
        rentText: item.rentText || null,
        yieldText: item.yieldText || null,
        statusLabel: item.statusLabel || null,
        source: item.source || null,
      },
    },
  });
  const listingId = created[0].id;
  if (names.length) {
    await rest("listing_photos", {
      method: "POST",
      body: names.map((name, position) => ({
        listing_id: listingId,
        object_key: `catalog/${item.slug}/${name}`,
        position,
      })),
    });
    photos += names.length;
  }
  inserted += 1;
}

console.log(`inserted ${inserted} listings, ${photos} photos, skipped ${present.size}`);
