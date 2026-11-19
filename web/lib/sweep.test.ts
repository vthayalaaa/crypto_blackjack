import assert from "node:assert/strict";
import { test } from "node:test";
import type { SecretTable } from "./server/engine.ts";
import { feeSeats, feeSweepAmount, readArchive, sweepDestination, tablesForSweep } from "./server/sweep.ts";

function table(patch: Partial<SecretTable> = {}): SecretTable {
  const seat = {
    address: "seat-address",
    secret: "seat-secret",
    wallet: "player-wallet",
    funded: true,
    cards: [],
    hits: 0,
    seen: 0,
    beat: 0,
    out: false,
    ready: false,
  };
  return {
    id: "table-1",
    cluster: "devnet",
    stake: "50000000",
    due: "70000000",
    buffer: "20000000",
    phase: "settled",
    turn: -1,
    winners: [],
    invite: "",
    seats: [seat, { ...seat, address: "seat-two", secret: "secret-two", wallet: "player-two" }],
    fundSignatures: [],
    deck: [],
    deadline: 0,
    payouts: [],
    payoutError: "",
    paid: { "0": true, "1": true },
    sends: {},
    createdAt: 1,
    kickVotes: {},
    ...patch,
  };
}

test("the sweep takes the leftover reserve and leaves anything above it", () => {
  assert.equal(feeSweepAmount(19_995_000n, 5_000n, 20_000_000n), 19_990_000n);
  assert.equal(feeSweepAmount(50_000_000n, 5_000n, 20_000_000n), 20_000_000n);
  assert.equal(feeSweepAmount(5_000n, 5_000n, 20_000_000n), 0n);
  assert.equal(feeSweepAmount(30_000_000n, 5_000n, 0n), 0n);
});

test("a seat is swept only after its own payouts have landed", () => {
  const ready = feeSeats(table());
  assert.deepEqual(ready.map((seat) => seat.index), [0, 1]);
  const unpaid = feeSeats(table({ paid: { "0": true } }));
  assert.deepEqual(unpaid.map((seat) => seat.index), [0]);
  assert.equal(feeSeats(table({ phase: "acting" })).length, 0);
  assert.equal(feeSeats(table({ phase: "waiting" })).length, 0);
  const noLeg = table();
  noLeg.seats[1] = { ...noLeg.seats[1]!, wallet: "" };
  assert.deepEqual(feeSeats(noLeg).map((seat) => seat.index), [0]);
});

test("the master wallet is an address and cannot be a seat", () => {
  assert.equal(sweepDestination("devnet", "11111111111111111111111111111111", []), "11111111111111111111111111111111");
  assert.throws(() => sweepDestination("devnet", "11111111111111111111111111111111", ["11111111111111111111111111111111"]), /one of the seats/);
  assert.throws(() => sweepDestination("devnet", "not-an-address", []), /not a Solana address/);
  assert.throws(() => sweepDestination("sepolia", "", []), /SWEEP_ETH_ADDRESS/);
  assert.equal(sweepDestination("sepolia", "0x0000000000000000000000000000000000000001", []), "0x0000000000000000000000000000000000000001");
  assert.throws(() => sweepDestination("ethereum", "0x0000000000000000000000000000000000000001", ["0x0000000000000000000000000000000000000001"]), /one of the seats/);
});

test("archive lines yield to the live table, and a broken line is not echoed", () => {
  const older = table({ id: "same", buffer: "1" });
  const newer = table({ id: "same", buffer: "2" });
  const live = table({ id: "same", buffer: "9" });
  const chosen = tablesForSweep([live], [older, newer], "devnet");
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0]!.buffer, "9");
  const other = tablesForSweep([], [table({ id: "eth", cluster: "sepolia" })], "devnet");
  assert.equal(other.length, 0);
  const read = readArchive(`\nnot json {"secret":"should-not-surface"}\n${JSON.stringify(table())}\n`);
  assert.equal(read.broken, 1);
  assert.equal(read.tables.length, 1);
  assert.equal(JSON.stringify(read).includes("should-not-surface"), false);
});
