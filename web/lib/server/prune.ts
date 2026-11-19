import fs from "node:fs";
import path from "node:path";
import { payoutLegs } from "./cashier.ts";
import type { SecretTable } from "./engine.ts";
import type { QueueEntry } from "./match.ts";
import type { Session } from "./store.ts";

const EMPTY_MS = 24 * 60 * 60 * 1000;
const DONE_MS = 7 * 24 * 60 * 60 * 1000;
const archive = path.join(process.cwd(), "data", "tables-archive.jsonl");

type Db = {
  tables: Record<string, SecretTable>;
  sessions: Record<string, Session>;
  queue: Record<string, QueueEntry>;
};

/**
 * A table leaves the live file when nobody funded it within a day, or a week after
 * it was fully paid. An unfunded table with no creation time is already past that
 * day: the clock was added later, and the buy-in never arrived.
 */
export function isStale(table: SecretTable, now: number): boolean {
  const untouched = !table.seats.some((seat) => seat.funded) && table.fundSignatures.length === 0;
  const open = table.phase === "waiting" || table.phase === "cancelled";
  if (!table.createdAt) return untouched && open;
  const age = now - table.createdAt;
  if (untouched) return open && age > EMPTY_MS;
  if (table.phase !== "settled" && table.phase !== "cancelled") return false;
  return age > DONE_MS && payoutLegs(table).every((leg) => table.paid[leg.id]);
}

/**
 * Move stale tables out of the live file and drop the sessions and queue entries
 * that pointed at them. The seat keys are appended to the archive, never deleted:
 * a seat may still hold the fee buffer or a transfer that was never reported.
 */
export function prune(db: Db, now: number, keep: (tables: SecretTable[]) => void = appendArchive): number {
  const stale = Object.values(db.tables).filter((table) => isStale(table, now));
  if (stale.length === 0) return 0;
  keep(stale);
  for (const table of stale) delete db.tables[table.id];
  for (const [token, session] of Object.entries(db.sessions)) {
    if (!db.tables[session.tableId]) delete db.sessions[token];
  }
  for (const [token, entry] of Object.entries(db.queue)) {
    if (entry.tableId && !db.tables[entry.tableId]) delete db.queue[token];
  }
  return stale.length;
}

function appendArchive(tables: SecretTable[]): void {
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.appendFileSync(archive, tables.map((table) => `${JSON.stringify(table)}\n`).join(""));
}
