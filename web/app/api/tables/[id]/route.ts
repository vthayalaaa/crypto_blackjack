import { jsonError, loadTable, publish, currentSeat, viewOf } from "../../../../lib/server/http";
import { rememberSeatWallet } from "../../../../lib/server/keys";
import { notePresence } from "../../../../lib/server/presence";
import { assertClear, assertClearIfWallet } from "../../../../lib/server/sanctions";
import { update } from "../../../../lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) return jsonError(new Error("That table link is not valid."), 404);
    const seat = await currentSeat(id);
    const beat = Number(new URL(request.url).searchParams.get("beat"));
    if ((seat === "player" || seat === "dealer") && Number.isInteger(beat) && beat > 0) {
      const existing = await loadTable(id);
      const seatedWallet = seat === "player" ? existing.playerWallet : existing.dealerWallet;
      if (seatedWallet) await assertClear(existing.cluster, seatedWallet);
      await assertClearIfWallet(existing.cluster, request.headers.get("x-bj-wallet") ?? "");
      const table = await update((db) => {
        const found = db.tables[id];
        if (!found) return null;
        notePresence(found, seat, true, beat, Date.now());
        const claimed = request.headers.get("x-bj-wallet") ?? "";
        if (seat === "player") found.playerWallet = rememberSeatWallet(found.cluster, found.playerWallet, claimed);
        else found.dealerWallet = rememberSeatWallet(found.cluster, found.dealerWallet, claimed);
        return found;
      });
      if (!table) return jsonError(new Error("No table is using that id."), 404);
      return publish(viewOf(table, seat));
    }
    return publish(viewOf(await loadTable(id), seat));
  } catch (error) {
    const missing = error instanceof Error && error.message === "No table is using that id.";
    return jsonError(error, missing ? 404 : 400);
  }
}
