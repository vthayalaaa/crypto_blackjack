import fs from "node:fs";
import path from "node:path";
import { isEthCluster, MAX_SEATS, networkLabel, type Cluster } from "../table-view.ts";
import { withFileLock } from "./lockfile.ts";

if (typeof window !== "undefined") {
  throw new Error("The activity log cannot load in the browser.");
}

/**
 * Append-only operator log at data/activity.jsonl.
 * One JSON object per line. A line is an allowlist of fields, so a seat key
 * or the shoe cannot be written by adding them to the call.
 * Heartbeats are not logged. A leave is recorded only when a seated player
 * closes the page after they were present.
 */

const KINDS = ["join", "leave", "hit", "stand", "cancel", "claim", "buyin", "payout", "fees", "sweep", "vote", "kick"] as const;
const DETAILS = ["", "opened", "joined", "matched", "left", "held in seat", "collected", "start"] as const;

export type ActivityKind = (typeof KINDS)[number];
export type ActivityDetail = (typeof DETAILS)[number];

export type ActivityEvent = {
  at: number;
  kind: ActivityKind;
  table: string;
  cluster: Cluster;
  seat: number;
  wallet: string;
  amount: string;
  signature: string;
  detail: ActivityDetail;
};

export type ActivityInput = {
  at?: number;
  kind: ActivityKind;
  table: string;
  cluster: Cluster;
  seat: number;
  wallet?: string;
  amount?: string;
  signature?: string;
  detail?: ActivityDetail;
};

const CLUSTERS = new Set<Cluster>(["devnet", "localnet", "mainnet", "sepolia", "ethereum"]);
const KIND_SET = new Set<string>(KINDS);
const DETAIL_SET = new Set<string>(DETAILS);
const WALLET = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
const SIGNATURE = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})$/;

export function activityFile(): string {
  return path.join(process.cwd(), "data", "activity.jsonl");
}

/** The paying seat of a payout leg. Split legs look like "0>1". */
export function seatFromLeg(id: string): number {
  const head = id.split(">")[0] ?? "";
  if (!/^\d+$/.test(head)) return -1;
  const seat = Number(head);
  return seat >= 0 && seat < MAX_SEATS ? seat : -1;
}

export function eventFrom(input: unknown): ActivityEvent {
  if (!input || typeof input !== "object") throw new Error("Refusing to write that activity.");
  const raw = input as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !KIND_SET.has(raw.kind)) throw new Error("Refusing to write that activity.");
  if (typeof raw.table !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(raw.table)) throw new Error("Refusing to write that activity.");
  if (typeof raw.cluster !== "string" || !CLUSTERS.has(raw.cluster as Cluster)) throw new Error("Refusing to write that activity.");
  if (typeof raw.seat !== "number" || !Number.isInteger(raw.seat) || raw.seat < 0 || raw.seat >= MAX_SEATS) {
    throw new Error("Refusing to write that activity.");
  }
  const at = raw.at === undefined ? Date.now() : raw.at;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) throw new Error("Refusing to write that activity.");
  const wallet = clean(raw.wallet, WALLET);
  const signature = clean(raw.signature, SIGNATURE);
  const amount = raw.amount === undefined || raw.amount === "" ? "" : raw.amount;
  if (typeof amount !== "string" || (amount !== "" && !/^\d{1,80}$/.test(amount))) throw new Error("Refusing to write that activity.");
  const detail = raw.detail === undefined ? "" : raw.detail;
  if (typeof detail !== "string" || !DETAIL_SET.has(detail)) throw new Error("Refusing to write that activity.");
  const event: ActivityEvent = {
    at,
    kind: raw.kind as ActivityKind,
    table: raw.table,
    cluster: raw.cluster as Cluster,
    seat: raw.seat,
    wallet,
    amount,
    signature,
    detail: detail as ActivityDetail,
  };
  if (encode(event).includes("enc:v1:")) throw new Error("Refusing to write that activity.");
  return event;
}

/**
 * Append one committed action. The same buy-in, payout, sweep, join, or fee
 * line is not written twice. Returns false when this exact action is already there.
 */
export async function recordActivity(input: unknown, file = activityFile()): Promise<boolean> {
  const event = eventFrom(input);
  const line = encode(event);
  return withFileLock(`${file}.lock`, () => {
    if (readStored(file).some((prior) => sameActivity(prior, event))) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "a");
    try {
      fs.writeSync(fd, `${line}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  }, 5_000);
}

/** A log failure must not fail the hand or the payout that already landed. */
export async function noteActivity(input: ActivityInput, file = activityFile()): Promise<void> {
  try {
    await recordActivity(input, file);
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not be written";
    console.error(`activity: ${message}`);
  }
}

export async function loadActivity(limit: number, file = activityFile()): Promise<ActivityEvent[]> {
  const capped = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 50;
  return withFileLock(`${file}.lock`, () => readStored(file).slice(-capped), 5_000);
}

export function renderActivity(events: ActivityEvent[]): string {
  if (events.length === 0) return "No activity.";
  return events.map((event) => {
    const when = new Date(event.at).toISOString().replace("T", " ").slice(0, 19);
    const parts = [
      when,
      label(event.kind).padEnd(16),
      event.table,
      networkLabel(event.cluster),
      `seat ${event.seat}`,
    ];
    if (event.wallet) parts.push(event.wallet);
    if (event.amount) parts.push(formatUnits(event.cluster, event.amount));
    if (event.kind === "fees") parts.push("collected, still in the seat");
    if (event.kind === "sweep") parts.push("sent to master");
    if (event.detail === "opened" || event.detail === "matched" || event.detail === "joined" || event.detail === "start") parts.push(event.detail);
    if (event.signature) parts.push(event.signature);
    return parts.join("  ");
  }).join("\n");
}

function label(kind: ActivityKind): string {
  switch (kind) {
    case "join": return "joined";
    case "leave": return "left";
    case "hit": return "hit";
    case "stand": return "stand";
    case "cancel": return "cancelled";
    case "claim": return "claimed timeout";
    case "buyin": return "buy-in";
    case "payout": return "payout";
    case "fees": return "fee reserve";
    case "sweep": return "fees collected";
    case "vote": return "voted to start";
    case "kick": return "kicked";
  }
}

function formatUnits(cluster: Cluster, units: string): string {
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

function clean(value: unknown, pattern: RegExp): string {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || value.length > 128 || value.includes("enc:v1:") || !pattern.test(value)) {
    throw new Error("Refusing to write that activity.");
  }
  return value;
}

function encode(event: ActivityEvent): string {
  return JSON.stringify({
    at: event.at,
    kind: event.kind,
    table: event.table,
    cluster: event.cluster,
    seat: event.seat,
    wallet: event.wallet,
    amount: event.amount,
    signature: event.signature,
    detail: event.detail,
  });
}

function sameActivity(prior: ActivityEvent, next: ActivityEvent): boolean {
  if (prior.kind !== next.kind || prior.table !== next.table) return false;
  if (next.kind === "join" || next.kind === "fees") return prior.seat === next.seat;
  if (next.kind === "buyin" || next.kind === "payout" || next.kind === "sweep") {
    return next.signature !== "" && prior.signature === next.signature;
  }
  return false;
}

function readStored(file: string): ActivityEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: ActivityEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(eventFrom(JSON.parse(trimmed) as unknown));
    } catch {
      // A broken line can hold a seat key. Skip it and do not echo it.
    }
  }
  return events;
}
