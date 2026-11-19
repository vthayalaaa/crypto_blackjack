import fs from "node:fs";
import path from "node:path";
import { MAX_SEATS } from "../table-view.ts";
import { normalizeStoredSeat, normalizeTable, type SecretTable } from "./engine.ts";
import { withFileLock } from "./lockfile.ts";
import type { QueueEntry } from "./match.ts";
import { recordSettled } from "./profiles.ts";
import { gameDb } from "./supabase.ts";

if (typeof window !== "undefined") {
  throw new Error("Game secrets cannot load in the browser.");
}

const file = path.join(process.cwd(), "data", "tables.json");

export type Session = { tableId: string; seat: number };

type Db = {
  tables: Record<string, SecretTable>;
  sessions: Record<string, Session>;
  queue: Record<string, QueueEntry>;
};

type Fingerprint = {
  tables: Map<string, string>;
  sessions: Map<string, string>;
  queue: Map<string, string>;
};

let queue: Promise<void> = Promise.resolve();
const STORE_WAIT_MS = 30_000;
const PAGE = 1000;

/**
 * One read-modify-write at a time, across every process that shares `data/`.
 * Without the file lock, a second process could write back a copy it read
 * before a payout was recorded, and the record would be lost.
 * When Supabase is configured, the same lock wraps the database round trip.
 * The database write finishes before this returns, so a payout is recorded
 * before it is broadcast.
 */
function locked<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = queue.then(() => withFileLock(`${file}.lock`, fn, STORE_WAIT_MS));
  queue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Ids and tokens from a request are used as keys. A map with no prototype has
 * no `__proto__` or `constructor` for one of them to land on.
 */
function bare<T>(source?: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, source ?? {});
}

function emptyDb(): Db {
  return { tables: bare(), sessions: bare(), queue: bare() };
}

function usingDatabase(): boolean {
  if (process.env.SUPABASE_STORE !== "on") return false;
  const key = process.env.SUPABASE_SECRET_KEY ?? "";
  return Boolean(process.env.SUPABASE_URL) && key.length > 0 && !key.startsWith("sb_publishable_");
}

export function diffKeys(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): { upsert: string[]; remove: string[] } {
  const upsert: string[] = [];
  const remove: string[] = [];
  for (const [key, value] of after) {
    if (before.get(key) !== value) upsert.push(key);
  }
  for (const key of before.keys()) {
    if (!after.has(key)) remove.push(key);
  }
  return { upsert, remove };
}

function fingerprint(db: Db): Fingerprint {
  const tables = new Map<string, string>();
  for (const [id, table] of Object.entries(db.tables)) tables.set(id, JSON.stringify(table));
  const sessions = new Map<string, string>();
  for (const [token, session] of Object.entries(db.sessions)) sessions.set(token, `${session.tableId}\n${session.seat}`);
  const queueEntries = new Map<string, string>();
  for (const [token, entry] of Object.entries(db.queue)) queueEntries.set(token, JSON.stringify(entry));
  return { tables, sessions, queue: queueEntries };
}

function readFile(): Db {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDb();
    throw error;
  }
  // A file that is there but unreadable must not be replaced by an empty one:
  // the next write would erase every seat key.
  const parsed = JSON.parse(text) as Partial<Db>;
  if (!parsed.tables || !parsed.sessions) return emptyDb();
  const db = { tables: bare(parsed.tables), sessions: bare(parsed.sessions), queue: bare(parsed.queue) };
  normalizeDb(db);
  return db;
}

function normalizeDb(db: Db): void {
  for (const [id, table] of Object.entries(db.tables)) db.tables[id] = normalizeTable(table);
  for (const session of Object.values(db.sessions)) {
    const seat = normalizeStoredSeat(session.seat);
    session.seat = seat === "spectator" ? -1 : seat;
  }
  for (const entry of Object.values(db.queue)) {
    if (typeof entry.seats !== "number") entry.seats = 2;
    const role = entry.role as unknown;
    if (role === "player") entry.role = 0;
    else if (role === "dealer") entry.role = 1;
    else if (typeof role !== "number" || !Number.isInteger(role) || role < 0 || role >= MAX_SEATS) entry.role = "";
  }
}

