import { randomBytes } from "node:crypto";
import { isEthCluster } from "../../../lib/table-view";
import { blankTable, toView } from "../../../lib/server/engine";
import { jsonError, publish, setSeatCookie } from "../../../lib/server/http";
import { assertWallet, newEthSeat, newSolanaSeat } from "../../../lib/server/keys";
import { parseCluster, quote } from "../../../lib/server/money";
import { assertClear } from "../../../lib/server/sanctions";
import { update } from "../../../lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { cluster?: unknown; stake?: unknown; invite?: unknown; wallet?: unknown };
    const cluster = parseCluster(body.cluster);
    const priced = quote(cluster, typeof body.stake === "string" ? body.stake : "");
    const invite = typeof body.invite === "string" ? body.invite.trim() : "";
    const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
    if (invite) {
      assertWallet(cluster, invite);
      await assertClear(cluster, invite);
    }
    if (wallet) {
      assertWallet(cluster, wallet);
      await assertClear(cluster, wallet);
    }
    const seat = isEthCluster(cluster) ? newEthSeat() : newSolanaSeat();
    const id = randomBytes(9).toString("base64url");
    const token = randomBytes(24).toString("base64url");
    const table = blankTable({
      id,
      cluster,
      stake: priced.stake,
      due: priced.due,
      buffer: priced.buffer,
      invite,
      playerSeat: seat.address,
      playerSecret: seat.secret,
    });
    if (wallet) table.playerWallet = wallet;
    await update((db) => {
      db.tables[id] = table;
      db.sessions[token] = { tableId: id, seat: "player" };
    });
    await setSeatCookie(token);
    return publish(toView(table, "player"));
  } catch (error) {
    return jsonError(error);
  }
}
