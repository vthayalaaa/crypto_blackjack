import assert from "node:assert/strict";
import { test } from "node:test";
import { payoutLegs } from "./server/cashier.ts";
import { blankTable, cancel, claim, hit, normalizeTable, openHand, stand, toView } from "./server/engine.ts";

function table(deck: number[], capacity = 2) {
  const game = blankTable({
    id: "table-test",
    cluster: "devnet",
    stake: 50_000_000n,
    due: 70_000_000n,
    buffer: 20_000_000n,
    invite: "",
    capacity,
    playerSeat: "seat-0",
    playerSecret: "secret-0",
    deck,
  });
  game.seats[0]!.funded = true;
  game.seats[0]!.wallet = "wallet-0";
  for (let index = 1; index < capacity; index += 1) {
    game.seats[index]!.address = `seat-${index}`;
    game.seats[index]!.secret = `secret-${index}`;
    game.seats[index]!.wallet = `wallet-${index}`;
    game.seats[index]!.funded = true;
  }
  return game;
}

test("each player sees only their own cards until the hand is finished", () => {
  const game = table([7, 8, 5, 9]);
  openHand(game, 1_700_000_000_000);
  const first = toView(game, 0);
  const second = toView(game, 1);
  const watching = toView(game, "spectator");
  assert.equal(first.seats[0]!.cards.length, 2);
  assert.equal(first.seats[1]!.cards.length, 0);
  assert.equal(first.seats[1]!.faceDown, 2);
  assert.equal(second.seats[1]!.cards.length, 2);
  assert.equal(second.seats[0]!.cards.length, 0);
  assert.equal(watching.seats[0]!.cards.length, 0);
  assert.equal(watching.seats[1]!.cards.length, 0);
  assert.equal(JSON.stringify(first).includes("secret-0"), false);
  assert.equal(JSON.stringify(first).includes("secret-1"), false);
});

test("a bust still lets the next player choose", () => {
  const game = table([9, 7, 9, 5, 9]);
  openHand(game, 0);
  hit(game, 0, 0);
  assert.equal(game.phase, "acting");
  assert.equal(game.turn, 1);
  assert.equal(toView(game, 1).seats[0]!.cards.length, 0);
  stand(game, 1, 0);
  const view = toView(game, "spectator");
  assert.deepEqual(game.winners, [1]);
  assert.equal(view.phase, "settled");
  assert.equal(view.seats[0]!.cards.length, 3);
  assert.equal(view.seats[1]!.cards.length, 2);
});

test("the higher standing total takes the pot and a tie sends both buy-ins back", () => {
  const higher = table([7, 9, 5, 9]);
  openHand(higher, 0);
  stand(higher, 0, 0);
  stand(higher, 1, 0);
  assert.deepEqual(higher.winners, [0]);

  const tied = table([9, 9, 9, 9]);
  openHand(tied, 0);
  stand(tied, 0, 0);
  stand(tied, 1, 0);
  assert.deepEqual(tied.winners, []);
});

test("a dealt 21 passes the turn and two 21s push", () => {
  const game = table([4, 9, 5, 0]);
  openHand(game, 0);
  assert.equal(game.turn, 1);
  stand(game, 1, 0);
  assert.deepEqual(game.winners, [0]);

  const both = table([9, 9, 0, 0]);
  openHand(both, 0);
  assert.equal(both.phase, "settled");
  assert.deepEqual(both.winners, []);
});

test("the next player can hit, and a bust loses to a standing hand", () => {
  const game = table([9, 5, 6, 9, 9]);
  openHand(game, 0);
  stand(game, 0, 0);
  assert.throws(() => hit(game, 0, 0), /not your turn/);
  hit(game, 1, 0);
  assert.equal(game.phase, "settled");
  assert.deepEqual(game.winners, [0]);
  assert.equal(game.seats[1]!.cards.length, 3);
});

test("every bust sends the buy-ins back", () => {
  const game = table([9, 9, 5, 5, 9, 9]);
  openHand(game, 0);
  hit(game, 0, 0);
  hit(game, 1, 0);
  assert.deepEqual(game.winners, []);
});

test("three players play in seat order and a tie splits the pot", () => {
  const game = table([8, 7, 9, 9, 9, 9], 3);
  openHand(game, 0);
  assert.equal(toView(game, 2).seats[0]!.cards.length, 0);
  stand(game, 0, 0);
  stand(game, 1, 0);
  stand(game, 2, 0);
  assert.deepEqual(game.winners, [0]);

  const split = table([9, 7, 9, 9, 9, 9], 3);
  openHand(split, 0);
  stand(split, 0, 0);
  stand(split, 1, 0);
  stand(split, 2, 0);
  assert.deepEqual(split.winners, [0, 2]);
  split.phase = "settled";
  const legs = payoutLegs(split);
  const received = new Map<string, bigint>();
  for (const leg of legs) received.set(leg.to, (received.get(leg.to) ?? 0n) + leg.amount);
  assert.equal(received.get("wallet-0"), 75_000_000n);
  assert.equal(received.get("wallet-2"), 75_000_000n);
  assert.equal(received.has("wallet-1"), false);
});

