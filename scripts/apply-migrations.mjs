#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(process.argv[2] || "supabase/migrations");
const mode = process.argv[3] || "apply";
if (!["apply", "baseline", "validate"].includes(mode)) {
  throw new Error("Usage: apply-migrations.mjs [directory] [apply|baseline|validate]");
}

const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
const migrations = await Promise.all(names.map(async (name) => {
  const match = /^(\d{14})_[a-z0-9_]+\.sql$/.exec(name);
  if (!match) throw new Error(`Invalid migration name: ${name}`);
  const sql = await readFile(resolve(directory, name), "utf8");
  if (!sql.trim()) throw new Error(`Empty migration: ${name}`);
  return { version: match[1], name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
}));
if (new Set(migrations.map((item) => item.version)).size !== migrations.length) {
  throw new Error("Duplicate migration version");
}
if (mode === "validate") {
  console.log(`Validated ${migrations.length} migration files`);
  process.exit(0);
}

const url = process.env.SUPABASE_URL;
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!url || !token) throw new Error("SUPABASE_URL and SUPABASE_ACCESS_TOKEN are required");
const ref = new URL(url).hostname.split(".")[0];
if (!/^[a-z0-9]+$/.test(ref)) throw new Error("Invalid Supabase project ref");

async function query(sql, readOnly = false) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: sql, read_only: readOnly }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase SQL request failed (${response.status}): ${body.slice(0, 1000)}`);
  return body ? JSON.parse(body) : [];
}

const historyTable = "public.ai_family_schema_migrations";
const historyExists = (await query(`select to_regclass('${historyTable}') is not null as present`, true))[0].present;
const applicationTables = (await query(
  "select count(*)::int as count from information_schema.tables where table_schema = 'public' " +
  "and table_name in ('conversations', 'agent_jobs', 'projects', 'listings', 'listing_photos')", true,
))[0].count;

const createHistory = `
  create table ${historyTable} (
    version text primary key,
    name text not null,
    checksum text not null,
    applied_at timestamptz not null default now()
  );
  alter table ${historyTable} enable row level security;
`;

if (mode === "baseline") {
  if (historyExists || applicationTables !== 5 || migrations.length !== 7) {
    throw new Error("Baseline requires the seven known migrations, all five application tables and no history");
  }
  const expectedColumns = {
    conversations: ["id", "project_id", "kind", "telegram_chat_id", "telegram_topic_id", "opened_by", "cursor_chat_id", "started_at", "closed_at"],
    agent_jobs: ["id", "conversation_id", "project_id", "created_by", "source", "external_user_id", "kind", "payload", "status", "not_before", "created_at", "started_at", "finished_at", "attempts", "result", "error", "context", "artifacts", "model"],
    projects: ["id", "name", "slug", "telegram_chat_id", "telegram_topic_id", "repo_url", "created_at"],
    listings: ["id", "project_id", "catalog_number", "status", "city", "municipality", "neighborhood", "address", "source_url", "asking_price_eur", "area_m2", "rooms", "floor", "year_built", "heating", "notes", "fit", "created_at", "source_urls", "details"],
    listing_photos: ["id", "listing_id", "object_key", "position", "created_at"],
  };
  const columns = await query(
    "select table_name, column_name from information_schema.columns where table_schema = 'public' " +
    "and table_name in ('conversations', 'agent_jobs', 'projects', 'listings', 'listing_photos')", true,
  );
  const actual = new Set(columns.map((row) => `${row.table_name}.${row.column_name}`));
  for (const [table, fields] of Object.entries(expectedColumns)) {
    for (const field of fields) {
      if (!actual.has(`${table}.${field}`)) throw new Error(`Baseline schema is missing ${table}.${field}`);
    }
  }
  const objects = await query(`
    select
      (select count(*) from pg_indexes where schemaname = 'public'
       and indexname in ('one_open_private', 'one_topic'))::int as indexes,
      (select count(*) from pg_constraint where conname in
       ('conversations_project_id_fkey', 'agent_jobs_project_id_fkey',
        'listings_project_id_fkey', 'listing_photos_listing_id_fkey'))::int as foreign_keys,
      (select count(*) from pg_class where relnamespace = 'public'::regnamespace
       and relname in ('conversations', 'agent_jobs', 'projects', 'listings', 'listing_photos')
       and relrowsecurity)::int as rls_tables
  `, true);
  if (objects[0].indexes !== 2 || objects[0].foreign_keys !== 4 || objects[0].rls_tables !== 5) {
    throw new Error("Baseline indexes, foreign keys or RLS differ from migrations");
  }
  const values = migrations.map((item) =>
    `(${quote(item.version)}, ${quote(item.name)}, ${quote(item.checksum)})`).join(",\n");
  await query(`begin; ${createHistory}
    insert into ${historyTable} (version, name, checksum) values ${values}; commit;`);
  console.log(`Baselined ${migrations.length} existing migrations`);
  process.exit(0);
}

if (!historyExists) {
  if (applicationTables) {
    throw new Error("Existing schema has no migration history; verify it and run baseline once");
  }
  await query(`begin; ${createHistory} commit;`);
}

const applied = await query(`select version, name, checksum from ${historyTable} order by version`, true);
const byVersion = new Map(migrations.map((item) => [item.version, item]));
for (const row of applied) {
  const local = byVersion.get(row.version);
  if (!local) throw new Error(`Remote migration ${row.version} is missing locally`);
  if (local.name !== row.name || local.checksum !== row.checksum) {
    throw new Error(`Migration ${row.version} changed after application`);
  }
}
const appliedVersions = new Set(applied.map((row) => row.version));
let missingSeen = false;
for (const item of migrations) {
  if (appliedVersions.has(item.version)) {
    if (missingSeen) throw new Error(`Migration order has a gap before ${item.version}`);
    continue;
  }
  missingSeen = true;
  await query(`begin; ${item.sql}
    insert into ${historyTable} (version, name, checksum)
    values (${quote(item.version)}, ${quote(item.name)}, ${quote(item.checksum)}); commit;`);
  console.log(`Applied ${item.name}`);
}
console.log(`Migration check complete: ${migrations.length} files, ${applied.length} already applied`);
