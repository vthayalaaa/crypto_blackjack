import { randomBytes } from "node:crypto";
import { noteActivity } from "../../../lib/server/activity";
import { assertBuyInBalance } from "../../../lib/server/cashier";
import { blankTable, startBuyInClock, takeSeat, toView } from "../../../lib/server/engine";
import { jsonError, queueToken, setQueueCookie, setSeatCookie } from "../../../lib/server/http";
import { assertWallet, newSeat } from "../../../lib/server/keys";
import { limit } from "../../../lib/server/limit";
import { countOtherWaiters, expireQueue, findPartners, type QueueEntry } from "../../../lib/server/match";
import { parseCluster, quote } from "../../../lib/server/money";
import { SanctionedWalletError, assertClear } from "../../../lib/server/sanctions";
import { inspect, update } from "../../../lib/server/store";
import { parseSeats, type Cluster, type TableView } from "../../../lib/table-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MatchBody =
  | { status: "idle" }
  | { status: "waiting"; stake: string; cluster: Cluster; others: number; seats: number }
  | { status: "matched"; table: TableView };

type StoredMatch =
  | { status: "idle" }
  | { status: "waiting"; stake: string; cluster: Cluster; others: number; seats: number }
  | { status: "matched"; table: TableView; seatToken: string; seated?: { seat: number; wallet: string }[] };

export async function GET() {
  try {
    const token = await queueToken();
    if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return Response.json({ status: "idle" } satisfies MatchBody);
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
      if (!table || entry.role === "") return { status: "idle" } as StoredMatch;
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
    limit(request, "match", 20);
    const body = await request.json() as { cluster?: unknown; stake?: unknown; wallet?: unknown; seats?: unknown };
    const cluster = parseCluster(body.cluster);
    const seats = parseSeats(body.seats);
    const priced = quote(cluster, typeof body.stake === "string" ? body.stake : "");
    const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
    assertWallet(cluster, wallet);
    await assertClear(cluster, wallet);
    await assertBuyInBalance(cluster, wallet, priced.due);
    const existing = await queueToken();
    const token = existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing) ? existing : randomBytes(18).toString("base64url");
    const now = Date.now();
    const result = await update((db) => {
      expireQueue(db.queue, now);
      let entry = db.queue[token];
      if (entry?.tableId && entry.role !== "") {
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
          seats,
          role: "",
        };
        db.queue[token] = entry;
      } else {
        entry.cluster = cluster;
        entry.stake = priced.stake.toString();
        entry.wallet = wallet;
        entry.seats = seats;
        entry.createdAt = now;
      }
      const partners = findPartners(Object.values(db.queue), entry.id, cluster, entry.stake, seats, wallet, now);
      if (!partners) return waitingBody(db.queue, entry);
      const tableId = randomBytes(9).toString("base64url");
      const ordered = [...partners, entry];
      const keys = ordered.map(() => newSeat(cluster));
      const table = blankTable({
        id: tableId,
        cluster,
        stake: priced.stake,
        due: priced.due,
        buffer: priced.buffer,
        invite: "",
        capacity: ordered.length,
        playerSeat: keys[0]!.address,
        playerSecret: keys[0]!.secret,
      });
      table.seats[0]!.wallet = ordered[0]!.wallet;
      const tokens = ordered.map(() => randomBytes(18).toString("base64url"));
      for (let index = 1; index < ordered.length; index += 1) {
        takeSeat(table, index, { address: keys[index]!.address, secret: keys[index]!.secret, wallet: ordered[index]!.wallet });
      }
      startBuyInClock(table, now);
      db.tables[tableId] = table;
      ordered.forEach((person, index) => {
        db.sessions[tokens[index]!] = { tableId, seat: index };
        person.tableId = tableId;
        person.seatToken = tokens[index]!;
        person.role = index;
      });
      const caller = ordered.length - 1;
      return {
        status: "matched" as const,
        table: toView(table, caller),
        seatToken: tokens[caller]!,
        seated: ordered.map((person, index) => ({ seat: index, wallet: person.wallet })),
      };
    });
    if (result.status === "matched" && result.seated) {
      for (const person of result.seated) {
        await noteActivity({
          kind: "join",
          table: result.table.id,
          cluster: result.table.cluster,
          seat: person.seat,
          wallet: person.wallet,
          detail: "matched",
        });
      }
    }
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
      if (entry.tableId && entry.role !== "") {
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
    seats: entry.seats ?? 2,
  };
}

function containsSecret(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "playerSecret" || key === "dealerSecret" || key === "deck" || key === "secret") return true;
    if (containsSecret(child)) return true;
  }
  return false;
}

function publishMatch(body: MatchBody): Response {
  if (body.status === "matched") {
    if (containsSecret(body.table)) throw new Error("Refusing to send a private table.");
  }
  return Response.json(body);
}