test("a stalled seat is out and the remaining players continue", () => {
  const game = table([8, 7, 9, 9, 9, 9], 3);
  openHand(game, 0);
  stand(game, 0, 0);
  assert.equal(game.turn, 1);
  assert.throws(() => claim(game, 2, 1_000), /still has time/);
  claim(game, 2, game.deadline * 1000);
  assert.equal(game.seats[1]!.out, true);
  assert.equal(game.turn, 2);
  stand(game, 2, 0);
  assert.deepEqual(game.winners, [0]);
});

test("cancel is only available before the hand starts", () => {
  const game = table([1, 2, 3, 4]);
  assert.throws(() => cancel(game, 1), /first player/);
  cancel(game, 0);
  assert.equal(game.phase, "cancelled");
  assert.throws(() => hit(game, 0, 0), /not your turn/);
});

test("the other player can claim only after the clock runs out", () => {
  const game = table([7, 8, 5, 9]);
  openHand(game, 0);
  assert.throws(() => claim(game, 0, game.deadline * 1000), /another player/);
  assert.throws(() => claim(game, 1, 1_000), /still has time/);
  claim(game, 1, game.deadline * 1000);
  assert.deepEqual(game.winners, [1]);
  assert.equal(game.phase, "settled");

  const later = table([7, 8, 5, 9]);
  openHand(later, 0);
  stand(later, 0, 0);
  assert.throws(() => claim(later, 1, later.deadline * 1000), /another player/);
  claim(later, 0, later.deadline * 1000);
  assert.deepEqual(later.winners, [0]);
});

test("a busted player cannot take the pot by claiming a timeout", () => {
  // Seat 0 holds 20 and hits to 30. Seat 1 holds 14 and lets the clock run out.
  const game = table([9, 7, 9, 5, 9]);
  openHand(game, 0);
  hit(game, 0, 0);
  assert.equal(game.turn, 1);
  claim(game, 0, game.deadline * 1000);
  assert.equal(game.phase, "settled");
  assert.deepEqual(game.winners, []);
  const legs = payoutLegs(game);
  assert.deepEqual(legs.map((leg) => [leg.id, leg.to]), [["0", "wallet-0"], ["1", "wallet-1"]]);
});

test("a standing hand still takes the pot when the only other seat times out", () => {
  const game = table([9, 7, 9, 5]);
  openHand(game, 0);
  stand(game, 0, 0);
  claim(game, 0, game.deadline * 1000);
  assert.deepEqual(game.winners, [0]);
});

test("with three seats, a timeout does not hand the pot to a bust", () => {
  // Seat 0 busts, seat 1 times out, seat 2 busts on its turn.
  const game = table([9, 9, 5, 9, 9, 7, 9, 9], 3);
  openHand(game, 0);
  hit(game, 0, 0);
  assert.equal(game.seats[0]!.cards.length, 3);
  assert.equal(game.turn, 1);
  claim(game, 2, game.deadline * 1000);
  assert.equal(game.turn, 2);
  hit(game, 2, 0);
  assert.equal(game.phase, "settled");
  assert.deepEqual(game.winners, []);

  // The same table, but seat 2 stands on a good hand and takes it.
  const stood = table([9, 9, 5, 9, 9, 7, 9, 9], 3);
  openHand(stood, 0);
  hit(stood, 0, 0);
  claim(stood, 2, stood.deadline * 1000);
  stand(stood, 2, 0);
  assert.deepEqual(stood.winners, [2]);
});

test("an older two-seat table still loads", () => {
  const loaded = normalizeTable({
    id: "old",
    cluster: "devnet",
    stake: "1",
    due: "2",
    buffer: "1",
    phase: "second",
    outcome: 0,
    playerSeat: "player-seat",
    dealerSeat: "dealer-seat",
    playerSecret: "secret-player",
    dealerSecret: "secret-dealer",
    playerCards: [1, 2],
    dealerCards: [3, 4],
    paid: { player: true },
  });
  assert.equal(loaded.phase, "acting");
  assert.equal(loaded.turn, 1);
  assert.equal(loaded.seats[0]!.address, "player-seat");
  assert.equal(loaded.seats[1]!.secret, "secret-dealer");
  assert.equal(loaded.paid["0"], true);
  assert.equal(JSON.stringify(toView(loaded, "spectator")).includes("secret-player"), false);
});
