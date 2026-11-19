import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { createPublicClient, createWalletClient, http, keccak256, TransactionReceiptNotFoundError, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, sepolia } from "viem/chains";
import { isEthCluster, type Cluster } from "../table-view.ts";
import { noteActivity, seatFromLeg } from "./activity.ts";
import type { PayoutSend, SecretTable } from "./engine.ts";
import { openSecret } from "./keys.ts";
import { LockBusyError, withFileLock } from "./lockfile.ts";
import { mainnetBuyIn } from "./money.ts";
import { base58, ethLanding, ethReceiptIsFor, payLeg, pollLanding, solanaLanding, type Landing, type Rail } from "./payout.ts";
import { assertClear } from "./sanctions.ts";
import { inspect, update } from "./store.ts";

const SOL_FEE = 5_000n;

export async function assertPayment(
  table: SecretTable,
  signature: string,
  wallet: string,
  seat: string,
  due: bigint,
): Promise<void> {
  if (isEthCluster(table.cluster)) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(signature)) throw new Error("That is not a transaction hash.");
    const client = ethClient(table.cluster);
    // Wait for the mined result first. A pending transfer can still be replaced by
    // another one with the same nonce, and the wait then returns the replacement.
    const receipt = await client.waitForTransactionReceipt({
      hash: signature as Hex,
      confirmations: table.cluster === "ethereum" ? 2 : 1,
    });
    if (!ethReceiptIsFor(receipt, signature)) throw new Error("That transfer was replaced or did not go through.");
    // Read the mined transaction by the same hash. Its fields can no longer change.
    const tx = await client.getTransaction({ hash: signature as Hex });
    if (!tx || !tx.blockNumber) throw new Error("That transfer is not confirmed yet.");
    if (tx.to?.toLowerCase() !== seat.toLowerCase()) throw new Error("That transfer did not pay this seat.");
    if (tx.from.toLowerCase() !== wallet.toLowerCase()) throw new Error("That transfer came from a different wallet.");
    if (tx.value < due) throw new Error("That transfer is short of the buy-in.");
    return;
  }
  const parsed = await solanaTransfer(table.cluster, signature);
  if (!parsed || parsed.meta?.err || !parsed.meta) throw new Error("That transfer is not confirmed yet.");
  const problem = solanaPaymentProblem({
    keys: parsed.transaction.message.accountKeys.map((key) => ({ pubkey: key.pubkey.toBase58(), signer: key.signer })),
    pre: parsed.meta.preBalances,
    post: parsed.meta.postBalances,
  }, wallet, seat, due);
  if (problem) throw new Error(problem);
}

export { ethReceiptIsFor };

/**
 * The claimed wallet has to have signed the transfer and paid the buy-in itself.
 * Being named in the transaction is not enough.
 */
export function solanaPaymentProblem(
  tx: { keys: { pubkey: string; signer: boolean }[]; pre: number[]; post: number[] },
  wallet: string,
  seat: string,
  due: bigint,
): string {
  const source = tx.keys.findIndex((key) => key.pubkey === wallet);
  const destination = tx.keys.findIndex((key) => key.pubkey === seat);
  if (source < 0 || destination < 0) return "That transfer did not pay this seat.";
  if (!tx.keys[source]!.signer) return "That transfer came from a different wallet.";
  const gained = BigInt(tx.post[destination] ?? 0) - BigInt(tx.pre[destination] ?? 0);
  if (gained < due) return "That transfer is short of the buy-in.";
  const spent = BigInt(tx.pre[source] ?? 0) - BigInt(tx.post[source] ?? 0);
  if (spent < due) return "That transfer came from a different wallet.";
  return "";
}

/** Mainnet waits for a finalized block. The browser only waited for a confirmed one, so give it a little time. */
async function solanaTransfer(cluster: Cluster, signature: string) {
  const connection = solanaConnection(cluster);
  const commitment = cluster === "mainnet" ? "finalized" : "confirmed";
  const tries = cluster === "mainnet" ? 20 : 1;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const parsed = await connection.getParsedTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 });
    if (parsed) return parsed;
    if (attempt + 1 < tries) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return null;
}

const cashierDir = path.join(process.cwd(), "data", "cashier");

/**
 * Pay whatever a settled table still owes. One cashier per table, across every
 * process that shares `data/`. If another process holds this table's lock it is
 * already paying these legs, so this call does nothing.
 */
export async function settleMoney(id: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
  try {
    await withFileLock(path.join(cashierDir, `${id}.lock`), () => payTable(id), 0);
  } catch (error) {
    if (error instanceof LockBusyError) return;
    throw error;
  }
}

