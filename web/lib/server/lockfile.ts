import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A lock shared by every server process on this machine that uses the same
 * `data/` directory. The in-memory queues only order work inside one process.
 *
 * The lock file is created in one step with its owner already written, so it
 * is never seen half-made. A lock is taken from its owner only when that owner
 * is a process on this host that is no longer running. A lock written by
 * another host is never taken: the data directory must not be shared across
 * machines.
 */

export class LockBusyError extends Error {
  constructor(message = "Another server process is doing this right now.") {
    super(message);
    this.name = "LockBusyError";
  }
}

type Owner = { pid: number; host: string; token: string; at: number };

const held = new Set<string>();
const MAX_DEPTH = 4;

export async function withFileLock<T>(file: string, fn: () => T | Promise<T>, waitMs: number): Promise<T> {
  const token = await acquire(file, waitMs);
  try {
    return await fn();
  } finally {
    release(file, token);
  }
}

export async function acquire(file: string, waitMs: number): Promise<string> {
  const until = Date.now() + waitMs;
  for (;;) {
    const token = tryAcquire(file, 0);
    if (token) return token;
    if (Date.now() >= until) throw new LockBusyError();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function release(file: string, token: string): void {
  held.delete(token);
  // Only the owner can be in the file while it is running, so the check and the
  // unlink cannot be separated by anyone else.
  if (readOwner(file)?.token === token) fs.rmSync(file, { force: true });
}

/** Take the lock now, or return null if a running process holds it. */
export function tryAcquire(file: string, depth: number): string | null {
  const token = link(file);
  if (token) return token;
  const owner = readOwner(file);
  if (!owner) return link(file);
  if (isRunning(owner) || depth >= MAX_DEPTH) return null;
  // Only one process can hold `<file>.<dead token>`, so only one can remove the
  // dead owner's file. Anyone who arrives later sees a different owner and stops.
  const marker = `${file}.${owner.token}`;
  const markerToken = tryAcquire(marker, depth + 1);
  if (!markerToken) return null;
  try {
    if (readOwner(file)?.token === owner.token) fs.rmSync(file, { force: true });
  } finally {
    release(marker, markerToken);
  }
  return link(file);
}

export function isRunning(owner: Pick<Owner, "pid" | "host" | "token">): boolean {
  if (owner.host !== os.hostname()) return true;
  if (owner.pid === process.pid) return held.has(owner.token);
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function link(file: string): string | null {
  const token = randomBytes(12).toString("hex");
  const owner: Owner = { pid: process.pid, host: os.hostname(), token, at: Date.now() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${token}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(owner));
  try {
    fs.linkSync(tmp, file);
    held.add(token);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function readOwner(file: string): Owner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Owner>;
    if (typeof parsed.pid !== "number" || typeof parsed.host !== "string" || typeof parsed.token !== "string") {
      // Not something this code wrote. Treat it as held rather than guess.
      return { pid: -1, host: "", token: "", at: 0 };
    }
    return parsed as Owner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { pid: -1, host: "", token: "", at: 0 };
  }
}
