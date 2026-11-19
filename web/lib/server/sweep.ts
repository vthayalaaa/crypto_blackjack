import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { isAddress } from "viem";
import { isEthCluster, type Cluster } from "../table-view.ts";
import { noteActivity } from "./activity.ts";
import { payoutLegs, seatBalance, seatRail, sweepNetworkFee } from "./cashier.ts";
import type { PayoutSend, SecretTable } from "./engine.ts";
import { normalizeTable } from "./engine.ts";
import { LockBusyError, withFileLock } from "./lockfile.ts";
import { payLeg } from "./payout.ts";
import { assertClear } from "./sanctions.ts";
import { inspect } from "./store.ts";

const ledgerFile = path.join(process.cwd(), "data", "sweeps.json");
const ledgerLock = `${ledgerFile}.lock`;
const cashierDir = path.join(process.cwd(), "data", "cashier");

export type FeeSeat = {
  tableId: string;
  index: number;
  cluster: Cluster;
  address: string;
  secret: string;
  buffer: bigint;
};

/**
 * What can move to the master wallet.
 * The seat keeps enough for the transfer fee. Anything above the recorded
 * reserve may be a player's extra deposit, so it stays in the seat.
 */
export function feeSweepAmount(balance: bigint, networkFee: bigint, buffer: bigint): bigint {
  if (buffer <= 0n || networkFee < 0n || balance <= networkFee) return 0n;
  const spendable = balance - networkFee;
  return spendable < buffer ? spendable : buffer;
}

/**
 * A seat can be swept only when this hand is over and every payout from that
 * seat has landed. A funded seat with no payout leg still holds a buy-in.
 */
export function feeSeats(table: SecretTable): FeeSeat[] {
  if (table.phase !== "settled" && table.phase !== "cancelled") return [];
  const buffer = readBuffer(table.buffer);
  if (buffer === null) return [];
  const legs = payoutLegs(table);
  return table.seats.flatMap((seat, index) => {
    if (!seat.funded || !seat.secret || !seat.address) return [];
    const own = legs.filter((leg) => leg.id === String(index) || leg.id.startsWith(`${index}>`));
    if (own.length === 0 || own.some((leg) => !table.paid[leg.id])) return [];
    return [{ tableId: table.id, index, cluster: table.cluster, address: seat.address, secret: seat.secret, buffer }];
  });
}

/** Later archive lines win. A live table wins over the archive. */
export function tablesForSweep(live: SecretTable[], archived: SecretTable[], cluster: Cluster): SecretTable[] {
  const byId = new Map<string, SecretTable>();
  for (const table of archived) if (table.cluster === cluster && table.id) byId.set(table.id, table);
  for (const table of live) if (table.cluster === cluster && table.id) byId.set(table.id, table);
  return [...byId.values()];
}

/** Broken lines are counted and skipped. Their text can contain seat keys, so it is not returned. */
export function readArchive(text: string): { tables: SecretTable[]; broken: number } {
  const tables: SecretTable[] = [];
  let broken = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      tables.push(normalizeTable(JSON.parse(trimmed)));
    } catch {
      broken += 1;
    }
  }
  return { tables, broken };
}

/**
 * The master wallet is an address only. Its private key never belongs in this server.
 * It also must not be one of the seats, or the sweep would pay a seat the server holds.
 */
export function sweepDestination(cluster: Cluster, destination: string, seatAddresses: string[]): string {
  const target = destination.trim();
  const label = isEthCluster(cluster) ? "SWEEP_ETH_ADDRESS" : "SWEEP_SOL_ADDRESS";
  if (!target) throw new Error(`Set ${label} to the master wallet.`);
  if (isEthCluster(cluster)) {
    if (!isAddress(target)) throw new Error(`${label} is not an Ethereum address.`);
    if (seatAddresses.some((seat) => seat.toLowerCase() === target.toLowerCase())) {
      throw new Error("The master wallet is one of the seats.");
    }
    return target;
  }
  let text: string;
  try {
    text = new PublicKey(target).toBase58();
  } catch {
    throw new Error(`${label} is not a Solana address.`);
  }
  if (seatAddresses.includes(text)) throw new Error("The master wallet is one of the seats.");
  return text;
}

export function sweepEnvName(cluster: Cluster): "SWEEP_ETH_ADDRESS" | "SWEEP_SOL_ADDRESS" {
  return isEthCluster(cluster) ? "SWEEP_ETH_ADDRESS" : "SWEEP_SOL_ADDRESS";
}

type Ledger = { sends: Record<string, PayoutSend> };

function ledgerKey(seat: FeeSeat): string {
  return `${seat.tableId}:${seat.index}`;
}

function readLedger(): Ledger {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerFile, "utf8")) as Partial<Ledger>;
    const sends = Object.create(null) as Record<string, PayoutSend>;
    if (parsed.sends && typeof parsed.sends === "object") Object.assign(sends, parsed.sends);
    return { sends };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sends: Object.create(null) };
    throw error;
  }
}

