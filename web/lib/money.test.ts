import assert from "node:assert/strict";
import { test } from "node:test";
import { quote } from "./server/money.ts";

test("a 100 buy-in is accepted and 101 is not", () => {
  assert.equal(quote("devnet", "100").stake, 100_000_000_000n);
  assert.equal(quote("sepolia", "100").stake, 100n * 10n ** 18n);
  assert.equal(quote("devnet", "0.05").stake, 50_000_000n);
  assert.equal(quote("mainnet", "0.05").stake, 50_000_000n);
  assert.equal(quote("ethereum", "0.05").stake, 50_000_000_000_000_000n);
  assert.equal(quote("devnet", "0.01").stake, 10_000_000n);
  assert.throws(() => quote("devnet", "0.0001"), /between 0.01 and 100 SOL/);
  assert.throws(() => quote("sepolia", "0.0001"), /between 0.01 and 100 ETH/);
  assert.throws(() => quote("devnet", "101"), /between 0.01 and 100 SOL/);
  assert.throws(() => quote("sepolia", "101"), /between 0.01 and 100 ETH/);
});
