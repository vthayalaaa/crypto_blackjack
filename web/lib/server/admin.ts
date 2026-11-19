import fs from "node:fs";
import path from "node:path";
import { isEthCluster, networkLabel, type Cluster, type Phase } from "../table-view.ts";
import { payoutLegs } from "./cashier.ts";
import type { SecretTable } from "./engine.ts";
import { prune } from "./prune.ts";
import { readArchive } from "./sweep.ts";
import { update } from "./store.ts";

export type TableLine = {
  id: string;
  cluster: Cluster;
  phase: Phase;
  stake: string;
  funded: number;
  seats: number;
  payout: "paid" | "unpaid" | "none";
  where: "live" | "archive";
  createdAt: number;
};

/** A row an operator can read. Seat keys and the shoe are not copied onto it. */
export function tableLine(table: SecretTable, where: "live" | "archive"): TableLine {
  const legs = payoutLegs(table);
  const payout = legs.length === 0 ? "none" : legs.every((leg) => table.paid[leg.id]) ? "paid" : "unpaid";
  return {
    id: table.id,
    cluster: table.cluster,
    phase: table.phase,
    stake: table.stake,
    funded: table.seats.filter((seat) => seat.funded).length,
    seats: table.seats.length,
    payout,
    where,
    createdAt: table.createdAt,
  };
}

/** Active hands are only the live waiting and acting tables. Completed includes the archive. */
export function selectTables(live: SecretTable[], archived: SecretTable[], which: "active" | "completed"): TableLine[] {
  const byId = new Map<string, { table: SecretTable; where: "live" | "archive" }>();
  for (const table of archived) if (table.id) byId.set(table.id, { table, where: "archive" });
  for (const table of live) if (table.id) byId.set(table.id, { table, where: "live" });
  const lines = [...byId.values()].map(({ table, where }) => tableLine(table, where));
  const picked = which === "active"
    ? lines.filter((line) => line.where === "live" && (line.phase === "waiting" || line.phase === "acting"))
    : lines.filter((line) => line.phase === "settled" || line.phase === "cancelled");
  return picked.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
}

export function formatStake(cluster: Cluster, units: string): string {
  let amount: bigint;
  try {
    amount = BigInt(units || "0");
  } catch {
    return units;
  }
  const decimals = isEthCluster(cluster) ? 18 : 9;
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const frac = (amount % scale).toString().padStart(decimals, "0").slice(0, 4).replace(/0+$/, "");
  const text = frac ? `${whole}.${frac}` : whole.toString();
  return `${text} ${isEthCluster(cluster) ? "ETH" : "SOL"}`;
}

export function renderTables(rows: TableLine[]): string {
  if (rows.length === 0) return "No tables.";
  const header = ["Id", "Network", "Phase", "Buy-in", "Seats", "Payout", "Kept"];
  const body = rows.map((row) => [
    row.id,
    networkLabel(row.cluster),
    row.phase,
    formatStake(row.cluster, row.stake),
    `${row.funded}/${row.seats}`,
    row.payout === "none" ? "-" : row.payout,
    row.where,
  ]);
  const widths = header.map((name, index) => Math.max(name.length, ...body.map((line) => line[index]!.length)));
  const paint = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  return [paint(header), ...body.map(paint)].join("\n");
}

export async function loadTables(which: "active" | "completed"): Promise<{ text: string; broken: number }> {
  return update((db) => {
    prune(db, Date.now());
    const archivePath = path.join(process.cwd(), "data", "tables-archive.jsonl");
    const archive = fs.existsSync(archivePath) ? readArchive(fs.readFileSync(archivePath, "utf8")) : { tables: [], broken: 0 };
    return { text: renderTables(selectTables(Object.values(db.tables), archive.tables, which)), broken: archive.broken };
  });
}
