import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import type { PayoutSend } from "./server/engine.ts";
import { isRunning, release, tryAcquire } from "./server/lockfile.ts";
import {
  CANNOT_TELL,
  NOT_CONFIRMED,
  base58,
  ethLanding,
  payLeg,
  solanaLanding,
  type Landing,
  type Rail,
} from "./server/payout.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A pretend chain. `landed` holds every signature that made it on-chain.
 * A transfer is only counted once however many times its bytes are broadcast.
 */
function fakeChain() {
  const landed = new Set<string>();
  const log: string[] = [];
  let built = 0;
  let mode: "lands" | "drops" = "lands";
  let state: (send: PayoutSend) => Landing = (send) => (landed.has(send.signature) ? "landed" : "pending");
  const rail: Rail = {
    check: async (send) => state(send),
    build: async () => {
      built += 1;
      log.push(`build ${built}`);
      return { signature: `sig-${built}`, raw: `raw-${built}`, from: "seat", expires: 100, nonce: built, at: 0 };
    },
    broadcast: async (send, again) => {
      log.push(`${again ? "rebroadcast" : "broadcast"} ${send.signature}`);
      if (mode === "lands") landed.add(send.signature);
    },
    wait: async (send) => state(send),
  };
  return {
    rail,
    log,
    landed,
    built: () => built,
    drop: () => { mode = "drops"; },
    land: () => { mode = "lands"; },
    setState: (next: (send: PayoutSend) => Landing) => { state = next; },
  };
}

const pass = async () => {};

test("a crash after the broadcast does not pay twice", async () => {
  const chain = fakeChain();
  const saved: PayoutSend[] = [];
  // The first attempt broadcasts and then dies before `paid` is written.
  const crashing = { ...chain.rail, wait: async () => { throw new Error("process died"); } };
  await assert.rejects(payLeg(crashing, undefined, pass, async (send) => { saved.push(send); }), /process died/);
  assert.equal(chain.landed.size, 1);
  // The retry starts from the saved record and finds the transfer on-chain.
  const signature = await payLeg(chain.rail, saved[0], pass, async () => assert.fail("must not build again"));
  assert.equal(signature, "sig-1");
  assert.equal(chain.built(), 1);
  assert.equal(chain.landed.size, 1);
});

test("the record is saved before the transfer is broadcast", async () => {
  const chain = fakeChain();
  await payLeg(chain.rail, undefined, pass, async (send) => { chain.log.push(`save ${send.signature}`); });
  assert.deepEqual(chain.log, ["build 1", "save sig-1", "broadcast sig-1"]);
});

test("a save that fails sends nothing", async () => {
  const chain = fakeChain();
  await assert.rejects(payLeg(chain.rail, undefined, pass, async () => { throw new Error("disk full"); }), /disk full/);
  assert.equal(chain.log.some((line) => line.includes("broadcast")), false);
});

test("a transfer that may still land is only sent again as the same bytes", async () => {
  const chain = fakeChain();
  chain.drop();
  const saved: PayoutSend[] = [];
  await assert.rejects(payLeg(chain.rail, undefined, pass, async (send) => { saved.push(send); }), new RegExp(NOT_CONFIRMED));
  await assert.rejects(payLeg(chain.rail, saved[0], pass, async () => assert.fail("must not build")), new RegExp(NOT_CONFIRMED));
  chain.land();
  assert.equal(await payLeg(chain.rail, saved[0], pass, async () => assert.fail("must not build")), "sig-1");
  assert.equal(chain.built(), 1);
  assert.deepEqual(chain.log.filter((line) => line.startsWith("rebroadcast")), ["rebroadcast sig-1", "rebroadcast sig-1"]);
});

test("only a transfer that can never land is replaced", async () => {
  const chain = fakeChain();
  const prior: PayoutSend = { signature: "old", raw: "old", from: "seat", expires: 1, nonce: 0, at: 0 };
  chain.setState((send) => (send.signature === "old" ? "dead" : chain.landed.has(send.signature) ? "landed" : "pending"));
  assert.equal(await payLeg(chain.rail, prior, pass, pass), "sig-1");
  assert.equal(chain.built(), 1);
});

test("an unclear on-chain state sends nothing", async () => {
  const chain = fakeChain();
  const prior: PayoutSend = { signature: "old", raw: "old", from: "seat", expires: 1, nonce: 0, at: 0 };
  chain.setState(() => "unknown");
  await assert.rejects(payLeg(chain.rail, prior, pass, pass), new RegExp(CANNOT_TELL.slice(0, 30)));
  assert.deepEqual(chain.log, []);
});