function writeLedger(ledger: Ledger): void {
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const tmp = `${ledgerFile}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(ledger));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, ledgerFile);
}

export type SweepRow = { tableId: string; index: number; address: string; amount: bigint; signature: string };
export type SweepSkip = { tableId: string; index: number; address: string; reason: string };

export type SweepResult = {
  rows: SweepRow[];
  skipped: SweepSkip[];
  errors: SweepSkip[];
  brokenArchive: number;
};

/**
 * Move fee reserves to the master wallet.
 * Pass `send: false` to read balances and send nothing.
 * A saved transfer is reused, so a crash cannot pay the same reserve twice.
 */
export async function sweepFees(cluster: Cluster, destination: string, send: boolean): Promise<SweepResult> {
  const live = await inspect((db) => Object.values(db.tables));
  const archivePath = path.join(process.cwd(), "data", "tables-archive.jsonl");
  let archived: SecretTable[] = [];
  let brokenArchive = 0;
  if (fs.existsSync(archivePath)) {
    const read = readArchive(fs.readFileSync(archivePath, "utf8"));
    archived = read.tables;
    brokenArchive = read.broken;
  }
  const seats = tablesForSweep(live, archived, cluster).flatMap((table) => feeSeats(table));
  const master = destination.trim() ? sweepDestination(cluster, destination, seats.map((seat) => seat.address)) : "";
  if (send && !master) throw new Error(`Set ${sweepEnvName(cluster)} to the master wallet.`);
  if (send && seats.some((seat) => seat.secret.startsWith("enc:v1:")) && !(process.env.SEAT_KEY_SECRET ?? "")) {
    throw new Error("The seat key is encrypted and SEAT_KEY_SECRET is not set.");
  }
  if (send && seats.some((seat) => seat.secret.startsWith("enc:v2:")) && !(process.env.ARGON2_PASS || process.env.ARGAON2_PASS)) {
    throw new Error("The seat key is encrypted and ARGON2_PASS is not set.");
  }
  const networkFee = seats.length > 0 ? await sweepNetworkFee(cluster) : 0n;
  const rows: SweepRow[] = [];
  const skipped: SweepSkip[] = [];
  const errors: SweepSkip[] = [];
  const run = async () => {
    const ledger = send ? readLedger() : { sends: Object.create(null) as Record<string, PayoutSend> };
    for (const seat of seats) {
      try {
        const balance = await seatBalance(seat.cluster, seat.address);
        const amount = feeSweepAmount(balance, networkFee, seat.buffer);
        if (amount <= 0n) {
          skipped.push({ tableId: seat.tableId, index: seat.index, address: seat.address, reason: "Nothing is left of the fee reserve." });
          continue;
        }
        if (!send || !master) {
          rows.push({ tableId: seat.tableId, index: seat.index, address: seat.address, amount, signature: "" });
          continue;
        }
        const signature = await paySeat(seat, master, amount, ledger);
        rows.push({ tableId: seat.tableId, index: seat.index, address: seat.address, amount, signature });
        await noteActivity({
          kind: "sweep",
          table: seat.tableId,
          cluster: seat.cluster,
          seat: seat.index,
          wallet: master,
          amount: amount.toString(),
          signature,
          detail: "collected",
        });
      } catch (error) {
        if (error instanceof LockBusyError) {
          skipped.push({ tableId: seat.tableId, index: seat.index, address: seat.address, reason: "A payout is in progress on this table." });
          continue;
        }
        errors.push({ tableId: seat.tableId, index: seat.index, address: seat.address, reason: scrub(error) });
      }
    }
  };
  if (send) await withFileLock(ledgerLock, run, 15_000);
  else await run();
  return { rows, skipped, errors, brokenArchive };
}

async function paySeat(seat: FeeSeat, destination: string, amount: bigint, ledger: Ledger): Promise<string> {
  const key = ledgerKey(seat);
  return withFileLock(path.join(cashierDir, `${seat.tableId}.lock`), async () => {
    const live = await inspect((db) => db.tables[seat.tableId]);
    if (live && !feeSeats(live).some((item) => item.index === seat.index)) {
      throw new Error("This seat is no longer ready to sweep.");
    }
    return payLeg(
      seatRail(seat.cluster, seat.secret, destination, amount),
      ledger.sends[key],
      () => assertClear(seat.cluster, destination),
      async (saved) => {
        ledger.sends[key] = saved;
        writeLedger(ledger);
      },
    );
  }, 0);
}

function readBuffer(value: string): bigint | null {
  try {
    const amount = BigInt(value || "0");
    return amount >= 0n ? amount : null;
  } catch {
    return null;
  }
}

function scrub(error: unknown): string {
  const raw = error instanceof Error ? error.message : "The sweep could not be sent.";
  return raw.replace(/0x[0-9a-fA-F]{64}/g, "0x…").slice(0, 240);
}

export function formatSweepResult(cluster: Cluster, result: SweepResult, send: boolean, destination: string): string {
  const unit = isEthCluster(cluster) ? "wei" : "lamports";
  const lines: string[] = [];
  if (result.brokenArchive > 0) lines.push(`${result.brokenArchive} archive lines could not be read and were left untouched.`);
  for (const row of result.rows) {
    const action = row.signature ? `sent ${row.signature}` : "would send";
    lines.push(`${row.tableId} seat ${row.index} ${row.address} ${action} ${row.amount} ${unit}`);
  }
  for (const row of result.skipped) lines.push(`${row.tableId} seat ${row.index} ${row.address} skipped: ${row.reason}`);
  for (const row of result.errors) lines.push(`${row.tableId} seat ${row.index} ${row.address} error: ${row.reason}`);
  if (!send) lines.push(`Dry run. Nothing was sent. Set ${sweepEnvName(cluster)} and pass --send to move the fees.`);
  else if (destination) lines.push(`Master wallet: ${destination}`);
  return lines.join("\n");
}
