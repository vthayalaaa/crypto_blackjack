import assert from "node:assert/strict";
import { test } from "node:test";
import { assertBuyInBalance, ethReceiptIsFor, solanaPaymentProblem } from "./server/cashier.ts";
import { blankTable, cancel, normalizeTable, openHand, startBuyInClock, startRefundClock, voteKick, voteStart } from "./server/engine.ts";
import { mainnetBuyIn } from "./server/money.ts";
import { solanaParties, tokenRowCounts } from "./server/exposure.ts";
import { newSeat, openSecret, sealSecret } from "./server/keys.ts";
import { allow } from "./server/limit.ts";
import { isStale, prune } from "./server/prune.ts";

const HASH = `0x${"ab".repeat(32)}`;
const OTHER = `0x${"cd".repeat(32)}`;

function waitingTable() {
  const game = blankTable({
    id: "table-sec",
    cluster: "devnet",
    stake: 50_000_000n,
    due: 70_000_000n,
    buffer: 20_000_000n,
    invite: "",
    playerSeat: "seat-0",
    playerSecret: "secret-0",
    deck: [1, 2, 3, 4],
  });
  game.seats[1]!.address = "seat-1";
  game.seats[1]!.secret = "secret-1";
  game.seats[1]!.wallet = "wallet-1";
  return game;
}

test("a replaced or failed ethereum transfer does not fund a seat", () => {
  assert.equal(ethReceiptIsFor({ status: "success", transactionHash: HASH.toUpperCase().replace("0X", "0x") }, HASH), true);
  assert.equal(ethReceiptIsFor({ status: "success", transactionHash: OTHER }, HASH), false);
  assert.equal(ethReceiptIsFor({ status: "reverted", transactionHash: HASH }, HASH), false);
});

test("a solana buy-in has to be signed and paid by the claimed wallet", () => {
  const paid = {
    keys: [{ pubkey: "payer", signer: true }, { pubkey: "seat", signer: false }, { pubkey: "named", signer: false }],
    pre: [100, 0, 5],
    post: [29, 70, 5],
  };
  assert.equal(solanaPaymentProblem(paid, "payer", "seat", 70n), "");
  // Named in the transaction but did not sign it.
  assert.match(solanaPaymentProblem(paid, "named", "seat", 70n), /different wallet/);
  assert.match(solanaPaymentProblem(paid, "absent", "seat", 70n), /did not pay this seat/);
  assert.match(solanaPaymentProblem(paid, "payer", "seat", 71n), /short of the buy-in/);
  // Signed, but somebody else's balance paid the seat.
  const cosigned = {
    keys: [{ pubkey: "payer", signer: true }, { pubkey: "seat", signer: false }, { pubkey: "cosigner", signer: true }],
    pre: [100, 0, 5],
    post: [29, 70, 5],
  };
  assert.match(solanaPaymentProblem(cosigned, "cosigner", "seat", 70n), /different wallet/);
});

test("a funded player can cancel once the wait has run out", () => {
  const game = waitingTable();
  game.seats[1]!.funded = true;
  assert.throws(() => cancel(game, 1, 0), /first player/);
  startRefundClock(game, 1_000_000);
  const deadline = game.deadline * 1000;
  assert.equal(deadline, 1_000_000 + 900_000);
  startRefundClock(game, 5_000_000);
  assert.equal(game.deadline * 1000, deadline, "a later buy-in does not push the clock back");
  assert.throws(() => cancel(game, 1, deadline - 1), /first player/);
  assert.throws(() => cancel(game, "spectator", deadline), /first player/);
  cancel(game, 1, deadline);
  assert.equal(game.phase, "cancelled");
  assert.equal(game.deadline, 0);
});

test("a full table gets five minutes to finish the buy-ins", () => {
  const game = waitingTable();
  game.seats[1]!.address = "";
  startBuyInClock(game, 1_000_000);
  assert.equal(game.deadline, 0);
  game.seats[1]!.address = "seat-1";
  startRefundClock(game, 1_000_000);
  startBuyInClock(game, 1_200_000);
  assert.equal(game.deadline, Math.floor(1_200_000 / 1000) + 300);
  const deadline = game.deadline * 1000;
  game.seats[0]!.funded = true;
  game.seats[1]!.funded = true;
  assert.throws(() => cancel(game, 1, deadline - 1), /first player/);
  cancel(game, 1, deadline);
  assert.equal(game.phase, "cancelled");
  const playing = waitingTable();
  playing.phase = "acting";
  playing.deadline = 5;
  startBuyInClock(playing, 9_000_000);
  assert.equal(playing.deadline, 5);
});

