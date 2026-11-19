import assert from "node:assert/strict";
import { test } from "node:test";
import { OFF } from "./layout.ts";

test("game account fields are packed without gaps", () => {
  const sizes = [
    ["player", OFF.player, 32],
    ["dealer", OFF.dealer, 32],
    ["invite", OFF.invite, 32],
    ["stake", OFF.stake, 8],
    ["gameId", OFF.gameId, 8],
    ["status", OFF.status, 1],
    ["outcome", OFF.outcome, 1],
    ["playerCommits", OFF.playerCommits, 512],
    ["dealerCommits", OFF.dealerCommits, 512],
    ["playerCards", OFF.playerCards, 11],
    ["playerLen", OFF.playerLen, 1],
    ["dealerCards", OFF.dealerCards, 11],
    ["dealerLen", OFF.dealerLen, 1],
    ["deckMask", OFF.deckMask, 8],
    ["nextPlayerHit", OFF.nextPlayerHit, 1],
    ["deadline", OFF.deadline, 8],
    ["createdAt", OFF.createdAt, 8],
    ["bump", OFF.bump, 1],
    ["vaultBump", OFF.vaultBump, 1],
    ["staged", OFF.staged, 224],
    ["stagedLen", OFF.stagedLen, 1],
    ["playerOwed", OFF.playerOwed, 8],
    ["dealerOwed", OFF.dealerOwed, 8],
  ] as const;
  let cursor = 0;
  for (const [name, offset, size] of sizes) {
    assert.equal(offset, cursor, name);
    cursor += size;
  }
  assert.equal(cursor, OFF.end);
  assert.equal(OFF.end, 1430);
});
