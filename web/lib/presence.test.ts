import assert from "node:assert/strict";
import { test } from "node:test";
import { notePresence, seatHere } from "./server/presence.ts";

test("leaving the table beats an older poll, and a stale poll cannot undo it", () => {
  const table = { playerSeen: 0, playerBeat: 0 };
  notePresence(table, "player", true, 1, 1_000);
  assert.equal(seatHere(table.playerSeen, 1_000), true);
  notePresence(table, "player", false, 2, 1_100);
  assert.equal(table.playerSeen, 0);
  notePresence(table, "player", true, 1, 1_200);
  assert.equal(table.playerSeen, 0);
  assert.equal(seatHere(table.playerSeen, 1_200), false);
});

test("a fresh poll keeps the seat, and a quiet seat drops out", () => {
  const table = { dealerSeen: 0, dealerBeat: 0 };
  notePresence(table, "dealer", true, 4, 5_000);
  notePresence(table, "dealer", true, 4, 8_000);
  assert.equal(table.dealerSeen, 8_000);
  assert.equal(seatHere(table.dealerSeen, 8_000 + 20_000), true);
  assert.equal(seatHere(table.dealerSeen, 8_000 + 20_001), false);
  assert.equal(seatHere(undefined, 8_000), false);
});
