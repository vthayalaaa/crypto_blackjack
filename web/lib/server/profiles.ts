import {
  canonicalAddress,
  cleanAvatar,
  cleanUsername,
  parseProfileChain,
  settledResults,
  type CountedSeat,
  type ProfileChain,
  type PublicProfile,
} from "../profile.ts";
import { gameDb } from "./supabase.ts";

type ProfileRow = {
  chain: ProfileChain;
  address: string;
  username: string;
  avatar_url: string;
};

function fail(error: { code?: string }): never {
  console.error(error.code ?? "profile");
  if (error.code === "PGRST205" || error.code === "42P01") {
    throw new Error("Run the profile tables in web/supabase/schema.sql.");
  }
  throw new Error("The profile could not be saved.");
}

export async function ensureProfile(chainValue: unknown, addressValue: unknown): Promise<PublicProfile> {
  const chain = parseProfileChain(chainValue);
  const address = canonicalAddress(chain, String(addressValue ?? ""));
  const created = await gameDb()
    .from("profiles")
    .upsert({ chain, address }, { onConflict: "chain,address", ignoreDuplicates: true });
  if (created.error) fail(created.error);
  return readProfile(chain, address);
}

export async function updateProfile(
  chainValue: unknown,
  addressValue: unknown,
  username: unknown,
  avatarUrl: unknown,
): Promise<PublicProfile> {
  const chain = parseProfileChain(chainValue);
  const address = canonicalAddress(chain, String(addressValue ?? ""));
  const saved = await ensureProfile(chain, address);
  const next = {
    username: username === undefined ? saved.username : cleanUsername(username),
    avatar_url: avatarUrl === undefined ? saved.avatarUrl : cleanAvatar(avatarUrl),
  };
  const updated = await gameDb().from("profiles").update(next).eq("chain", chain).eq("address", address);
  if (updated.error) fail(updated.error);
  return readProfile(chain, address);
}

/**
 * Record a finished blackjack hand. A later save of the same hand does not
 * add the players again. A failure here does not undo the hand.
 */
export async function recordSettled(table: {
  id: string;
  cluster: string;
  phase: string;
  winners: readonly number[];
  seats: readonly CountedSeat[];
}): Promise<void> {
  if (table.phase !== "settled" || !table.id) return;
  const results = settledResults(table.cluster, table.seats, table.winners);
  if (results.length === 0) return;
  const profiles = await gameDb()
    .from("profiles")
    .upsert(results.map(({ chain, address }) => ({ chain, address })), { onConflict: "chain,address", ignoreDuplicates: true });
  if (profiles.error) {
    console.error(profiles.error.code);
    return;
  }
  const rows = results.map((result) => ({
    hand_id: table.id,
    chain: result.chain,
    address: result.address,
    game: "blackjack",
    win: result.win,
  }));
  const saved = await gameDb()
    .from("profile_results")
    .upsert(rows, { onConflict: "hand_id,chain,address", ignoreDuplicates: true });
  if (saved.error) console.error(saved.error.code);
}

async function readProfile(chain: ProfileChain, address: string): Promise<PublicProfile> {
  const row = await gameDb()
    .from("profiles")
    .select("chain,address,username,avatar_url")
    .eq("chain", chain)
    .eq("address", address)
    .maybeSingle();
  if (row.error) fail(row.error);
  const profile = row.data as ProfileRow | null;
  if (!profile) throw new Error("The profile could not be saved.");
  const games = await gameDb()
    .from("profile_results")
    .select("hand_id", { count: "exact", head: true })
    .eq("chain", chain)
    .eq("address", address);
  if (games.error) fail(games.error);
  const wins = await gameDb()
    .from("profile_results")
    .select("hand_id", { count: "exact", head: true })
    .eq("chain", chain)
    .eq("address", address)
    .eq("win", true);
  if (wins.error) fail(wins.error);
  return {
    chain,
    address,
    username: profile.username ?? "",
    avatarUrl: profile.avatar_url ?? "",
    gamesPlayed: games.count ?? 0,
    wins: wins.count ?? 0,
  };
}
