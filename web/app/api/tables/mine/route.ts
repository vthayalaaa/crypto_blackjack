import { randomBytes } from "node:crypto";
import { jsonError, readSeatToken, setSeatCookie } from "../../../../lib/server/http";
import { assertWallet } from "../../../../lib/server/keys";
import { limit } from "../../../../lib/server/limit";
import { parseCluster } from "../../../../lib/server/money";
import { currentSeatIndex, listCurrentTables, sessionTokenFor } from "../../../../lib/server/rejoin";
import { inspect, update } from "../../../../lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function walletOf(request: Request): string {
  return request.headers.get("x-bj-wallet")?.trim() ?? "";
}

export async function GET(request: Request) {
  try {
    limit(request, "mine", 90);
    const cluster = parseCluster(new URL(request.url).searchParams.get("cluster"));
    const wallet = walletOf(request);
    if (wallet) assertWallet(cluster, wallet);
    const token = await readSeatToken();
    const tables = await inspect((db) => {
      const session = token ? db.sessions[token] : undefined;
      return listCurrentTables(db.tables, {
        cluster,
        wallet,
        session: session && session.seat >= 0 ? session : null,
      });
    });
    return Response.json({ tables });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    limit(request, "rejoin", 30);
    const body = await request.json() as { id?: unknown };
    const id = typeof body.id === "string" ? body.id : "";
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) throw new Error("That table link is not valid.");
    const wallet = walletOf(request);
    const token = await readSeatToken();
    const next = await update((db) => {
      const table = db.tables[id];
      if (!table) throw new Error("No table is using that id.");
      if (table.phase !== "waiting" && table.phase !== "acting") throw new Error("That hand is already over.");
      if (wallet) assertWallet(table.cluster, wallet);
      const session = token ? db.sessions[token] : undefined;
      const seat = currentSeatIndex(table, id, {
        wallet,
        session: session && session.seat >= 0 ? session : null,
      });
      if (seat < 0) throw new Error("That seat is not yours.");
      return {
        token: sessionTokenFor(db.sessions, id, seat, token, () => randomBytes(24).toString("base64url")),
        cluster: table.cluster,
      };
    });
    await setSeatCookie(next.token);
    return Response.json({ id, cluster: next.cluster });
  } catch (error) {
    const missing = error instanceof Error && error.message === "No table is using that id.";
    return jsonError(error, missing ? 404 : 400);
  }
}
