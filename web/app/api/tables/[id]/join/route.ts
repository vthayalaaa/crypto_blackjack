import { randomBytes } from "node:crypto";
import { noteActivity } from "../../../../../lib/server/activity";
import { assertBuyInBalance } from "../../../../../lib/server/cashier";
import { startBuyInClock, takeSeat, toView } from "../../../../../lib/server/engine";
import { currentSeat, jsonError, loadTable, publish, setSeatCookie } from "../../../../../lib/server/http";
import { assertWallet, newSeat, sameWallet } from "../../../../../lib/server/keys";
import { limit } from "../../../../../lib/server/limit";
import { assertClear } from "../../../../../lib/server/sanctions";
import { update } from "../../../../../lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) throw new Error("That table link is not valid.");
    limit(request, "join", 20);
    const body = await request.json() as { wallet?: unknown };
    const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
    if (typeof await currentSeat(id) === "number") throw new Error("Open the invite link in another player's browser.");
    const existing = await loadTable(id);
    assertWallet(existing.cluster, wallet);
    await assertClear(existing.cluster, wallet);
    await assertBuyInBalance(existing.cluster, wallet, BigInt(existing.due));
    for (const seat of existing.seats) {
      if (seat.wallet) await assertClear(existing.cluster, seat.wallet);
    }
    const token = randomBytes(24).toString("base64url");
    const view = await update((db) => {
      const table = db.tables[id];
      if (!table) throw new Error("No table is using that id.");
      assertWallet(table.cluster, wallet);
      const open = table.seats.findIndex((seat) => !seat.address);
      if (open < 0) throw new Error("The table is full.");
      if (table.phase !== "waiting") throw new Error("This hand has already started.");
      if (table.seats.some((seat) => sameWallet(table.cluster, seat.wallet, wallet))) {
        throw new Error("Use a different wallet for each seat.");
      }
      const invited = table.seats.some((seat) => seat.wallet && sameWallet(table.cluster, table.invite, seat.wallet));
      if (table.invite && !invited && !sameWallet(table.cluster, table.invite, wallet)) {
        throw new Error("This table is reserved for another wallet.");
      }
      const seat = newSeat(table.cluster);
      takeSeat(table, open, { address: seat.address, secret: seat.secret, wallet });
      startBuyInClock(table, Date.now());
      db.sessions[token] = { tableId: id, seat: open };
      return toView(table, open);
    });
    if (typeof view.yourSeat === "number") {
      await noteActivity({
        kind: "join",
        table: id,
        cluster: existing.cluster,
        seat: view.yourSeat,
        wallet,
        detail: "joined",
      });
    }
    await setSeatCookie(token);
    return publish(view);
  } catch (error) {
    const missing = error instanceof Error && error.message === "No table is using that id.";
    return jsonError(error, missing ? 404 : 400);
  }
}
