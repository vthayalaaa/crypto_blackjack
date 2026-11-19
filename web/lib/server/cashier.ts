import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, sepolia } from "viem/chains";
import { isEthCluster, type Cluster } from "../table-view.ts";
import type { SecretTable } from "./engine.ts";
import { assertClear } from "./sanctions.ts";
import { update } from "./store.ts";

const SOL_FEE = 5_000n;

export async function assertPayment(
  table: SecretTable,
  signature: string,
  wallet: string,
  seat: string,
  due: bigint,
): Promise<void> {
  if (isEthCluster(table.cluster)) {
    const tx = await ethClient(table.cluster).getTransaction({ hash: signature as Hex });
    if (!tx) throw new Error("That transfer is not on Sepolia yet.");
    if (tx.to?.toLowerCase() !== seat.toLowerCase()) throw new Error("That transfer did not pay this seat.");
    if (tx.from.toLowerCase() !== wallet.toLowerCase()) throw new Error("That transfer came from a different wallet.");
    if (tx.value < due) throw new Error("That transfer is short of the buy-in.");
    await ethClient(table.cluster).waitForTransactionReceipt({ hash: signature as Hex });
    return;
  }
  const connection = solanaConnection(table.cluster);
  const parsed = await connection.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!parsed || parsed.meta?.err) throw new Error("That transfer is not confirmed yet.");
  const keys = parsed.transaction.message.accountKeys.map((key) => key.pubkey.toBase58());
  const source = keys.indexOf(wallet);
  const destination = keys.indexOf(seat);
  if (source < 0 || destination < 0 || !parsed.meta) throw new Error("That transfer did not pay this seat.");
  const gained = BigInt(parsed.meta.postBalances[destination]! - parsed.meta.preBalances[destination]!);
  if (gained < due) throw new Error("That transfer is short of the buy-in.");
}

export async function settleMoney(id: string): Promise<void> {
  const claimed = await update((db) => {
    const table = db.tables[id];
    if (!table || table.paying) return null;
    if (table.phase !== "settled" && table.phase !== "cancelled") return null;
    const pending = legs(table).filter((leg) => !table.paid[leg.id] && leg.secret && leg.to);
    if (pending.length === 0) return null;
    table.paying = true;
    table.payoutError = "";
    return pending.map((leg) => ({ ...leg, cluster: table.cluster }));
  });
  if (!claimed) return;
  try {
    for (const leg of claimed) {
      const signature = await send(leg.cluster, leg.secret, leg.to, leg.amount);
      await update((db) => {
        const current = db.tables[id];
        if (!current || current.paid[leg.id]) return;
        current.paid[leg.id] = true;
        current.payouts.push(signature);
        current.payoutError = "";
      });
    }
  } catch (error) {
    const message = safeError(error);
    await update((db) => {
      const current = db.tables[id];
      if (current) current.payoutError = message;
    });
  } finally {
    await update((db) => {
      const current = db.tables[id];
      if (current) current.paying = false;
    });
  }
}

export async function unlockPayout(id: string): Promise<void> {
  await update((db) => {
    const table = db.tables[id];
    if (table) table.paying = false;
  });
  await settleMoney(id);
}

function legs(table: SecretTable): { id: "player" | "dealer"; secret: string; to: string; amount: bigint }[] {
  const stake = BigInt(table.stake);
  if (table.phase === "cancelled") {
    const out: { id: "player" | "dealer"; secret: string; to: string; amount: bigint }[] = [];
    if (table.playerFunded && table.playerWallet && table.playerSecret) {
      out.push({ id: "player", secret: table.playerSecret, to: table.playerWallet, amount: stake });
    }
    if (table.dealerFunded && table.dealerWallet && table.dealerSecret) {
      out.push({ id: "dealer", secret: table.dealerSecret, to: table.dealerWallet, amount: stake });
    }
    return out;
  }
  if (table.outcome === 3) {
    return [
      { id: "player", secret: table.playerSecret, to: table.playerWallet, amount: stake },
      { id: "dealer", secret: table.dealerSecret, to: table.dealerWallet, amount: stake },
    ];
  }
  const winner = table.outcome === 1 ? table.playerWallet : table.dealerWallet;
  return [
    { id: "player", secret: table.playerSecret, to: winner, amount: stake },
    { id: "dealer", secret: table.dealerSecret, to: winner, amount: stake },
  ];
}

async function send(cluster: SecretTable["cluster"], secret: string, to: string, amount: bigint): Promise<string> {
  if (!secret || !to) throw new Error("This seat has nobody to pay.");
  await assertClear(cluster, to);
  if (isEthCluster(cluster)) {
    const account = privateKeyToAccount(secret as Hex);
    const chain = cluster === "ethereum" ? mainnet : sepolia;
    const client = createWalletClient({ account, chain, transport: http(ethRpc(cluster)) });
    return client.sendTransaction({ account, chain, to: to as Hex, value: amount });
  }
  const from = Keypair.fromSecretKey(Buffer.from(secret, "base64"));
  const connection = solanaConnection(cluster);
  const balance = BigInt(await connection.getBalance(from.publicKey));
  if (balance < amount + SOL_FEE) throw new Error("The seat does not have enough left for the payout and the fee.");
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: from.publicKey,
    toPubkey: new PublicKey(to),
    lamports: Number(amount),
  }));
  return sendAndConfirmTransaction(connection, tx, [from], { commitment: "confirmed" });
}

const SOLANA_MAINNET_RPC = "https://solana-rpc.publicnode.com";
const ETHEREUM_MAINNET_RPC = "https://ethereum-rpc.publicnode.com";

function solanaConnection(cluster: SecretTable["cluster"]): Connection {
  if (cluster === "mainnet") return new Connection(SOLANA_MAINNET_RPC, "confirmed");
  const endpoint = cluster === "localnet"
    ? "http://127.0.0.1:8899"
    : (process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com");
  if (endpoint.includes("mainnet") || endpoint === SOLANA_MAINNET_RPC) {
    throw new Error("This table does not use Solana mainnet.");
  }
  return new Connection(endpoint, "confirmed");
}

function ethRpc(cluster: Cluster): string {
  if (cluster === "ethereum") return ETHEREUM_MAINNET_RPC;
  const endpoint = process.env.NEXT_PUBLIC_ETH_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  if (endpoint.includes("mainnet") || endpoint === ETHEREUM_MAINNET_RPC) {
    throw new Error("This table does not use Ethereum mainnet.");
  }
  return endpoint;
}

function ethClient(cluster: Cluster) {
  const chain = cluster === "ethereum" ? mainnet : sepolia;
  return createPublicClient({ chain, transport: http(ethRpc(cluster)) });
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "The payout could not be sent.";
  return raw.replace(/0x[0-9a-fA-F]{64}/g, "0x…").slice(0, 240);
}