function writeFile(db: Db): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // Flushed before the rename: a payout record has to be on disk before its
  // transaction is broadcast.
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(db));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

async function fetchPage<T>(table: string, columns: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await gameDb().from(table).select(columns).range(from, from + PAGE - 1);
    if (error) {
      console.error(error.code);
      throw new Error("The database could not be read.");
    }
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}

async function readRemote(): Promise<Db> {
  const [tableRows, sessionRows, queueRows] = await Promise.all([
    fetchPage<{ id: string; document: SecretTable }>("game_tables", "id, document"),
    fetchPage<{ token: string; table_id: string; seat: number }>("game_sessions", "token, table_id, seat"),
    fetchPage<{ token: string; document: QueueEntry }>("game_queue", "token, document"),
  ]);
  const db = emptyDb();
  for (const row of tableRows) {
    if (!row?.document) throw new Error("The database could not be read.");
    const table = normalizeTable(row.document);
    table.id = row.id;
    db.tables[row.id] = table;
  }
  for (const row of sessionRows) db.sessions[row.token] = { tableId: row.table_id, seat: row.seat };
  for (const row of queueRows) {
    if (!row?.document) throw new Error("The database could not be read.");
    db.queue[row.token] = row.document;
  }
  normalizeDb(db);
  if (tableRows.length === 0 && sessionRows.length === 0) {
    const local = readFile();
    const hasLocal = Object.keys(local.tables).length > 0 || Object.keys(local.sessions).length > 0;
    if (hasLocal) {
      await writeRemote(local, { tables: new Map(), sessions: new Map(), queue: new Map() });
      return local;
    }
  }
  return db;
}

async function writeRemote(db: Db, before: Fingerprint): Promise<void> {
  const after = fingerprint(db);
  const tables = diffKeys(before.tables, after.tables);
  const sessions = diffKeys(before.sessions, after.sessions);
  const queueEntries = diffKeys(before.queue, after.queue);
  if (tables.upsert.length === 0 && tables.remove.length === 0
    && sessions.upsert.length === 0 && sessions.remove.length === 0
    && queueEntries.upsert.length === 0 && queueEntries.remove.length === 0) return;

  const tableRows = tables.upsert.map((id) => {
    const table = db.tables[id];
    if (!table) return null;
    return {
      id,
      cluster: table.cluster,
      phase: table.phase,
      created_at: typeof table.createdAt === "number" ? table.createdAt : 0,
      document: table,
    };
  }).filter((row) => row !== null);
  const sessionRows = sessions.upsert.map((token) => {
    const session = db.sessions[token];
    if (!session) return null;
    return { token, table_id: session.tableId, seat: session.seat };
  }).filter((row) => row !== null);
  const queueRows = queueEntries.upsert.map((token) => {
    const entry = db.queue[token];
    if (!entry) return null;
    return { token, document: entry };
  }).filter((row) => row !== null);

  await putRows("game_tables", tableRows);
  await putRows("game_sessions", sessionRows);
  await putRows("game_queue", queueRows);
  await dropRows("game_tables", "id", tables.remove);
  await dropRows("game_sessions", "token", sessions.remove);
  await dropRows("game_queue", "token", queueEntries.remove);
  for (const id of tables.upsert) {
    const table = db.tables[id];
    if (table) await recordSettled(table);
  }
}

async function putRows(table: string, rows: object[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await gameDb().from(table).upsert(rows);
  if (error) {
    console.error(error.code);
    throw new Error("The database could not be saved.");
  }
}

async function dropRows(table: string, column: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const { error } = await gameDb().from(table).delete().in(column, keys);
  if (error) {
    console.error(error.code);
    throw new Error("The database could not be saved.");
  }
}

export function inspect<T>(fn: (db: Db) => T): Promise<T> {
  return locked(async () => fn(usingDatabase() ? await readRemote() : readFile()));
}

export function update<T>(fn: (db: Db) => T): Promise<T> {
  return locked(async () => {
    const remote = usingDatabase();
    const db = remote ? await readRemote() : readFile();
    const before = remote ? fingerprint(db) : null;
    const result = fn(db);
    if (before) await writeRemote(db, before);
    else writeFile(db);
    return result;
  });
}
