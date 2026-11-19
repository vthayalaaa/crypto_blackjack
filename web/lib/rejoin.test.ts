import assert from "node:assert/strict";
import { test } from "node:test";
import { currentSeatIndex, listCurrentTables, sessionTokenFor, type RejoinTable } from "./server/rejoin.ts";

function seat(wallet: string, extra: Partial<RejoinTable["seats"][number]> = {}): RejoinTable["seats"][number] {
  return { address: wallet ? `seat-${wallet}` : "", wallet, funded: false, out: false, ...extra };
}

function table(extra: Partial<RejoinTable> = {}): RejoinTable {
  return {
    cluster: "devnet",
    phase: "waiting",
    stake: "50000000",
    turn: -1,
    createdAt: 1,
    seats: [seat("wallet-a", { funded: true }), seat("")],
    ...extra,
  };
}

test("a waiting or live hand for this wallet is listed, and finished hands are not", () => {
  const rows = listCurrentTables({
    open: table(),
    live: table({ phase: "acting", turn: 0, createdAt: 5, seats: [seat("wallet-a"), seat("wallet-b", { address: "seat-b" })] }),
    done: table({ phase: "settled", createdAt: 9 }),
    dropped: table({ phase: "cancelled", createdAt: 8 }),
    other: table({ seats: [seat("wallet-z", { funded: true }), seat("")] }),
    eth: table({ cluster: "sepolia", seats: [seat("wallet-a"), seat("")] }),
  }, { cluster: "devnet", wallet: "wallet-a", session: null });
  assert.deepEqual(rows.map((row) => row.id), ["live", "open"]);
  assert.equal(rows[0]?.turn, true);
  assert.equal(rows[0]?.phase, "acting");
  assert.equal(rows[1]?.funded, true);
  assert.equal(rows[1]?.seat, 0);
  assert.equal(rows[1]?.seats, 2);
});

test("the list keeps only public fields and prefers the wallet seat over the cookie", () => {
  const secret = table({
    phase: "acting",
    turn: 2,
    seats: [seat("wallet-a"), seat(""), seat("Wallet-B")],
  });
  Object.assign(secret, { deck: [1, 2], sends: { leg: "raw" } });
  secret.seats[2] = seat("wallet-b", { address: "seat-secret" });
  const rows = listCurrentTables(
    { hand: secret },
    { cluster: "devnet", wallet: "wallet-b", session: { tableId: "hand", seat: 0 } },
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ["cluster", "funded", "id", "phase", "seat", "seats", "stake", "turn"]);
  assert.equal(rows[0]?.seat, 2);
  assert.equal(rows[0]?.turn, true);
  const text = JSON.stringify(rows);
  assert.equal(text.includes("seat-secret"), false);
  assert.equal(text.includes("deck"), false);
  assert.equal(text.includes("wallet"), false);
});

test("an ethereum wallet matches without case, and an empty wallet matches nothing", () => {
  const tables = {
    eth: table({
      cluster: "ethereum",
      seats: [seat("0xAbCDEF0123456789abcdef0123456789abcdEF01"), seat("")],
    }),
  };
  const wallet = "0xabcdef0123456789abcdef0123456789abcdef01";
  assert.equal(listCurrentTables(tables, { cluster: "ethereum", wallet, session: null })[0]?.id, "eth");
  assert.equal(listCurrentTables(tables, { cluster: "ethereum", wallet: "", session: null }).length, 0);
  assert.equal(currentSeatIndex(tables.eth!, "eth", { wallet: "0x0000000000000000000000000000000000000000", session: null }), -1);
});

test("the seat cookie opens the last table when the wallet is still that seat or was never recorded", () => {
  const bare = table({ seats: [seat("", { address: "seat-open" }), seat("")] });
  assert.equal(currentSeatIndex(bare, "bare", { wallet: "", session: { tableId: "bare", seat: 0 } }), 0);
  assert.equal(currentSeatIndex(bare, "bare", { wallet: "wallet-a", session: { tableId: "bare", seat: 0 } }), 0);
  const taken = table();
  assert.equal(currentSeatIndex(taken, "taken", { wallet: "wallet-z", session: { tableId: "taken", seat: 0 } }), -1);
  assert.equal(currentSeatIndex(taken, "taken", { wallet: "", session: { tableId: "taken", seat: 0 } }), -1);
  assert.equal(listCurrentTables({ taken }, { cluster: "devnet", wallet: "", session: { tableId: "taken", seat: 0 } }).length, 0);
  assert.equal(currentSeatIndex(taken, "other", { wallet: "", session: { tableId: "taken", seat: 0 } }), -1);
  assert.equal(currentSeatIndex(taken, "taken", { wallet: "", session: { tableId: "taken", seat: 1 } }), -1);
  const rows = listCurrentTables(
    { bare, later: table({ phase: "settled" }) },
    { cluster: "devnet", wallet: "", session: { tableId: "bare", seat: 0 } },
  );
  assert.deepEqual(rows.map((row) => row.id), ["bare"]);
});

test("a timed-out seat is still listed, but it is not that seat's turn", () => {
  const rows = listCurrentTables({
    hand: table({ phase: "acting", turn: 0, seats: [seat("wallet-a", { out: true }), seat("wallet-b")] }),
  }, { cluster: "devnet", wallet: "wallet-a", session: null });
  assert.equal(rows[0]?.turn, false);
  assert.equal(rows[0]?.phase, "acting");
});

test("hands in play come first, then the newest, and the list stops at eight", () => {
  const tables: Record<string, RejoinTable> = {};
  for (let index = 0; index < 6; index += 1) {
    tables[`wait-${index}`] = table({ createdAt: index + 1 });
  }
  for (let index = 0; index < 4; index += 1) {
    tables[`live-${index}`] = table({ phase: "acting", turn: 0, createdAt: index + 1 });
  }
  const rows = listCurrentTables(tables, { cluster: "devnet", wallet: "wallet-a", session: null });
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.map((row) => row.id), [
    "live-3", "live-2", "live-1", "live-0",
    "wait-5", "wait-4", "wait-3", "wait-2",
  ]);
});

test("rejoin keeps the current cookie, then any session for that seat, and does not mint a short token", () => {
  const sessions: Record<string, { tableId: string; seat: number }> = Object.create(null);
  sessions["short"] = { tableId: "table-1", seat: 0 };
  sessions.bbbbbbbbbbbbbbbb = { tableId: "table-1", seat: 1 };
  sessions.aaaaaaaaaaaaaaaa = { tableId: "table-1", seat: 0 };
  assert.equal(sessionTokenFor(sessions, "table-1", 0, "aaaaaaaaaaaaaaaa", () => "cccccccccccccccc"), "aaaaaaaaaaaaaaaa");
  assert.equal(sessionTokenFor(sessions, "table-1", 0, "bbbbbbbbbbbbbbbb", () => "cccccccccccccccc"), "aaaaaaaaaaaaaaaa");
  assert.equal(sessionTokenFor(sessions, "table-2", 0, null, () => "cccccccccccccccc"), "cccccccccccccccc");
  assert.deepEqual(sessions.cccccccccccccccc, { tableId: "table-2", seat: 0 });
  assert.equal(Object.hasOwn(sessions, "short"), true);
  assert.throws(() => sessionTokenFor(sessions, "table-3", 0, null, () => "nope"), /could not do that/);
});