async function payTable(id: string): Promise<void> {
  // Read under the cashier lock. Only the holder writes `sends`, so this copy stays current.
  const work = await inspect((db) => {
    const table = db.tables[id];
    if (!table || (table.phase !== "settled" && table.phase !== "cancelled")) return null;
    const legs = payoutLegs(table).filter((leg) => !table.paid[leg.id] && leg.secret && leg.to);
    return legs.length > 0 ? { cluster: table.cluster, legs, sends: { ...table.sends } } : null;
  });
  if (!work) return;
  await update((db) => {
    const table = db.tables[id];
    if (table) table.payoutError = "";
  });
  try {
    for (const leg of work.legs) {
      const signature = await payLeg(
        railFor(work.cluster, leg.secret, leg.to, leg.amount),
        work.sends[leg.id],
        () => assertClear(work.cluster, leg.to),
        (send) => update((db) => {
          const table = db.tables[id];
          if (!table) throw new Error("No table is using that id.");
          table.sends[leg.id] = send;
        }),
      );
      const noted = await update((db) => {
        const table = db.tables[id];
        if (!table) return null;
        const fresh = table.paid[leg.id] !== true;
        table.paid[leg.id] = true;
        if (!table.payouts.includes(signature)) table.payouts.push(signature);
        table.payoutError = "";
        if (!fresh) return null;
        const index = seatFromLeg(leg.id);
        const own = payoutLegs(table).filter((item) => seatFromLeg(item.id) === index);
        const seatDone = index >= 0 && own.length > 0 && own.every((item) => table.paid[item.id]);
        let buffer = "";
        if (seatDone) {
          try {
            if (BigInt(table.buffer) > 0n) buffer = table.buffer;
          } catch {
            buffer = "";
          }
        }
        return { cluster: table.cluster, amount: leg.amount.toString(), to: leg.to, seat: index, buffer };
      });
      if (noted && noted.seat >= 0) {
        await noteActivity({
          kind: "payout",
          table: id,
          cluster: noted.cluster,
          seat: noted.seat,
          wallet: noted.to,
          amount: noted.amount,
          signature,
        });
        if (noted.buffer) {
          await noteActivity({
            kind: "fees",
            table: id,
            cluster: noted.cluster,
            seat: noted.seat,
            amount: noted.buffer,
            detail: "held in seat",
          });
        }
      }
    }
  } catch (error) {
    const message = safeError(error);
    await update((db) => {
      const table = db.tables[id];
      if (table) table.payoutError = message;
    });
  }
}

export function payoutLegs(table: SecretTable): { id: string; secret: string; to: string; amount: bigint }[] {
  const stake = BigInt(table.stake);
  const funded = table.seats.flatMap((seat, index) => (
    seat.funded && seat.secret && seat.wallet ? [{ index, secret: seat.secret, wallet: seat.wallet }] : []
  ));
  if (table.phase === "cancelled" || table.winners.length === 0) {
    return funded.map((seat) => ({ id: String(seat.index), secret: seat.secret, to: seat.wallet, amount: stake }));
  }
  if (table.winners.length === 1) {
    const winner = table.seats[table.winners[0]!]?.wallet ?? "";
    return funded.map((seat) => ({ id: String(seat.index), secret: seat.secret, to: winner, amount: stake }));
  }
  const shares = splitPot(stake * BigInt(funded.length), table.winners);
  const pools = funded.map((seat) => ({ ...seat, left: stake }));
  const legs: { id: string; secret: string; to: string; amount: bigint }[] = [];
  for (const [winner, share] of shares) {
    let need = share;
    const to = table.seats[winner]?.wallet ?? "";
    for (const pool of pools) {
      if (need === 0n || pool.left === 0n) continue;
      const amount = pool.left < need ? pool.left : need;
      legs.push({ id: `${pool.index}>${winner}`, secret: pool.secret, to, amount });
      pool.left -= amount;
      need -= amount;
    }
  }
  return legs;
}

function splitPot(pot: bigint, winners: number[]): Map<number, bigint> {
  const ordered = [...winners].sort((left, right) => left - right);
  const share = pot / BigInt(ordered.length);
  let remainder = pot % BigInt(ordered.length);
  const amounts = new Map<number, bigint>();
  for (const winner of ordered) {
    const extra = remainder > 0n ? 1n : 0n;
    if (remainder > 0n) remainder -= 1n;
    amounts.set(winner, share + extra);
  }
  return amounts;
}

const WAIT_MS = 60_000;

/** The same signed-transfer path a payout uses. The sweep calls it for the fee reserve. */
export function seatRail(cluster: Cluster, secret: string, to: string, amount: bigint): Rail {
  return railFor(cluster, secret, to, amount);
}

