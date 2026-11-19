import assert from "node:assert/strict";
import { test } from "node:test";
import { chipUnits } from "./stakes.ts";
import { countOtherWaiters, expireQueue, findPartner, lobbyCounts, type QueueEntry } from "./server/match.ts";

function entry(id: string, wallet: string, createdAt: number, stake = "50000000"): QueueEntry {
  return { id, cluster: "devnet", stake, wallet, createdAt, tableId: "", seatToken: "", role: "" };
}

test("the oldest different wallet at the same buy-in is the match", () => {
  const now = 1_000_000;
  const waiting = [
    entry("new", "wallet-c", now),
    entry("old", "wallet-b", now - 10),
    entry("other", "wallet-d", now, "100000000"),
    entry("self", "wallet-a", now),
  ];
  const partner = findPartner(waiting, "self", "devnet", "50000000", "wallet-a", now);
  assert.equal(partner?.id, "old");
});

test("the same wallet is left waiting", () => {
  const now = 1_000_000;
  const partner = findPartner([entry("old", "wallet-a", now - 10)], "self", "devnet", "50000000", "wallet-a", now);
  assert.equal(partner, null);
});

test("the lobby counts waiters by stake and seats still in a hand", () => {
  const now = 1_000_000;
  const queue = {
    low: entry("low", "wallet-a", now, chipUnits("devnet", "0.05").toString()),
    same: entry("same", "wallet-b", now, chipUnits("devnet", "0.05").toString()),
    high: entry("high", "wallet-c", now, chipUnits("devnet", "100").toString()),
    other: entry("other", "wallet-d", now, chipUnits("sepolia", "1").toString()),
    gone: entry("gone", "wallet-e", now - 16 * 60 * 1000),
    seated: { ...entry("seated", "wallet-f", now), tableId: "table-1" },
  };
  queue.other.cluster = "sepolia";
  const counts = lobbyCounts(queue, {
    open: { cluster: "devnet", phase: "waiting", playerSeat: "seat-a", dealerSeat: "", playerSeen: now },
    live: { cluster: "devnet", phase: "player", playerSeat: "seat-b", dealerSeat: "seat-c", playerSeen: now, dealerSeen: now },
    away: { cluster: "devnet", phase: "player", playerSeat: "seat-z", dealerSeat: "seat-y", playerSeen: now - 21_000, dealerSeen: 0 },
    done: { cluster: "devnet", phase: "settled", playerSeat: "seat-d", dealerSeat: "seat-e", playerSeen: now, dealerSeen: now },
    dropped: { cluster: "devnet", phase: "cancelled", playerSeat: "seat-f", dealerSeat: "", playerSeen: now },
    eth: { cluster: "sepolia", phase: "player", playerSeat: "seat-g", dealerSeat: "seat-h", playerSeen: now, dealerSeen: now },
  }, "devnet", now);
  assert.equal(counts.waiting, 3);
  assert.equal(counts.stakes["0.05"], 2);
  assert.equal(counts.stakes["100"], 1);
  assert.equal(counts.stakes["1"], 0);
  assert.equal(counts.playing, 3);
});

test("one wallet counts once in the lobby", () => {
  const now = 1_000_000;
  const low = chipUnits("devnet", "0.05").toString();
  const mid = chipUnits("devnet", "1").toString();
  const queue = {
    older: entry("older", "WalletA", now - 20, low),
    newer: entry("newer", "WalletA", now, mid),
    pair: entry("pair", "WalletB", now, low),
    ethOld: entry("ethOld", "0xABC", now - 5, chipUnits("sepolia", "5").toString()),
    ethNew: entry("ethNew", "0xabc", now, chipUnits("sepolia", "1").toString()),
  };
  queue.ethOld.cluster = "sepolia";
  queue.ethNew.cluster = "sepolia";
  const dev = lobbyCounts(queue, {
    here: {
      cluster: "devnet",
      phase: "player",
      playerSeat: "p",
      dealerSeat: "d",
      playerWallet: "WalletA",
      dealerWallet: "WalletB",
      playerSeen: now,
      dealerSeen: now,
    },
    again: {
      cluster: "devnet",
      phase: "waiting",
      playerSeat: "p2",
      dealerSeat: "",
      playerWallet: "WalletB",
      playerSeen: now,
    },
  }, "devnet", now);
  assert.equal(dev.waiting, 0);
  assert.equal(dev.stakes["0.05"], 0);
  assert.equal(dev.stakes["1"], 0);
  assert.equal(dev.playing, 2);
  const eth = lobbyCounts(queue, {}, "sepolia", now);
  assert.equal(eth.waiting, 1);
  assert.equal(eth.stakes["1"], 1);
  assert.equal(eth.stakes["5"], 0);
  assert.equal(countOtherWaiters(queue, queue.older, now), 1);
  assert.equal(countOtherWaiters(queue, queue.pair, now), 1);
  const dup = { a: entry("a", "WalletA", now, low), b: entry("b", "WalletA", now, low) };
  assert.equal(countOtherWaiters(dup, dup.a, now), 0);
  const once = lobbyCounts(dup, {}, "devnet", now);
  assert.equal(once.waiting, 1);
  assert.equal(once.stakes["0.05"], 1);
});

test("an expired wait is removed and cannot match", () => {
  const now = 2_000_000;
  const queue = { old: entry("old", "wallet-b", now - 16 * 60 * 1000) };
  expireQueue(queue, now);
  assert.equal(queue.old, undefined);
  assert.equal(findPartner([entry("old", "wallet-b", now - 16 * 60 * 1000)], "self", "devnet", "50000000", "wallet-a", now), null);
});
