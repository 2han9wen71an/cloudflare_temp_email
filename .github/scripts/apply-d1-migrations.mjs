#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

const dbName = process.env.D1_DATABASE_NAME || process.env.DB_NAME || "mail";
const migrationsDir = resolve(process.cwd(), process.argv[2] || "../db");
const wrangler = existsSync(resolve(process.cwd(), "node_modules/.bin/wrangler"))
  ? resolve(process.cwd(), "node_modules/.bin/wrangler")
  : "wrangler";
const migrationTable = "mail_migrations";

const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;

const runWrangler = (args, label) => {
  try {
    return execFileSync(wrangler, args, {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stdout = error.stdout ? `\nstdout:\n${error.stdout}` : "";
    const stderr = error.stderr ? `\nstderr:\n${error.stderr}` : "";
    throw new Error(`${label} failed.${stdout}${stderr}`);
  }
};

const parseWranglerJson = (output, label) => {
  const trimmed = output.trim();
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== "[" && trimmed[index] !== "{") {
      continue;
    }

    try {
      return JSON.parse(trimmed.slice(index));
    } catch {
      // Wrangler may print upload progress before JSON. Keep scanning.
    }
  }

  throw new Error(`${label} did not return JSON:\n${output}`);
};

const executeSql = (sql, label) => {
  const dir = mkdtempSync(resolve(tmpdir(), "d1-migration-"));
  const file = resolve(dir, "migration.sql");

  try {
    writeFileSync(file, sql);
    const output = runWrangler(
      ["d1", "execute", dbName, "--remote", "--file", file, "--json"],
      label,
    );
    const results = parseWranglerJson(output, label);
    if (!Array.isArray(results)) {
      throw new Error(`${label} failed: ${JSON.stringify(results.error || results)}`);
    }
    const failed = results.find((result) => !result.success);
    if (failed) {
      throw new Error(`${label} failed: ${JSON.stringify(failed.errors)}`);
    }
    return results;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const queryRows = (sql, label) => {
  const output = runWrangler(
    ["d1", "execute", dbName, "--remote", "--command", sql, "--json"],
    label,
  );
  const results = parseWranglerJson(output, label);
  if (!Array.isArray(results)) {
    throw new Error(`${label} failed: ${JSON.stringify(results.error || results)}`);
  }
  const first = results[0];
  if (!first?.success) {
    throw new Error(`${label} failed: ${JSON.stringify(first?.errors)}`);
  }
  return first.results || [];
};

const tableExists = (table) =>
  queryRows(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${sqlString(
      table,
    )} LIMIT 1;`,
    `check table ${table}`,
  ).length > 0;

const columnExists = (table, column) => {
  if (!tableExists(table)) {
    return false;
  }
  return queryRows(`PRAGMA table_info(${table});`, `check column ${table}.${column}`).some(
    (row) => row.name === column,
  );
};

const indexExists = (index) =>
  queryRows(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = ${sqlString(
      index,
    )} LIMIT 1;`,
    `check index ${index}`,
  ).length > 0;

const existingSchemaGuards = {
  "2024-01-13-patch.sql": () => !tableExists("mails") || columnExists("mails", "message_id"),
  "2024-04-03-patch.sql": () => columnExists("address", "updated_at"),
  "2024-04-09-patch.sql": () => tableExists("raw_mails"),
  "2024-04-12-patch.sql": () => tableExists("address_sender") && tableExists("sendbox"),
  "2024-05-01-patch.sql": () => tableExists("settings"),
  "2024-05-08-patch.sql": () => tableExists("users") && tableExists("users_address"),
  "2024-07-14-patch.sql": () => tableExists("user_roles"),
  "2024-08-10-patch.sql": () => tableExists("user_passkeys"),
  "2025-09-23-patch.sql": () => columnExists("address", "password"),
  "2025-12-06-metadata.sql": () => columnExists("raw_mails", "metadata"),
  "2025-12-15-message-id-index.sql": () => indexExists("idx_raw_mails_message_id"),
  "2025-12-27-source-meta.sql": () =>
    columnExists("address", "source_meta") && indexExists("idx_address_source_meta"),
  "2026-04-03-raw-blob.sql": () => columnExists("raw_mails", "raw_blob"),
};

executeSql(
  `CREATE TABLE IF NOT EXISTS ${migrationTable} (
    name TEXT PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  "create migration table",
);

const applied = new Set(
  queryRows(`SELECT name FROM ${migrationTable};`, "read applied migrations").map(
    (row) => row.name,
  ),
);
const migrations = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql") && file !== "schema.sql")
  .sort();

for (const migration of migrations) {
  if (applied.has(migration)) {
    console.log(`[skip] ${migration}`);
    continue;
  }

  const guard = existingSchemaGuards[migration];
  if (guard?.()) {
    executeSql(
      `INSERT OR IGNORE INTO ${migrationTable} (name) VALUES (${sqlString(migration)});`,
      `record existing migration ${migration}`,
    );
    console.log(`[mark] ${migration}`);
    continue;
  }

  const sql = readFileSync(resolve(migrationsDir, migration), "utf8");
  executeSql(sql, `apply migration ${migration}`);
  executeSql(
    `INSERT OR IGNORE INTO ${migrationTable} (name) VALUES (${sqlString(migration)});`,
    `record migration ${migration}`,
  );
  console.log(`[apply] ${migration}`);
}

console.log(`D1 migrations are up to date for ${basename(migrationsDir)} on ${dbName}.`);
