import { noteActivity } from "../../../../../lib/server/activity";
import { assertPayment, settleMoney } from "../../../../../lib/server/cashier";
import { openHand, startRefundClock, toView } from "../../../../../lib/server/engine";
import { limit } from "../../../../../lib/server/limit";
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
    limit(request, "fund", 20);
    const seat = await currentSeat(id);
    if (typeof seat !== "number") throw new Error("Sit down from this browser before sending the buy-in.");
    const body = await request.json() as { wallet?: unknown; signature?: unknown };
    const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
    const signature = typeof body.signature === "string" ? body.signature.trim() : "";
    if (!signature) throw new Error("The buy-in transfer is missing.");
    const existing = await loadTable(id);
    assertWallet(existing.cluster, wallet);
    await assertClear(existing.cluster, wallet);
    for (const slot of existing.seats) {
      if (slot.wallet) await assertClear(existing.cluster, slot.wallet);
    }
    const destination = existing.seats[seat]?.address ?? "";
    if (!destination) throw new Error("Take the seat before sending the buy-in.");
    const seated = existing.seats[seat]?.wallet ?? "";
    if (seated && !sameWallet(existing.cluster, seated, wallet)) {
      throw new Error("Send the buy-in from the wallet that sat down.");
    }
    await assertPayment(existing, signature, wallet, destination, BigInt(existing.due));
    const funded = await update((db) => {
      const table = db.tables[id];
      if (!table) throw new Error("No table is using that id.");
      if (table.fundSignatures.includes(signature)) return null;
      const slot = table.seats[seat];
      if (!slot?.address) throw new Error("Take the seat before sending the buy-in.");
      if (slot.funded) throw new Error("This seat is already funded.");
      if (table.seats.some((other, index) => index !== seat && sameWallet(table.cluster, other.wallet, wallet))) {
        throw new Error("Use a different wallet for each seat.");
      }
      table.fundSignatures.push(signature);
      slot.funded = true;
      slot.wallet = wallet;
      delete table.kickVotes[String(seat)];
      if (table.phase === "waiting" && table.seats.every((other) => other.address && other.funded)) {
        openHand(table, Date.now());
      } else {
        startRefundClock(table, Date.now());
      }
      return { cluster: table.cluster, amount: table.due };
    });
    if (funded) {
      await noteActivity({
        kind: "buyin",
        table: id,
        cluster: funded.cluster,
        seat,
        wallet,
        amount: funded.amount,
        signature,
      });
    }
    await settleMoney(id);
    const fresh = await loadTable(id);
    return publish(toView(fresh, seat));
  } catch (error) {
    const missing = error instanceof Error && error.message === "No table is using that id.";
    return jsonError(error, missing ? 404 : 400);
  }
}