test("two seated players can vote a larger invite table down to themselves", () => {
  const game = blankTable({
    id: "table-vote",
    cluster: "localnet",
    stake: 50_000_000n,
    due: 70_000_000n,
    buffer: 20_000_000n,
    invite: "",
    capacity: 5,
    playerSeat: "seat-0",
    playerSecret: "secret-0",
    deck: [1, 2, 3, 4, 5, 6],
  });
  assert.throws(() => voteStart(game, 0, 1_000), /Two players/);
  game.seats[1]!.address = "seat-1";
  game.seats[1]!.secret = "secret-1";
  voteStart(game, 0, 1_200_000);
  assert.equal(game.seats.length, 5);
  assert.equal(game.seats[0]!.ready, true);
  voteStart(game, 0, 1_200_000);
  assert.equal(game.seats[0]!.ready, false);
  voteStart(game, 0, 1_200_000);
  voteStart(game, 1, 1_200_000);
  assert.equal(game.seats.length, 2);
  assert.equal(game.phase, "waiting");
  assert.equal(game.deadline, Math.floor(1_200_000 / 1000) + 300);
  assert.equal(game.seats.every((seat) => seat.address && !seat.ready), true);
  const stored = JSON.parse(JSON.stringify(waitingTable())) as { seats: Array<Record<string, unknown>> };
  delete stored.seats[0]!.ready;
  assert.equal(normalizeTable(stored).seats[0]!.ready, false);
  const full = waitingTable();
  assert.throws(() => voteStart(full, 0, 0), /already taken/);
});

test("a unanimous vote deals the hand when everyone sitting has paid", () => {
  const game = blankTable({
    id: "table-vote-paid",
    cluster: "localnet",
    stake: 50_000_000n,
    due: 70_000_000n,
    buffer: 20_000_000n,
    invite: "",
    capacity: 4,
    playerSeat: "seat-0",
    playerSecret: "secret-0",
    deck: [1, 2, 3, 4, 5, 6, 7, 8],
  });
  game.seats[0]!.funded = true;
  game.seats[1]!.address = "seat-1";
  game.seats[1]!.secret = "secret-1";
  game.seats[1]!.funded = true;
  voteStart(game, 0, 5_000);
  voteStart(game, 1, 5_000);
  assert.equal(game.phase, "acting");
  assert.equal(game.seats.length, 2);
  assert.equal(game.seats[0]!.cards.length, 2);
  assert.equal(game.seats[1]!.cards.length, 2);
});

test("paid players can kick an unpaid player by majority, and two paid players cannot", () => {
  const game = blankTable({
    id: "table-kick",
    cluster: "localnet",
    stake: 50_000_000n,
    due: 70_000_000n,
    buffer: 20_000_000n,
    invite: "",
    capacity: 5,
    playerSeat: "seat-0",
    playerSecret: "secret-0",
  });
  for (const index of [1, 2, 3]) {
    game.seats[index]!.address = `seat-${index}`;
    game.seats[index]!.secret = `secret-${index}`;
    game.seats[index]!.wallet = `wallet-${index}`;
  }
  game.seats[0]!.funded = true;
  game.seats[1]!.funded = true;
  game.seats[2]!.funded = true;
  assert.throws(() => voteKick(game, 3, 0), /Buy in/);
  assert.throws(() => voteKick(game, 0, 1), /already bought in/);
  const first = voteKick(game, 0, 3);
  assert.equal(first.kicked, false);
  assert.equal(first.votes, 1);
  assert.equal(first.needed, 2);
  const second = voteKick(game, 1, 3);
  assert.equal(second.kicked, true);
  assert.equal(game.seats[3]!.address, "");
  assert.equal(game.kickVotes["3"], undefined);
  const short = blankTable({
    id: "table-kick-short",
    cluster: "localnet",
    stake: 50_000_000n,
    due: 70_000_000n,
    buffer: 20_000_000n,
    invite: "",
    capacity: 3,
    playerSeat: "seat-0",
    playerSecret: "secret-0",
  });
  short.seats[1]!.address = "seat-1";
  short.seats[2]!.address = "seat-2";
  short.seats[0]!.funded = true;
  short.seats[1]!.funded = true;
  assert.throws(() => voteKick(short, 0, 2), /More than two paid/);
  const pair = waitingTable();
  pair.seats[0]!.funded = true;
  pair.seats[1]!.funded = true;
  assert.throws(() => voteKick(pair, 0, 1), /two-player/);
});

