import fs from "node:fs";
import path from "node:path";
import type { Seat } from "../table-view.ts";
import type { SecretTable } from "./engine.ts";
import type { QueueEntry } from "./match.ts";

if (typeof window !== "undefined") {
  throw new Error("Game secrets cannot load in the browser.");
}

const file = path.join(process.cwd(), "data", "tables.json");

export type Session = { tableId: string; seat: Exclude<Seat, "spectator"> };

type Db = {
  tables: Record<string, SecretTable>;
  sessions: Record<string, Session>;
  queue: Record<string, QueueEntry>;
};

let queue: Promise<void> = Promise.resolve();

function locked<T>(fn: () => T): Promise<T> {
  const run = queue.then(fn);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

function read(): Db {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Db>;
    if (!parsed.tables || !parsed.sessions) return { tables: {}, sessions: {}, queue: {} };
    return { tables: parsed.tables, sessions: parsed.sessions, queue: parsed.queue ?? {} };
  } catch {
    return { tables: {}, sessions: {}, queue: {} };
  }
}

function write(db: Db): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, file);
}

export function inspect<T>(fn: (db: Db) => T): Promise<T> {
  return locked(() => fn(read()));
}

export function update<T>(fn: (db: Db) => T): Promise<T> {
  return locked(() => {
    const db = read();
    const result = fn(db);
    write(db);
    return result;
  });
}
