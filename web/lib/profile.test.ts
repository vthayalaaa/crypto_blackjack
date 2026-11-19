import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { test } from "node:test";
import {
  canonicalAddress,
  cleanAvatar,
  cleanUsername,
  profilePath,
  settledResults,
} from "./profile.ts";

test("a wallet address is stored in one form", () => {
  const solana = Keypair.generate().publicKey.toBase58();
  assert.equal(canonicalAddress("solana", `  ${solana}  `), solana);
  assert.equal(
    canonicalAddress("ethereum", "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD"),
    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  );
  assert.throws(() => canonicalAddress("solana", "not-a-key"), /Solana address/);
  assert.throws(() => canonicalAddress("ethereum", solana), /Ethereum address/);
});

test("a settled hand counts each wallet once", () => {
  const first = Keypair.generate().publicKey.toBase58();
  const second = Keypair.generate().publicKey.toBase58();
  const results = settledResults("mainnet", [
    { wallet: first, funded: true, cards: [1, 2] },
    { wallet: first, funded: true, cards: [3, 4] },
    { wallet: second, funded: true, cards: [5, 6] },
    { wallet: second, funded: false, cards: [7, 8] },
    { wallet: "not-a-key", funded: true, cards: [9] },
  ], [0]);
  assert.deepEqual(results, [
    { chain: "solana", address: first, win: true },
    { chain: "solana", address: second, win: false },
  ]);
  assert.deepEqual(settledResults("ethereum", [
    { wallet: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD", funded: true, cards: [1] },
    { wallet: "0x1111111111111111111111111111111111111111", funded: true, cards: [2] },
  ], []), [
    { chain: "ethereum", address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", win: false },
    { chain: "ethereum", address: "0x1111111111111111111111111111111111111111", win: false },
  ]);
});

test("a profile name and picture stay plain", () => {
  assert.equal(cleanUsername("  Ada   Lovelace "), "Ada Lovelace");
  assert.equal(cleanUsername(""), "");
  assert.throws(() => cleanUsername("x".repeat(25)), /24/);
  assert.equal(cleanAvatar(""), "");
  assert.equal(cleanAvatar("https://example.com/a.png"), "https://example.com/a.png");
  assert.throws(() => cleanAvatar("http://example.com/a.png"), /not valid/);
  assert.equal(profilePath("solana", "Abc"), "/profile/solana/Abc");
});
