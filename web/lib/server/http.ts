import { cookies } from "next/headers";
import type { Seat, TableView } from "../table-view.ts";
import { toView, type SecretTable } from "./engine.ts";
import { inspect } from "./store.ts";

const COOKIE = "bj_seat";
const QUEUE_COOKIE = "bj_queue";

export function publish(view: TableView): Response {
  for (const key of Object.keys(view)) {
    if (key === "playerSecret" || key === "dealerSecret" || key === "deck" || key === "secret") {
      throw new Error("Refusing to send a private table.");
    }
  }
  return Response.json({ table: view });
}

export function jsonError(error: unknown, status = 400): Response {
  const message = error instanceof Error ? error.message : "The table could not do that.";
  return Response.json({ error: message.slice(0, 240) }, { status });
}

export async function setSeatCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7 });
}

export async function queueToken(): Promise<string | undefined> {
  return (await cookies()).get(QUEUE_COOKIE)?.value;
}

export async function setQueueCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(QUEUE_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 });
}

export async function currentSeat(tableId: string): Promise<Seat> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return "spectator";
  return inspect((db) => {
    const session = db.sessions[token];
    if (!session || session.tableId !== tableId) return "spectator";
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
