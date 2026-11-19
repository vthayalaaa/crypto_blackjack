import { sameWallet } from "./keys.ts";
import type { Cluster, Phase } from "../table-view.ts";

/** A waiting or live hand this browser can open again. No seat keys, cards, or other wallets. */
export type CurrentTable = {
  id: string;
  cluster: Cluster;
  phase: "waiting" | "acting";
  stake: string;
  seat: number;
  seats: number;
  funded: boolean;
  turn: boolean;
};

export const CURRENT_TABLE_CAP = 8;

type SeatLike = { address: string; wallet: string; funded: boolean; out: boolean };

export type RejoinTable = {
  cluster: Cluster;
  phase: Phase;
  stake: string;
  turn: number;
  createdAt?: number;
  seats: SeatLike[];
};

type Identity = {
  wallet: string;
  session: { tableId: string; seat: number } | null;
};

/**
 * The connected wallet wins. The seat cookie counts only when it still points
 * at a taken seat, and only when that seat has no other wallet recorded.
 */
export function currentSeatIndex(table: RejoinTable, tableId: string, input: Identity): number {
  const wallet = input.wallet.trim();
  if (wallet) {
    const match = table.seats.findIndex((seat) => seat.address && sameWallet(table.cluster, seat.wallet, wallet));
    if (match >= 0) return match;
  }
  const session = input.session;
  if (!session || session.tableId !== tableId) return -1;
  const seat = table.seats[session.seat];
  if (!seat?.address) return -1;
  // A recorded wallet has to be the one connected now. A signed-out browser keeps the cookie, but not the list.
  if (seat.wallet && !sameWallet(table.cluster, seat.wallet, wallet)) return -1;
  return session.seat;
}

export function listCurrentTables(
  tables: Record<string, RejoinTable>,
  input: Identity & { cluster: Cluster },
): CurrentTable[] {
  const ranked: { row: CurrentTable; createdAt: number }[] = [];
  for (const [id, table] of Object.entries(tables)) {
    if (table.cluster !== input.cluster) continue;
    if (table.phase !== "waiting" && table.phase !== "acting") continue;
    const seat = currentSeatIndex(table, id, input);
    if (seat < 0) continue;
    const slot = table.seats[seat];
    if (!slot) continue;
    ranked.push({
      createdAt: table.createdAt ?? 0,
      row: {
        id,
        cluster: table.cluster,
        phase: table.phase,
        stake: table.stake,
        seat,
        seats: table.seats.length,
        funded: slot.funded,
        turn: table.phase === "acting" && table.turn === seat && !slot.out,
      },
    });
  }
  ranked.sort((left, right) => {
    const phase = Number(right.row.phase === "acting") - Number(left.row.phase === "acting");
    if (phase !== 0) return phase;
    if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt;
    return left.row.id < right.row.id ? -1 : left.row.id > right.row.id ? 1 : 0;
  });
  return ranked.slice(0, CURRENT_TABLE_CAP).map((item) => item.row);
}

/** Reuse the cookie for this seat when it is still valid. Otherwise reuse any session for that seat, or mint one. */
export function sessionTokenFor(
  sessions: Record<string, { tableId: string; seat: number }>,
  tableId: string,
  seat: number,
  current: string | null,
  create: () => string,
): string {
  if (current && validToken(current)) {
    const own = sessions[current];
    if (own && own.tableId === tableId && own.seat === seat) return current;
  }
  for (const [token, session] of Object.entries(sessions)) {
    if (session.tableId === tableId && session.seat === seat && validToken(token)) return token;
  }
  const created = create();
  if (!validToken(created)) throw new Error("The table could not do that.");
  sessions[created] = { tableId, seat };
  return created;
}

function validToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{16,64}$/.test(token);
}
