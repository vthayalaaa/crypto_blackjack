import { jsonError } from "../../../lib/server/http";
import { expireQueue, lobbyCounts } from "../../../lib/server/match";
import { parseCluster } from "../../../lib/server/money";
import { prune } from "../../../lib/server/prune";
import { update } from "../../../lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const cluster = parseCluster(new URL(request.url).searchParams.get("cluster"));
    const body = await update((db) => {
      const now = Date.now();
      expireQueue(db.queue, now);
      prune(db, now);
      return lobbyCounts(db.queue, db.tables, cluster, now);
    });
    return Response.json(body);
  } catch (error) {
    return jsonError(error);
  }
}
