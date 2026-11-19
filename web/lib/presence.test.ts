import assert from "node:assert/strict";
import { test } from "node:test";
import { notePresence, seatHere } from "./server/presence.ts";

test("leaving the table beats an older poll, and a stale poll cannot undo it", () => {
  const table = { seats: [{ seen: 0, beat: 0 }] };
  notePresence(table, 0, true, 1, 1_000);
  assert.equal(seatHere(table.seats[0]!.seen, 1_000), true);
  notePresence(table, 0, false, 2, 1_100);
  assert.equal(table.seats[0]!.seen, 0);
  notePresence(table, 0, true, 1, 1_200);
  assert.equal(table.seats[0]!.seen, 0);
  assert.equal(seatHere(table.seats[0]!.seen, 1_200), false);
});

test("a fresh poll keeps the seat, and a quiet seat drops out", () => {
  const table = { seats: [{ seen: 0, beat: 0 }, { seen: 0, beat: 0 }] };
  notePresence(table, 1, true, 4, 5_000);
  notePresence(table, 1, true, 4, 8_000);
  assert.equal(table.seats[1]!.seen, 8_000);
  assert.equal(seatHere(table.seats[1]!.seen, 8_000 + 20_000), true);
  assert.equal(seatHere(table.seats[1]!.seen, 8_000 + 20_001), false);
  assert.equal(seatHere(undefined, 8_000), false);
});
