import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  activityFile,
  eventFrom,
  loadActivity,
  noteActivity,
  recordActivity,
  renderActivity,
  seatFromLeg,
  type ActivityInput,
} from "./server/activity.ts";

const wallet = "11111111111111111111111111111111";
const signature = "1".repeat(88);

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bj-activity-")), "activity.jsonl");
}

function hit(at: number, seat = 0): ActivityInput {
  return { at, kind: "hit", table: "tableid01", cluster: "devnet", seat, wallet };
}

test("a log line has no seat key and refuses an encrypted secret", async () => {
  const event = eventFrom({ ...hit(1_700_000_000_000), secret: "seat-secret-value", deck: [1, 2, 3] });
  const text = JSON.stringify(event);
  assert.equal(text.includes("seat-secret-value"), false);
  assert.equal(text.includes("deck"), false);
  assert.equal(text.includes("\"secret\""), false);
  const file = tempFile();
  await assert.rejects(() => recordActivity({ ...hit(1), wallet: "enc:v1:not-a-wallet" }, file), /Refusing to write/);
  assert.equal(fs.existsSync(file), false);
});

test("committed actions append, and a repeated buy-in or fee is kept once", async () => {
  const file = tempFile();
  assert.equal(await recordActivity(hit(1_700_000_000_000), file), true);
  assert.equal(await recordActivity(hit(1_700_000_000_001), file), true);
  const buyin: ActivityInput = {
    at: 1_700_000_000_002,
    kind: "buyin",
    table: "tableid01",
    cluster: "devnet",
    seat: 0,
    wallet,
    amount: "70000000",
    signature,
  };
  assert.equal(await recordActivity(buyin, file), true);
  assert.equal(await recordActivity(buyin, file), false);
  const fee: ActivityInput = {
    at: 1_700_000_000_003,
    kind: "fees",
    table: "tableid01",
    cluster: "devnet",
    seat: 0,
    amount: "20000000",
    detail: "held in seat",
  };
  assert.equal(await recordActivity(fee, file), true);
  assert.equal(await recordActivity({ ...fee, at: 1_700_000_000_004 }, file), false);
  assert.equal(await recordActivity({ ...fee, seat: 1 }, file), true);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines.some((line) => line.includes("seat-secret") || line.includes("enc:v1:")), false);
  const shown = renderActivity(await loadActivity(10, file));
  assert.match(shown, /hit/);
  assert.match(shown, /buy-in/);
  assert.match(shown, /0\.07 SOL/);
  assert.match(shown, /fee reserve/);
  assert.match(shown, /0\.02 SOL/);
  assert.match(shown, /collected, still in the seat/);
  assert.equal(shown.includes("enc:v1"), false);
});

test("a sweep line says the fee was sent, and a broken line is not shown", async () => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{\"secret\":\"enc:v1:hidden-seat-key\"}\n");
  const sweep: ActivityInput = {
    at: 1_700_000_000_000,
    kind: "sweep",
    table: "tableid01",
    cluster: "ethereum",
    seat: 2,
    wallet: "0x0000000000000000000000000000000000000001",
    amount: "2000000000000000",
    signature: `0x${"ab".repeat(32)}`,
    detail: "collected",
  };
  assert.equal(await recordActivity(sweep, file), true);
  assert.equal(await recordActivity(sweep, file), false);
  const events = await loadActivity(10, file);
  assert.equal(events.length, 1);
  const shown = renderActivity(events);
  assert.match(shown, /fees collected/);
  assert.match(shown, /sent to master/);
  assert.match(shown, /0\.002 ETH/);
  assert.equal(shown.includes("enc:v1"), false);
  assert.equal(shown.includes("hidden-seat-key"), false);
});

test("a failed activity write does not throw", async () => {
  const file = tempFile();
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await noteActivity({ kind: "hit", table: "short", cluster: "devnet", seat: 0 }, file);
  } finally {
    console.error = original;
  }
  assert.equal(fs.existsSync(file), false);
  assert.match(errors[0] ?? "", /activity:/);
});

test("the log file lives under data, and a payout leg names its seat", () => {
  assert.equal(activityFile().endsWith(path.join("data", "activity.jsonl")), true);
  assert.equal(seatFromLeg("0"), 0);
  assert.equal(seatFromLeg("2>1"), 2);
  assert.equal(seatFromLeg("9"), -1);
  assert.equal(seatFromLeg("nope"), -1);
  assert.equal(renderActivity([]), "No activity.");
});
