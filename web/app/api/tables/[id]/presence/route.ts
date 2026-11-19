import { noteActivity } from "../../../../../lib/server/activity";
import { currentSeat, jsonError } from "../../../../../lib/server/http";
import { notePresence } from "../../../../../lib/server/presence";
import { update } from "../../../../../lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) return Response.json({ ok: true });
    const seat = await currentSeat(id);
    if (typeof seat !== "number") return Response.json({ ok: true });
    const body = await request.json().catch(() => ({})) as { present?: unknown; beat?: unknown };
    const beat = typeof body.beat === "number" ? body.beat : Number(body.beat);
    const left = await update((db) => {
      const table = db.tables[id];
      if (!table) return null;
      const slot = table.seats[seat];
      if (!slot) return null;
      const wasHere = slot.seen > 0;
      notePresence(table, seat, body.present === true, beat, Date.now());
      if (body.present === true || !wasHere || slot.seen > 0) return null;
      return { cluster: table.cluster, wallet: slot.wallet };
    });
    if (left) {
      await noteActivity({
        kind: "leave",
        table: id,
        cluster: left.cluster,
        seat,
        wallet: left.wallet,
        detail: "left",
      });
    }
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
