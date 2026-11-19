import { isEthCluster, type Cluster } from "../table-view.ts";

const SOL_MIN = 10_000_000n;
const SOL_MAX = 100n * 1_000_000_000n;
const ETH_MIN = 10_000_000_000_000_000n;
const ETH_MAX = 100n * 10n ** 18n;
const SOL_BUFFER = 20_000_000n;
const ETH_BUFFER = 2_000_000_000_000_000n;

export function parseCluster(value: unknown): Cluster {
  if (value === "devnet" || value === "localnet" || value === "mainnet" || value === "sepolia" || value === "ethereum") return value;
  throw new Error("Choose Solana devnet, Solana mainnet, Solana localnet, Ethereum Sepolia, or Ethereum mainnet.");
}

export function quote(cluster: Cluster, text: string): { stake: bigint; due: bigint; buffer: bigint } {
  const eth = isEthCluster(cluster);
  const stake = parseDecimal(text, eth ? 18 : 9, eth ? ETH_MIN : SOL_MIN, eth ? ETH_MAX : SOL_MAX, eth ? "ETH" : "SOL");
  const buffer = eth ? ETH_BUFFER : SOL_BUFFER;
  return { stake, due: stake + buffer, buffer };
}

function parseDecimal(value: string, decimals: number, min: bigint, max: bigint, unit: string): bigint {
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error(`Enter a buy-in in ${unit}.`);
  const frac = match[2] ?? "";
  if (frac.length > decimals) throw new Error(`Enter a buy-in in ${unit}.`);
  const amount = BigInt(match[1] ?? "0") * 10n ** BigInt(decimals) + BigInt((frac || "0").padEnd(decimals, "0"));
  if (amount < min || amount > max) throw new Error(`Buy-in must be between 0.01 and 100 ${unit}.`);
  return amount;
}
