import { createClient, type SupabaseClient } from "@supabase/supabase-js";

if (typeof window !== "undefined") {
  throw new Error("The database client cannot load in the browser.");
}

let client: SupabaseClient | null = null;
let clientKey = "";

/**
 * Server connection for the game tables. Uses the secret key only.
 * The publishable key can be shipped to a browser, so it must not read seat keys or the shoe.
 */
export function gameDb(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SECRET_KEY ?? "";
  if (!url || !key) throw new Error("Set SUPABASE_URL and SUPABASE_SECRET_KEY before using the database.");
  if (key.startsWith("sb_publishable_")) throw new Error("SUPABASE_SECRET_KEY must be the secret key, not the publishable key.");
  if (client && clientKey === key) return client;
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      // A secret key is not a JWT. Sending it as a Bearer token is rejected.
      fetch(input, init) {
        const headers = new Headers(init?.headers);
        if (!key.startsWith("eyJ")) headers.delete("Authorization");
        headers.set("apikey", key);
        return fetch(input, { ...init, headers });
      },
    },
  });
  clientKey = key;
  return client;
}
