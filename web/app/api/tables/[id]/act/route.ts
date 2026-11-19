import { noteActivity } from "../../../../../lib/server/activity";
import { settleMoney } from "../../../../../lib/server/cashier";
import { cancel, claim, hit, stand, toView, voteStart } from "../../../../../lib/server/engine";
import { currentSeat, jsonError, loadTable, publish } from "../../../../../lib/server/http";
import { update } from "../../../../../lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) throw new Error("That table link is not valid.");
    const seat = await currentSeat(id);
    if (typeof seat !== "number") throw new Error("Sit down from this browser before acting.");
    const body = await request.json() as { action?: unknown };
    const action = body.action;
    if (action !== "hit" && action !== "stand" && action !== "cancel" && action !== "claim" && action !== "payout" && action !== "vote") {
      throw new Error("That action is not part of this hand.");
    }
    // No sanctions re-check here. Every wallet was screened before it sat and before it
    // funded, and it is screened again before it is paid. A check that fails in the middle
    // of a hand would only make that player lose the pot on the clock.
    if (action !== "payout") {
      const acted = await update((db) => {
        const table = db.tables[id];
        if (!table) throw new Error("No table is using that id.");
        const now = Date.now();
        if (action === "hit") hit(table, seat, now);
        if (action === "stand") stand(table, seat);
        if (action === "cancel") cancel(table, seat, now);
        if (action === "claim") claim(table, seat, now);
        const wasReady = action === "vote" && Boolean(table.seats[seat]?.ready);
        if (action === "vote") voteStart(table, seat, now);
        const agreed = action === "vote" && !wasReady;
        return { cluster: table.cluster, wallet: table.seats[seat]?.wallet ?? "", agreed };
      });
      if (action !== "vote" || acted.agreed) {
        await noteActivity({
          kind: action === "vote" ? "vote" : action,
          table: id,
          cluster: acted.cluster,
          seat,
          wallet: acted.wallet,
          detail: action === "vote" ? "start" : "",
        });
      }
    }
    await settleMoney(id);
    return publish(toView(await loadTable(id), await currentSeat(id)));
  } catch (error) {
    const missing = error instanceof Error && error.message === "No table is using that id.";
    return jsonError(error, missing ? 404 : 400);
  }
}