test("a buy-in balance is required only on solana and ethereum mainnet", async () => {
  assert.equal(mainnetBuyIn("mainnet"), true);
  assert.equal(mainnetBuyIn("ethereum"), true);
  assert.equal(mainnetBuyIn("devnet"), false);
  assert.equal(mainnetBuyIn("localnet"), false);
  assert.equal(mainnetBuyIn("sepolia"), false);
  await assertBuyInBalance("localnet", "not-a-wallet", 1n);
  await assertBuyInBalance("devnet", "not-a-wallet", 1n);
  await assertBuyInBalance("sepolia", "not-a-wallet", 1n);
});

test("a seat that has not funded cannot cancel, and the clock stops mattering once the hand starts", () => {
  const game = waitingTable();
  game.seats[0]!.funded = true;
  game.seats[0]!.wallet = "wallet-0";
  startRefundClock(game, 0);
  assert.throws(() => cancel(game, 1, game.deadline * 1000), /first player/);
  game.seats[1]!.funded = true;
  openHand(game, 0);
  assert.throws(() => cancel(game, 1, Number.MAX_SAFE_INTEGER), /already started/);
});

test("naming a listed address beside a wallet is not exposure, a signature is", () => {
  const tx = (keys: string[], signers: number) => ({
    transaction: { message: { accountKeys: keys, header: { numRequiredSignatures: signers } } },
    meta: { loadedAddresses: { writable: [], readonly: [] } },
  });
  // A stranger pays for a transaction that lists the wallet and a listed address.
  assert.deepEqual(solanaParties(tx(["Stranger", "Wallet", "Listed"], 1), "Wallet"), ["Stranger"]);
  // The wallet signed, so everything it touched counts.
  assert.deepEqual(solanaParties(tx(["Wallet", "Listed"], 1), "Wallet"), ["Wallet", "Listed"]);
  // The listed address signed a transfer to the wallet.
  assert.deepEqual(solanaParties(tx(["Listed", "Wallet"], 1), "Wallet"), ["Listed"]);
  // No signer count: keep every account instead of guessing.
  assert.deepEqual(
    solanaParties({ transaction: { message: { accountKeys: ["A", "Listed"] } } }, "Wallet"),
    ["A", "Listed"],
  );
});

test("a token transfer counts only inside a transaction the wallet sent", () => {
  const signed = new Set([HASH]);
  assert.equal(tokenRowCounts({ hash: HASH.toUpperCase().replace("0X", "0x") }, signed), true);
  assert.equal(tokenRowCounts({ hash: OTHER }, signed), false);
  assert.equal(tokenRowCounts({}, signed), false);
});

test("seat keys are encrypted when a secret is set, and mainnet refuses without one", () => {
  const before = process.env.SEAT_KEY_SECRET;
  const argon = process.env.ARGON2_PASS;
  const typo = process.env.ARGAON2_PASS;
  try {
    delete process.env.SEAT_KEY_SECRET;
    delete process.env.ARGON2_PASS;
    delete process.env.ARGAON2_PASS;
    assert.equal(sealSecret("plain"), "plain");
    assert.equal(openSecret("plain"), "plain");
    assert.throws(() => newSeat("mainnet"), /not set up to hold mainnet/);
    assert.throws(() => newSeat("ethereum"), /not set up to hold mainnet/);
    assert.equal(newSeat("devnet").secret.startsWith("enc:"), false);

    process.env.SEAT_KEY_SECRET = "a".repeat(40);
    const sealed = sealSecret("plain");
    assert.equal(sealed.startsWith("enc:v1:"), true);
    assert.equal(sealed.includes("plain"), false);
    assert.equal(openSecret(sealed), "plain");
    assert.equal(openSecret("plain"), "plain", "a seat stored before encryption still reads");
    assert.equal(sealSecret(sealed), sealed);
    assert.equal(newSeat("mainnet").secret.startsWith("enc:v1:"), true);

    process.env.SEAT_KEY_SECRET = "b".repeat(40);
    assert.throws(() => openSecret(sealed));
    process.env.SEAT_KEY_SECRET = "short";
    assert.throws(() => sealSecret("plain"), /at least 32/);
  } finally {
    if (before === undefined) delete process.env.SEAT_KEY_SECRET;
    else process.env.SEAT_KEY_SECRET = before;
    if (argon === undefined) delete process.env.ARGON2_PASS;
    else process.env.ARGON2_PASS = argon;
    if (typo === undefined) delete process.env.ARGAON2_PASS;
    else process.env.ARGAON2_PASS = typo;
  }
});

