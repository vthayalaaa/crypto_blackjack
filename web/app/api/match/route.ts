import { randomBytes } from "node:crypto";
import { blankTable, toView } from "../../../lib/server/engine";
import { jsonError, queueToken, setQueueCookie, setSeatCookie } from "../../../lib/server/http";
import { assertWallet, newEthSeat, newSolanaSeat } from "../../../lib/server/keys";
import { countOtherWaiters, expireQueue, findPartner, type QueueEntry } from "../../../lib/server/match";
import { parseCluster, quote } from "../../../lib/server/money";
import { SanctionedWalletError, assertClear } from "../../../lib/server/sanctions";
import { inspect, update } from "../../../lib/server/store";
import { isEthCluster, type Cluster, type TableView } from "../../../lib/table-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MatchBody =
  | { status: "idle" }
  | { status: "waiting"; stake: string; cluster: Cluster; others: number }
  | { status: "matched"; table: TableView };

type StoredMatch =
  | { status: "idle" }
  | { status: "waiting"; stake: string; cluster: Cluster; others: number }
  | { status: "matched"; table: TableView; seatToken: string };

export async function GET() {
  try {
    const token = await queueToken();
    if (!token) return Response.json({ status: "idle" } satisfies MatchBody);
    const waiting = await inspect((db) => db.queue[token]);
    if (waiting && !waiting.tableId && waiting.wallet) {
      try {
        await assertClear(waiting.cluster, waiting.wallet);
      } catch (error) {
        if (error instanceof SanctionedWalletError) {
          await update((db) => {
            delete db.queue[token];
          });
        }
        throw error;
      }
    }
    const result = await update((db) => {
      expireQueue(db.queue, Date.now());
      const entry = db.queue[token];
      if (!entry) return { status: "idle" } as StoredMatch;
      if (!entry.tableId) return waitingBody(db.queue, entry);
      const table = db.tables[entry.tableId];
      if (!table || !entry.role) return { status: "idle" } as StoredMatch;
      return { status: "matched", table: toView(table, entry.role), seatToken: entry.seatToken } as StoredMatch;
    });
    if (result.status === "matched") {
      await setSeatCookie(result.seatToken);
      return publishMatch({ status: "matched", table: result.table });
    }
    return publishMatch(result);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { cluster?: unknown; stake?: unknown; wallet?: unknown };
    const cluster = parseCluster(body.cluster);
    const priced = quote(cluster, typeof body.stake === "string" ? body.stake : "");
    const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
    assertWallet(cluster, wallet);
    await assertClear(cluster, wallet);
    const existing = await queueToken();
    const token = existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing) ? existing : randomBytes(18).toString("base64url");
    const now = Date.now();
    const result = await update((db) => {
      expireQueue(db.queue, now);
      let entry = db.queue[token];
      if (entry?.tableId && entry.role) {
        const table = db.tables[entry.tableId];
        if (table) return { status: "matched" as const, table: toView(table, entry.role), seatToken: entry.seatToken };
      }
      if (!entry || entry.tableId) {
        entry = {
          id: token,
          cluster,
          stake: priced.stake.toString(),
          wallet,
          createdAt: now,
          tableId: "",
          seatToken: "",
          role: "",
        };
        db.queue[token] = entry;
      } else {
        entry.cluster = cluster;
        entry.stake = priced.stake.toString();
        entry.wallet = wallet;
        entry.createdAt = now;
      }
      const partner = findPartner(Object.values(db.queue), entry.id, cluster, entry.stake, wallet, now);
      if (!partner) return waitingBody(db.queue, entry);
      const tableId = randomBytes(9).toString("base64url");
      const playerToken = randomBytes(18).toString("base64url");
      const dealerToken = randomBytes(18).toString("base64url");
      const playerKey = isEthCluster(cluster) ? newEthSeat() : newSolanaSeat();
      const dealerKey = isEthCluster(cluster) ? newEthSeat() : newSolanaSeat();
      const table = blankTable({
        id: tableId,
        cluster,
        stake: priced.stake,
        due: priced.due,
        buffer: priced.buffer,
        invite: "",
        playerSeat: playerKey.address,
        playerSecret: playerKey.secret,
      });
      table.dealerSeat = dealerKey.address;
      table.dealerSecret = dealerKey.secret;
      table.playerWallet = partner.wallet;
      table.dealerWallet = wallet;
      db.tables[tableId] = table;
      db.sessions[playerToken] = { tableId, seat: "player" };
      db.sessions[dealerToken] = { tableId, seat: "dealer" };
      partner.tableId = tableId;
      partner.seatToken = playerToken;
      partner.role = "player";
      entry.tableId = tableId;
      entry.seatToken = dealerToken;
      entry.role = "dealer";
      return { status: "matched" as const, table: toView(table, "dealer"), seatToken: dealerToken };
    });
    await setQueueCookie(token);
    if (result.status === "matched") {
      await setSeatCookie(result.seatToken);
      return publishMatch({ status: "matched", table: result.table });
    }
    return publishMatch(result);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE() {
  try {
    const token = await queueToken();
    if (!token) return publishMatch({ status: "idle" });
    const result = await update((db) => {
      const entry = db.queue[token];
      if (!entry) return { status: "idle" } as StoredMatch;
      if (entry.tableId && entry.role) {
        const table = db.tables[entry.tableId];
        if (!table) return { status: "idle" } as StoredMatch;
        return { status: "matched", table: toView(table, entry.role), seatToken: entry.seatToken } as StoredMatch;
      }
      delete db.queue[token];
      return { status: "idle" } as StoredMatch;
    });
    if (result.status === "matched") {
      await setSeatCookie(result.seatToken);
      return publishMatch({ status: "matched", table: result.table });
    }
    return publishMatch(result);
  } catch (error) {
    return jsonError(error);
  }
}

function waitingBody(queue: Record<string, QueueEntry>, entry: QueueEntry): StoredMatch {
  return {
    status: "waiting",
    stake: entry.stake,
    cluster: entry.cluster,
    others: countOtherWaiters(queue, entry, Date.now()),
  };
}

function publishMatch(body: MatchBody): Response {
  if (body.status === "matched") {
    for (const key of Object.keys(body.table)) {
      if (key === "playerSecret" || key === "dealerSecret" || key === "deck" || key === "secret") {
        throw new Error("Refusing to send a private table.");
      }
    }
  }
  return Response.json(body);
}
