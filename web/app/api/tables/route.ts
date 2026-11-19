import { randomBytes } from "node:crypto";
import { parseSeats } from "../../../lib/table-view";
import { noteActivity } from "../../../lib/server/activity";
import { blankTable, toView } from "../../../lib/server/engine";
import { jsonError, publish, setSeatCookie } from "../../../lib/server/http";
import { assertWallet, newSeat } from "../../../lib/server/keys";
import { limit } from "../../../lib/server/limit";
import { assertBuyInBalance } from "../../../lib/server/cashier";
import { parseCluster, quote } from "../../../lib/server/money";
import { prune } from "../../../lib/server/prune";
import { assertClear } from "../../../lib/server/sanctions";
import { update } from "../../../lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    limit(request, "create", 10);
    const body = await request.json() as { cluster?: unknown; stake?: unknown; invite?: unknown; wallet?: unknown; seats?: unknown };
    const cluster = parseCluster(body.cluster);
    const seats = parseSeats(body.seats);
    const priced = quote(cluster, typeof body.stake === "string" ? body.stake : "");
    const invite = typeof body.invite === "string" ? body.invite.trim() : "";
    const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
    if (invite) {
      assertWallet(cluster, invite);
      await assertClear(cluster, invite);
    }
    if (wallet) {
      assertWallet(cluster, wallet);
      await assertClear(cluster, wallet);
      await assertBuyInBalance(cluster, wallet, priced.due);
    }
    const seat = newSeat(cluster);
    const id = randomBytes(9).toString("base64url");
    const token = randomBytes(24).toString("base64url");
    const table = blankTable({
      id,
      cluster,
      stake: priced.stake,
      due: priced.due,
      buffer: priced.buffer,
      invite,
      capacity: seats,
      playerSeat: seat.address,
      playerSecret: seat.secret,
    });
    if (wallet) table.seats[0]!.wallet = wallet;
    await update((db) => {
      prune(db, Date.now());
      db.tables[id] = table;
      db.sessions[token] = { tableId: id, seat: 0 };
    });
    await noteActivity({ kind: "join", table: id, cluster, seat: 0, wallet, detail: "opened" });
    await setSeatCookie(token);
    return publish(toView(table, 0));
  } catch (error) {
    return jsonError(error);
  }
}
