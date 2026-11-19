import { chipLabel, STAKE_CHIPS, type LobbyCounts } from "../stakes.ts";
import { isEthCluster, type Cluster } from "../table-view.ts";
import { sameWallet } from "./keys.ts";
import { seatHere } from "./presence.ts";

type OpenSeat = {
  cluster: Cluster;
  phase: string;
  playerSeat: string;
  dealerSeat: string;
  playerWallet?: string;
  dealerWallet?: string;
  playerSeen?: number;
  dealerSeen?: number;
};

function walletKey(cluster: Cluster, wallet: string): string {
  return isEthCluster(cluster) ? wallet.trim().toLowerCase() : wallet.trim();
}

export const MATCH_TTL_MS = 15 * 60 * 1000;

export type QueueEntry = {
  id: string;
  cluster: Cluster;
  stake: string;
  wallet: string;
  createdAt: number;
  tableId: string;
  seatToken: string;
  role: "player" | "dealer" | "";
};

export function findPartner(
  entries: QueueEntry[],
  selfId: string,
  cluster: Cluster,
  stake: string,
  wallet: string,
  now: number,
): QueueEntry | null {
  return entries
    .filter((entry) =>
      entry.id !== selfId
      && !entry.tableId
      && entry.cluster === cluster
      && entry.stake === stake
      && now - entry.createdAt <= MATCH_TTL_MS
      && !sameWallet(cluster, entry.wallet, wallet))
    .sort((left, right) => left.createdAt - right.createdAt)[0] ?? null;
}

export function expireQueue(queue: Record<string, QueueEntry>, now: number): void {
  for (const [id, entry] of Object.entries(queue)) {
    if (!entry.tableId && now - entry.createdAt > MATCH_TTL_MS) delete queue[id];
  }
}

/** Other browsers waiting at this stake, one per wallet. The caller's own wallet is not another player. */
export function countOtherWaiters(queue: Record<string, QueueEntry>, entry: QueueEntry, now: number): number {
  const seen = new Set<string>();
  for (const item of Object.values(queue)) {
    if (item.id === entry.id || item.tableId || item.cluster !== entry.cluster || item.stake !== entry.stake) continue;
    if (now - item.createdAt > MATCH_TTL_MS || !item.wallet) continue;
    if (sameWallet(entry.cluster, item.wallet, entry.wallet)) continue;
    seen.add(walletKey(item.cluster, item.wallet));
  }
  return seen.size;
}

/** Waiting is the match line. Playing is someone still at a table. Each wallet counts once. */
export function lobbyCounts(
  queue: Record<string, QueueEntry>,
  tables: Record<string, OpenSeat>,
  cluster: Cluster,
  now: number,
): LobbyCounts {
  const stakes: Record<string, number> = {};
  for (const chip of STAKE_CHIPS) stakes[chip] = 0;
  const playing = new Set<string>();
  let unnamed = 0;
  for (const table of Object.values(tables)) {
    if (table.cluster !== cluster || table.phase === "settled" || table.phase === "cancelled") continue;
    unnamed += seatedWallet(table, "player", cluster, playing, now);
    unnamed += seatedWallet(table, "dealer", cluster, playing, now);
  }
  const waitingByWallet = new Map<string, { at: number; label: string | null }>();
  for (const entry of Object.values(queue)) {
    if (entry.tableId || entry.cluster !== cluster || now - entry.createdAt > MATCH_TTL_MS || !entry.wallet) continue;
    const key = walletKey(cluster, entry.wallet);
    if (playing.has(key)) continue;
    const prev = waitingByWallet.get(key);
    if (prev && prev.at > entry.createdAt) continue;
    waitingByWallet.set(key, { at: entry.createdAt, label: chipLabel(cluster, entry.stake) });
  }
  for (const item of waitingByWallet.values()) {
    if (item.label) stakes[item.label] = (stakes[item.label] ?? 0) + 1;
  }
  return { waiting: waitingByWallet.size, playing: playing.size + unnamed, stakes };
}

function seatedWallet(
  table: OpenSeat,
  seat: "player" | "dealer",
  cluster: Cluster,
  playing: Set<string>,
  now: number,
): number {
  const occupied = seat === "player" ? table.playerSeat : table.dealerSeat;
  const seen = seat === "player" ? table.playerSeen : table.dealerSeen;
  const wallet = seat === "player" ? table.playerWallet : table.dealerWallet;
  if (!occupied || !seatHere(seen, now)) return 0;
  if (!wallet) return 1;
  playing.add(walletKey(cluster, wallet));
  return 0;
}
