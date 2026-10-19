import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import * as schema from "@/db/schema";

export const ROOT = process.cwd();
export const DATA_DIR = path.join(ROOT, "data");
export const DB_PATH = process.env.JOBHUNT_DB ?? path.join(DATA_DIR, "jobhunt.db");

type DB = BetterSQLite3Database<typeof schema>;

const globalForDb = globalThis as unknown as { __jobhuntDb?: DB };

function open(): DB {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(ROOT, "db", "migrations") });
  return db;
}

export function getDb(): DB {
  if (!globalForDb.__jobhuntDb) globalForDb.__jobhuntDb = open();
  return globalForDb.__jobhuntDb;
}

export const db = new Proxy({} as DB, {
  get(_t, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const v = real[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});

export { schema };
