import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { chatAccess, chatLine, chatName, chatSender, cleanChatBody, findKickTarget, kickQuery } from "./chat.ts";

test("a chat name falls back to the wallet address", () => {
  assert.equal(chatName("  Ada ", "SoLanaAddress"), "Ada");
  assert.equal(chatName("   ", "SoLanaAddress"), "SoLanaAddress");
  assert.equal(chatName("", "0xabc"), "0xabc");
});

test("a disconnected wallet cannot keep the seated name", () => {
  const seat = Keypair.generate().publicKey.toBase58();
  const other = Keypair.generate().publicKey.toBase58();
  assert.equal(chatSender(seat, seat), seat);
  assert.equal(chatSender(seat, other), null);
  assert.equal(chatAccess("spectator", "", "", "solana").notice, "Sit at the table to chat.");
  assert.equal(chatAccess(0, seat, "", "solana").canSend, false);
  assert.equal(chatAccess(0, seat, "", "solana").notice, "Connect your wallet to chat.");
  assert.equal(chatAccess(0, seat, other, "solana").notice, "Connect the wallet that sat down.");
  assert.equal(chatAccess(0, seat, seat, "solana").canSend, true);
  const eth = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const mixed = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
  assert.equal(chatAccess(1, eth, mixed, "ethereum").canSend, true);
  assert.equal(chatAccess(1, eth, mixed, "ethereum").wallet, mixed);
});

test("a kick command names a player, a chat name, or a wallet", () => {
  const seats = [
    { address: "a", wallet: "WalletA", name: "Ada" },
    { address: "b", wallet: "WalletB", name: "WalletB" },
    { address: "", wallet: "", name: "" },
  ];
  assert.equal(kickQuery("hello"), null);
  assert.equal(kickQuery("/kick Player 2"), "Player 2");
  assert.equal(kickQuery("/kicker"), null);
  assert.equal(findKickTarget(seats, "player 1"), 0);
  assert.equal(findKickTarget(seats, "ada"), 1 - 1);
  assert.equal(findKickTarget(seats, "WalletB"), 1);
  assert.throws(() => findKickTarget(seats, ""), /player name/);
  assert.throws(() => findKickTarget(seats, "Player 3"), /Nobody/);
  assert.throws(() => findKickTarget(seats, "Nobody"), /Nobody/);
});

test("a chat message is one short line", () => {
  assert.equal(cleanChatBody("  hello   table "), "hello table");
  assert.throws(() => cleanChatBody("   "), /Write a message/);
  assert.throws(() => cleanChatBody("x".repeat(201)), /200/);
  assert.equal(chatLine({ id: "1", name: "Ada", body: "hi", created_at: "t" })?.at, "t");
  assert.equal(chatLine({ id: "", name: "Ada", body: "hi" }), null);
});
