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
    if (seat !== "player" && seat !== "dealer") return Response.json({ ok: true });
    const body = await request.json().catch(() => ({})) as { present?: unknown; beat?: unknown };
    const beat = typeof body.beat === "number" ? body.beat : Number(body.beat);
    await update((db) => {
      const table = db.tables[id];
      if (!table) return;
      notePresence(table, seat, body.present === true, beat, Date.now());
    });
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
