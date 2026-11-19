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

/** Devnet stays at /. Every other network keeps its name in the link. */
export function networkHref(cluster: Cluster, tableId = ""): string {
  const params = new URLSearchParams();
  if (cluster !== "devnet") params.set("chain", cluster);
  if (tableId) params.set("table", tableId);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}
export type Seat = "player" | "dealer" | "spectator";
export type Phase = "waiting" | "player" | "second" | "settled" | "cancelled";

/** What the browser is allowed to see. No seat keys and no undealt cards. */
export type TableView = {
  id: string;
  cluster: Cluster;
  stake: string;
  due: string;
  buffer: string;
  pot: string;
  phase: Phase;
  outcome: 0 | 1 | 2 | 3;
  yourSeat: Seat;
  playerSeat: string;
  dealerSeat: string;
  playerWallet: string;
  dealerWallet: string;
  playerFunded: boolean;
  dealerFunded: boolean;
  invite: string;
  playerCards: number[];
  dealerCards: number[];
  playerFaceDown: number;
  dealerFaceDown: number;
  hitsLeft: number;
  deadline: number;
  payouts: string[];
  payoutError: string;
  depositAddress: string;
};
