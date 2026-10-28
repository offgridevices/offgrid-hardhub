// SQLite for tests (sql.js, WebAssembly): the Durable Object's `sql.exec`
// and a D1 binding, both over the real schema.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs, { type Database } from "sql.js";
import type { Sql } from "../../src/room/core";

const SQL = await initSqlJs();

export function memoryDb(): Database {
  return new SQL.Database();
}

function rows(db: Database, query: string, params: unknown[]): Record<string, unknown>[] {
  const st = db.prepare(query);
  try {
    st.bind(params as never);
    const out: Record<string, unknown>[] = [];
    while (st.step()) out.push(st.getAsObject() as Record<string, unknown>);
    return out;
  } finally {
    st.free();
  }
}

/** ctx.storage.sql */
export function doSql(db = memoryDb()): Sql {
  // like the Durable Object's, a statement runs when exec is called
  return {
    exec: (q, ...b) => {
      const r = rows(db, q, b);
      return { toArray: () => r };
    },
  };
}

/** a D1Database with the API's migrations applied */
export function d1(): D1Database {
  const db = memoryDb();
  const dir = join(fileURLToPath(import.meta.url), "../../../migrations");
  for (const f of readdirSync(dir).sort()) db.exec(readFileSync(join(dir, f), "utf8"));
  db.exec("PRAGMA foreign_keys = ON");
  const prepare = (q: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt;
      },
      async first<T>() {
        return (rows(db, q, params)[0] as T) ?? null;
      },
      async all<T>() {
        return { results: rows(db, q, params) as T[], success: true, meta: {} };
      },
      async run() {
        rows(db, q, params);
        return { success: true, meta: {} };
      },
    };
    return stmt;
  };
  return { prepare } as unknown as D1Database;
}
