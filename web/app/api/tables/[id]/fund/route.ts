import { openHand, toView } from "../../../../../lib/server/engine";
import { assertPayment, settleMoney } from "../../../../../lib/server/cashier";
import { currentSeat, jsonError, loadTable, publish } from "../../../../../lib/server/http";
import { assertWallet, sameWallet } from "../../../../../lib/server/keys";
import { assertClear } from "../../../../../lib/server/sanctions";
import { update } from "../../../../../lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) throw new Error("That table link is not valid.");
    const seat = await currentSeat(id);
    if (seat === "spectator") throw new Error("Sit down from this browser before sending the buy-in.");
    const body = await request.json() as { wallet?: unknown; signature?: unknown };
    const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
    const signature = typeof body.signature === "string" ? body.signature.trim() : "";
    if (!signature) throw new Error("The buy-in transfer is missing.");
    const existing = await loadTable(id);
    assertWallet(existing.cluster, wallet);
    await assertClear(existing.cluster, wallet);
    if (existing.playerWallet) await assertClear(existing.cluster, existing.playerWallet);
    if (existing.dealerWallet) await assertClear(existing.cluster, existing.dealerWallet);
    const destination = seat === "player" ? existing.playerSeat : existing.dealerSeat;
    if (!destination) throw new Error("Take the seat before sending the buy-in.");
    if (seat === "dealer" && existing.dealerWallet && !sameWallet(existing.cluster, existing.dealerWallet, wallet)) {
      throw new Error("Send the buy-in from the wallet that sat down.");
    }
    await assertPayment(existing, signature, wallet, destination, BigInt(existing.due));
    await update((db) => {
      const table = db.tables[id];
      if (!table) throw new Error("No table is using that id.");
      if (table.fundSignatures.includes(signature)) return;
      const already = seat === "player" ? table.playerFunded : table.dealerFunded;
      if (already) throw new Error("This seat is already funded.");
      const other = seat === "player" ? table.dealerWallet : table.playerWallet;
      if (sameWallet(table.cluster, other, wallet)) throw new Error("Use a second wallet for the other seat.");
      table.fundSignatures.push(signature);
      if (seat === "player") {
        table.playerFunded = true;
        table.playerWallet = wallet;
      } else {
        table.dealerFunded = true;
        table.dealerWallet = wallet;
      }
      if (table.playerFunded && table.dealerFunded && table.phase === "waiting" && table.dealerSeat) {
        openHand(table, Date.now());
      }
    });
    await settleMoney(id);
    const fresh = await loadTable(id);
    return publish(toView(fresh, seat));
  } catch (error) {
    const missing = error instanceof Error && error.message === "No table is using that id.";
    return jsonError(error, missing ? 404 : 400);
  }
}
