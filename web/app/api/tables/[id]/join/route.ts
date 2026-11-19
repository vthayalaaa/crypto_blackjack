import { randomBytes } from "node:crypto";
import { isEthCluster } from "../../../../../lib/table-view";
import { toView } from "../../../../../lib/server/engine";
import { currentSeat, jsonError, loadTable, publish, setSeatCookie } from "../../../../../lib/server/http";
import { assertWallet, newEthSeat, newSolanaSeat, sameWallet } from "../../../../../lib/server/keys";
import { assertClear } from "../../../../../lib/server/sanctions";
import { update } from "../../../../../lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) throw new Error("That table link is not valid.");
    const body = await request.json() as { wallet?: unknown };
    const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
    if (await currentSeat(id) === "player") throw new Error("Open the invite link in the other player's browser.");
    const existing = await loadTable(id);
    assertWallet(existing.cluster, wallet);
    await assertClear(existing.cluster, wallet);
    if (existing.playerWallet) await assertClear(existing.cluster, existing.playerWallet);
    const token = randomBytes(24).toString("base64url");
    const view = await update((db) => {
      const table = db.tables[id];
      if (!table) throw new Error("No table is using that id.");
      assertWallet(table.cluster, wallet);
      if (table.dealerSeat) throw new Error("Someone already took the other seat.");
      if (table.phase !== "waiting") throw new Error("This hand has already started.");
      if (sameWallet(table.cluster, table.playerWallet, wallet)) throw new Error("Use a second wallet for the other seat.");
      if (table.invite && !sameWallet(table.cluster, table.invite, wallet)) {
        throw new Error("This table is reserved for another wallet.");
      }
      const seat = isEthCluster(table.cluster) ? newEthSeat() : newSolanaSeat();
      table.dealerSeat = seat.address;
      table.dealerSecret = seat.secret;
      table.dealerWallet = wallet;
      db.sessions[token] = { tableId: id, seat: "dealer" };
      return toView(table, "dealer");
    });
    await setSeatCookie(token);
    return publish(view);
  } catch (error) {
    const missing = error instanceof Error && error.message === "No table is using that id.";
    return jsonError(error, missing ? 404 : 400);
  }
}
