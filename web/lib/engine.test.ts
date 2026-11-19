import assert from "node:assert/strict";
import { test } from "node:test";
import { blankTable, cancel, claim, hit, openHand, stand, toView } from "./server/engine.ts";

function table(deck: number[]) {
  return blankTable({
    id: "table-test",
    cluster: "devnet",
    stake: 50_000_000n,
    due: 70_000_000n,
    buffer: 20_000_000n,
    invite: "",
    playerSeat: "player-seat",
    playerSecret: "secret-player",
    deck,
  });
}

test("each player sees only their own cards until both have finished", () => {
  const game = table([7, 8, 5, 9]);
  game.dealerSeat = "dealer-seat";
  game.dealerSecret = "secret-dealer";
  game.playerFunded = true;
  game.dealerFunded = true;
  openHand(game, 1_700_000_000_000);
  const first = toView(game, "player");
  const second = toView(game, "dealer");
  const watching = toView(game, "spectator");
  assert.equal(Object.hasOwn(first, "deck"), false);
  assert.equal(Object.hasOwn(first, "playerSecret"), false);
  assert.equal(Object.hasOwn(first, "dealerSecret"), false);
  assert.equal(first.playerCards.length, 2);
  assert.equal(first.dealerCards.length, 0);
  assert.equal(first.dealerFaceDown, 2);
  assert.equal(second.dealerCards.length, 2);
  assert.equal(second.playerCards.length, 0);
  assert.equal(second.playerFaceDown, 2);
  assert.equal(watching.playerCards.length, 0);
  assert.equal(watching.dealerCards.length, 0);
  assert.equal(JSON.stringify(first).includes("secret-player"), false);
  assert.equal(JSON.stringify(first).includes("secret-dealer"), false);
});

test("a bust still lets the other player choose", () => {
  const game = table([9, 7, 8, 5, 9]);
  openHand(game, 0);
  hit(game, "player", 0);
  assert.equal(game.phase, "second");
  assert.equal(toView(game, "dealer").playerCards.length, 0);
  stand(game, "dealer", 0);
  const view = toView(game, "spectator");
  assert.equal(game.outcome, 2);
  assert.equal(view.phase, "settled");
  assert.equal(view.playerCards.length, 3);
  assert.equal(view.dealerCards.length, 2);
});

test("the higher standing total takes the pot and a tie splits it", () => {
  const higher = table([7, 8, 5, 9]);
  openHand(higher, 0);
  stand(higher, "player", 0);
  stand(higher, "dealer", 0);
  assert.equal(higher.outcome, 2);
  assert.equal(higher.dealerCards.length, 2);

  const tied = table([5, 9, 5, 9]);
  openHand(tied, 0);
  stand(tied, "player", 0);
  stand(tied, "dealer", 0);
  assert.equal(tied.outcome, 3);
});

test("a dealt 21 passes the turn and both 21s push", () => {
  const game = table([4, 4, 9, 0]);
  openHand(game, 0);
  assert.equal(game.phase, "second");
  stand(game, "dealer", 0);
  assert.equal(game.outcome, 1);
  assert.equal(game.dealerCards.length, 2);

  const both = table([9, 0, 9, 0]);
  openHand(both, 0);
  assert.equal(both.phase, "settled");
  assert.equal(both.outcome, 3);
});

test("the second player can hit, and a bust loses to a standing hand", () => {
  const game = table([9, 7, 8, 5, 9]);
  openHand(game, 0);
  stand(game, "player", 0);
  assert.throws(() => hit(game, "player", 0), /not your turn/);
  hit(game, "dealer", 0);
  assert.equal(game.phase, "settled");
  assert.equal(game.outcome, 1);
  assert.equal(game.dealerCards.length, 3);
});

test("both busts split the pot", () => {
  const game = table([9, 9, 7, 8, 5, 9]);
  openHand(game, 0);
  hit(game, "player", 0);
  hit(game, "dealer", 0);
  assert.equal(game.outcome, 3);
});

test("cancel is only available before the hand starts", () => {
  const game = table([1, 2, 3, 4]);
  cancel(game, "player");
  assert.equal(game.phase, "cancelled");
  assert.throws(() => hit(game, "player", 0), /not your turn/);
});

test("the other player can claim only after the clock runs out", () => {
  const game = table([7, 8, 5, 9]);
  openHand(game, 0);
  assert.throws(() => claim(game, "player", game.deadline * 1000), /other player/);
  assert.throws(() => claim(game, "dealer", 1_000), /still has time/);
  claim(game, "dealer", game.deadline * 1000);
  assert.equal(game.outcome, 2);
  assert.equal(game.phase, "settled");

  const later = table([7, 8, 5, 9]);
  openHand(later, 0);
  stand(later, "player", 0);
  assert.throws(() => claim(later, "dealer", later.deadline * 1000), /other player/);
  claim(later, "player", later.deadline * 1000);
  assert.equal(later.outcome, 1);
});
