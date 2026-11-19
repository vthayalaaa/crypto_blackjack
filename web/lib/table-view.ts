export type Cluster = "devnet" | "localnet" | "mainnet" | "sepolia" | "ethereum";

export function isEthCluster(cluster: Cluster): boolean {
  return cluster === "sepolia" || cluster === "ethereum";
}

export function networkLabel(cluster: Cluster): string {
  switch (cluster) {
    case "mainnet": return "Solana mainnet";
    case "localnet": return "Solana localnet";
    case "sepolia": return "Ethereum Sepolia";
    case "ethereum": return "Ethereum mainnet";
    default: return "Solana devnet";
  }
}

const CLUSTERS: readonly Cluster[] = ["devnet", "localnet", "mainnet", "sepolia", "ethereum"];

/** A missing chain means Solana mainnet. Any other known name is that network. */
export function chainFromUrl(value: string | null): Cluster | null {
  return value !== null && (CLUSTERS as readonly string[]).includes(value) ? value as Cluster : null;
}

/** Solana mainnet stays at /. Every other network keeps its name in the link. */
export function networkHref(cluster: Cluster, tableId = ""): string {
  const params = new URLSearchParams();
  if (cluster !== "mainnet") params.set("chain", cluster);
  if (tableId) params.set("table", tableId);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}
/** A seated player is a zero-based index. Seven is the usual full table. */
export type Seat = number | "spectator";
export type Phase = "waiting" | "acting" | "settled" | "cancelled";

export const MIN_SEATS = 2;
export const MAX_SEATS = 7;

export function parseSeats(value: unknown): number {
  if (value === undefined || value === null || value === "") return MIN_SEATS;
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < MIN_SEATS || parsed > MAX_SEATS) {
    throw new Error("A table seats 2 to 7 players.");
  }
  return parsed;
}

export type SeatView = {
  index: number;
  address: string;
  wallet: string;
  funded: boolean;
  cards: number[];
  faceDown: number;
  out: boolean;
  /** This seated player voted to start before the empty seats fill. */
  ready: boolean;
};

/** What the browser is allowed to see. No seat keys and no undealt cards. */
export type TableView = {
  id: string;
  cluster: Cluster;
  stake: string;
  due: string;
  buffer: string;
  pot: string;
  phase: Phase;
  turn: number;
  winners: number[];
  yourSeat: Seat;
  seats: SeatView[];
  invite: string;
  hitsLeft: number;
  deadline: number;
  payouts: string[];
  payoutError: string;
  depositAddress: string;
};
