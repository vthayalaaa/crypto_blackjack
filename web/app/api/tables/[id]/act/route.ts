import { cancel, claim, hit, stand, toView } from "../../../../../lib/server/engine";
import { settleMoney, unlockPayout } from "../../../../../lib/server/cashier";
import { currentSeat, jsonError, loadTable, publish } from "../../../../../lib/server/http";
import { assertClear } from "../../../../../lib/server/sanctions";
import { update } from "../../../../../lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) throw new Error("That table link is not valid.");
    const seat = await currentSeat(id);
    if (seat === "spectator") throw new Error("Sit down from this browser before acting.");
    const body = await request.json() as { action?: unknown };
    const action = body.action;
    if (action !== "hit" && action !== "stand" && action !== "cancel" && action !== "claim" && action !== "payout") {
      throw new Error("That action is not part of this hand.");
    }
    if (action === "hit" || action === "stand" || action === "claim") {
      const existing = await loadTable(id);
      const acting = seat === "player" ? existing.playerWallet : existing.dealerWallet;
      if (acting) await assertClear(existing.cluster, acting);
    }
    if (action !== "payout") {
      await update((db) => {
        const table = db.tables[id];
        if (!table) throw new Error("No table is using that id.");
        const now = Date.now();
        if (action === "hit") hit(table, seat, now);
        if (action === "stand") stand(table, seat);
        if (action === "cancel") cancel(table, seat);
        if (action === "claim") claim(table, seat, now);
      });
    }
    if (action === "payout") await unlockPayout(id);
    else await settleMoney(id);
    return publish(toView(await loadTable(id), await currentSeat(id)));
  } catch (error) {
    const missing = error instanceof Error && error.message === "No table is using that id.";
    return jsonError(error, missing ? 404 : 400);
  }
}
