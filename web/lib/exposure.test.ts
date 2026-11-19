import assert from "node:assert/strict";
import { test } from "node:test";
import { accountsOrRefuse, ethParties, exposureDenied, scanPages, scanSignaturePages, solanaAccounts } from "./server/exposure.ts";
import { SanctionedWalletError } from "./server/sanctions.ts";

const listedEth = new Set(["0xabc0000000000000000000000000000000000001"]);
const listedSol = new Set(["SanctionedSolAddress111"]);

test("an ethereum transfer with a listed counterparty is a hit", () => {
  const parties = ethParties({
    from: "0xabc0000000000000000000000000000000000001",
    to: "0x1111111111111111111111111111111111111111",
    contractAddress: "",
  }, "0x1111111111111111111111111111111111111111");
  assert.deepEqual(parties, ["0xabc0000000000000000000000000000000000001"]);
  assert.equal(listedEth.has(parties[0] ?? ""), true);
});

test("solana account keys include addresses loaded from a lookup table", () => {
  const accounts = solanaAccounts({
    transaction: { message: { accountKeys: ["Wallet", { pubkey: "Other" }] } },
    meta: { loadedAddresses: { writable: ["SanctionedSolAddress111"], readonly: ["Program"] } },
  });
  assert.deepEqual(accounts, ["Wallet", "Other", "SanctionedSolAddress111", "Program"]);
  assert.equal(accounts.some((account) => listedSol.has(account)), true);
});

test("a finished history with no listed counterparty is clear", async () => {
  const result = await scanPages(async () => ({ parties: ["0x2222222222222222222222222222222222222222"], full: false }), listedEth, (value) => value, 2);
  assert.equal(result, "clear");
});

test("a listed account in a later solana page is a hit", async () => {
  const result = await scanSignaturePages(async (before) => {
    if (!before) return { accounts: ["Wallet"], full: true, cursor: "sig-1" };
    return { accounts: ["SanctionedSolAddress111"], full: false, cursor: "sig-2" };
  }, listedSol, 2);
  assert.equal(result, "hit");
});

test("history that does not end within the page limit is refused", async () => {
  await assert.rejects(
    scanSignaturePages(async () => ({ accounts: ["Wallet"], full: true, cursor: "sig" }), listedSol, 2),
    /too long to finish checking/,
  );
});

test("a missing solana transaction is not treated as clear", () => {
  assert.throws(() => accountsOrRefuse(null), /could not be checked/);
  assert.throws(() => accountsOrRefuse({}), /could not be checked/);
});

test("a history hit is the sanctions error that removes a waiting wallet", () => {
  const error = exposureDenied();
  assert.equal(error instanceof SanctionedWalletError, true);
  assert.match(error.message, /transacted with an address on the U\.S\. sanctions list/);
});
