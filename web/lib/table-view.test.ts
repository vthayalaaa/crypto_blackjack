import assert from "node:assert/strict";
import { test } from "node:test";
import { chainFromUrl, networkHref } from "./table-view.ts";

test("solana mainnet is the bare lobby link", () => {
  assert.equal(networkHref("mainnet"), "/");
  assert.equal(networkHref("mainnet", "abc"), "/?table=abc");
  assert.equal(networkHref("ethereum"), "/?chain=ethereum");
  assert.equal(networkHref("devnet"), "/?chain=devnet");
  assert.equal(networkHref("devnet", "abc"), "/?chain=devnet&table=abc");
  assert.equal(chainFromUrl(null), null);
  assert.equal(chainFromUrl("devnet"), "devnet");
  assert.equal(chainFromUrl("mainnet"), "mainnet");
  assert.equal(chainFromUrl("nope"), null);
});