test("a listed recipient blocks a new or repeated broadcast but not recording one that landed", async () => {
  const chain = fakeChain();
  const listed = async () => { throw new Error("listed"); };
  await assert.rejects(payLeg(chain.rail, undefined, listed, pass), /listed/);
  assert.equal(chain.built(), 0);
  const prior: PayoutSend = { signature: "done", raw: "done", from: "seat", expires: 1, nonce: 0, at: 0 };
  chain.landed.add("done");
  assert.equal(await payLeg(chain.rail, prior, listed, pass), "done");
});

test("solana: a missing transfer is dead only once the finalized height has passed its blockhash", () => {
  assert.equal(solanaLanding(null, 100, 100), "pending");
  assert.equal(solanaLanding(null, 101, 100), "dead");
  assert.equal(solanaLanding(null, 500, 0), "unknown");
  assert.equal(solanaLanding({ err: null, confirmationStatus: "confirmed" }, 0, 100), "landed");
  assert.equal(solanaLanding({ err: null, confirmationStatus: "processed" }, 0, 100), "pending");
  assert.equal(solanaLanding({ err: { InstructionError: [] }, confirmationStatus: "confirmed" }, 999, 100), "pending");
  assert.equal(solanaLanding({ err: { InstructionError: [] }, confirmationStatus: "finalized" }, 999, 100), "dead");
});

test("ethereum: a used nonce with no receipt sends nothing, and a receipt waits for its confirmations", () => {
  const hash = `0x${"ab".repeat(32)}`;
  const mined = (status: string, transactionHash = hash) => ({ status, blockNumber: 10n, transactionHash });
  assert.equal(ethLanding(null, hash, 0n, 1, 5, 5), "pending");
  assert.equal(ethLanding(null, hash, 0n, 1, 6, 5), "unknown");
  assert.equal(ethLanding(mined("success"), hash, 10n, 2, 0, 5), "pending");
  assert.equal(ethLanding(mined("success"), hash, 11n, 2, 0, 5), "landed");
  assert.equal(ethLanding(mined("success", hash.toUpperCase().replace("0X", "0x")), hash, 11n, 2, 0, 5), "landed");
  assert.equal(ethLanding(mined("reverted"), hash, 11n, 2, 0, 5), "dead");
  // A receipt for some other hash never marks this leg paid and never lets it be rebuilt.
  assert.equal(ethLanding(mined("success", `0x${"cd".repeat(32)}`), hash, 11n, 2, 0, 5), "unknown");
});

test("a transfer the node only accepted is not recorded as paid", async () => {
  const chain = fakeChain();
  chain.drop();
  let paid = false;
  await payLeg(chain.rail, undefined, pass, pass).then(() => { paid = true; }, () => {});
  assert.equal(paid, false);
});

test("the signature is base58 the same way web3.js writes keys", () => {
  for (let index = 0; index < 20; index += 1) {
    const key = Keypair.generate().publicKey;
    assert.equal(base58(key.toBytes()), key.toBase58());
  }
  assert.equal(base58(new Uint8Array([0, 0, 1])), "112");
});

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bj-lock-"));
}

test("a lock held by a running process is not taken", () => {
  const file = path.join(scratch(), "a.lock");
  const token = tryAcquire(file, 0);
  assert.ok(token);
  assert.equal(tryAcquire(file, 0), null);
  release(file, token);
  const again = tryAcquire(file, 0);
  assert.ok(again);
  release(file, again);
});

test("a lock left by a process that exited is taken once, and one from another host never is", () => {
  const dir = scratch();
  const file = path.join(dir, "a.lock");
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const deadPid = Number(child.stdout);
  assert.equal(isRunning({ pid: deadPid, host: os.hostname(), token: "x" }), false);
  fs.writeFileSync(file, JSON.stringify({ pid: deadPid, host: os.hostname(), token: "dead", at: 0 }));
  const token = tryAcquire(file, 0);
  assert.ok(token, "the dead owner's lock is taken");
  assert.equal(tryAcquire(file, 0), null, "and then held by the new owner");
  release(file, token);

  fs.writeFileSync(file, JSON.stringify({ pid: deadPid, host: "some-other-host", token: "far", at: 0 }));
  assert.equal(tryAcquire(file, 0), null);
  fs.writeFileSync(file, "not json");
  assert.equal(tryAcquire(file, 0), null, "a file this code did not write is left alone");
});

test("several processes writing the store at once lose no update", { timeout: 120_000 }, async () => {
  const dir = scratch();
  const writer = path.join(here, "fixtures", "store-writer.ts");
  const runs = Array.from({ length: 4 }, (_, index) => new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", writer, `p${index}`, "15"], { cwd: dir, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  }));
  assert.deepEqual(await Promise.all(runs), [0, 0, 0, 0]);
  const db = JSON.parse(fs.readFileSync(path.join(dir, "data", "tables.json"), "utf8")) as { sessions: Record<string, unknown> };
  assert.equal(Object.keys(db.sessions).length, 60);
  assert.equal(fs.existsSync(path.join(dir, "data", "tables.json.lock")), false);
});
