import { cookies } from "next/headers";
import type { Seat, TableView } from "../table-view.ts";
import { toView, type SecretTable } from "./engine.ts";
import { RateLimitError } from "./limit.ts";
import { SanctionedWalletError } from "./sanctions.ts";
import { inspect } from "./store.ts";

const COOKIE = "bj_seat";
const QUEUE_COOKIE = "bj_queue";

export function publish(view: TableView): Response {
  if (hasSecret(view)) throw new Error("Refusing to send a private table.");
  return Response.json({ table: view });
}

function hasSecret(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "playerSecret" || key === "dealerSecret" || key === "deck" || key === "secret") return true;
    if (hasSecret(child)) return true;
  }
  return false;
}

const GENERIC = "The table could not do that.";

/**
 * Only messages this app wrote itself go to the browser. Library, network, and
 * file errors can carry RPC addresses, paths, and request bodies.
 */
export function publicMessage(error: unknown): string {
  if (!(error instanceof Error)) return GENERIC;
  const own = error.name === "Error" || error instanceof SanctionedWalletError || error instanceof RateLimitError;
  if (!own || "code" in error || "cause" in error) return GENERIC;
  return error.message
    .replace(/https?:\/\/\S+/g, "…")
    .replace(/0x[0-9a-fA-F]{64}/g, "0x…")
    .slice(0, 240);
}

export function jsonError(error: unknown, status = 400): Response {
  if (publicMessage(error) === GENERIC && error instanceof Error) console.error(error);
  return Response.json({ error: publicMessage(error) }, { status: error instanceof RateLimitError ? 429 : status });
}

const secure = process.env.NODE_ENV === "production";

export async function setSeatCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, token, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7 });
}

export async function queueToken(): Promise<string | undefined> {
  return (await cookies()).get(QUEUE_COOKIE)?.value;
}

export async function setQueueCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(QUEUE_COOKIE, token, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 60 * 60 });
}

export async function readSeatToken(): Promise<string | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  return token;
}

export async function currentSeat(tableId: string): Promise<Seat> {
  const token = await readSeatToken();
  if (!token) return "spectator";
  return inspect((db) => {
    const session = db.sessions[token];
    if (!session || session.tableId !== tableId || session.seat < 0) return "spectator";
    return session.seat;
  });
}

export async function loadTable(id: string): Promise<SecretTable> {
  const table = await inspect((db) => db.tables[id]);
  if (!table) throw new Error("No table is using that id.");
  return table;
}

export function viewOf(table: SecretTable, seat: Seat): TableView {
  return toView(table, seat);
}
