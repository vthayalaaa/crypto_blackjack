import { chipLabel, STAKE_CHIPS, type LobbyCounts } from "../stakes.ts";
import { isEthCluster, MAX_SEATS, MIN_SEATS, type Cluster } from "../table-view.ts";
import { sameWallet } from "./keys.ts";
import { seatHere } from "./presence.ts";

type OpenSeat = {
  cluster: Cluster;
  phase: string;
  seats?: { address?: string; wallet?: string; seen?: number }[];
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
  seats: number;
  role: number | "";
};

export function findPartner(
  entries: QueueEntry[],
  selfId: string,
  cluster: Cluster,
  stake: string,
  wallet: string,
  now: number,
  seats = 2,
): QueueEntry | null {
  return findPartners(entries, selfId, cluster, stake, seats, wallet, now)?.[0] ?? null;
}

/** The oldest unmatched wallets that want this buy-in and this table size. Null until the table can fill. */
export function findPartners(
  entries: QueueEntry[],
  selfId: string,
  cluster: Cluster,
  stake: string,
  seats: number,
  wallet: string,
  now: number,
): QueueEntry[] | null {
  const found = entries
    .filter((entry) =>
      entry.id !== selfId
      && !entry.tableId
      && entry.cluster === cluster
      && entry.stake === stake
      && (entry.seats ?? 2) === seats
      && now - entry.createdAt <= MATCH_TTL_MS
      && !sameWallet(cluster, entry.wallet, wallet))
    .sort((left, right) => left.createdAt - right.createdAt);
  const unique: QueueEntry[] = [];
  const seen = new Set<string>();
  for (const entry of found) {
    const key = walletKey(cluster, entry.wallet);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
    if (unique.length === seats - 1) return unique;
  }
  return null;
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
    if ((item.seats ?? 2) !== (entry.seats ?? 2)) continue;
    if (now - item.createdAt > MATCH_TTL_MS || !item.wallet) continue;
    if (sameWallet(entry.cluster, item.wallet, entry.wallet)) continue;
    seen.add(walletKey(item.cluster, item.wallet));
  }
  return seen.size;
}

function emptyStakeCounts(): Record<string, Record<string, number>> {
  const stakes: Record<string, Record<string, number>> = {};
  for (let seats = MIN_SEATS; seats <= MAX_SEATS; seats += 1) {
    const row: Record<string, number> = {};
    for (const chip of STAKE_CHIPS) row[chip] = 0;
    stakes[String(seats)] = row;
  }
  return stakes;
}

/**
 * Waiting is the match line. Playing is someone still at a table.
 * The total counts each wallet once. The number under a buy-in counts wallets
 * waiting for that buy-in and that table size. A wallet in two sizes counts in
 * both. Two entries for one size keep the newest buy-in.
 */
export function lobbyCounts(
  queue: Record<string, QueueEntry>,
  tables: Record<string, OpenSeat>,
  cluster: Cluster,
  now: number,
): LobbyCounts {
  const stakes = emptyStakeCounts();
  const playing = new Set<string>();
  let unnamed = 0;
  for (const table of Object.values(tables)) {
    if (table.cluster !== cluster || table.phase === "settled" || table.phase === "cancelled") continue;
    for (const seat of table.seats ?? []) unnamed += seatedWallet(seat, cluster, playing, now);
  }
  const waitingWallets = new Set<string>();
  const newestBySize = new Map<string, { at: number; seats: number; label: string | null }>();
  for (const entry of Object.values(queue)) {
    const seats = entry.seats ?? MIN_SEATS;
    if (!Number.isInteger(seats) || seats < MIN_SEATS || seats > MAX_SEATS) continue;
    if (entry.tableId || entry.cluster !== cluster || now - entry.createdAt > MATCH_TTL_MS || !entry.wallet) continue;
    const key = walletKey(cluster, entry.wallet);
    if (playing.has(key)) continue;
    waitingWallets.add(key);
    const sized = `${seats}:${key}`;
    const prev = newestBySize.get(sized);
    if (prev && prev.at > entry.createdAt) continue;
    newestBySize.set(sized, { at: entry.createdAt, seats, label: chipLabel(cluster, entry.stake) });
  }
  for (const item of newestBySize.values()) {
    if (!item.label) continue;
    const row = stakes[String(item.seats)];
    if (row) row[item.label] = (row[item.label] ?? 0) + 1;
  }
  return { waiting: waitingWallets.size, playing: playing.size + unnamed, stakes };
}

function seatedWallet(
  seat: { address?: string; wallet?: string; seen?: number },
  cluster: Cluster,
  playing: Set<string>,
  now: number,
): number {
  if (!seat.address || !seatHere(seat.seen, now)) return 0;
  if (!seat.wallet) return 1;
  playing.add(walletKey(cluster, seat.wallet));
  return 0;
}
