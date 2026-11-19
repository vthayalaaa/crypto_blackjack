import { PublicKey } from "@solana/web3.js";

export type ProfileChain = "solana" | "ethereum";

export type PublicProfile = {
  chain: ProfileChain;
  address: string;
  username: string;
  avatarUrl: string;
  gamesPlayed: number;
  wins: number;
};

export function profileChainOf(cluster: string): ProfileChain {
  return cluster === "sepolia" || cluster === "ethereum" ? "ethereum" : "solana";
}

export function parseProfileChain(value: unknown): ProfileChain {
  if (value === "solana" || value === "ethereum") return value;
  throw new Error("That network has no profile.");
}

/** The stored address. Ethereum is lowercase. Solana stays the canonical base58 text. */
export function canonicalAddress(chain: ProfileChain, value: string): string {
  const trimmed = value.trim();
  if (chain === "ethereum") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) throw new Error("That is not an Ethereum address.");
    return trimmed.toLowerCase();
  }
  try {
    const key = new PublicKey(trimmed);
    if (!PublicKey.isOnCurve(key.toBytes())) throw new Error("off curve");
    return key.toBase58();
  } catch (error) {
    if (error instanceof Error && error.message === "That is not a Solana address.") throw error;
    throw new Error("That is not a Solana address.");
  }
}

export function profilePath(chain: ProfileChain, address: string): string {
  return `/profile/${chain}/${encodeURIComponent(address)}`;
}

export type CountedSeat = { wallet: string; funded: boolean; cards: readonly number[] };

/**
 * One finished hand. A push is played and is not a win. An empty or unfunded
 * seat is not played. Two seats with the same wallet count once.
 */
export function settledResults(
  cluster: string,
  seats: readonly CountedSeat[],
  winners: readonly number[],
): { chain: ProfileChain; address: string; win: boolean }[] {
  const chain = profileChainOf(cluster);
  const byAddress = new Map<string, boolean>();
  seats.forEach((seat, index) => {
    if (!seat.funded || seat.cards.length === 0 || !seat.wallet) return;
    let address: string;
    try {
      address = canonicalAddress(chain, seat.wallet);
    } catch {
      return;
    }
    const win = winners.includes(index);
    byAddress.set(address, (byAddress.get(address) ?? false) || win);
  });
  return [...byAddress].map(([address, win]) => ({ chain, address, win }));
}

/** Empty is allowed. Anything else is a short display name. */
export function cleanUsername(value: unknown): string {
  if (typeof value !== "string") throw new Error("The username is not valid.");
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length > 24) throw new Error("Use a username of 24 characters or fewer.");
  if (name && !/^[\p{L}\p{N} _.'-]+$/u.test(name)) throw new Error("The username is not valid.");
  return name;
}

/** Empty clears the picture. A picture is an https link. */
export function cleanAvatar(value: unknown): string {
  if (typeof value !== "string") throw new Error("The avatar link is not valid.");
  const url = value.trim();
  if (!url) return "";
  if (url.length > 300) throw new Error("The avatar link is not valid.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The avatar link is not valid.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("The avatar link is not valid.");
  }
  return parsed.toString();
}