test("Argon2 seals a seat key and the ciphertext is not the key", () => {
  const before = process.env.SEAT_KEY_SECRET;
  const argon = process.env.ARGON2_PASS;
  const typo = process.env.ARGAON2_PASS;
  try {
    delete process.env.SEAT_KEY_SECRET;
    delete process.env.ARGAON2_PASS;
    process.env.ARGON2_PASS = "short";
    assert.throws(() => sealSecret("plain-seat-key"), /at least 32/);
    process.env.ARGON2_PASS = "c".repeat(40);
    const sealed = sealSecret("plain-seat-key");
    assert.equal(sealed.startsWith("enc:v2:"), true);
    assert.equal(sealed.includes("plain-seat-key"), false);
    assert.equal(openSecret(sealed), "plain-seat-key");
    assert.equal(sealSecret(sealed), sealed);
    assert.equal(newSeat("mainnet").secret.startsWith("enc:v2:"), true);
    process.env.ARGON2_PASS = "d".repeat(40);
    assert.throws(() => openSecret(sealed));
    delete process.env.ARGON2_PASS;
    process.env.ARGAON2_PASS = "c".repeat(40);
    assert.equal(openSecret(sealed), "plain-seat-key");
  } finally {
    if (before === undefined) delete process.env.SEAT_KEY_SECRET;
    else process.env.SEAT_KEY_SECRET = before;
    if (argon === undefined) delete process.env.ARGON2_PASS;
    else process.env.ARGON2_PASS = argon;
    if (typo === undefined) delete process.env.ARGAON2_PASS;
    else process.env.ARGAON2_PASS = typo;
  }
});

test("a caller is held to the limit until the minute is over", () => {
  const key = `test:${Math.random()}`;
  assert.equal(allow(key, 2, 0), true);
  assert.equal(allow(key, 2, 1), true);
  assert.equal(allow(key, 2, 2), false);
  assert.equal(allow(`${key}:other`, 2, 2), true);
  assert.equal(allow(key, 2, 60_000), true);
});

test("only untouched or fully paid old tables leave the live file, and their keys are kept", () => {
  const day = 24 * 60 * 60 * 1000;
  const empty = waitingTable();
  empty.id = "empty";
  empty.createdAt = 1;
  const funded = waitingTable();
  funded.id = "funded";
  funded.createdAt = 1;
  funded.seats[0]!.funded = true;
  const legacy = waitingTable();
  legacy.id = "legacy";
  legacy.createdAt = 0;
  const unpaid = waitingTable();
  unpaid.id = "unpaid";
  unpaid.createdAt = 1;
  unpaid.phase = "cancelled";
  unpaid.seats[0]!.funded = true;
  unpaid.seats[0]!.wallet = "wallet-0";
  const paid = structuredClone(unpaid);
  paid.id = "paid";
  paid.paid = { "0": true };

  assert.equal(isStale(empty, day), false);
  assert.equal(isStale(empty, day + 2), true);
  assert.equal(isStale(funded, 30 * day), false, "a waiting table holding a buy-in stays");
  assert.equal(isStale(legacy, 30 * day), true, "an undated table that never took a buy-in is closed");
  assert.equal(isStale(unpaid, 30 * day), false, "an unpaid refund stays");
  assert.equal(isStale(paid, 6 * day), false);
  assert.equal(isStale(paid, 8 * day), true);

  const db = {
    tables: { empty, funded, legacy, unpaid, paid },
    sessions: { a: { tableId: "empty", seat: 0 }, b: { tableId: "funded", seat: 0 } },
    queue: {},
  };
  const kept: string[] = [];
  const removed = prune(db, 8 * day, (tables) => kept.push(...tables.map((table) => `${table.id}:${table.seats[0]!.secret}`)));
  assert.equal(removed, 3);
  assert.deepEqual(Object.keys(db.tables).sort(), ["funded", "unpaid"]);
  assert.deepEqual(Object.keys(db.sessions), ["b"]);
  assert.deepEqual(kept.sort(), ["empty:secret-0", "legacy:secret-0", "paid:secret-0"]);
});
