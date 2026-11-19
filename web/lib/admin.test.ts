import assert from "node:assert/strict";
import { test } from "node:test";
import { formatStake, renderTables, selectTables, tableLine, type TableLine } from "./server/admin.ts";
import { consoleBanner, consoleRule } from "./server/banner.ts";
import type { SecretTable } from "./server/engine.ts";
import { isBlackjackServer, pidsOnPort } from "./server/restart.ts";

function table(patch: Partial<SecretTable> = {}): SecretTable {
  const seat = {
    address: "seat-address",
    secret: "seat-secret-do-not-print",
    wallet: "player-wallet",
    funded: true,
    cards: [1, 2],
    hits: 0,
    seen: 0,
    beat: 0,
    out: false,
    ready: false,
  };
  return {
    id: "table-1",
    cluster: "devnet",
    stake: "50000000",
    due: "70000000",
    buffer: "20000000",
    phase: "settled",
    turn: -1,
    winners: [],
    invite: "",
    seats: [seat, { ...seat, address: "seat-two", secret: "other-secret", wallet: "player-two" }],
    fundSignatures: [],
    deck: [7, 8, 9],
    deadline: 0,
    payouts: [],
    payoutError: "",
    paid: { "0": true, "1": true },
    sends: {},
    createdAt: 20,
    kickVotes: {},
    ...patch,
  };
}

test("active tables are live hands, and completed ones include the archive", () => {
  const waiting = table({ id: "open", phase: "waiting", createdAt: 5, paid: {} });
  const acting = table({ id: "hand", phase: "acting", createdAt: 9, paid: {} });
  const settled = table({ id: "done", phase: "settled", createdAt: 3 });
  const archived = table({ id: "old", phase: "settled", createdAt: 8 });
  const active = selectTables([waiting, acting, settled], [archived], "active");
  assert.deepEqual(active.map((line) => line.id), ["hand", "open"]);
  const completed = selectTables([waiting, settled], [archived, settled], "completed");
  assert.deepEqual(completed.map((line) => line.id), ["old", "done"]);
  assert.equal(completed.find((line) => line.id === "done")?.where, "live");
  assert.equal(completed.find((line) => line.id === "old")?.where, "archive");
});

test("a table row has no seat key, shoe, or wallet secret", () => {
  const line = tableLine(table({ phase: "waiting", paid: {} }), "live");
  const text = JSON.stringify(line);
  assert.equal(text.includes("seat-secret-do-not-print"), false);
  assert.equal(text.includes("other-secret"), false);
  assert.equal(line.payout, "unpaid");
  const shown = renderTables([line]);
  assert.equal(shown.includes("seat-secret"), false);
  assert.match(shown, /0\.05 SOL/);
  assert.equal(formatStake("sepolia", "1000000000000000000"), "1 ETH");
});

test("the port listing ignores other listeners", () => {
  const text = [
    "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       11704",
    "  TCP    [::]:3000              [::]:0                 LISTENING       11704",
    "  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       99",
    "  TCP    127.0.0.1:5354         0.0.0.0:0              TIME_WAIT       50",
  ].join("\n");
  assert.deepEqual(pidsOnPort(text, 3000), [11704]);
});

test("only this app's Next process may be restarted", () => {
  const root = "C:\\Users\\vthayala\\Dev\\DApps\\sol-blackjack\\web";
  const ours = "\"C:\\Program Files\\nodejs\\node.exe\" C:\\Users\\vthayala\\Dev\\DApps\\sol-blackjack\\web\\node_modules\\next\\dist\\server\\lib\\start-server.js";
  assert.equal(isBlackjackServer(ours, root), true);
  assert.equal(isBlackjackServer("node C:\\other\\web\\node_modules\\next\\dist\\server\\lib\\start-server.js", root), false);
  assert.equal(isBlackjackServer("npm run dev", root), false);
});

test("the console banner is DeFi Casino with a Blackjack subtext", () => {
  const lines = consoleBanner().split("\n");
  const art = lines.slice(0, 9);
  assert.equal(new Set(art.map((line) => line.length)).size, 1);
  assert.match(art[2]!, /^\$\$\$\$\$\$\$ {2}\| {2}______ {2}\$\$\$\$\$\$\$\$\//);
  assert.equal(lines.at(-1)?.trim(), "Blackjack");
  assert.match(consoleRule(), /\( 5 \).*\( 25 \).*\( 100 \)/);
});

test("the table list lines up under its headings", () => {
  const rows: TableLine[] = [tableLine(table(), "archive")];
  const [header, line] = renderTables(rows).split("\n");
  assert.match(header!, /^Id\s+Network\s+Phase\s+Buy-in\s+Seats\s+Payout\s+Kept$/);
  assert.match(line!, /table-1\s+Solana devnet\s+settled\s+0\.05 SOL\s+2\/2\s+paid\s+archive$/);
});
