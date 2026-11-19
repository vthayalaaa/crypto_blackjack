import type { PayoutSend } from "./engine.ts";

/** The receipt has to be a success for this exact hash, not for a replacement. */
export function ethReceiptIsFor(receipt: { status: string; transactionHash: string }, hash: string): boolean {
  return receipt.status === "success" && receipt.transactionHash.toLowerCase() === hash.toLowerCase();
}

/**
 * What the chain says about a saved transfer.
 * landed: it paid. pending: it may still land, so only the same bytes may be sent.
 * dead: it can never land, so a new transfer is safe. unknown: cannot tell, send nothing.
 */
export type Landing = "landed" | "pending" | "dead" | "unknown";

export type Rail = {
  check(send: PayoutSend): Promise<Landing>;
  /** Sign a new transfer. Does not broadcast it. */
  build(): Promise<PayoutSend>;
  /** `again` is a rebroadcast of bytes that may already be on-chain, so its errors are not failures. */
  broadcast(send: PayoutSend, again: boolean): Promise<void>;
  wait(send: PayoutSend): Promise<Landing>;
};

export const NOT_CONFIRMED = "The payout was sent and is not confirmed yet. Try again shortly. It will not be sent twice.";
export const NOT_THROUGH = "The payout did not go through. Try again.";
export const CANNOT_TELL = "The payout's state on-chain could not be confirmed, so nothing was sent again. The operator has to check this seat.";

/**
 * Pay one leg at most once.
 *
 * A saved transfer is looked up on-chain before anything else. A new transfer
 * is signed and saved before it is broadcast, so a crash at any point leaves a
 * record the next attempt can check. A new transfer is only built when there is
 * no record, or the chain shows the recorded one can never land.
 */
export async function payLeg(
  rail: Rail,
  prior: PayoutSend | undefined,
  screen: () => Promise<void>,
  save: (send: PayoutSend) => Promise<void>,
): Promise<string> {
  if (prior) {
    const state = await rail.check(prior);
    if (state === "landed") return prior.signature;
    if (state === "unknown") throw new Error(CANNOT_TELL);
    if (state === "pending") {
      await screen();
      await rail.broadcast(prior, true);
      return outcome(prior, await rail.wait(prior));
    }
  }
  await screen();
  const next = await rail.build();
  await save(next);
  await rail.broadcast(next, false);
  return outcome(next, await rail.wait(next));
}

function outcome(send: PayoutSend, state: Landing): string {
  if (state === "landed") return send.signature;
  if (state === "dead") throw new Error(NOT_THROUGH);
  if (state === "unknown") throw new Error(CANNOT_TELL);
  throw new Error(NOT_CONFIRMED);
}

/**
 * Solana. `finalizedHeight` has to be read before the status. A transfer can only
 * land in a block at or below `expires`. If the finalized height was already past
 * that, any block holding the transfer was finalized before the status was read,
 * so a missing status means it never landed.
 */
export function solanaLanding(
  status: { err: unknown; confirmationStatus?: string | null } | null,
  finalizedHeight: number,
  expires: number,
): Landing {
  if (status) {
    const settled = status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized";
    if (!status.err) return settled ? "landed" : "pending";
    // A failure seen only on an unconfirmed fork may not be the final result.
    return status.confirmationStatus === "finalized" ? "dead" : "pending";
  }
  if (!Number.isFinite(expires) || expires <= 0) return "unknown";
  return finalizedHeight > expires ? "dead" : "pending";
}

/**
 * Ethereum. Every payout from a seat uses a nonce taken in order, and the seat
 * key signs nothing else. If the nonce is used and this hash has no receipt,
 * something else used it, so nothing is sent.
 */
export function ethLanding(
  receipt: { status: string; blockNumber: bigint; transactionHash: string } | null,
  hash: string,
  latestBlock: bigint,
  confirmations: number,
  minedNonce: number,
  nonce: number,
): Landing {
  if (receipt) {
    // Same rule as a buy-in: only a receipt for this exact hash says anything about it.
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) return "unknown";
    if (latestBlock - receipt.blockNumber + 1n < BigInt(confirmations)) return "pending";
    return ethReceiptIsFor(receipt, hash) ? "landed" : "dead";
  }
  return minedNonce > nonce ? "unknown" : "pending";
}

export async function pollLanding(check: () => Promise<Landing>, timeoutMs: number, everyMs: number): Promise<Landing> {
  const until = Date.now() + timeoutMs;
  let state: Landing = "pending";
  for (;;) {
    try {
      state = await check();
    } catch {
      state = "pending";
    }
    if (state === "landed" || state === "dead" || Date.now() >= until) return state;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)]! + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}
