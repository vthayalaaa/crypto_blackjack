/** Fixed buy-ins for invite and match. The same list on every network. */
export const STAKE_CHIPS = ["0.05", "0.1", "0.25", "0.5", "1", "5", "10", "20", "50", "100"] as const;

type StakeCluster = "devnet" | "localnet" | "mainnet" | "sepolia" | "ethereum";

export type LobbyCounts = {
  waiting: number;
  playing: number;
  /** Waiters at each buy-in, one map per table size ("2" through "7"). */
  stakes: Record<string, Record<string, number>>;
};

export function chipUnits(cluster: StakeCluster, chip: string): bigint {
  const decimals = cluster === "sepolia" || cluster === "ethereum" ? 18 : 9;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(chip);
  if (!match || (match[2]?.length ?? 0) > decimals) throw new Error("Unknown buy-in.");
  const frac = (match[2] ?? "").padEnd(decimals, "0");
  return BigInt(match[1] || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

export function chipLabel(cluster: StakeCluster, units: string): string | null {
  for (const chip of STAKE_CHIPS) {
    if (chipUnits(cluster, chip).toString() === units) return chip;
  }
  return null;
}
