import assert from "node:assert/strict";
import { test } from "node:test";
import { handTotal } from "./cards.ts";

test("totals follow blackjack rules", () => {
  assert.equal(handTotal([0, 12]), 21);
  assert.equal(handTotal([0, 13, 8]), 21);
  assert.equal(handTotal([0, 13, 26, 8]), 12);
  assert.equal(handTotal([12, 11]), 20);
  assert.equal(handTotal([9, 5, 6]), 23);
  assert.equal(handTotal([4, 0]), 16);
  assert.equal(handTotal([8, 0, 13]), 21);
});
