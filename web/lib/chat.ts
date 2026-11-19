import { canonicalAddress, type ProfileChain } from "./profile.ts";

export type ChatLine = {
  id: string;
  name: string;
  body: string;
  at: string;
};

export type ChatAccess = {
  canSend: boolean;
  wallet: string;
  notice: string;
};

/** The seated address when the connected wallet is that same account. */
export function chatSender(seatAddress: string, connectedAddress: string): string | null {
  if (!seatAddress || !connectedAddress || seatAddress !== connectedAddress) return null;
  return seatAddress;
}

/** Sending follows the wallet connected now. A leftover seat does not keep the composer open. */
export function chatAccess(
  seat: number | "spectator" | undefined,
  seatWallet: string,
  connectedWallet: string,
  chain: ProfileChain,
): ChatAccess {
  if (typeof seat !== "number" || !seatWallet) {
    return { canSend: false, wallet: "", notice: "Sit at the table to chat." };
  }
  const connected = connectedWallet.trim();
  if (!connected) {
    return { canSend: false, wallet: "", notice: "Connect your wallet to chat." };
  }
  try {
    const sender = chatSender(canonicalAddress(chain, seatWallet), canonicalAddress(chain, connected));
    if (!sender) return { canSend: false, wallet: "", notice: "Connect the wallet that sat down." };
    return { canSend: true, wallet: connected, notice: "" };
  } catch {
    return { canSend: false, wallet: "", notice: "Connect your wallet to chat." };
  }
}

/** The profile username, or the wallet address when the player has not set one. */
export function chatName(username: string, address: string): string {
  const name = username.trim();
  return name || address;
}

/** The name after `/kick`, or null when the line is an ordinary message. */
export function kickQuery(body: string): string | null {
  const match = body.match(/^\/kick(?:\s+(.*))?$/i);
  if (!match) return null;
  return (match[1] ?? "").trim();
}

/** Seat index for `/kick`. Accepts `Player 3`, the chat name, or the wallet address. */
export function findKickTarget(
  seats: readonly { address: string; wallet: string; name: string }[],
  query: string,
): number {
  const name = query.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Type /kick and the player name.");
  const player = name.match(/^player\s+(\d+)$/i);
  if (player) {
    const index = Number(player[1]) - 1;
    if (!seats[index]?.address) throw new Error("Nobody at the table has that name.");
    return index;
  }
  const folded = name.toLowerCase();
  const matches = seats.flatMap((seat, index) => {
    if (!seat.address) return [];
    if (seat.name.trim().toLowerCase() === folded || seat.wallet === name) return [index];
    return [];
  });
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error("Name the player more exactly.");
  throw new Error("Nobody at the table has that name.");
}

export function cleanChatBody(value: unknown): string {
  if (typeof value !== "string") throw new Error("Write a message first.");
  const body = value.trim().replace(/\s+/g, " ");
  if (!body) throw new Error("Write a message first.");
  if (body.length > 200) throw new Error("Keep the message under 200 characters.");
  return body;
}

export function chatLine(row: { id?: unknown; name?: unknown; body?: unknown; created_at?: unknown; at?: unknown }): ChatLine | null {
  const id = typeof row.id === "string" ? row.id : typeof row.id === "number" ? String(row.id) : "";
  const name = typeof row.name === "string" ? row.name : "";
  const body = typeof row.body === "string" ? row.body : "";
  const at = typeof row.at === "string" ? row.at : typeof row.created_at === "string" ? row.created_at : "";
  if (!id || !name || !body) return null;
  return { id, name, body, at };
}
