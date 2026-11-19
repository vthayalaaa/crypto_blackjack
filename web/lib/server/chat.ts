import { noteActivity } from "./activity.ts";
import { chatAccess, chatLine, chatName, cleanChatBody, findKickTarget, kickQuery, type ChatLine } from "../chat.ts";
import { canonicalAddress, profileChainOf, type ProfileChain } from "../profile.ts";
import { voteKick, type SecretTable } from "./engine.ts";
import { currentSeat, loadTable } from "./http.ts";
import { gameDb } from "./supabase.ts";
import { update } from "./store.ts";

function fail(error: { code?: string }): never {
  console.error(error.code ?? "chat");
  if (error.code === "PGRST205" || error.code === "42P01") {
    throw new Error("Run the chat table in web/supabase/schema.sql.");
  }
  throw new Error("The message could not be sent.");
}

export async function listChat(tableId: string): Promise<ChatLine[]> {
  await loadTable(tableId);
  const rows = await gameDb()
    .from("chat_messages")
    .select("id,name,body,created_at")
    .eq("table_id", tableId)
    .order("created_at", { ascending: false })
    .limit(80);
  if (rows.error) fail(rows.error);
  return (rows.data ?? [])
    .map((row) => chatLine(row as { id?: unknown; name?: unknown; body?: unknown; created_at?: unknown }))
    .filter((row): row is ChatLine => row !== null)
    .reverse();
}

export async function postChat(tableId: string, raw: unknown, claimedWallet: unknown): Promise<ChatLine> {
  const body = cleanChatBody(raw);
  const seat = await currentSeat(tableId);
  const table = await loadTable(tableId);
  const wallet = typeof seat === "number" ? table.seats[seat]?.wallet ?? "" : "";
  const chain = profileChainOf(table.cluster);
  const access = chatAccess(typeof seat === "number" ? seat : "spectator", wallet, typeof claimedWallet === "string" ? claimedWallet : "", chain);
  if (!access.canSend) throw new Error(access.notice);
  if (typeof seat !== "number") throw new Error("Sit at the table to chat.");
  if (kickQuery(body) !== null) return castKick(table, seat, wallet, body);
  const address = canonicalAddress(chain, wallet);
  const profile = await gameDb()
    .from("profiles")
    .select("username")
    .eq("chain", chain)
    .eq("address", address)
    .maybeSingle();
  if (profile.error && profile.error.code !== "PGRST116") {
    console.error(profile.error.code ?? "chat");
  }
  const username = typeof profile.data?.username === "string" ? profile.data.username : "";
  return insertLine(tableId, chatName(username, address), body);
}

async function castKick(table: SecretTable, seat: number, wallet: string, body: string): Promise<ChatLine> {
  const query = kickQuery(body) ?? "";
  const chain = profileChainOf(table.cluster);
  const names = await displayNames(table, chain);
  const target = findKickTarget(names, query);
  const targetWallet = table.seats[target]?.wallet ?? "";
  const voterName = names[seat]?.name || wallet;
  const targetName = names[target]?.name || `Player ${target + 1}`;
  const outcome = await update((db) => {
    const live = db.tables[table.id];
    if (!live) throw new Error("No table is using that id.");
    const slot = live.seats[target];
    if (!slot?.address || (targetWallet && slot.wallet !== targetWallet)) throw new Error("Nobody at the table has that name.");
    const result = voteKick(live, seat, target);
    if (result.kicked) {
      for (const [token, session] of Object.entries(db.sessions)) {
        if (session.tableId === table.id && session.seat === target) delete db.sessions[token];
      }
    }
    return result;
  });
  if (outcome.kicked) {
    await noteActivity({ kind: "kick", table: table.id, cluster: table.cluster, seat: target, wallet: targetWallet, detail: "left" });
  }
  const text = outcome.kicked
    ? `${targetName} was removed from the table.`
    : `${voterName} voted to kick ${targetName}. ${outcome.votes} of ${outcome.needed}.`;
  return insertLine(table.id, "Table", text);
}

async function displayNames(table: SecretTable, chain: ProfileChain): Promise<{ address: string; wallet: string; name: string }[]> {
  const wallets = table.seats.map((seat) => {
    if (!seat.wallet) return "";
    try {
      return canonicalAddress(chain, seat.wallet);
    } catch {
      return "";
    }
  });
  const listed = [...new Set(wallets.filter((address) => address))];
  const usernames = new Map<string, string>();
  if (listed.length > 0) {
    const rows = await gameDb().from("profiles").select("address,username").eq("chain", chain).in("address", listed);
    if (rows.error && rows.error.code !== "PGRST116") console.error(rows.error.code ?? "chat");
    for (const row of rows.data ?? []) {
      if (typeof row.address === "string" && typeof row.username === "string") usernames.set(row.address, row.username);
    }
  }
  return table.seats.map((seat, index) => ({
    address: seat.address,
    wallet: seat.wallet,
    name: seat.address ? chatName(usernames.get(wallets[index] ?? "") ?? "", seat.wallet || `Player ${index + 1}`) : "",
  }));
}

async function insertLine(tableId: string, name: string, body: string): Promise<ChatLine> {
  const inserted = await gameDb()
    .from("chat_messages")
    .insert({ table_id: tableId, name, body })
    .select("id,name,body,created_at")
    .single();
  if (inserted.error) fail(inserted.error);
  const line = chatLine(inserted.data as { id?: unknown; name?: unknown; body?: unknown; created_at?: unknown });
  if (!line) throw new Error("The message could not be sent.");
  return line;
}