/** Lamports or wei a sweep must leave so the seat can pay the transfer itself. */
export async function sweepNetworkFee(cluster: Cluster): Promise<bigint> {
  if (!isEthCluster(cluster)) return SOL_FEE;
  const fees = await ethClient(cluster).estimateFeesPerGas();
  const perGas = fees.maxFeePerGas ?? 0n;
  if (perGas <= 0n) throw new Error("The network fee could not be read.");
  // A plain transfer is 21,000 gas. The extra fifth covers a small fee movement.
  return 21_000n * perGas * 12n / 10n;
}

/** Refuse a mainnet seat or queue spot when the wallet cannot cover the buy-in. */
export async function assertBuyInBalance(cluster: Cluster, wallet: string, due: bigint): Promise<void> {
  if (!mainnetBuyIn(cluster) || !wallet) return;
  let balance: bigint;
  try {
    balance = await seatBalance(cluster, wallet);
  } catch {
    throw new Error("The wallet balance could not be checked. Try again shortly.");
  }
  if (balance < due) throw new Error("This wallet does not have enough for the buy-in.");
}

export async function seatBalance(cluster: Cluster, address: string): Promise<bigint> {
  if (isEthCluster(cluster)) return ethClient(cluster).getBalance({ address: address as Hex });
  return BigInt(await solanaConnection(cluster).getBalance(new PublicKey(address)));
}

function railFor(cluster: Cluster, secret: string, to: string, amount: bigint): Rail {
  if (!secret || !to) throw new Error("This seat has nobody to pay.");
  return isEthCluster(cluster) ? ethRail(cluster, secret, to, amount) : solanaRail(cluster, secret, to, amount);
}

function solanaRail(cluster: Cluster, secret: string, to: string, amount: bigint): Rail {
  const connection = solanaConnection(cluster);
  const check = async (send: PayoutSend): Promise<Landing> => {
    const finalized = await connection.getBlockHeight("finalized");
    const { value } = await connection.getSignatureStatuses([send.signature], { searchTransactionHistory: true });
    return solanaLanding(value[0] ?? null, finalized, send.expires);
  };
  return {
    check,
    async build() {
      const from = Keypair.fromSecretKey(Buffer.from(openSecret(secret), "base64"));
      const balance = BigInt(await connection.getBalance(from.publicKey));
      if (balance < amount + SOL_FEE) throw new Error("The seat does not have enough left for the payout and the fee.");
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: from.publicKey, blockhash, lastValidBlockHeight }).add(SystemProgram.transfer({
        fromPubkey: from.publicKey,
        toPubkey: new PublicKey(to),
        lamports: Number(amount),
      }));
      tx.sign(from);
      if (!tx.signature) throw new Error("The payout could not be signed.");
      return {
        signature: base58(tx.signature),
        raw: tx.serialize().toString("base64"),
        from: from.publicKey.toBase58(),
        expires: lastValidBlockHeight,
        nonce: 0,
        at: Date.now(),
      };
    },
    async broadcast(send, again) {
      try {
        await connection.sendRawTransaction(Buffer.from(send.raw, "base64"), { skipPreflight: again });
      } catch (error) {
        if (!again) throw error;
      }
    },
    wait: (send) => pollLanding(() => check(send), WAIT_MS, 2_000),
  };
}

function ethRail(cluster: Cluster, secret: string, to: string, amount: bigint): Rail {
  const client = ethClient(cluster);
  const confirmations = cluster === "ethereum" ? 2 : 1;
  const check = async (send: PayoutSend): Promise<Landing> => {
    const receipt = await client.getTransactionReceipt({ hash: send.signature as Hex }).catch((error: unknown) => {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    });
    if (receipt) {
      return ethLanding(receipt, send.signature, await client.getBlockNumber(), confirmations, 0, send.nonce);
    }
    const mined = await client.getTransactionCount({ address: send.from as Hex, blockTag: "latest" });
    return ethLanding(null, send.signature, 0n, confirmations, mined, send.nonce);
  };
  return {
    check,
    async build() {
      const account = privateKeyToAccount(openSecret(secret) as Hex);
      const chain = cluster === "ethereum" ? mainnet : sepolia;
      const wallet = createWalletClient({ account, chain, transport: http(ethRpc(cluster)) });
      const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
      const request = await wallet.prepareTransactionRequest({ account, chain, to: to as Hex, value: amount, nonce });
      const raw = await wallet.signTransaction(request as Parameters<typeof wallet.signTransaction>[0]);
      return { signature: keccak256(raw), raw, from: account.address, expires: 0, nonce, at: Date.now() };
    },
    async broadcast(send, again) {
      try {
        await client.request({ method: "eth_sendRawTransaction", params: [send.raw as Hex] });
      } catch (error) {
        if (!again) throw error;
      }
    },
    wait: (send) => pollLanding(() => check(send), WAIT_MS, 3_000),
  };
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
