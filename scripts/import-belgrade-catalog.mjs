import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const catalogDir = process.argv.slice(2).find((arg) => !arg.startsWith("-"))
  || "/Users/vladryba/dev/codex-notes-ai-2026/20260909-serbia-real-estate";
const dataPath = join(catalogDir, "assets/listings-data.js");
const photosDir = join(catalogDir, "assets/listings");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is empty`);
  return value;
}

function loadScript(path, names) {
  const context = { console };
  vm.createContext(context);
  const assign = names.map((name) => `this.${name} = ${name};`).join("\n");
  vm.runInContext(`${readFileSync(path, "utf8")}\n${assign}`, context);
  return context;
}

function loadListings() {
  return loadScript(dataPath, ["listings"]).listings;
}

function categoryOf(item) {
  if (item.category) return item.category;
  return item.propertyType === "house" ? "houses" : "living";
}

function marketOf(item, assessments) {
  const assessment = assessments[item.slug];
  if (!assessment || !item.price || !item.area) return null;
  const unitPrice = assessment.unitPrice || Math.round(item.price / item.area);
  const difference = Math.round((unitPrice / assessment.benchmark - 1) * 100);
  let tone = "fair";
  let label = "В рынке";
  if (difference <= -10) {
    tone = "below";
    label = "Ниже рынка";
  } else if (difference >= 10) {
    tone = "above";
    label = "Выше рынка";
  }
  return {
    tone,
    label,
    difference,
    unitPrice,
    benchmark: assessment.benchmark,
    area: assessment.area,
    note: assessment.note || null,
    source: assessment.source,
    kind: assessment.kind || null,
  };
}

function heatingOf(item, number, heating) {
  const model = heating.heatingModels[heating.heatingAssignments[number]];
  if (!model) return null;
  const box = { tone: model.tone, label: model.label, verdict: model.verdict, note: model.note };
  if (!model.annualPerM2 || !item.area) return box;
  const annualMin = Math.round(item.area * model.annualPerM2[0] / 100) * 100;
  const annualMax = Math.round(item.area * model.annualPerM2[1] / 100) * 100;
  box.annualMin = annualMin;
  box.annualMax = annualMax;
  box.monthlyEuroMin = Math.round(annualMin / 12 / heating.heatingExchangeRate);
  box.monthlyEuroMax = Math.round(annualMax / 12 / heating.heatingExchangeRate);
  return box;
}

function detailsOf(item, number, extras) {
  return {
    slug: item.slug,
    category: categoryOf(item),
    floor: item.floor || null,
    year: item.year || null,
    route: item.route || null,
    description: item.description || null,
    problems: item.problems || [],
    criteria: item.criteria || [],
    wifeChecklist: item.wifeChecklist || null,
    duplicates: item.duplicates || null,
    priceHistory: item.priceHistory || null,
    availabilityStatus: item.availabilityStatus || null,
    availabilityLabel: item.availabilityLabel || null,
    availabilityNote: item.availabilityNote || null,
    availabilityChecked: item.availabilityChecked || null,
    rentText: item.rentText || null,
    yieldText: item.yieldText || null,
    rentSource: item.rentSource || null,
    map: item.map || null,
    source: item.source || null,
    completion: item.completion || null,
    reference: Boolean(item.reference),
    rentalBudgetDelta: item.rentalBudgetDelta || null,
    budgetNote: item.budgetNote || null,
    statusLabel: item.statusLabel || null,
    developer: item.developer || null,
    developerRating: item.developerRating || null,
    developerEvidence: item.developerEvidence || null,
    developerWarning: item.developerWarning || null,
    developerUrl: item.developerUrl || null,
    projectUrl: item.projectUrl || null,
    market: marketOf(item, extras.marketAssessments),
    heating: heatingOf(item, number, extras.heating),
  };
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
const extras = {
  marketAssessments: loadScript(join(catalogDir, "assets/market-data.js"), ["marketAssessments"]).marketAssessments,
  heating: loadScript(join(catalogDir, "assets/heating-data.js"), ["heatingModels", "heatingAssignments", "heatingExchangeRate"]),
};
if (process.argv.includes("--details")) {
  let updated = 0;
  for (const [index, item] of listings.entries()) {
    await rest(`listings?catalog_number=eq.${index + 1}`, {
      method: "PATCH",
      body: { details: detailsOf(item, index + 1, extras) },
    });
    updated += 1;
  }
  console.log(`updated ${updated} cards`);
  process.exit(0);
}
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
      details: detailsOf(item, catalogNumber, extras),
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
