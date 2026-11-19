import assert from "node:assert/strict";
import { test } from "node:test";
import { chipUnits } from "./stakes.ts";
import { countOtherWaiters, expireQueue, findPartner, findPartners, lobbyCounts, type QueueEntry } from "./server/match.ts";

function entry(id: string, wallet: string, createdAt: number, stake = "50000000", seats = 2): QueueEntry {
  return { id, cluster: "devnet", stake, wallet, createdAt, tableId: "", seatToken: "", seats, role: "" };
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

test("a larger table waits until enough wallets want that size", () => {
  const now = 1_000_000;
  const waiting = [
    entry("pair", "wallet-b", now - 30, "50000000", 2),
    entry("first", "wallet-c", now - 20, "50000000", 3),
    entry("second", "wallet-d", now - 10, "50000000", 3),
  ];
  assert.equal(findPartners(waiting, "self", "devnet", "50000000", 3, "wallet-a", now)?.map((item) => item.id).join(","), "first,second");
  assert.equal(findPartners(waiting.slice(0, 2), "self", "devnet", "50000000", 3, "wallet-a", now), null);
  assert.equal(findPartner(waiting, "self", "devnet", "50000000", "wallet-a", now, 2)?.id, "pair");
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
    open: { cluster: "devnet", phase: "waiting", seats: [{ address: "seat-a", seen: now }] },
    live: { cluster: "devnet", phase: "acting", seats: [{ address: "seat-b", seen: now }, { address: "seat-c", seen: now }] },
    away: { cluster: "devnet", phase: "acting", seats: [{ address: "seat-z", seen: now - 21_000 }, { address: "seat-y", seen: 0 }] },
    done: { cluster: "devnet", phase: "settled", seats: [{ address: "seat-d", seen: now }, { address: "seat-e", seen: now }] },
    dropped: { cluster: "devnet", phase: "cancelled", seats: [{ address: "seat-f", seen: now }] },
    eth: { cluster: "sepolia", phase: "acting", seats: [{ address: "seat-g", seen: now }, { address: "seat-h", seen: now }] },
  }, "devnet", now);
  assert.equal(counts.waiting, 3);
  assert.equal(counts.stakes["2"]["0.05"], 2);
  assert.equal(counts.stakes["2"]["100"], 1);
  assert.equal(counts.stakes["2"]["1"], 0);
  assert.equal(counts.stakes["3"]["0.05"], 0);
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
      phase: "acting",
      seats: [
        { address: "p", wallet: "WalletA", seen: now },
        { address: "d", wallet: "WalletB", seen: now },
      ],
    },
    again: {
      cluster: "devnet",
      phase: "waiting",
      seats: [{ address: "p2", wallet: "WalletB", seen: now }],
    },
  }, "devnet", now);
  assert.equal(dev.waiting, 0);
  assert.equal(dev.stakes["2"]["0.05"], 0);
  assert.equal(dev.stakes["2"]["1"], 0);
  assert.equal(dev.playing, 2);
  const eth = lobbyCounts(queue, {}, "sepolia", now);
  assert.equal(eth.waiting, 1);
  assert.equal(eth.stakes["2"]["1"], 1);
  assert.equal(eth.stakes["2"]["5"], 0);
  assert.equal(countOtherWaiters(queue, queue.older, now), 1);
  assert.equal(countOtherWaiters(queue, queue.pair, now), 1);
  const dup = { a: entry("a", "WalletA", now, low), b: entry("b", "WalletA", now, low) };
  assert.equal(countOtherWaiters(dup, dup.a, now), 0);
  const once = lobbyCounts(dup, {}, "devnet", now);
  assert.equal(once.waiting, 1);
  assert.equal(once.stakes["2"]["0.05"], 1);
});

test("a buy-in count includes only wallets waiting for that table size", () => {
  const now = 1_000_000;
  const low = chipUnits("devnet", "0.05").toString();
  const mid = chipUnits("devnet", "1").toString();
  const queue = {
    twoA: entry("twoA", "wallet-a", now, low, 2),
    twoB: entry("twoB", "wallet-b", now, low, 2),
    three: entry("three", "wallet-c", now, low, 3),
    threeAlso: entry("threeAlso", "wallet-a", now + 1, low, 3),
    threeNewer: entry("threeNewer", "wallet-c", now + 5, mid, 3),
  };
  const counts = lobbyCounts(queue, {}, "devnet", now + 5);
  assert.equal(counts.waiting, 3);
  assert.equal(counts.stakes["2"]["0.05"], 2);
  assert.equal(counts.stakes["3"]["0.05"], 1);
  assert.equal(counts.stakes["3"]["1"], 1);
  assert.equal(counts.stakes["4"]["0.05"], 0);
});

test("an expired wait is removed and cannot match", () => {
  const now = 2_000_000;
  const queue = { old: entry("old", "wallet-b", now - 16 * 60 * 1000) };
  expireQueue(queue, now);
  assert.equal(queue.old, undefined);
  assert.equal(findPartner([entry("old", "wallet-b", now - 16 * 60 * 1000)], "self", "devnet", "50000000", "wallet-a", now), null);
});
