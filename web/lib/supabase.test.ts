import assert from "node:assert/strict";
import { test } from "node:test";
import { gameDb } from "./server/supabase.ts";

test("the game database requires the secret key", () => {
  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  try {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    delete process.env.SUPABASE_SECRET_KEY;
    assert.throws(() => gameDb(), /SUPABASE_SECRET_KEY/);
    process.env.SUPABASE_SECRET_KEY = "sb_publishable_example";
    assert.throws(() => gameDb(), /publishable key/);
  } finally {
    if (url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = url;
    if (secret === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = secret;
  }
});
