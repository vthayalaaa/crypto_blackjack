import { Keypair, PublicKey } from "@solana/web3.js";
import { isAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isEthCluster, type Cluster } from "../table-view.ts";

export function newSolanaSeat(): { address: string; secret: string } {
  const key = Keypair.generate();
  return { address: key.publicKey.toBase58(), secret: Buffer.from(key.secretKey).toString("base64") };
}

export function newEthSeat(): { address: string; secret: string } {
  const secret = generatePrivateKey();
  return { address: privateKeyToAccount(secret).address, secret };
}

export function sameWallet(cluster: Cluster, left: string, right: string): boolean {
  if (!left || !right) return false;
  return isEthCluster(cluster) ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Keep the first wallet recorded for a seat. A later check from that same wallet may refresh it. */
export function rememberSeatWallet(cluster: Cluster, current: string, claimed: string): string {
  const next = claimed.trim();
  if (!next) return current;
  try {
    assertWallet(cluster, next);
  } catch {
    return current;
  }
  if (!current || sameWallet(cluster, current, next)) return next;
  return current;
}

export function assertWallet(cluster: Cluster, value: string): void {
  if (!value) throw new Error("Connect a wallet first.");
  if (isEthCluster(cluster)) {
    if (!isAddress(value)) throw new Error("That is not an Ethereum address.");
    return;
  }
  try {
    const key = new PublicKey(value);
    if (!PublicKey.isOnCurve(key.toBytes())) throw new Error("off curve");
  } catch {
    throw new Error("That is not a Solana address.");
  }
}
