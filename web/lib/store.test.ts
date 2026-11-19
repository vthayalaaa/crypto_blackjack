import assert from "node:assert/strict";
import { test } from "node:test";
import { diffKeys } from "./server/store.ts";

test("a database write keeps changed rows and drops removed ones", () => {
  const before = new Map([["a", "1"], ["b", "2"], ["c", "3"]]);
  const after = new Map([["a", "1"], ["b", "9"], ["d", "4"]]);
  assert.deepEqual(diffKeys(before, after), { upsert: ["b", "d"], remove: ["c"] });
});
